#!/usr/bin/env node
/* ============================================================
   finished-test.js — 回归：出图之后还能不能“补一个指示灯”
   ------------------------------------------------------------
   第 32 轮 P0：draw_plan / draw_template 成功后原来把工具整体断掉，
   导致“启动停止 + 运行指示灯”这种复合指令的第二段被吞掉，图里没有灯。
   现在的语义：
     · 覆盖/删除类（draw_plan、draw_template、remove、clear_drawing）→ 禁止
     · 纯追加类（place_component、add_lead、connect、wire_nodes）→ 最多 3 次
     · 追加把图搞成电气错误 → 只回滚这一次追加，主图保留
   全部用假 fetch 驱动真实 callModel，不联网。
   ============================================================ */
'use strict';

global.window = global;
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

global.localStorage = {
  _v: {},
  getItem: function (k) { return this._v[k] == null ? null : this._v[k]; },
  setItem: function (k, v) { this._v[k] = String(v); }
};
C.saveCfg({
  endpoint: 'http://fake.local/v1/chat/completions',
  apiKey: 'sk-test',
  model: 'fake'
});

var queue = [];
var requests = [];

function sseOf(chunks) {
  return chunks.map(function (j) { return 'data: ' + JSON.stringify(j) + '\n'; }).join('') +
    'data: [DONE]\n';
}

function toolSse(calls) {
  var deltas = calls.map(function (c, i) {
    return {
      choices: [{
        delta: {
          tool_calls: [{
            index: i,
            id: c.id || ('call_' + i),
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
          }]
        }
      }]
    };
  });
  deltas.push({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  });
  return sseOf(deltas);
}

function textSse(text) {
  return sseOf([
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ]);
}

global.fetch = function (url, init) {
  requests.push(JSON.parse(init.body));
  var s = queue.shift();
  if (!s) return Promise.reject(new Error('假 fetch 没有剩余响应'));
  return Promise.resolve({
    ok: true,
    body: null,
    text: function () { return Promise.resolve(s); }
  });
};

function reset(items) {
  queue = items.slice();
  requests = [];
  C.resetConversation();
}

function keys(doc) { return doc.comps.map(function (c) { return c.key; }); }
function types(doc) { return doc.comps.map(function (c) { return c.type; }); }

var failures = 0;
var total = 0;
function assert(cond, msg) {
  total++;
  if (cond) { console.log('✓ ' + msg); }
  else { failures++; console.log('✗ ' + msg); }
}

function toolNames(req) {
  return (req.tools || []).map(function (t) { return t.function.name; });
}

