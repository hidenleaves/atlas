#!/usr/bin/env node
/* ============================================================
   api-test.js — 路由 v2 / 模板 / removeInterlock 的 Node 回归
   ------------------------------------------------------------
   用 window shim 加载 editor-model / advisor / api / chat，
   不碰 DOM，验证：
     · buildReverse 的互锁、自锁开关
     · removeInterlock 删除 + 旁路
     · interpretV2 的端到端执行
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

let pass = 0, fail = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('✓ ' + name);
  } catch (e) {
    fail++;
    console.log('✗ ' + name);
    console.log('  ' + (e && e.message || e));
  }
}

function makeReverse(lock, self) {
  const doc = M.blank(760, 500);
  C.buildReverse(doc, { interlock: lock, selflock: self });
  return doc;
}

// 星三角里同一个 QA3 会有多个常闭/常开触点，按 type+key 重复放置
function makeDup() {
  const doc = M.blank(760, 500);
  A.place(doc, 'btnNo', { key: 'SF1', branch: 1 });
  A.place(doc, 'nc', { key: 'QA3', branch: 1 });
  A.place(doc, 'nc', { key: 'QA3', branch: 3 });
  A.place(doc, 'coil', { key: 'QA2', branch: 1 });
  return doc;
}

function coilLoose(doc) {
  return A.analyze(doc).issues.filter(function (it) {
    return /QA[12]/.test(it.msg) && /悬空|只接了一端|还没接线/.test(it.msg);
  });
}

function sameNet(doc, refA, refB) {
  const a = A.pins(doc, refA), b = A.pins(doc, refB);
  if (!a.ok || !b.ok) return false;
  const pa = a.pins[+refA.split('#')[1]], pb = b.pins[+refB.split('#')[1]];
  const nb = PLCAdvisor.buildNets(doc);
  const key = function (p) { return (Math.round(p.x * 2) / 2) + ',' + (Math.round(p.y * 2) / 2); };
  return nb.net.find(key(pa)) === nb.net.find(key(pb));
}

check('正反转默认：2 个互锁 nc、2 个自锁 no', function () {
  const doc = makeReverse(true, true);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, 'nc 数量');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, 'no 数量');
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, 'coil 数量');
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.level === 'error'; }), JSON.stringify(an.issues));
  assert(!coilLoose(doc).length, JSON.stringify(coilLoose(doc)));
});

check('正反转不带互锁：0 个 nc，线圈仍接两端', function () {
  const doc = makeReverse(false, true);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, 'nc 应被省略');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁应保留');
  assert(!coilLoose(doc).length, JSON.stringify(coilLoose(doc)));
});

check('正反转不带自锁：0 个 no，支路仍通', function () {
  const doc = makeReverse(true, false);
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, 'no 应被省略');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁应保留');
  assert(!coilLoose(doc).length, JSON.stringify(coilLoose(doc)));
});

check('去除互锁：删 2 个 nc，旁路接通两支路', function () {
  const doc = makeReverse(true, true);
  const before = doc.wires.length;
  const r = A.removeInterlock(doc);
  assert(r.ok, r.error);
  assert(r.removed.length === 2, JSON.stringify(r));
  assert(r.bypassed >= 2, 'bypassed=' + r.bypassed);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, 'nc 未删净');
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '线圈被误删');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁被误删');
  assert(doc.wires.length < before, '导线未减少');
  assert(!coilLoose(doc).length, JSON.stringify(coilLoose(doc)));
  // 关键：按钮、自锁、线圈必须重新回到同一个网，不能只通路一半
  assert(sameNet(doc, 'SF1#1', 'coil:QA1#0'), '正转按钮未接回线圈');
  assert(sameNet(doc, 'no:QA1#1', 'coil:QA1#0'), '正转自锁未接回线圈');
  assert(sameNet(doc, 'SF2#1', 'coil:QA2#0'), '反转按钮未接回线圈');
  assert(sameNet(doc, 'no:QA2#1', 'coil:QA2#0'), '反转自锁未接回线圈');
});

check('没有互锁时再去除：明确报错，不动其他元件', function () {
  const doc = makeReverse(false, true);
  const before = doc.comps.length;
  const r = A.removeInterlock(doc);
  assert(r.ok === false && /没找到/.test(r.error), JSON.stringify(r));
  assert(doc.comps.length === before, '不应改动画布');
});

check('interpretV2：画一个互锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画一个互锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '线圈数量');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁数量');
  assert(!coilLoose(doc).length, JSON.stringify(coilLoose(doc)));
});

check('interpretV2：正反转不带互锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('正反转不带互锁', doc);
  assert(r && /没有串互锁/.test(r.reply), JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, 'nc 应被省略');
});

check('interpretV2：去除互锁', function () {
  const doc = makeReverse(true, true);
  const r = C.interpretV2('去除互锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, 'nc 未删净');
});

check('interpretV2：别把互锁删了（否定操作）', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = C.interpretV2('别把互锁删了', doc);
  assert(r && r.changed === false, JSON.stringify(r));
  assert(doc.comps.length === before, '不应改动画布');
});

check('interpretV2：正反转带主电路、熔断器、热继电器、自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('正反转带主电路、熔断器、热继电器、自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'motor'; }), '缺电机');
  assert(doc.comps.some(function (c) { return c.type === 'thermal'; }), '缺热继电器');
  assert(doc.comps.some(function (c) { return c.type === 'fuse'; }), '缺熔断器');
  assert(doc.comps.length >= 20, '元件数 ' + doc.comps.length);
});

check('interpretV2：没有互锁时，去除互锁 + 画正反转仍继续', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('把互锁去掉，再画个正反转', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '应画出正反转');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应画');
  assert(!/好的，不动/.test(r.reply), '不应输出好的不动');
});

check('interpretV2：清空 + 画一个互锁', function () {
  const doc = makeReverse(true, true);
  const r = C.interpretV2('清空，画一个互锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '应重画互锁');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '互锁模板不该有自锁');
});

check('interpretV2：加一个正反转交给模型，不清空', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = C.interpretV2('加一个正反转', doc);
  assert(r === null, '应返回 null 交给模型');
  assert(doc.comps.length === before, '不应清空或改动');
});

check('interpretV2：空画布加自锁给明确提示', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('加个自锁', doc);
  assert(r && /还没有线圈/.test(r.reply), JSON.stringify(r));
  assert(r.changed === false, '不应改动');
});

check('interpretV2：画个正反转，不要自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，不要自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '线圈数量');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁应保留');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '不应有自锁');
  assert(/没有加自锁/.test(r.reply), r.reply);
});

check('interpretV2：画个正反转，主电路要', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，主电路要', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'motor'; }), '缺电机');
  assert(doc.comps.some(function (c) { return c.type === 'thermal'; }), '缺热继电器');
  assert(doc.comps.length >= 20, '元件数 ' + doc.comps.length);
});

check('interpretV2：主电路不带热继电器交给模型', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画一个正反转带主电路不带热继电器', doc);
  assert(r === null, '应交给模型');
  assert(doc.comps.length === 0, '不应先改画布');
});

check('interpretV2：主电路要，画个正反转', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('主电路要，画个正反转', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'motor'; }), '缺电机');
  assert(doc.comps.length >= 20, '元件数 ' + doc.comps.length);
});

check('interpretV2：不要自锁，画个正反转', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('不要自锁，画个正反转', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '不应有自锁');
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '线圈数量');
});

check('interpretV2：主电路不带热继电器（前置）交给模型', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('主电路不带热继电器，画个正反转带主电路', doc);
  assert(r === null, '应交给模型');
  assert(doc.comps.length === 0, '不应先改画布');
});

check('interpretV2：动词否定——别加互锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，别加互锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应画');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁应保留');
  assert(!/好的，不动/.test(r.reply), '不应输出好的不动');
});

check('interpretV2：动词否定——不加自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，不加自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁应保留');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '自锁不应画');
  assert(!/好的，不动/.test(r.reply), '不应输出好的不动');
});

check('interpretV2：省掉自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，省掉自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁应保留');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '自锁不应画');
});

check('interpretV2：不要互锁要自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，不要互锁要自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应画');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁应保留');
});

check('interpretV2：不要互锁，要自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，不要互锁，要自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应画');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁应保留');
});

check('interpretV2：互锁和自锁都不要', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，互锁和自锁都不要', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 4, '应只剩两个按钮和两个线圈');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应画');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '自锁不应画');
});

check('interpretV2：自锁和互锁都别加', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，自锁和互锁都别加', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应画');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '自锁不应画');
});

check('interpretV2：请把互锁去掉，画个正反转', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('请把互锁去掉，画个正反转', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 6, '应画无互锁正反转');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁不应复活');
  assert(!/好的，不动/.test(r.reply), '不应输出好的不动');
  assert(!/没找到互锁触点/.test(r.reply), '不应先执行一次空的 remove');
});

check('interpretV2：把互锁去掉，画个正反转带主电路交给模型', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('把互锁去掉，画个正反转带主电路', doc);
  assert(r === null, '固定主电路模板不能去互锁，应交给模型');
  assert(doc.comps.length === 0, '不应先改画布');
});

check('interpretV2：去掉自锁交给模型', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，去掉自锁', doc);
  assert(r === null, '应交给模型');
  assert(doc.comps.length === 0, '不应先改画布');
});

check('interpretV2：别画熔断器（主电路固定）交给模型', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转带主电路，别画熔断器', doc);
  assert(r === null, '应交给模型');
  assert(doc.comps.length === 0, '不应先改画布');
});

check('interpretV2：别删互锁不输出好的不动', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，别删互锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 8, '应画标准正反转');
  assert(!/好的，不动/.test(r.reply), '不应输出好的不动');
});

check('interpretV2：只要自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，只要自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 6, '元件数 ' + doc.comps.length);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁应关闭');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁应保留');
});

check('interpretV2：除了互锁都要', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，除了互锁都要', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 6, '元件数 ' + doc.comps.length);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁应关闭');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁应保留');
});

check('interpretV2：除了自锁都要', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个正反转，除了自锁都要', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 6, '元件数 ' + doc.comps.length);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁应保留');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 0, '自锁应关闭');
});

check('interpretV2：画个互锁，要自锁', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画个互锁，要自锁', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.length === 8, '元件数 ' + doc.comps.length);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁数量');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁数量');
  assert(/自锁/.test(r.reply), r.reply);
});

check('drawTemplate：interlock + selflock', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'interlock', selflock: true });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.level === 'ok', 'level=' + r.level);
  assert(doc.comps.length === 8, '元件数 ' + doc.comps.length);
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁数量');
  assert(doc.comps.filter(function (c) { return c.type === 'no'; }).length === 2, '自锁数量');
});

check('drawTemplate：主电路明确关闭元件时拒绝', function () {
  ['thermal', 'fuse', 'selflock', 'interlock'].forEach(function (k) {
    const doc = M.blank(760, 500);
    const opts = { kind: 'reverse', main: true };
    opts[k] = false;
    const r = A.drawTemplate(doc, opts);
    assert(r.ok === false, k + ' 应拒绝，实际 ' + JSON.stringify(r));
    assert(new RegExp(k + ':false').test(r.error || ''), k + ' 报错缺参数名：' + r.error);
    assert(doc.comps.length === 0, k + ' 拒绝时不应出图');
  });
});

check('draw_plan：单引脚节点 + 端子', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'btnNo', key: 'SF1', branch: 1 },
      { type: 'coil', key: 'QA1', branch: 1 }
    ],
    nodes: [
      { name: 'L', pins: ['SF1#0'] },
      { name: 'A', pins: ['SF1#1', 'coil:QA1#0'] },
      { name: 'N', pins: ['coil:QA1#1'] }
    ],
    terminals: [{ name: 'L1', node: 'L' }, { name: 'N', node: 'N' }]
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.wiring === '全部连通', r.wiring);
  assert(doc.comps.length === 2, '元件数');
  assert(doc.marks.filter(function (m) { return m.kind === 'term'; }).length === 2, '端子数');
  assert(!A.analyze(doc).issues.some(function (i) { return i.level === 'error'; }),
    JSON.stringify(A.analyze(doc).issues));
});

/* ---------------- 带图修改：纠错语气交模型 ---------------- */

