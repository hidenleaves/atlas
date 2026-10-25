#!/usr/bin/env node
/* ============================================================
   relayout-test.js — 回归：B04 布局两次重排
   ------------------------------------------------------------
   第 32 轮 P1：
     · 第一次重排按“串联链分列”；第二次必须换强策略（两行错半列 + 每节点母线），
       不能又退回按列分配（在已有元件的画布上，旧代码第二次重排仍然短路）；
     · 两次都失败时，必须告诉模型是哪两个节点被并到同一根线，
       并给出“换 branch”的可执行建议。
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

var failures = 0;
var total = 0;
function assert(cond, msg) {
  total++;
  if (cond) { console.log('✓ ' + msg); }
  else { failures++; console.log('✗ ' + msg); }
}

/* 两个带自锁的起保停支路，全部塞在 branch 1 —— 模型常见的“全给第一列”写法。
   第一次布局必短路，靠重排救。 */
function twoBranchPlan() {
  var comps = [
    { type: 'fuse', key: 'FA1' },
    { type: 'btnNo', key: 'SF1' },
    { type: 'btnNc', key: 'SF2' },
    { type: 'coil', key: 'QA1' },
    { type: 'no', key: 'QA1' },
    { type: 'btnNo', key: 'SF3' },
    { type: 'btnNc', key: 'SF4' },
    { type: 'coil', key: 'QA2' },
    { type: 'no', key: 'QA2' }
  ];
  var nodes = [
    { name: 'L', pins: ['FA1#0', 'no:QA1#0', 'no:QA2#0'] },
    { name: 'A', pins: ['FA1#1', 'SF1#0', 'SF3#0'] },
    { name: 'B', pins: ['SF1#1', 'no:QA1#1', 'SF2#0'] },
    { name: 'C', pins: ['SF2#1', 'coil:QA1#0'] },
    { name: 'D', pins: ['SF3#1', 'no:QA2#1', 'SF4#0'] },
    { name: 'E', pins: ['SF4#1', 'coil:QA2#0'] },
    { name: 'N', pins: ['coil:QA1#1', 'coil:QA2#1'] }
  ];
  comps.forEach(function (c) { c.branch = 1; });
  return { components: comps, nodes: nodes };
}

function newDoc(hasOld) {
  var d = M.blank(760, 500);
  if (hasOld) A.place(d, 'lamp', { key: 'HL0', x: 660, y: 60 });
  return d;
}

