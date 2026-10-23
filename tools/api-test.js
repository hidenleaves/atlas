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
global.PLCRoute = require('../js/route.js');
global.PLCPrompt = require('../js/prompt.js');
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

check('interpretV2：带主电路时交给模型（返回 null）', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('正反转带主电路、熔断器、热继电器、自锁', doc);
  assert(r === null, '应返回 null 交给模型');
  assert(doc.comps.length === 0, '不应先清空画布');
});

check('interpretV2：没有互锁时，去除互锁 + 画正反转仍继续', function () {
  const doc = M.blank(760, 500);
  const r = C.interpretV2('把互锁去掉，再画个正反转', doc);
  assert(r && r.changed, JSON.stringify(r));
  assert(doc.comps.filter(function (c) { return c.type === 'coil'; }).length === 2, '应画出正反转');
  assert(/没找到互锁触点/.test(r.reply), '应提示没找到互锁');
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

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
