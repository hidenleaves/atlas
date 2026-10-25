#!/usr/bin/env node
/* ============================================================
   model-eval.js — 真实模型端到端评测
   ------------------------------------------------------------
   为什么需要这个：
     现有的 321 条 npm test 和 34 条 perturb-review 全是**规则层**测试，
     测的是 route() / api.js 的确定性行为。它们完全不知道
     「DeepSeek 拿到 draw_plan 后到底画成什么样」。
     而"AI 画图"是这个项目的主打功能。

   本 harness 跑的是 js/chat.js 里**线上同一段 callModel**（已导出），
   只把 fetch 换成可控实现，所以结果对线上有代表性。

   三种模式：
     --live              真打 DeepSeek（需 DEEPSEEK_API_KEY 或 --key）
     --replay <file>     回放录制，不需要 key，结果可复现
     --fake <policy>     用脚本化假模型验证 harness 自身（不需要 key）
                           policy: good=理想模型 / lazy=只 place 不连线 /
                                   sloppy=先画错再自愈

   录制：--live 时自动把请求/响应存到 tools/eval-recordings/，
   下次 --replay 该文件即可离线复现同一次评测。

   用法：
     node tools/model-eval.js --fake good
     node tools/model-eval.js --live --key sk-xxx
     node tools/model-eval.js --live            # 读 DEEPSEEK_API_KEY
     node tools/model-eval.js --replay tools/eval-recordings/xxx.json
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------------- Node 环境桩 ---------------- */
global.window = global;
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
global.document = {
  addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }; }
};

require('../js/editor-model.js');
require('../js/advisor.js');
require('../js/api.js');
require('../js/circuits.js');
global.PLCRoute = require('../js/route.js');
global.PLCPrompt = require('../js/prompt.js');
global.PLCTemplates = require('../js/templates.js');
require('../js/chat.js');

const M = global.PLCEditorModel;
const A = global.PLCApi;
const C = global.PLCChat;

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);

const MODE = has('selftest') ? 'selftest'
  : has('live') ? 'live'
  : has('replay') ? 'replay'
  : has('fake') ? 'fake' : null;
const REPLAY_FILE = arg('replay');
const FAKE_POLICY = arg('fake') || 'good';
const API_KEY = arg('key') || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
const VERBOSE = has('verbose');
const ONLY = arg('only');

if (!MODE) {
  console.log('用法：');
  console.log('  node tools/model-eval.js --selftest               # 不需要 key，验证 harness 判别力');
  console.log('  node tools/model-eval.js --fake good|sloppy|lazy   # 不需要 key，单跑一种假模型');
  console.log('  node tools/model-eval.js --live [--key sk-xxx]     # 真打模型');
  console.log('  node tools/model-eval.js --replay <record.json>    # 离线复现');
  process.exit(2);
}

/* ------------------------------------------------------------
   --selftest：证明 harness 能区分好坏模型
   ------------------------------------------------------------
   一个只会"跑完不报错"的 harness 是没有价值的。这里用三种
   脚本化假模型验证判别力，关系必须成立：
       good   通过率最高，无散图
       sloppy 通过率居中，且能识别出「先失败后自愈」
       lazy   通过率最低，散图数 = 全量（只放元件不连线）
   用子进程跑，避免三种策略共享模块状态互相污染。
   ------------------------------------------------------------ */
