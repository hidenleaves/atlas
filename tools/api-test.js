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
  const r = A.drawTemplate(doc, { kind: 'star' });
  assert(r.ok === false, JSON.stringify(r));
  assert(/没有这种模板/.test(r.error || ''), r.error);
  assert(r.rolledBack === true, '应回滚');
  assert(doc.comps.length === before, '原图被改动');
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

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
