'use strict';
/* ============================================================
   perturb-review.js — WorkBuddy 的独立审查套件
   ------------------------------------------------------------
   与 Claude 自己的 route-test / route-fuzz 分开维护，防止
   「自己出题自己答」。Claude 不得修改本文件。

   两档判定：
     BLOCKING —— 必修项。任何一条失败，VERDICT 只能是 CONTINUE。
     KNOWN    —— 已确认的边角缺陷。只记录，不阻塞；修好后自然变 ✓。

   运行：node tools/perturb-review.js
   ============================================================ */
global.window = global;
require('../js/editor-model.js');
require('../js/advisor.js');
require('../js/api.js');
require('../js/circuits.js');
global.PLCRoute = require('../js/route.js');
global.PLCPrompt = require('../js/prompt.js');
global.PLCTemplates = require('../js/templates.js');
require('../js/chat.js');
const M = global.PLCEditorModel, A = global.PLCApi, C = global.PLCChat;

const BLOCKING = [
  /* ---- 第 23 轮暴露的 P0：secondary 降级 + remove→draw 时序 ---- */
  ['画个正反转，省掉自锁',            { nc: 2, no: 0 },           '属性否定（省掉）'],
  ['画个正反转，不要互锁要自锁',       { nc: 0, no: 2 },           '否定只作用前项'],
  ['画个正反转，不要自锁要互锁',       { nc: 2, no: 0 },           '否定只作用前项（镜像）'],
  ['画个正反转，互锁和自锁都不要',      { nc: 0, no: 0 },           '后置否定 + 并列'],
  ['请把互锁去掉，画个正反转',         { nc: 0 },                  '把字句宾语前置'],
  ['画个正反转，把互锁删了',           { nc: 0 },                  '删互锁后不应复活'],
  ['画个正反转，把自锁加上',           { nc: 2, no: 2 },           '加属性不应改主体'],
  ['不要互锁',                       { none: true },             '无对象时不画图'],
  ['互锁和自锁都不要',                { none: true },             '无对象时不画图（并列）'],

  /* ---- 动词否定（防回退） ---- */
  ['画个正反转别加互锁',              { nc: 0 },                  '动词否定'],
  ['画个正反转，不加自锁',            { nc: 2, no: 0 },            '动词否定（自锁）'],
  ['画个正反转，无需互锁',            { nc: 0 },                  '无需'],
  ['画个正反转，别不要互锁',           { nc: 2 },                  '双重否定 = 要'],
  ['画个正反转不能没有互锁',           { nc: 2, no: 2 },            '双重否定 = 要'],

  /* ---- 排他 / 排除语义（第 25 轮） ---- */
  ['画个正反转，只要自锁',            { nc: 0, no: 2 },           '排他「只要」'],
  ['画个正反转，只要互锁',            { nc: 2, no: 0 },           '排他「只要」（镜像）'],
  ['画个正反转，除了互锁都要',         { nc: 0, no: 2 },           '排除式「除了」'],
  ['画个正反转，除了自锁都要',         { nc: 2, no: 0 },           '排除式（镜像）'],

  /* ---- 基线：改动不能误伤普通句 ---- */
  ['画个正反转',                     { nc: 2, no: 2, comps: 8 }, '正反转基线'],
  ['画个起保停',                     { nc: 0, no: 1, comps: 4 }, '起保停基线'],
  ['画个互锁',                       { nc: 2, no: 0, comps: 6 }, '互锁基线'],
  ['画个点动',                       { nc: 0, no: 0, comps: 2 }, '点动基线'],
  ['画个正反转，主电路不要',           { nc: 2, no: 2 },           '主电路否定不伤控制回路'],
  ['清空，画个正反转，不要自锁',       { nc: 2, no: 0 },           'clear 后属性仍生效'],
  ['画个正反转带主电路',              { comps: 26 },              '主电路模板'],

  /* ---- draw_plan / wireNodes 单引脚 ---- */
  ['__SINGLE_TWO_TERMS__',           { fn: 'singleTwoTerms' },   '单引脚串联 + 双端子'],
  ['__SINGLE_NO_TERM__',             { fn: 'singleNoTerm' },     '单引脚串联无端子'],
  ['__EMPTY_NODE__',                 { fn: 'emptyNode' },        '空 pins 必须拒绝'],
  ['__BAD_PIN__',                    { fn: 'badPin' },           '不存在引脚必须拒绝'],
  ['__TWO_PLANS__',                  { fn: 'twoPlans' },         '连续两次 draw_plan 无污染'],
  ['__TEMPLATES__',                  { fn: 'templates' },        '模板全部 level=ok'],
  ['__TPL_LEGAL__',                  { fn: 'tplLegal' },         'drawTemplate 合法调用必须放行'],
  ['__TPL_ILLEGAL__',                { fn: 'tplIllegal' },       'drawTemplate 非法参数必须拒绝'],
  ['__INTERLOCK_SELF__',             { fn: 'interlockSelf' },    '互锁+自锁'],
  // 第 27 轮修好，升入必修防止回退：
  ['__MAIN_ONLY__',                  { fn: 'mainOnly' },         '只画主电路不能因缺线圈被拦'],
  ['__THERMAL_CONTACT__',            { fn: 'thermalContact' },   '热继电器触点无线圈不该报错'],
  ['__COIL_MISSING__',               { fn: 'coilMissing' },      '真漏画线圈仍须报错'],
];