if (MODE === 'selftest') {
  const { execFileSync } = require('child_process');
  const outDir = path.join(__dirname, 'eval-results');

  // 不再 rmSync 整个目录（会触发沙箱的批量删除拦截，也容易和并发评测打架）。
  // 改成记录「跑之前有哪些文件」，跑完取新出现的那个。
  const runOne = policy => {
    const before = fs.existsSync(outDir)
      ? new Set(fs.readdirSync(outDir).filter(f => f.includes('fake-' + policy)))
      : new Set();
    try {
      execFileSync(process.execPath, [__filename, '--fake', policy], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { /* 非零退出正常，结果看 JSON */ }
    const fresh = fs.readdirSync(outDir)
      .filter(f => f.includes('fake-' + policy) && !before.has(f))
      .sort();
    const pick = fresh.length ? fresh[fresh.length - 1]
      : fs.readdirSync(outDir).filter(f => f.includes('fake-' + policy)).sort().pop();
    return JSON.parse(fs.readFileSync(path.join(outDir, pick), 'utf8')).summary;
  };

  console.log('=== harness 自检：三种假模型判别力 ===\n');
  const g = runOne('good');
  const s = runOne('sloppy');
  const l = runOne('lazy');
  const d = runOne('dsml');

  const rows = [['good', g], ['sloppy', s], ['lazy', l], ['dsml', d]];
  console.log('策略     通过率   散图   未用draw   自愈');
  console.log('─'.repeat(46));
  rows.forEach(([n, x]) => console.log(
    n.padEnd(8),
    `${x.pass}/${x.total}`.padStart(6),
    String(x.scatter).padStart(6),
    String(x.noDrawCall).padStart(9),
    String(x.recovered).padStart(6)
  ));

  const checks = [
    ['good 通过率 > sloppy', g.pass > s.pass],
    ['sloppy 通过率 > lazy', s.pass > l.pass],
    ['good 无散图', g.scatter === 0],
    ['lazy 全部是散图', l.scatter === l.total],
    ['lazy 完全没用 draw 工具', l.noDrawCall === l.total],
    ['sloppy 识别出自愈', s.recovered > 0],
    ['good 全部走 draw 工具', g.noDrawCall === 0],
    // DSML 故障注入：模型把工具调用写成文本时必须能救回来，
    // 至少要有产出、要有工具调用记录（救不回来就是 0/0）。
    ['dsml 文本能被救成工具调用', d.noDrawCall === 0],
    ['dsml 有实际产出', d.pass > 0]
  ];
  console.log('');
  let bad = 0;
  checks.forEach(([name, ok]) => {
    console.log((ok ? '✓' : '✗') + ' ' + name);
    if (!ok) bad++;
  });
  console.log('\n' + (bad === 0
    ? 'harness 判别力正常 —— 可以接真实模型。'
    : `有 ${bad} 项不成立，harness 本身有问题，先修再评测。`));
  process.exit(bad === 0 ? 0 : 1);
}

/* ============================================================
   评测集：40 条开放式指令
   ------------------------------------------------------------
   设计原则：
     · 不用规则测试里那套规整说法，用真人会说的话
     · 每条写清「什么样算过」，能机械判定
     · 分五组，分别对应不同失效模式
   ============================================================ */

const CASES = [
  /* ---- A 组：内置已有模板（对照组）。这些不该交给模型，
         如果调了模型反而说明路由判断错了 ---- */
  { id: 'A01', group: 'A 内置模板', text: '画一个起保停', expect: { compsMin: 4, level: 'ok', engine: 'either' } },
  { id: 'A02', group: 'A 内置模板', text: '来个正反转，带互锁的', expect: { compsMin: 8, level: 'ok', engine: 'either' } },
  { id: 'A03', group: 'A 内置模板', text: '帮我画两地控制', expect: { compsMin: 10, level: 'ok', engine: 'either' } },

  /* ---- B 组：内置没有，只能靠模型 ----
         重点看：是否一次调用 draw_plan 把图画完整，而不是散着 place ---- */
  { id: 'B01', group: 'B 只能模型', text: '画一个星三角启动的主电路', expect: { compsMin: 6, level: 'ok|warn', engine: 'model' } },
  { id: 'B02', group: 'B 只能模型', text: '给我画一个电机正转，带启动停止，加个运行指示灯', expect: { compsMin: 5, level: 'ok|warn', engine: 'model' } },
  { id: 'B03', group: 'B 只能模型', text: '画一个带急停按钮的控制回路，急停要能切断整个回路', expect: { compsMin: 4, level: 'ok|warn', engine: 'model' } },
  { id: 'B04', group: 'B 只能模型', text: '两个电机，要求 A 启动后 B 才能启动，画出来', expect: { compsMin: 6, level: 'ok|warn', engine: 'model' } },
  { id: 'B05', group: 'B 只能模型', text: '画个点动加自锁的混合控制，点动优先', expect: { compsMin: 4, level: 'ok|warn', engine: 'model' } },
  { id: 'B06', group: 'B 只能模型', text: '帮我画一个电机过载保护回路，热继电器动作后要能报警', expect: { compsMin: 5, level: 'ok|warn', engine: 'model' } },

  /* ---- C 组：否定与约束。核心失效模式：说了不要却画了 ---- */
  { id: 'C01', group: 'C 否定', text: '画个正反转，但是不要自锁', expect: { noMax: 0, level: 'ok|warn', engine: 'either' } },
  { id: 'C02', group: 'C 否定', text: '画正反转，互锁不用加', expect: { ncMax: 1, level: 'ok|warn', engine: 'either' } },
  { id: 'C03', group: 'C 否定', text: '来个正反转控制，只保留互锁，不要自锁', expect: { noMax: 0, level: 'ok|warn', engine: 'either' } },
  { id: 'C04', group: 'C 否定', text: '画一个起保停，但不要停止按钮', expect: { compsMin: 2, level: 'ok|warn', engine: 'model' } },
  { id: 'C05', group: 'C 否定', text: '画个星三角，先不要画主电路，只画控制部分', expect: { compsMin: 3, level: 'ok|warn', engine: 'model' } },

  /* ---- D 组：口语 / 错别字 / 省略。看鲁棒性 ---- */
  { id: 'D01', group: 'D 口语', text: '那个…正反转，你懂的，画一下', expect: { compsMin: 4, level: 'ok|warn', engine: 'either' } },
  { id: 'D02', group: 'D 口语', text: '正反专', expect: { comps: 'any', engine: 'either' } },
  { id: 'D03', group: 'D 口语', text: '来张图，启动停止带自锁那种', expect: { compsMin: 3, level: 'ok|warn', engine: 'either' } },
  { id: 'D04', group: 'D 口语', text: '我要一个按下去就转、松开就停的', expect: { compsMin: 2, level: 'ok|warn', engine: 'either' } },
  { id: 'D05', group: 'D 口语', text: '接触器互锁那两个线圈别让它同时吸合，画出来', expect: { compsMin: 4, level: 'ok|warn', engine: 'model' } },

  /* ---- E 组：画完之后的操作。看上下文是否接得上 ---- */
  { id: 'E01', group: 'E 后续操作', text: '画一个起保停，然后加个运行指示灯', expect: { compsMin: 5, level: 'ok|warn', engine: 'model' } },
  { id: 'E02', group: 'E 后续操作', text: '清空，然后画个互锁', expect: { compsMin: 5, level: 'ok|warn', engine: 'either' } },
  { id: 'E03', group: 'E 后续操作', text: '画个正反转，把热继电器补上', expect: { compsMin: 8, level: 'ok|warn', engine: 'model' } },
  { id: 'E04', group: 'E 后续操作', text: '先画互锁，再把两个启动按钮换成带灯按钮', expect: { compsMin: 5, level: 'ok|warn', engine: 'model' } },

  /* ---- F 组：超出能力。期望它说不会，而不是乱画 ---- */
  { id: 'F01', group: 'F 边界', text: '帮我算一下这个电机的接触器选型', expect: { noDraw: true, engine: 'either' } },
  { id: 'F02', group: 'F 边界', text: '今天天气怎么样', expect: { noDraw: true, engine: 'either' } },
  { id: 'F03', group: 'F 边界', text: '把这台设备的 PLC 程序写出来', expect: { noDraw: true, engine: 'either' } },
  { id: 'F04', group: 'F 边界', text: '画一个能自动检测故障并报警的智能系统', expect: { allowEmpty: true, engine: 'either' } },
];

/* ============================================================
   fetch 桩：把 SSE 流喂给 callModel
   ============================================================ */

let RECORD = null;      // live 模式下累积
let RECORD_IDX = 0;
let REPLAY_DATA = null; // replay 模式

// 把一次模型响应包成 fetch 期望的 Response-like
function sseResponse(chunks) {
  const text = chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  const buf = Buffer.from(text, 'utf8');
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: new Uint8Array(buf) });
          }
        };
      }
    },
    text: () => Promise.resolve(text)
  };
}