check('带图修改：四条纠错句交给模型且不改画布', function () {
  [
    '不对，互锁应该串在启动按钮后面',
    '错了，改成不带自锁的',
    '改成两个接触器',
    '把热继电器挪到下面'
  ].forEach(function (text) {
    const doc = makeReverse(true, true);
    const before = doc.comps.length;
    const r = C.interpretV2(text, doc);
    assert(r === null, text + ' → 应返回 null，实际 ' + JSON.stringify(r));
    assert(doc.comps.length === before, text + ' → 画布被改动了');
  });
});

check('带图修改：纯增量仍走离线', function () {
  const doc = makeReverse(true, true);
  const r = C.interpretV2('再加一个运行指示灯', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'lamp'; }), '没加信号灯');
  assert(doc.comps.length <= 10, '增量不应大改：' + doc.comps.length);
});

check('带图修改：明确删除仍走离线', function () {
  const doc = makeReverse(true, true);
  const r = C.interpretV2('互锁要去掉', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '互锁未删除');
});

check('带图修改：空画布不受影响', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('不对，画个正反转', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '空画布仍应能画');
});

check('draw_plan：同 type:key 可重复，nodes 用 @n 定位', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'btnNo', key: 'SF1', branch: 1 },
      { type: 'nc', key: 'QA3', branch: 1 },
      { type: 'nc', key: 'QA3', branch: 3 },
      { type: 'coil', key: 'QA3', branch: 1 }
    ],
    nodes: [
      // QA3 有两个常闭：L 接第二个，A 接第一个，B 把两个下端和线圈上端并起来
      { name: 'L', pins: ['SF1#0', 'nc:QA3@2#0'] },
      { name: 'A', pins: ['SF1#1', 'nc:QA3@1#0'] },
      { name: 'B', pins: ['nc:QA3@1#1', 'nc:QA3@2#1', 'coil:QA3#0'] },
      { name: 'N', pins: ['coil:QA3#1'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(!/重复元件/.test(String(r.error) + String(r.placeErrors)), JSON.stringify(r));
  const qa3 = doc.comps.filter(function (c) {
    return c.type === 'nc' && c.key === 'QA3';
  });
  assert(qa3.length === 2, 'QA3 常闭数量=' + qa3.length);

  const p1 = A.pins(doc, 'nc:QA3@1#0');
  const p2 = A.pins(doc, 'nc:QA3@2#0');
  assert(p1.ok && p2.ok, JSON.stringify(p1) + ' / ' + JSON.stringify(p2));
  assert(Math.abs(p1.pins[0].x - p2.pins[0].x) > 1,
    '@1/@2 指向了同一个触点：' + JSON.stringify([p1.pins[0], p2.pins[0]]));
  assert(!A.analyze(doc).issues.some(function (i) { return i.level === 'error'; }),
    JSON.stringify(A.analyze(doc).issues));
});

check('@n：支持 nc:QA3@2#1 与 nc:QA3#1@2 两种写法', function () {
  const doc = makeDup();
  const a = A.pins(doc, 'nc:QA3@2#1');
  const b = A.pins(doc, 'nc:QA3#1@2');
  assert(a.ok && b.ok, JSON.stringify([a, b]));
  const pinA = a.pins[1], pinB = b.pins[1];
  assert(Math.abs(pinA.x - pinB.x) < 0.6 && Math.abs(pinA.y - pinB.y) < 0.6,
    '两种写法应指向同一引脚：' + JSON.stringify([pinA, pinB]));
  const first = A.pins(doc, 'nc:QA3@1#1');
  assert(Math.abs(first.pins[1].x - pinA.x) > 1, '@1 与 @2 下脚不应重合');
});

check('@n：align 也能引用第二个同名触点', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'nc', { key: 'QA3', branch: 1 });
  A.place(doc, 'nc', { key: 'QA3', branch: 3 });
  const second = doc.comps.filter(function (c) {
    return c.type === 'nc' && c.key === 'QA3';
  })[1];
  const r = A.place(doc, 'no', { key: 'QA1', branch: 2, align: 'nc:QA3@2' });
  assert(r.ok === true, JSON.stringify(r));
  const no = doc.comps.filter(function (c) { return c.type === 'no' && c.key === 'QA1'; })[0];
  assert(no && Math.abs(M.anchorOf(no).y - M.anchorOf(second).y) < 0.6,
    '没有对齐到第二个触点：' + (no && M.anchorOf(no).y) + ' vs ' + M.anchorOf(second).y);
});