function main() {
  /* ---------- 1. 空画布：第一次短路，第二次重排救回来 ---------- */
  var d = newDoc(false);
  var r = A.drawPlan(d, twoBranchPlan());
  assert(r.ok === true, '空画布：重排后出图成功（实际 ' + r.ok + '，' + (r.error || '') + '）');
  assert(r.relayout === 2, '空画布：用到了第 2 次重排（实际 ' + r.relayout + '）');
  assert(r.relayoutFrom === 'short', '空画布：重排原因是短路（实际 ' + r.relayoutFrom + '）');
  assert(r.level !== 'error', '空画布：最终电气等级 ' + r.level);
  assert(d.comps.length === 9, '空画布：9 个元件都在（实际 ' + d.comps.length + '）');
  assert(r.wiring === '全部连通', '空画布：节点全部连通（实际 ' + r.wiring + '）');

  /* ---------- 1b. 元件叠在同一坐标：第一次重排就该救回来 ---------- */
  d = M.blank(760, 500);
  r = A.drawPlan(d, {
    components: [
      { type: 'btnNo', key: 'SF1', x: 200, y: 100 },
      { type: 'btnNc', key: 'SF2', x: 200, y: 100 },
      { type: 'coil', key: 'QA1', x: 200, y: 250 }
    ],
    nodes: [
      { name: 'L', pins: ['SF1#0', 'SF2#0'] },
      { name: 'A', pins: ['SF1#1', 'coil:QA1#0'] },
      { name: 'B', pins: ['SF2#1', 'coil:QA1#1'] }
    ]
  });
  assert(r.ok === true, '重叠元件：重排后出图成功（实际 ' + r.ok + '，' + (r.error || '') + '）');
  assert(r.relayout === 1, '重叠元件：第 1 次重排就够（实际 ' + r.relayout + '）');
  assert(r.relayoutFrom === 'short', '重叠元件：重排原因是短路（实际 ' + r.relayoutFrom + '）');
  assert(r.level !== 'error', '重叠元件：最终电气等级 ' + r.level);
  assert(d.comps.length === 3, '重叠元件：3 个元件都在（实际 ' + d.comps.length + '）');

  /* ---------- 2. 已有元件的画布：第二次重排必须是“两行网格”，不能退回按列 ---------- */
  d = newDoc(true);
  r = A.drawPlan(d, twoBranchPlan());
  assert(r.ok === true, '非空画布：重排后出图成功（实际 ' + r.ok + '，' + (r.error || '') + '）');
  assert(r.relayout === 2, '非空画布：用到了第 2 次重排（实际 ' + r.relayout + '）');
  assert(d.comps.length === 10, '非空画布：原有灯 + 9 个新元件 = 10（实际 ' + d.comps.length + '）');
  assert(d.comps.some(function (c) { return c.key === 'HL0'; }), '非空画布：原有 HL0 没被冲掉');

  var newYs = {};
  d.comps.forEach(function (c) {
    if (c.key !== 'HL0') newYs[c.y] = 1;
  });
  var ys = Object.keys(newYs).map(Number).sort(function (a, b) { return a - b; });
  assert(ys.length === 2 && ys[0] === 240 && ys[1] === 400,
    '非空画布：第二次重排用的是两行网格 y=240/400（实际 ' + JSON.stringify(ys) + '）');
  assert(d.comps.every(function (c) { return c.x >= 0 && c.x <= d.w; }),
    '非空画布：所有元件仍在画布横向范围内');
  assert(r.level !== 'error', '非空画布：最终电气等级 ' + r.level);

  /* ---------- 3. 两个节点写了同一个引脚：报出节点对 + 同引脚，而不是只说“失败” ---------- */
  d = M.blank(760, 500);
  r = A.drawPlan(d, {
    components: [
      { type: 'btnNo', key: 'SF1', branch: 1 },
      { type: 'coil', key: 'QA1', branch: 2 },
      { type: 'lamp', key: 'HL1', branch: 3 }
    ],
    nodes: [
      { name: 'A', pins: ['SF1#0', 'QA1#0'] },
      { name: 'B', pins: ['SF1#0', 'HL1#0'] },
      { name: 'N', pins: ['QA1#1', 'HL1#1'] }
    ]
  });
  assert(r.ok === false, '重复引脚：出图失败');
  assert(!r.rolledBack, '重复引脚：在放置前就拦下，画布没有被改动');
  assert(r.collision && r.collision.a === 'A' && r.collision.b === 'B',
    '重复引脚：collision 点名 A 与 B（实际 ' + JSON.stringify(r.collision) + '）');
  assert(r.collision && r.collision.sharedPin === 'SF1#0',
    '重复引脚：指出具体引脚 SF1#0（实际 ' +
      (r.collision && r.collision.sharedPin) + '）');
  assert(/同一个引脚 SF1#0/.test(r.error || '') && /删掉/.test(r.error || ''),
    '重复引脚：错误文本给出可执行建议（实际 ' + r.error + '）');
  assert(d.comps.length === 0, '重复引脚：画布恢复为空');

  /* ---------- 3b. 同列两脚之间夹着别的引脚：走线必须绕开 ---------- */
  d = M.blank(760, 500);
  A.place(d, 'btnNo', { key: 'SF1', x: 280, y: 130 });
  A.place(d, 'no', { key: 'QA1', x: 280, y: 260 });
  var cr = A.connect(d, 'SF1#0', 'no:QA1#0');
  assert(cr.ok, '绕线：connect 成功（实际 ' + JSON.stringify(cr) + '）');
  var w1 = d.wires[d.wires.length - 1];
  assert(w1.pts.length >= 4, '绕线：没有直接竖穿 SF1#1，走了侧向引出（点数 ' +
    w1.pts.length + '）');
  var an1 = A.analyze(d);
  assert(!an1.issues.some(function (i) { return i.code === 'short'; }),
    '绕线：没有短路（实际 ' + JSON.stringify(an1.issues) + '）');
  var nb1 = global.PLCAdvisor.buildNets(d);
  function netAt(px, py) {
    return nb1.net.find((Math.round(px * 2) / 2) + ',' + (Math.round(py * 2) / 2));
  }
  assert(netAt(280, 130) !== netAt(280, 170), '绕线：SF1 上脚和下脚没有并到一起');

  /* ---------- 3c. 第二条线不能和已有线共线重叠 ---------- */
  var cr2 = A.connect(d, 'SF1#1', 'no:QA1#1');
  assert(cr2.ok, '避重叠：第二条 connect 成功（实际 ' + JSON.stringify(cr2) + '）');
  var w2 = d.wires[d.wires.length - 1];
  var lane1 = w1.pts.map(function (p) { return p[0]; }).filter(function (x) { return x !== 280; });
  var lane2 = w2.pts.map(function (p) { return p[0]; }).filter(function (x) { return x !== 280; });
  assert(w2.pts.length >= 4, '避重叠：第二条线也绕开了中间的引脚（点数 ' + w2.pts.length + '）');
  assert(lane2.every(function (x) { return lane1.indexOf(x) < 0; }),
    '避重叠：两条线没有共用同一条竖直通道（' + JSON.stringify([lane1, lane2]) + '）');
  var an2 = A.analyze(d);
  assert(!an2.issues.some(function (i) { return i.code === 'short'; }),
    '避重叠：两条线仍然属于不同网络（实际 ' + JSON.stringify(an2.issues) + '）');

  /* ---------- 4. collision 真的被送进模型看到的工具结果 ---------- */
  var queue = [];
  var requests = [];
  function sseOf(chunks) {
    return chunks.map(function (j) { return 'data: ' + JSON.stringify(j) + '\n'; }).join('') +
      'data: [DONE]\n';
  }
  function toolSse(name, args) {
    return sseOf([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: {
        name: name, arguments: JSON.stringify(args)
      } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ]);
  }
  function textSse(t) {
    return sseOf([
      { choices: [{ delta: { content: t } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ]);
  }
  global.fetch = function (url, init) {
    requests.push(JSON.parse(init.body));
    var s = queue.shift();
    if (!s) return Promise.reject(new Error('假 fetch 没有剩余响应'));
    return Promise.resolve({
      ok: true, body: null, text: function () { return Promise.resolve(s); }
    });
  };
  C.resetConversation();
  queue = [
    toolSse('draw_plan', {
      components: [
        { type: 'btnNo', key: 'SF1', branch: 1 },
        { type: 'coil', key: 'QA1', branch: 2 },
        { type: 'lamp', key: 'HL1', branch: 3 }
      ],
      nodes: [
        { name: 'A', pins: ['SF1#0', 'QA1#0'] },
        { name: 'B', pins: ['SF1#0', 'HL1#0'] },
        { name: 'N', pins: ['QA1#1', 'HL1#1'] }
      ]
    }),
    textSse('这两个节点写重了，我改一下。')
  ];
  return C.callModel('画个带灯的控制回路', M.blank(760, 500), null).then(function () {
    var toolMsg = null;
    (requests[1].messages || []).forEach(function (m) {
      if (m.role === 'tool') toolMsg = m.content;
    });
    assert(!!toolMsg, '模型第二轮能看到工具结果');
    var seen = null;
    try { seen = JSON.parse(toolMsg); } catch (e) {}
    assert(seen && seen.ok === false, '工具结果里 ok=false');
    assert(seen && seen.collision && seen.collision.a === 'A' && seen.collision.b === 'B',
      '工具结果里带 collision A/B（实际 ' + (toolMsg || '').slice(0, 160) + '）');
    assert(seen && seen.collision && seen.collision.sharedPin === 'SF1#0',
      '工具结果里带 sharedPin（实际 ' + JSON.stringify(seen && seen.collision) + '）');
  });
}

Promise.resolve().then(main).then(function () {
  console.log('');
  console.log(failures ? '失败 ' + failures + ' / ' + total
    : '通过 ' + total + ' / ' + total);
  process.exit(failures ? 1 : 0);
}).catch(function (e) {
  console.log('✗ 测试异常：' + (e && e.stack || e));
  process.exit(1);
});