// 构造 OpenAI 兼容的 stream chunk
function chunkOf({ content, toolCalls, usage }) {
  const delta = {};
  if (content) delta.content = content;
  if (toolCalls) delta.tool_calls = toolCalls;
  const c = { choices: [{ index: 0, delta }] };
  if (usage) { c.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }]; c.usage = usage; }
  return c;
}

/* ---------------- 假模型：验证 harness 自身 ---------------- */
function fakeModel(messages, tools) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = (lastUser && lastUser.content) || '';
  const toolMsgs = messages.filter(m => m.role === 'tool');
  const turn = toolMsgs.length;

  // 内置模板能吃的就直接用 draw_template（good 策略）
  const tpl = /起保停/.test(text) ? 'selflock'
    : /两地控制/.test(text) ? 'remote'
    : /正反转/.test(text) ? 'reverse'
    : /互锁/.test(text) ? 'interlock'
    : /点动|松开就停/.test(text) ? 'jog' : null;

  const wantNoSelf = /不要自锁|自锁不用|不带自锁|除了自锁/.test(text);
  const wantNoLock = /互锁不用|不加互锁|不要互锁|不带互锁/.test(text);

  if (FAKE_POLICY === 'good') {
    // 第一次就给完整计划
    if (turn === 0) {
      if (/天气|选型|PLC 程序/.test(text)) {
        return sseResponse([chunkOf({ content: '这个我做不了，我只负责画继电器-接触器控制电路。' }),
          chunkOf({ usage: { total_tokens: 40 } })]);
      }
      if (tpl) {
        const args = { kind: tpl };
        if (tpl === 'reverse') {
          if (wantNoSelf) args.selflock = false;
          if (wantNoLock) args.interlock = false;
        }
        return sseResponse([
          chunkOf({ toolCalls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'draw_template', arguments: JSON.stringify(args) } }] }),
          chunkOf({ usage: { total_tokens: 60 } })
        ]);
      }
      // 没有模板：一次 draw_plan 画完整
      const plan = {
        clear: true,
        components: [{ type: 'btnNo', key: 'SF1', branch: 1 }, { type: 'btnNc', key: 'SF2', branch: 2 },
          { type: 'coil', key: 'QA1', branch: 3 }],
        nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'SF2#0'] },
          { name: 'B', pins: ['SF2#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }],
        terminals: [{ name: 'L', node: 'L' }, { name: 'N', node: 'N' }]
      };
      return sseResponse([
        chunkOf({ toolCalls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'draw_plan', arguments: JSON.stringify(plan) } }] }),
        chunkOf({ usage: { total_tokens: 200 } })
      ]);
    }
    return sseResponse([chunkOf({ content: '画好了。' }), chunkOf({ usage: { total_tokens: 30 } })]);
  }

  if (FAKE_POLICY === 'lazy') {
    // 只 place，从不连线 —— 典型的"散图"失败
    if (turn < 2) {
      return sseResponse([
        chunkOf({ toolCalls: [{ index: 0, id: 'c' + turn, type: 'function', function: { name: 'place_component', arguments: JSON.stringify({ type: 'coil', key: 'QA' + (turn + 1) }) } }] }),
        chunkOf({ usage: { total_tokens: 50 } })
      ]);
    }
    return sseResponse([chunkOf({ content: '放好了几个元件。' }), chunkOf({ usage: { total_tokens: 20 } })]);
  }

  if (FAKE_POLICY === 'dsml') {
    // 专门模拟真实出现过的故障：模型不走 function calling 通道，
    // 而是把工具调用写成 DSML 文本。用来验证 salvageDsml 能把它们救回来。
    if (turn === 0) {
      const plan = {
        clear: true,
        components: [{ type: 'btnNo', key: 'SF1', branch: 1 }, { type: 'btnNc', key: 'SF2', branch: 2 },
          { type: 'coil', key: 'QA1', branch: 3 }],
        nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'SF2#0'] },
          { name: 'B', pins: ['SF2#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }],
        terminals: [{ name: 'L', node: 'L' }, { name: 'N', node: 'N' }]
      };
      const P = '<\uff5c\uff5cDSML\uff5c\uff5c parameter';
      const E = '</\uff5c\uff5cDSML\uff5c\uff5c parameter>';
      const dsml =
        '<\uff5c\uff5cDSML\uff5c\uff5c calls>\n' +
        '<\uff5c\uff5cDSML\uff5c\uff5c invoke name="draw_plan">\n' +
        P + ' name="clear" string="false">true' + E + '\n' +
        P + ' name="components" string="false">' + JSON.stringify(plan.components) + E + '\n' +
        P + ' name="nodes" string="false">' + JSON.stringify(plan.nodes) + E + '\n' +
        P + ' name="terminals" string="false">' + JSON.stringify(plan.terminals) + E + '\n' +
        '</\uff5c\uff5cDSML\uff5c\uff5c invoke>\n' +
        '</\uff5c\uff5cDSML\uff5c\uff5c calls>';
      return sseResponse([chunkOf({ content: dsml }), chunkOf({ usage: { total_tokens: 220 } })]);
    }
    return sseResponse([chunkOf({ content: '画好了。' }), chunkOf({ usage: { total_tokens: 20 } })]);
  }

  // sloppy：先画错（短路），收到错误后自愈
  if (turn === 0) {
    const bad = {
      clear: true,
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1' }],
      nodes: [{ name: 'L', pins: ['SF1#0', 'SF1#1', 'QA1#0'] }]
    };
    return sseResponse([
      chunkOf({ toolCalls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'draw_plan', arguments: JSON.stringify(bad) } }] }),
      chunkOf({ usage: { total_tokens: 120 } })
    ]);
  }
  const fixed = {
    clear: true,
    components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1' }],
    nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }],
    terminals: [{ name: 'L', node: 'L' }, { name: 'N', node: 'N' }]
  };
  return sseResponse([
    chunkOf({ toolCalls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'draw_plan', arguments: JSON.stringify(fixed) } }] }),
    chunkOf({ usage: { total_tokens: 150 } })
  ]);
}