check('remove：同 type:key 多个时拒绝猜，@n 才删指定那个', function () {
  const doc = makeDup();
  const typed = A.remove(doc, 'nc:QA3');
  assert(typed.ok === false, JSON.stringify(typed));
  assert(/@序号/.test(typed.error || ''), typed.error);
  const bare = A.remove(doc, 'QA3');
  assert(bare.ok === false, JSON.stringify(bare));
  assert(/类型:代号/.test(bare.error || ''), bare.error);

  const r = A.remove(doc, 'nc:QA3@2');
  assert(r.ok === true, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc' && c.key === 'QA3'; }).length === 1,
    '应只删一个 QA3 常闭');
  assert(A.remove(doc, 'nc:QA3@2').ok === false, '第二个已删，@2 应找不到');
  assert(A.remove(doc, 'nc:QA3@1').ok === true, '剩下的 @1 应可删');
});

/* ---------------- draw_plan 原子性 / 排序 ---------------- */

check('draw_plan：无效类型在清空前被拦下，原图不动', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = A.drawPlan(doc, {
    clear: true,
    components: [{ type: 'nope', key: 'X', branch: 1 }],
    nodes: []
  });
  assert(r.ok === false, JSON.stringify(r));
  assert(/没有这种元件/.test(r.error || ''), r.error);
  assert(r.rolledBack === false, '校验阶段不应清空画布');
  assert(doc.comps.length === before, '原图被改动');
  assert(doc.title.indexOf('正反转') >= 0, '标题被清空');
});