const KNOWN = [
  ['画个正反转，用2个接触器',          { comps: 8 },               '量词生成多余元件（已裁定放弃）'],
  ['画个正反转，带QA1和QA2',          { nc: 2 },                  '代号导致回退模型（安全）'],
  ['__ATLAS_TERM_NAME__',            { fn: 'atlasTermName' },    '图集端子缺 name（范围外）'],
];

const PROBES = {
  singleTwoTerms() {
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1', near: 'SF1' }],
      nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }],
      terminals: [{ name: 'L', node: 'L' }, { name: 'N', node: 'N' }]
    });
    const terms = d.marks.filter(m => m.kind === 'term');
    const wiresOk = terms.every(t => d.wires.some(w =>
      w.pts.some(p => Math.abs(p[0] - t.x) < 1 && Math.abs(p[1] - t.y) < 1)));
    const onPin = terms.some(t => M.pinsOf(d).some(p => Math.hypot(p.x - t.x, p.y - t.y) < 1));
    return { ok: r.ok && terms.length === 2 && wiresOk && !onPin,
      detail: `ok=${r.ok} terms=${terms.length} 引线=${wiresOk} 压引脚=${onPin}` };
  },
  singleNoTerm() {
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1', near: 'SF1' }],
      nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }]
    });
    return { ok: r.ok && d.comps.length === 2, detail: `ok=${r.ok} comps=${d.comps.length} level=${r.level}` };
  },
  emptyNode() {
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1', near: 'SF1' }],
      nodes: [{ name: 'L', pins: [] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }]
    });
    return { ok: r.ok === false && r.rolledBack === true, detail: `ok=${r.ok} rolledBack=${r.rolledBack}` };
  },
  badPin() {
    const d = M.blank();
    const r = A.drawPlan(d, { components: [{ type: 'btnNo', key: 'SF1' }], nodes: [{ name: 'L', pins: ['SF1#0', 'SF1#9'] }] });
    return { ok: r.ok === false, detail: `ok=${r.ok} rolledBack=${r.rolledBack}` };
  },
  twoPlans() {
    const d = M.blank();
    const mk = (n) => ({
      components: [{ type: 'btnNo', key: 'SF' + n }, { type: 'coil', key: 'QA' + n, near: 'SF' + n }],
      nodes: [{ name: 'L', pins: ['SF' + n + '#0'] }, { name: 'A', pins: ['SF' + n + '#1', 'QA' + n + '#0'] },
             { name: 'N', pins: ['QA' + n + '#1'] }]
    });
    const r1 = A.drawPlan(d, mk(1)), r2 = A.drawPlan(d, mk(2));
    return { ok: r1.ok && r2.ok && d.comps.length === 4, detail: `comps=${d.comps.length}` };
  },
  templates() {
    const kinds = ['jog', 'selflock', 'interlock', 'reverse', 'remote'];
    const bad = [];
    kinds.forEach(k => {
      const d = M.blank();
      const r = A.drawTemplate(d, { kind: k });
      if (!r.ok || r.level !== 'ok') bad.push(k + '=' + (r.level || 'fail'));
    });
    const d = M.blank();
    const r = A.drawTemplate(d, { kind: 'reverse', main: true });
    if (!r.ok || r.level !== 'ok') bad.push('reverseMain=' + (r.level || 'fail'));
    return { ok: !bad.length, detail: bad.length ? bad.join(',') : '6/6 level=ok' };
  },
  tplLegal() {
    // 合法调用必须全部放行：显式 true 不能被当成"关闭"
    const cases = [
      [{ kind: 'reverse', main: true }, 'main 无参数'],
      [{ kind: 'reverse', main: true, thermal: true }, 'thermal:true'],
      [{ kind: 'reverse', main: true, fuse: true }, 'fuse:true'],
      [{ kind: 'reverse', main: true, selflock: true }, 'selflock:true'],
      [{ kind: 'reverse', main: true, interlock: true }, 'interlock:true'],
      [{ kind: 'reverse', main: false, selflock: false }, '非主电路关自锁']
    ];
    const bad = [];
    cases.forEach(([o, label]) => {
      const d = M.blank();
      const r = A.drawTemplate(d, o);
      if (!r.ok || !d.comps.length) bad.push(label);
    });
    return { ok: !bad.length, detail: bad.length ? '被误拒：' + bad.join(',') : `${cases.length}/${cases.length} 放行` };
  },
  tplIllegal() {
    // 主电路固定版，明确关掉其中元件必须被拒绝且不留残图
    const bad = [];
    [['thermal', '热继电器'], ['fuse', '熔断器'], ['selflock', '自锁'], ['interlock', '互锁']].forEach(([k]) => {
      const d = M.blank();
      const o = { kind: 'reverse', main: true }; o[k] = false;
      const r = A.drawTemplate(d, o);
      if (r.ok !== false || d.comps.length !== 0) bad.push(k);
    });
    return { ok: !bad.length, detail: bad.length ? '未拒绝：' + bad.join(',') : '4/4 拒绝且无残图' };
  },
  interlockSelf() {
    const d = M.blank();
    const r = A.drawTemplate(d, { kind: 'interlock', selflock: true });
    const no = d.comps.filter(c => c.type === 'no').length;
    return { ok: r.ok && r.level === 'ok' && no === 2,
      detail: `level=${r.level} comps=${d.comps.length} no=${no}` };
  },
  atlasTermName() {
    const d = M.blank();
    A.drawTemplate(d, { kind: 'remote' });
    const terms = d.marks.filter(m => m.kind === 'term');
    const named = terms.filter(x => x.name).length;
    return { ok: terms.length > 0 && named === terms.length, detail: `${terms.length} 个端子，带 name ${named}` };
  },
  mainOnly() {
    // 只画主电路：接触器主触点在图，线圈在控制回路、不在同一张图上。
    // 这是星三角/正反转主电路的常态。advisor 若把"图上没有同代号线圈"
    // 当成 error，这个合理需求就永远画不出来。
    // 注意元件必须分列，否则会先被同列短路挡住，测不到线圈这条规则。
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [
        { type: 'contactor3', key: 'QA1', branch: 1 },
        { type: 'motor', key: 'M1', branch: 3 }
      ],
      nodes: [
        { name: 'L1', pins: ['contactor3:QA1#0'] },
        { name: 'M', pins: ['contactor3:QA1#1', 'motor:M1#0'] }
      ]
    });
    const errs = (r.issues || []).filter(x => x.level === 'error');
    return {
      ok: r.ok && r.level !== 'error' && d.comps.length === 2,
      detail: `ok=${r.ok} level=${r.level} comps=${d.comps.length} ` +
        (errs.length ? 'error: ' + errs[0].msg.slice(0, 34) : String(r.error || '').slice(0, 34))
    };
  },
  thermalContact() {
    // 热继电器触点不需要同名线圈（它由双金属片驱动，不是电磁铁）。
    // 注意必须同时放 thermal 本体和 nc:FR1 触点 —— 只放本体测不到这条规则，
    // 第一版探针就是这么漏掉 B06 根因的。
    const d = M.blank();
    A.place(d, 'btnNo', { key: 'SF1' });
    A.place(d, 'thermal', { key: 'FR1' });
    A.place(d, 'nc', { key: 'FR1' });
    A.place(d, 'coil', { key: 'QA1', near: 'SF1' });
    A.wireNodes(d, [
      { name: 'L', pins: ['SF1#0'] },
      { name: 'A', pins: ['SF1#1', 'nc:FR1#0'] },
      { name: 'B', pins: ['nc:FR1#1', 'coil:QA1#0'] },
      { name: 'N', pins: ['coil:QA1#1'] }
    ]);
    const an = A.analyze(d);
    const errs = an.issues.filter(x => x.level === 'error');
    const keyless = errs.some(x => /FR1/.test(x.msg) && /线圈/.test(x.msg));
    return {
      ok: errs.length === 0,
      detail: `level=${an.level} error=${errs.length}${keyless ? ' ← FR1 被误判缺线圈' : ''}`
    };
  },
  coilMissing() {
    // 反向保护：放宽「主电路免检线圈」之后，真漏画线圈不能跟着被放过。
    // 图里既有线圈又有主元件时，某触点代号找不到线圈仍必须报 error。
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [
        { type: 'btnNo', key: 'SF1', branch: 1 },
        { type: 'nc', key: 'QA9', branch: 2 },
        { type: 'coil', key: 'QA1', branch: 3 },
        { type: 'motor', key: 'M1', branch: 5 }
      ],
      nodes: [
        { name: 'L', pins: ['SF1#0'] },
        { name: 'A', pins: ['SF1#1', 'nc:QA9#0'] },
        { name: 'B', pins: ['nc:QA9#1', 'coil:QA1#0'] },
        { name: 'N', pins: ['coil:QA1#1'] }
      ]
    });
    const errs = (r.issues || []).filter(x => x.level === 'error');
    const hit = errs.some(x => /QA9/.test(x.msg));
    return { ok: hit, detail: `level=${r.level} error=${errs.length}${hit ? ' 命中 QA9' : ' 没拦住'}` };
  }
};