/* ---------------- fetch 注入 ---------------- */
// 回放模式把真实 fetch 换成抛错，确保离线复现真的不联网 —— 同时任何
// 意外走到 live 分支的代码都会立刻暴露，而不是静默发出请求。
const realFetch = MODE === 'replay'
  ? () => Promise.reject(new Error('回放模式不应发起网络请求'))
  : global.fetch;
global.fetch = function (url, opts) {
  const body = JSON.parse(opts.body || '{}');

  if (MODE === 'fake') {
    const resp = fakeModel(body.messages, body.tools);
    if (VERBOSE) console.log('    [fake][' + FAKE_POLICY + '] 轮次 ' + body.messages.filter(m => m.role === 'tool').length);
    return Promise.resolve(resp);
  }

  if (MODE === 'replay') {
    const step = REPLAY_DATA.steps[RECORD_IDX++];
    if (!step) throw new Error('回放数据不够：请求数超过录制');
    return Promise.resolve(sseResponse(step.chunks));
  }

  // live
  const started = Date.now();
  return realFetch(url, opts).then(r => {
    if (!r.ok) return r.text().then(t => { throw new Error('HTTP ' + r.status + '：' + t.slice(0, 200)); });
    // 需要落盘，所以把流读完再重新包一个
    return r.text().then(text => {
      const chunks = text.split('\n')
        .filter(l => l.trim().startsWith('data:'))
        .map(l => l.slice(5).trim())
        .filter(d => d && d !== '[DONE]')
        .map(d => { try { return JSON.parse(d); } catch (e) { return null; } })
        .filter(Boolean);
      RECORD.steps.push({ ms: Date.now() - started, chunks });
      return sseResponse(chunks);
    });
  });
};