check('draw_plan：align 目标不存在时提前报错，原图不动', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = A.drawPlan(doc, {
    clear: true,
    components: [{ type: 'no', key: 'QA9', branch: 1, align: 'SF404' }],
    nodes: [{ name: 'A', pins: ['no:QA9#0', 'no:QA9#1'] }]
  });
  assert(r.ok === false, JSON.stringify(r));
  assert(r.placeErrors && /SF404/.test(r.placeErrors.join('；')), JSON.stringify(r.placeErrors));
  assert(doc.comps.length === before, '原图被改动');
});

check('draw_plan：放置后连线失败会回滚整张图', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = A.drawPlan(doc, {
    clear: true,
    components: [{ type: 'coil', key: 'QA9', branch: 1 }],
    nodes: [{ name: 'A', pins: ['coil:QA9#0', 'coil:QA9#1'] }]
  });
  assert(r.ok === false, JSON.stringify(r));
  assert(r.rolledBack === true, '应回滚');
  assert(doc.comps.length === before, '回滚后元件数不对');
  assert(doc.comps.some(function (c) { return c.key === 'QA1'; }), '原图没恢复');
  assert(doc.title.indexOf('正反转') >= 0, '标题没恢复');
});

check('draw_plan：clear + 合法 plan 会替换原图', function () {
  const doc = makeReverse(true, true);
  doc.deco.push({ id: 'd1', kind: 'divider', x1: 0, y1: 0, x2: 0, y2: 100 });
  const r = A.drawPlan(doc, {
    clear: true,
    components: [
      { type: 'btnNo', key: 'SF9', branch: 1 },
      { type: 'coil', key: 'QA9', branch: 3 }
    ],
    nodes: [
      { name: 'L', pins: ['SF9#0', 'coil:QA9#0'] },
      { name: 'N', pins: ['SF9#1', 'coil:QA9#1'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.rolledBack === false, '不应回滚');
  assert(doc.comps.length === 2, '应只剩新图 2 个元件');
  assert(doc.comps.some(function (c) { return c.key === 'QA9'; }), '新图没落盘');
  assert(doc.deco.length === 0, '旧虚线没清掉');
});

check('draw_plan：align 目标写在后面也能先放', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'no', key: 'QA1', branch: 2, align: 'SF1' },
      { type: 'btnNo', key: 'SF1', branch: 1 },
      { type: 'nc', key: 'QA2', branch: 1 },
      { type: 'coil', key: 'QA1', branch: 1 },
      { type: 'btnNo', key: 'SF2', branch: 3 },
      { type: 'nc', key: 'QA1', branch: 3 },
      { type: 'coil', key: 'QA2', branch: 3 },
      { type: 'no', key: 'QA2', branch: 4, align: 'SF2' }
    ],
    nodes: [
      { name: 'L', pins: ['SF1#0', 'SF2#0', 'no:QA1#0', 'no:QA2#0'] },
      { name: 'A1', pins: ['SF1#1', 'no:QA1#1', 'nc:QA2#0'] },
      { name: 'A2', pins: ['nc:QA2#1', 'coil:QA1#0'] },
      { name: 'B1', pins: ['SF2#1', 'no:QA2#1', 'nc:QA1#0'] },
      { name: 'B2', pins: ['nc:QA1#1', 'coil:QA2#0'] },
      { name: 'N', pins: ['coil:QA1#1', 'coil:QA2#1'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  const sf1 = doc.comps.filter(function (c) { return c.type === 'btnNo' && c.key === 'SF1'; })[0];
  const qa1 = doc.comps.filter(function (c) { return c.type === 'no' && c.key === 'QA1'; })[0];
  assert(sf1 && qa1, '元件没放上');
  assert(Math.abs(M.anchorOf(sf1).y - M.anchorOf(qa1).y) < 0.6,
    '自锁触点没有和按钮同行：' + M.anchorOf(sf1).y + ' vs ' + M.anchorOf(qa1).y);
});

check('draw_plan：母线引出线绕开同列引脚', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'no', key: 'QA1', branch: 2, align: 'SF1' },
      { type: 'btnNo', key: 'SF1', branch: 1 },
      { type: 'coil', key: 'QA1', branch: 1 },
      { type: 'btnNo', key: 'SF2', branch: 3 }
    ],
    nodes: [
      { name: 'L', pins: ['SF1#0', 'no:QA1#0'] },
      { name: 'M', pins: ['SF1#1', 'no:QA1#1', 'coil:QA1#0'] },
      { name: 'N', pins: ['coil:QA1#1', 'SF2#0'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.level === 'error'; }), JSON.stringify(an.issues));
  assert(doc.wires.some(function (w) { return w.pts.length >= 4; }), '没有侧向引出线');
});

check('draw_plan：同列多节点不短路（走线绕开，必要时重排）', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'btnNo', key: 'SF1', branch: 1 },
      { type: 'btnNc', key: 'SF2', branch: 1 },
      { type: 'coil', key: 'QA1', branch: 1 },
      { type: 'btnNo', key: 'SF3', branch: 1 },
      { type: 'coil', key: 'QA2', branch: 1 }
    ],
    nodes: [
      { name: 'L', pins: ['SF1#0', 'SF3#0'] },
      { name: 'A', pins: ['SF1#1', 'SF2#0'] },
      { name: 'B', pins: ['SF2#1', 'coil:QA1#0'] },
      { name: 'N', pins: ['coil:QA1#1', 'coil:QA2#1'] },
      { name: 'C', pins: ['SF3#1', 'coil:QA2#0'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  // 第 32 轮起 connect 会绕开中间引脚，这类图可能第一次就通（relayout=0）；
  // 仍然短路时必须靠第 1 次重排救回来。
  assert(r.relayout === 0 || r.relayout === 1, 'relayout=' + r.relayout);
  assert(r.relayout === 0 || r.relayoutFrom === 'short', 'relayoutFrom=' + r.relayoutFrom);
  assert(r.rolledBack === false, '出图成功不应回滚');
  assert(r.level !== 'error', 'level=' + r.level);
  assert(r.wiring === '全部连通', r.wiring);
  assert(doc.comps.length === 5, '元件数 ' + doc.comps.length);
  assert(doc.comps.map(function (c) { return c.key; }).join(',') === 'SF1,SF2,QA1,SF3,QA2',
    '重排不该改代号');
});

check('draw_plan：重排两次仍失败时整图回滚', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'no', key: 'QA9', branch: 1 },
      { type: 'coil', key: 'QA1', branch: 2 }
    ],
    nodes: [
      { name: 'L', pins: ['no:QA9#0'] },
      { name: 'A', pins: ['no:QA9#1', 'coil:QA1#0'] },
      { name: 'N', pins: ['coil:QA1#1'] }
    ]
  });
  assert(r.ok === false, JSON.stringify(r));
  assert(r.relayout === 2, 'relayout=' + r.relayout);
  assert(r.relayoutFrom === 'electrical', 'relayoutFrom=' + r.relayoutFrom);
  assert(r.rolledBack === true, '最终失败必须回滚');
  assert(doc.comps.length === 0, '回滚后不应留下残图：' + doc.comps.length);
});