function evalRoute(q, exp) {
  const d = M.blank();
  let res;
  try { res = C.interpretV2(q, d); } catch (e) { return { ok: false, detail: 'EXCEPTION ' + e.message }; }
  const cnt = t => d.comps.filter(c => c.type === t).length;
  const nc = cnt('nc'), no = cnt('no'), comps = d.comps.length;

  if (exp.none) return { ok: comps === 0, detail: `comps=${comps}（应留空）` };
  if (res === null) return { ok: !!exp.model, detail: '回退模型', model: true };
  const bads = [];
  if (exp.nc != null && nc !== exp.nc) bads.push(`nc=${nc}≠${exp.nc}`);
  if (exp.no != null && no !== exp.no) bads.push(`no=${no}≠${exp.no}`);
  if (exp.comps != null && comps !== exp.comps) bads.push(`comps=${comps}≠${exp.comps}`);
  if (/画好了/.test(res.reply) && /好的，不动/.test(res.reply)) bads.push('回复自相矛盾');
  return { ok: !bads.length, detail: `nc=${nc} no=${no} comps=${comps}` + (bads.length ? ' ✗ ' + bads.join(',') : '') };
}

function run(list) {
  let pass = 0, fail = 0, model = 0;
  const failed = [];
  for (const [q, exp, why] of list) {
    let r;
    if (exp.fn) {
      try { r = PROBES[exp.fn](); } catch (e) { r = { ok: false, detail: 'EXCEPTION ' + e.message }; }
    } else {
      r = evalRoute(q, exp);
    }
    const label = q.startsWith('__') ? q.replace(/__/g, '') : q;
    if (r.model) model++; else if (r.ok) pass++; else { fail++; failed.push(label + ' → ' + r.detail); }
    console.log((r.ok ? '✓' : '✗'), label.padEnd(24), '|', r.detail, '|', why);
  }
  return { pass, fail, model, failed };
}

console.log('=== BLOCKING（必修，任何失败即 CONTINUE）===');
const b = run(BLOCKING);
console.log(`\n必修：通过 ${b.pass} / 失败 ${b.fail} / 回退模型 ${b.model}  共 ${BLOCKING.length}`);

console.log('\n=== KNOWN（已知边角，不阻塞）===');
const k = run(KNOWN);
console.log(`\n已知：通过 ${k.pass} / 待修 ${k.fail}  共 ${KNOWN.length}`);

console.log('\n' + '='.repeat(56));
if (b.fail === 0) {
  console.log('BLOCKING 全绿 —— 可以讨论 VERDICT: STOP');
} else {
  console.log('BLOCKING 有 ' + b.fail + ' 条失败 —— VERDICT: CONTINUE');
  b.failed.forEach(x => console.log('  · ' + x));
}
console.log('='.repeat(56));
process.exitCode = b.fail === 0 ? 0 : 1;