/* ============================================================
   跑一条用例
   ============================================================ */

function runCase(c) {
  const doc = M.blank(760, 500);
  // 回放要按录制里的全局顺序消费请求（一次 live 是从头跑到尾的），
  // 每条用例都重置会让大家拿到同一批数据。live/fake 不需要这个游标。
  if (MODE !== 'replay') RECORD_IDX = 0;

  const t0 = Date.now();
  // DBG 是模块内累积的数组，且超过 160 条会被截断。
  // 用长度快照会在截断后拿到空数组，所以每次用例前显式清空。
  if (C.clearDebug) C.clearDebug();
  // 多轮历史同样是模块级的（chat.js 的 conv，取最后 8 条拼进请求）。
  // 不清空的话第 N 条用例会看到前几条的问答，测的就不是单指令了，
  // 而且每次运行的历史不同 → 通过率大幅漂移。评测必须隔离。
  if (C.resetConversation) C.resetConversation();
  return C.callModel(c.text, doc, null).then(res => {
    const ms = Date.now() - t0;
    const fresh = C.getDebug();
    const calls = fresh.filter(l => /\[tool\]/.test(l)).map(l => {
      const m = l.match(/\[tool\] (\w+) (OK|FAIL)/);
      return m ? { name: m[1], ok: m[2] === 'OK' } : null;
    }).filter(Boolean);

    const an = A.analyze(doc);
    const termCount = doc.marks.filter(m => m.kind === 'term').length;
    return {
      id: c.id, group: c.group, text: c.text,
      reply: (res && res.reply) || '',
      via: (res && res.via) || '?',
      ms,
      comps: doc.comps.length,
      wires: doc.wires.length,
      terms: termCount,
      nc: doc.comps.filter(x => x.type === 'nc').length,
      no: doc.comps.filter(x => x.type === 'no').length,
      level: an.level,
      issues: an.issues.slice(0, 5).map(x => x.level + ':' + x.msg),
      calls,
      drawCalls: calls.filter(x => x.name === 'draw_plan' || x.name === 'draw_template').length,
      placeCalls: calls.filter(x => x.name === 'place_component').length,
      failCalls: calls.filter(x => !x.ok).length,
      changed: !!(res && res.changed)
    };
  });
}