check('draw_plan：没给 nodes 时文案不含 undefined', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [{ type: 'coil', key: 'QA9', branch: 1 }],
    nodes: []
  });
  assert(r.ok === false, JSON.stringify(r));
  assert(r.wiring === '没有给 nodes', r.wiring);
  assert(!/undefined/.test(String(r.wiring) + String(r.error)), r.wiring + ' / ' + r.error);
  assert(r.rolledBack === true, '应回滚空图');
});

/* ---------------- draw_template 模板单一实现 ---------------- */

check('draw_template：正反转不带互锁', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'reverse', interlock: false, selflock: true });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.kind === 'reverse', JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 0, '不应有 nc');
  assert(/没有串互锁/.test(r.reply), r.reply);
  assert(r.level === 'ok' || r.level === 'warn', 'level=' + r.level);
});

check('draw_template：纯互锁', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'interlock' });
  assert(r.ok === true, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '线圈数量');
  assert(doc.comps.filter(function (c) { return c.type === 'nc'; }).length === 2, '互锁数量');
  assert(!coilLoose(doc).length, JSON.stringify(coilLoose(doc)));
});

check('draw_template：起保停与点动', function () {
  const a = M.blank(760, 500);
  const r1 = A.drawTemplate(a, { kind: 'selflock' });
  assert(r1.ok === true && /起保停/.test(r1.reply), JSON.stringify(r1));
  const b = M.blank(760, 500);
  const r2 = A.drawTemplate(b, { kind: 'jog' });
  assert(r2.ok === true && /点动/.test(r2.reply), JSON.stringify(r2));
});

check('draw_template：未知模板回滚原图', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = A.drawTemplate(doc, { kind: 'no-such-template' });
  assert(r.ok === false, JSON.stringify(r));
  assert(/没有这种模板/.test(r.error || ''), r.error);
  assert(r.rolledBack === true, '应回滚');
  assert(doc.comps.length === before, '原图被改动');
});

check('motor3W：6 引脚语义 U1/V1/W1 上排、U2/V2/W2 下排', function () {
  const c = M.TYPES.motor3W.make(122, 363);
  c.r = 30;
  const pins = M.TYPES.motor3W.pins(c);
  assert(pins.length === 6, '引脚数=' + pins.length);
  const top = pins.slice(0, 3), bot = pins.slice(3);
  top.forEach(function (p) { assert(p[1] === 318, '上排 y=' + p[1]); });
  bot.forEach(function (p) { assert(p[1] === 408, '下排 y=' + p[1]); });
  assert(top.map(function (p) { return p[0]; }).join(',') === '107,122,137',
    '上排 x=' + top.map(function (p) { return p[0]; }));
  assert(bot.map(function (p) { return p[0]; }).join(',') === '107,122,137',
    '下排 x=' + bot.map(function (p) { return p[0]; }));
  const b = M.TYPES.motor3W.box(c);
  pins.forEach(function (p) {
    assert(p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h,
      'box 没覆盖引脚 ' + p);
  });
});

check('draw_template：星三角主电路 + 控制电路', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'star' });
  assert(r.ok === true, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'motor3W'; }), '缺 6 端子电机');
  assert(doc.comps.some(function (c) { return c.type === 'contactor3' && c.key === 'KM1'; }),
    '缺 KM1 主触点组');
  assert(doc.comps.some(function (c) { return c.type === 'ktCoil' && c.key === 'KT'; }), '缺 KT');
  ['KM1', 'KM2', 'KM3'].forEach(function (k) {
    assert(doc.comps.some(function (c) { return c.type === 'coil' && c.key === k; }),
      '缺线圈 ' + k);
  });
  const an = A.analyze(doc);
  assert(an.level === 'ok', 'level=' + an.level + ' ' + JSON.stringify(an.issues));
  assert(!an.issues.some(function (i) { return i.code === 'short'; }), '出现 short');
  assert(!an.issues.some(function (i) { return i.code === 'loose'; }), '出现 loose');
});