async function main() {
  /* ---------- 0. 策略函数本身 ---------- */
  assert(C.afterFinishDecision('draw_plan', 0).allowed === false, '出图后 draw_plan 被禁止');
  assert(C.afterFinishDecision('draw_template', 0).allowed === false, '出图后 draw_template 被禁止');
  assert(C.afterFinishDecision('remove', 0).allowed === false, '出图后 remove 被禁止');
  assert(C.afterFinishDecision('clear_drawing', 0).allowed === false, '出图后 clear_drawing 被禁止');
  assert(C.afterFinishDecision('place_component', 0).allowed === true, '出图后 place_component 允许');
  assert(C.afterFinishDecision('add_lead', 0).allowed === true, '出图后 add_lead 允许');
  assert(C.afterFinishDecision('connect', 0).allowed === true, '出图后 connect 允许');
  assert(C.afterFinishDecision('place_component', 3).allowed === false, '第 4 次追加被上限挡住');
  assert(C.afterFinishDecision('check', 3).allowed === true, 'check 不占追加额度');

  /* ---------- 1. B02：出图后同一轮补两个附加元件 ---------- */
  reset([
    toolSse([{ name: 'draw_template', args: { kind: 'selflock' } }]),
    toolSse([{ name: 'place_component', args: { type: 'lamp', key: 'HL1', branch: 3 } }]),
    toolSse([{ name: 'add_lead', args: { ref: 'HL1', pin: 0, dir: 'up', length: 40 } }]),
    toolSse([{ name: 'place_component', args: { type: 'bell', key: 'HA1', branch: 4 } }]),
    toolSse([{ name: 'place_component', args: { type: 'lamp', key: 'HL2', branch: 5 } }]),
    textSse('起保停加运行指示灯，好了。')
  ]);
  var doc = M.blank(760, 500);
  var res = await C.callModel('电机正转 + 启动停止 + 运行指示灯', doc, null);

  assert(doc.comps.length >= 5, 'B02 形状：出图后追加到 ' + doc.comps.length + ' 个元件（≥5）');
  assert(types(doc).indexOf('lamp') >= 0, 'B02 形状：图里有 lamp');
  assert(keys(doc).indexOf('HL1') >= 0, '追加的信号灯 HL1 落到画布上了');
  assert(keys(doc).indexOf('HA1') >= 0, '追加的电铃 HA1 落到画布上了');
  assert(keys(doc).indexOf('HL2') < 0, '第 4 次追加（HL2）被上限挡住，没有落盘');
  assert(res && res.changed === true, '本轮 changed=true');
  assert(requests.length === 6, '共 6 次请求（1 次出图 + 3 次追加 + 2 次被挡也算一轮），实际 ' +
    requests.length);

  var firstNames = toolNames(requests[0]);
  var laterNames = toolNames(requests[1]);
  assert(firstNames.indexOf('draw_plan') >= 0 && firstNames.indexOf('remove') >= 0,
    '出图前的工具表仍含 draw_plan / remove（对照）');
  assert(laterNames.indexOf('draw_plan') < 0 &&
    laterNames.indexOf('draw_template') < 0 &&
    laterNames.indexOf('remove') < 0 &&
    laterNames.indexOf('clear_drawing') < 0,
    '出图后工具表去掉 draw_plan / draw_template / remove / clear_drawing');
  assert(laterNames.indexOf('place_component') >= 0 &&
    laterNames.indexOf('wire_nodes') >= 0 &&
    laterNames.indexOf('add_lead') >= 0,
    '出图后工具表仍保留 place_component / wire_nodes / add_lead');

  /* ---------- 2. E01：起保停 + 运行指示灯；出图后 remove 被挡 ---------- */
  reset([
    toolSse([{ name: 'draw_template', args: { kind: 'selflock' } }]),
    toolSse([{ name: 'place_component', args: { type: 'lamp', key: 'HL1', branch: 3 } }]),
    toolSse([{ name: 'remove', args: { ref: 'QA1' } }]),
    textSse('运行指示灯加好了。')
  ]);
  doc = M.blank(760, 500);
  res = await C.callModel('起保停 + 运行指示灯', doc, null);
  var beforeRemove = 5;
  assert(doc.comps.length === beforeRemove,
    'E01：4 个模板元件 + 1 个指示灯 = ' + doc.comps.length + '（期望 5）');
  assert(types(doc).indexOf('lamp') >= 0, 'E01：图里有 lamp');
  assert(keys(doc).indexOf('QA1') >= 0 && types(doc).indexOf('coil') >= 0,
    '出图后的 remove(QA1) 被挡住，线圈还在');
  assert(res && res.reply === '运行指示灯加好了。', '最终回复保留模型原话');

  var nudgeSeen = (requests[1].messages || []).some(function (m) {
    return m.role === 'system' && /图上还没有/.test(m.content) && /指示灯/.test(m.content);
  });
  assert(nudgeSeen, '出图后发现用户要的指示灯不在图上，会给模型一次追加提醒');

  /* ---------- 2b. 用户说了“不要指示灯”时不能误提醒 ---------- */
  assert(C.missingExtras('画个起保停，加个运行指示灯', M.blank(760, 500)).length === 1,
    'missingExtras：要指示灯且图上没有 → 1 条');
  assert(C.missingExtras('画个起保停，不要指示灯', M.blank(760, 500)).length === 0,
    'missingExtras：明确不要指示灯 → 0 条');
  assert(C.missingExtras('画个起保停，加个电铃', M.blank(760, 500))[0].type === 'bell',
    'missingExtras：要电铃 → 识别为 bell');

  reset([
    toolSse([{ name: 'draw_template', args: { kind: 'selflock' } }]),
    textSse('起保停画好了。')
  ]);
  doc = M.blank(760, 500);
  await C.callModel('画个起保停，不要指示灯', doc, null);
  var badNudge = (requests[1].messages || []).some(function (m) {
    return m.role === 'system' && /图上还没有/.test(m.content);
  });
  assert(!badNudge, '明确不要指示灯时，出图后不会误发追加提醒');

  /* ---------- 3. 追加把图搞成电气错误：只回滚这一次追加 ---------- */
  var realAnalyze = A.analyze;
  A.analyze = function (d) {
    if (d.comps.some(function (c) { return c.key === 'HL9'; })) {
      return {
        level: 'error',
        issues: [{ level: 'error', msg: '测试：追加导致短路', code: 'short' }]
      };
    }
    return realAnalyze(d);
  };
  reset([
    toolSse([{ name: 'draw_template', args: { kind: 'selflock' } }]),
    toolSse([{ name: 'place_component', args: { type: 'lamp', key: 'HL9', branch: 3 } }]),
    textSse('指示灯可能有冲突。')
  ]);
  doc = M.blank(760, 500);
  res = await C.callModel('起保停 + 运行指示灯', doc, null);
  A.analyze = realAnalyze;

  assert(keys(doc).indexOf('HL9') < 0, '出差错的追加 HL9 被回滚');
  assert(doc.comps.length === 4, '主图 4 个元件原样保留（期望 4），实际 ' + doc.comps.length);
  assert(keys(doc).indexOf('SF1') >= 0 && keys(doc).indexOf('QA1') >= 0,
    '主图的 SF1 / QA1 没有被回滚掉');
  assert(res && res.changed === true, '回滚的是追加，不是整张图，本轮仍算改动');

  /* ---------- 4. 失败时不再整图回滚（确认没有回到旧行为） ---------- */
  reset([
    toolSse([{ name: 'draw_plan', args: { components: [], nodes: [] } }]),
    textSse('没画出来。')
  ]);
  doc = M.blank(760, 500);
  res = await C.callModel('画个空图', doc, null);
  assert(doc.comps.length === 0, '空 plan 失败后画布仍为空（未误放元件）');
  assert(res && res.changed === false, '没有任何工具成功 → changed=false');

  console.log('');
  console.log(failures ? '失败 ' + failures + ' / ' + total
    : '通过 ' + total + ' / ' + total);
  process.exit(failures ? 1 : 0);
}

main().catch(function (e) {
  console.log('✗ 测试异常：' + (e && e.stack || e));
  process.exit(1);
});