/* ============================================================
   判定
   ============================================================ */

function judge(r, c) {
  const e = c.expect || {};
  const fails = [];

  if (e.noDraw) {
    if (r.comps > 0) fails.push(`不该画却画了 ${r.comps} 个元件`);
    return fails;
  }

  // 底线：除了 F 组「不该画 / 可画可不画」，任何用例都必须真的产出东西。
  // 否则「空画布」会骗过 noMax/ncMax 这类上限判定，造成假通过
  // （C 组早期就是这样：什么都没画，反而"没有多余的触点"）。
  if (!e.allowEmpty && !(r.comps >= 2)) {
    fails.push(`没有产出：元件 ${r.comps}（空画布不能算通过）`);
    if (!r.reply) fails.push('连回复都没有');
  }

  if (e.compsMin != null && r.comps < e.compsMin) fails.push(`元件 ${r.comps} < ${e.compsMin}`);
  if (e.noMax != null && r.no > e.noMax) fails.push(`常开触点 ${r.no} > ${e.noMax}（说了不要自锁）`);
  if (e.ncMax != null && r.nc > e.ncMax) fails.push(`常闭触点 ${r.nc} > ${e.ncMax}（说了不加互锁）`);
  if (e.level) {
    const ok = e.level.split('|');
    if (!ok.includes(r.level)) fails.push(`电气检查 level=${r.level}，期望 ${e.level}`);
  }
  // 散图检测：有元件但几乎没线
  if (r.comps >= 2 && r.wires === 0) fails.push('有元件但一根线都没有（散图）');

  return fails;
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  if (MODE === 'live' && !API_KEY) {
    console.error('✗ --live 需要 API key：设 DEEPSEEK_API_KEY 环境变量，或加 --key sk-xxx');
    process.exit(2);
  }
  if (MODE === 'replay') {
    if (!REPLAY_FILE || !fs.existsSync(REPLAY_FILE)) {
      console.error('✗ --replay 需要一个录制文件');
      process.exit(2);
    }
    // 支持 .gz：归档的基线录制压过，直接喂路径即可
    const raw = /\.gz$/.test(REPLAY_FILE)
      ? require('zlib').gunzipSync(fs.readFileSync(REPLAY_FILE)).toString('utf8')
      : fs.readFileSync(REPLAY_FILE, 'utf8');
    REPLAY_DATA = JSON.parse(raw);
  }
  if (MODE === 'live') {
    // 写进 localStorage，让 callModel 的 cfg() 读到
    store['plc-atlas.llm.v1'] = JSON.stringify({
      endpoint: arg('endpoint') || 'https://api.deepseek.com/v1/chat/completions',
      model: arg('model') || 'deepseek-chat',
      apiKey: API_KEY
    });
    RECORD = { startedAt: new Date().toISOString(), model: arg('model') || 'deepseek-chat', steps: [] };
  }
  if (MODE === 'fake') {
    // callModel 开头会检查 cfg()，没配置就直接返回 null。
    // 假模型不联网，但要给一份看起来合法的配置让链路走起来。
    store['plc-atlas.llm.v1'] = JSON.stringify({
      endpoint: 'https://fake.local/v1/chat/completions',
      model: 'fake-' + FAKE_POLICY,
      apiKey: 'fake-key'
    });
  }
  if (MODE === 'replay') {
    // 回放同样要过 callModel 的配置检查，否则它会静默返回 null，
    // 整轮评测变成「什么都没做」，而空画布又能骗过一部分判定 —— 假通过。
    store['plc-atlas.llm.v1'] = JSON.stringify({
      endpoint: 'https://replay.local/v1/chat/completions',
      model: 'replay',
      apiKey: 'replay-key'
    });
  }

  const list = ONLY ? CASES.filter(c => c.id === ONLY) : CASES;
  console.log(`模式：${MODE}${MODE === 'fake' ? '（' + FAKE_POLICY + '）' : ''}   用例：${list.length} 条\n`);
  console.log('ID    组          元件 线 端 工具调用(draw/place/fail)  level 判定');
  console.log('─'.repeat(84));

  const results = [];
  for (const c of list) {
    let r;
    try {
      r = await runCase(c);
    } catch (e) {
      r = { id: c.id, group: c.group, text: c.text, error: String(e.message || e), comps: 0, wires: 0, terms: 0, nc: 0, no: 0, level: '-', calls: [], drawCalls: 0, placeCalls: 0, failCalls: 0, reply: '', via: '?' };
    }
    const fails = r.error ? ['异常：' + r.error] : judge(r, c);
    r.fails = fails;
    r.pass = fails.length === 0;
    results.push(r);

    const toolStr = `${r.calls.length}(${r.drawCalls}/${r.placeCalls}/${r.failCalls})`;
    console.log(
      r.id.padEnd(5),
      String(c.group).padEnd(11),
      String(r.comps).padStart(4),
      String(r.wires).padStart(3),
      String(r.terms).padStart(2),
      toolStr.padStart(24),
      String(r.level).padStart(6),
      r.pass ? '✓' : '✗ ' + fails[0]
    );
  }

  /* ---- 汇总 ---- */
  const total = results.length;
  const pass = results.filter(r => r.pass).length;
  const scatter = results.filter(r => r.comps >= 2 && r.wires === 0).length;
  const noDrawCall = results.filter(r => r.comps > 0 && r.drawCalls === 0).length;
  const recovered = results.filter(r => r.failCalls > 0 && r.pass).length;
  const avgMs = Math.round(results.reduce((s, r) => s + (r.ms || 0), 0) / total);

  // 分组统计
  const groups = {};
  results.forEach(r => {
    const g = groups[r.group] = groups[r.group] || { n: 0, ok: 0 };
    g.n++; if (r.pass) g.ok++;
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`通过 ${pass}/${total}  (${Math.round(pass / total * 100)}%)`);
  console.log(`散图（有元件无连线）：${scatter}`);
  console.log(`没用 draw_plan/draw_template 出图：${noDrawCall}`);
  console.log(`先失败后自愈：${recovered}`);
  console.log(`平均耗时：${avgMs}ms`);
  console.log('\n分组：');
  Object.keys(groups).sort().forEach(g => {
    const x = groups[g];
    console.log(`  ${g.padEnd(12)} ${x.ok}/${x.n}`);
  });
  console.log('═'.repeat(60));

  if (pass < total) {
    console.log('\n失败明细：');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  ${r.id} 「${r.text}」`);
      r.fails.forEach(f => console.log(`      - ${f}`));
      if (r.reply) console.log(`      回复：${r.reply.slice(0, 100)}`);
    });
  }

  /* ---- 落盘 ---- */
  const outDir = path.join(__dirname, 'eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = MODE === 'fake' ? 'fake-' + FAKE_POLICY : MODE;
  const outFile = path.join(outDir, `eval-${tag}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    mode: MODE, policy: MODE === 'fake' ? FAKE_POLICY : null,
    at: new Date().toISOString(), summary: { total, pass, scatter, noDrawCall, recovered, avgMs },
    results
  }, null, 2));
  console.log('\n结果：' + outFile);

  // live 模式同时存录制，供 --replay 离线复现
  if (MODE === 'live' && RECORD) {
    const recDir = path.join(__dirname, 'eval-recordings');
    fs.mkdirSync(recDir, { recursive: true });
    const recFile = path.join(recDir, `rec-${stamp}.json`);
    fs.writeFileSync(recFile, JSON.stringify(RECORD, null, 2));
    console.log('录制：' + recFile + `（${RECORD.steps.length} 次请求）`);
    console.log('下次离线复现：node tools/model-eval.js --replay ' + recFile);
  }

  process.exitCode = pass === total ? 0 : 1;
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