check('draw_template：星三角 main:false 只出控制部分', function () {
  const full = M.blank(760, 500);
  const doc = M.blank(760, 500);
  assert(A.drawTemplate(full, { kind: 'star', main: true }).ok === true, 'main:true 失败');
  const r = A.drawTemplate(doc, { kind: 'star', main: false });
  assert(r.ok === true, JSON.stringify(r));
  assert(doc.comps.length < full.comps.length,
    'main:false ' + doc.comps.length + ' 不少于 main:true ' + full.comps.length);
  assert(!doc.comps.some(function (c) { return c.type === 'contactor3'; }), '仍有主触点组');
  assert(!doc.comps.some(function (c) { return c.type === 'motor3W'; }), '仍有 6 端子电机');
  assert(doc.comps.some(function (c) { return c.type === 'ktCoil' && c.key === 'KT'; }), '缺 KT');
  const an = A.analyze(doc);
  assert(an.level === 'ok', 'level=' + an.level + ' ' + JSON.stringify(an.issues));
  assert(doc.marks.some(function (m) { return m.kind === 'term'; }), '缺 L/N 端子');
});

check('interpretV2：星三角离线出完整图', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画一个星三角', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'motor3W'; }), '缺 motor3W');
  assert(doc.comps.some(function (c) { return c.type === 'contactor3'; }), '缺主触点组');
  assert(A.analyze(doc).level === 'ok', 'level≠ok');
});

check('interpretV2：星三角不要主电路 → main:false', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('星三角不要主电路', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(!doc.comps.some(function (c) { return c.type === 'contactor3'; }), '仍画了主触点组');
  assert(!doc.comps.some(function (c) { return c.type === 'motor3W'; }), '仍画了电机');
  assert(doc.comps.some(function (c) { return c.type === 'ktCoil'; }), '缺 KT');
  assert(A.analyze(doc).level === 'ok', 'level≠ok');
});

check('draw_template：星三角固定元件不能单独关', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'star', main: false, fuse: false });
  assert(r.ok === false, JSON.stringify(r));
  assert(r.rolledBack === true, '应回滚');
  assert(doc.comps.length === 0, '原图被改动');
});

check('draw_template：正反转 + 主电路', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'reverse', main: true });
  assert(r.ok === true, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.type === 'motor'; }), '缺电机');
  assert(doc.comps.some(function (c) { return c.type === 'thermal'; }), '缺热继电器');
  assert(doc.comps.some(function (c) { return c.type === 'fuse'; }), '缺熔断器');
  assert(doc.comps.some(function (c) { return c.type === 'switch3'; }), '缺隔离开关');
  assert(doc.marks.some(function (m) { return m.kind === 'term'; }), '缺端子');
  const mains = doc.comps.filter(function (c) {
    return c.type === 'no' && (c.key === 'QA1' || c.key === 'QA2');
  });
  assert(mains.length >= 6, '主触点数量=' + mains.length);
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.level === 'error'; }), JSON.stringify(an.issues));
});

check('draw_template：主电路模板不允许关闭互锁', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = A.drawTemplate(doc, { kind: 'reverse', main: true, interlock: false });
  assert(r.ok === false, JSON.stringify(r));
  assert(/固定/.test(r.error || ''), r.error);
  assert(doc.comps.length === before, '原图被改动');
});

check('draw_template：两地控制', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'remote' });
  assert(r.ok === true, JSON.stringify(r));
  ['SF11', 'SF21', 'SF12', 'SF22'].forEach(function (k) {
    assert(doc.comps.some(function (c) { return c.key === k; }), '缺 ' + k);
  });
  assert(doc.comps.some(function (c) { return c.type === 'motor'; }), '缺电机');
  assert(doc.comps.some(function (c) { return c.type === 'thermal'; }), '缺热继电器');
  assert(doc.marks.some(function (m) { return m.kind === 'term'; }), '缺端子');
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.level === 'error'; }), JSON.stringify(an.issues));
});

check('interpretV2：画一个两地控制', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('画一个两地控制', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.some(function (c) { return c.key === 'SF12'; }), '缺 SF12');
  assert(doc.comps.some(function (c) { return c.type === 'motor'; }), '缺电机');
});

check('draw_template：两地控制意图识别', function () {
  const doc = M.blank(760, 500);
  const r = A.drawTemplate(doc, { kind: 'remote' });
  assert(r.ok === true, JSON.stringify(r));
  assert(A.analyze(doc).intent === '两地控制', JSON.stringify(A.analyze(doc).intent));
});

/* ---------------- 问题定位框 ---------------- */

check('targetBox：元件 / 导线 / 接点 / 文字', function () {
  const doc = makeReverse(true, true);
  const comp = doc.comps[0];
  const cb = M.targetBox(doc, 'comp', comp.id);
  assert(cb && cb.w > 0 && cb.h > 0, JSON.stringify(cb));

  const wire = doc.wires[0];
  const wb = M.targetBox(doc, 'wire', wire.id);
  assert(wb && wb.w > 0 && wb.h >= 0, JSON.stringify(wb));

  doc.marks.push({ id: 'm9', kind: 'term', x: 100, y: 100 });
  const mb = M.targetBox(doc, 'mark', 'm9');
  assert(mb && mb.w === 16 && mb.h === 16, JSON.stringify(mb));

  doc.texts.push({ id: 't9', x: 100, y: 100, text: '测试', size: 12, anchor: 'start' });
  const tb = M.targetBox(doc, 'text', 't9');
  assert(tb && tb.w > 0 && tb.h > 0, JSON.stringify(tb));

  assert(M.targetBox(doc, 'comp', 'nope') === null, '未知 id 应返回 null');
});

/* ---------------- 电源端子 / 回路闭合 ---------------- */

check('电源端子：无端子时给 info，检查回复不说“没问题”', function () {
  const doc = makeReverse(true, true);
  const an = A.analyze(doc);
  const p = an.issues.filter(function (i) { return i.code === 'power'; });
  assert(p.length === 1 && p[0].level === 'info', JSON.stringify(p));
  assert(/没有电源端子/.test(p[0].msg), p[0].msg);
  const r = C.interpretV2('检查一下', doc);
  assert(r && /局部接法没发现问题/.test(r.reply), JSON.stringify(r));
  assert(/没有电源端子/.test(r.reply), JSON.stringify(r));
});

check('电源端子：L/N 到位后不再提示回路闭合', function () {
  const doc = makeReverse(true, true);
  const l = A.pins(doc, 'SF1#0').pins[0];
  const n = A.pins(doc, 'coil:QA1#1').pins[1];
  doc.marks.push({ id: 't1', kind: 'term', x: l.x, y: l.y, name: 'L1' });
  doc.marks.push({ id: 't2', kind: 'term', x: n.x, y: n.y, name: 'N' });
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'power'; }), JSON.stringify(an.issues));
  assert(an.power.terminals === 2, JSON.stringify(an.power));
});

check('draw_plan：terminals 落到节点并参与闭合判断', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'btnNo', key: 'SF9', branch: 1 },
      { type: 'coil', key: 'QA9', branch: 3 }
    ],
    nodes: [
      { name: 'L', pins: ['SF9#0', 'coil:QA9#0'] },
      { name: 'N', pins: ['SF9#1', 'coil:QA9#1'] }
    ],
    terminals: [{ name: 'L1', node: 'L' }, { name: 'N', node: 'N' }]
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.terminalsPlaced === 2, JSON.stringify(r));
  assert(doc.marks.filter(function (m) { return m.kind === 'term'; }).length === 2, '端子数量');
  assert(!A.analyze(doc).issues.some(function (i) { return i.code === 'power'; }), '不应再报电源端子');
});

check('draw_plan：端子在引脚外侧并有引线', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'btnNo', key: 'SF9', branch: 1 },
      { type: 'coil', key: 'QA9', branch: 3 }
    ],
    nodes: [
      { name: 'L', pins: ['SF9#0', 'coil:QA9#0'] },
      { name: 'N', pins: ['SF9#1', 'coil:QA9#1'] }
    ],
    terminals: [{ name: 'L1', node: 'L' }, { name: 'N', node: 'N' }]
  });
  assert(r.ok === true, JSON.stringify(r));
  const marks = doc.marks.filter(function (m) { return m.kind === 'term'; });
  assert(marks.length === 2, '端子数量');
  marks.forEach(function (m) {
    const hit = doc.wires.some(function (w) {
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      return (Math.abs(a[0] - m.x) < 0.6 && Math.abs(a[1] - m.y) < 0.6) ||
             (Math.abs(b[0] - m.x) < 0.6 && Math.abs(b[1] - m.y) < 0.6);
    });
    assert(hit, '端子没有引线：' + JSON.stringify(m));
  });
  const p = A.pins(doc, 'SF9#0').pins[0];
  assert(!marks.some(function (m) {
    return Math.abs(m.x - p.x) < 0.6 && Math.abs(m.y - p.y) < 0.6;
  }), '端子还压在引脚上');
});

check('draw_plan：terminals 指向不存在的节点时提前报错', function () {
  const doc = makeReverse(true, true);
  const before = doc.comps.length;
  const r = A.drawPlan(doc, {
    clear: true,
    components: [{ type: 'coil', key: 'QA9', branch: 1 }],
    nodes: [{ name: 'L', pins: ['coil:QA9#0', 'coil:QA9#1'] }],
    terminals: [{ name: 'L1', node: 'NOPE' }]
  });
  assert(r.ok === false, JSON.stringify(r));
  assert(/端子 L1 指向的节点 NOPE 不存在/.test(r.error), r.error);
  assert(doc.comps.length === before, '原图被改动');
});

check('draw_plan：没有 terminals 时返回“无法判断回路闭合”提示', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'btnNo', key: 'SF9', branch: 1 },
      { type: 'coil', key: 'QA9', branch: 3 }
    ],
    nodes: [
      { name: 'L', pins: ['SF9#0', 'coil:QA9#0'] },
      { name: 'N', pins: ['SF9#1', 'coil:QA9#1'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.issues.some(function (i) { return i.code === 'power' && i.level === 'info'; }),
    JSON.stringify(r.issues));
});

/* ---------------- 模型“嘴上画完”兜底 ---------------- */

check('claim 识别：真声称 / 否认 / 疑问', function () {
  assert(C.claimedDrawn('点动电路已画好：SF1 按钮直接串到 QA1 线圈') === true, '已画好');
  assert(C.claimedDrawn('画完了，一共 6 个元件') === true, '画完了');
  assert(C.claimedDrawn('我没能画出来：本轮没有任何元件') === false, '否认');
  assert(C.claimedDrawn('还没画好，缺一个自锁') === false, '还没画好');
  assert(C.claimedDrawn('画好了吗？') === false, '疑问');
});

check('claim 兜底：说画好但 changed=false → 明确说没画出来', function () {
  const r = C.guardClaim({
    reply: '点动电路已画好：SF1 按钮直接串到 QA1 线圈。',
    changed: false
  });
  assert(/^我没能画出来/.test(r.reply), r.reply);
  assert(/模型原话/.test(r.reply) && /点动电路已画好/.test(r.reply), r.reply);
});

check('claim 兜底：真的改了画布 / 没有声称 → 不改回复', function () {
  const ok = { reply: '点动电路已画好。', changed: true };
  const before = ok.reply;
  C.guardClaim(ok);
  assert(ok.reply === before, 'changed=true 不应改');

  const plain = { reply: '需要我画一个点动吗？', changed: false };
  const p = plain.reply;
  C.guardClaim(plain);
  assert(plain.reply === p, '没声称不应改');
  assert(C.guardClaim(null) === null, 'null 应安全');
});

/* ---------------- advisor：主电路单独成图 ---------------- */

check('advisor：主电路单独绘制不误报线圈（__MAIN_ONLY__）', function () {
  const doc = M.blank(760, 500);
  const r = A.drawPlan(doc, {
    components: [
      { type: 'contactor3', key: 'QA1', branch: 1 },
      { type: 'motor', key: 'M1', branch: 3 }
    ],
    nodes: [
      { name: 'L1', pins: ['contactor3:QA1#0'] },
      { name: 'M', pins: ['contactor3:QA1#1', 'motor:M1#0'] }
    ]
  });
  assert(r.ok === true, JSON.stringify(r));
  assert(doc.comps.length === 2, '元件数');
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.level === 'error'; }), JSON.stringify(an.issues));
  assert(an.issues.some(function (i) { return i.code === 'coil-offsheet'; }),
    '缺少“线圈不在本图”的说明');
});

check('advisor：有主电路元件也有线圈时，触点缺线圈仍报 error', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'contactor3', { key: 'QA1' });
  A.place(doc, 'motor', { key: 'M1' });
  A.place(doc, 'coil', { key: 'QA2' });
  const an = A.analyze(doc);
  assert(an.issues.some(function (i) {
    return i.code === 'keyless' && /QA1/.test(i.msg);
  }), JSON.stringify(an.issues));
});

check('advisor：控制回路单独成图，触点缺线圈仍报 error', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'coil', { key: 'QA1' });
  A.place(doc, 'nc', { key: 'QA2' });
  const an = A.analyze(doc);
  assert(an.issues.some(function (i) {
    return i.code === 'keyless' && /QA2/.test(i.msg);
  }), JSON.stringify(an.issues));
});

/* ---------------- advisor：非电磁驱动元件的触点 ---------------- */

check('advisor：热继电器本体 + 过载触点不需要同名线圈（thermal + nc/no）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'btnNo', { key: 'SF1' });
  A.place(doc, 'thermal', { key: 'FR1' });
  A.place(doc, 'nc', { key: 'FR1' });
  A.place(doc, 'no', { key: 'FR1' });
  A.place(doc, 'coil', { key: 'QA1', near: 'SF1' });
  A.wireNodes(doc, [
    { name: 'L', pins: ['SF1#0'] },
    { name: 'A', pins: ['SF1#1', 'nc:FR1#0'] },
    { name: 'B', pins: ['nc:FR1#1', 'coil:QA1#0'] },
    { name: 'N', pins: ['coil:QA1#1'] }
  ]);
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'keyless'; }),
    JSON.stringify(an.issues));
});

check('advisor：热继电器代号 FR/BB 在另一张图时也不误报', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'nc', { key: 'FR1' });
  A.place(doc, 'no', { key: 'BB2' });
  A.place(doc, 'coil', { key: 'QA1' });
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'keyless'; }),
    JSON.stringify(an.issues));
});

check('advisor：行程开关触点不需要同名线圈（limit + nc，非 SQ 代号）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'limit', { key: 'LS1' });
  A.place(doc, 'nc', { key: 'LS1' });
  A.place(doc, 'coil', { key: 'QA1' });
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'keyless'; }),
    JSON.stringify(an.issues));
});

check('advisor：接近开关触点不需要同名线圈（prox + nc，非 SQ 代号）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'prox', { key: 'PR1' });
  A.place(doc, 'nc', { key: 'PR1' });
  A.place(doc, 'coil', { key: 'QA1' });
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'keyless'; }),
    JSON.stringify(an.issues));
});

check('advisor：急停常闭触点不需要同名线圈（btnStop + nc，非 SB 代号）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'btnStop', { key: 'ES1' });
  A.place(doc, 'nc', { key: 'ES1' });
  A.place(doc, 'coil', { key: 'QA1' });
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'keyless'; }),
    JSON.stringify(an.issues));
});

check('advisor：电流互感器二次侧触点不需要同名线圈（ct + nc）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'ct', { key: 'TA1' });
  A.place(doc, 'nc', { key: 'TA1' });
  A.place(doc, 'coil', { key: 'QA1' });
  const an = A.analyze(doc);
  assert(!an.issues.some(function (i) { return i.code === 'keyless'; }),
    JSON.stringify(an.issues));
});

check('advisor：无关的非电磁驱动不会放过真缺线圈（nc:QA9）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'thermal', { key: 'FR1' });
  A.place(doc, 'coil', { key: 'QA1' });
  A.place(doc, 'nc', { key: 'QA9' });
  const an = A.analyze(doc);
  assert(an.issues.some(function (i) {
    return i.code === 'keyless' && /QA9/.test(i.msg);
  }), JSON.stringify(an.issues));
});

check('advisor：contactor3 仍按电磁接触器要求线圈（同代号有 thermal 也不例外）', function () {
  const doc = M.blank(760, 500);
  A.place(doc, 'thermal', { key: 'FR1' });
  A.place(doc, 'contactor3', { key: 'FR1' });
  A.place(doc, 'coil', { key: 'QA1' });
  const an = A.analyze(doc);
  assert(an.issues.some(function (i) {
    return i.code === 'keyless' && /FR1/.test(i.msg);
  }), JSON.stringify(an.issues));
});

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
