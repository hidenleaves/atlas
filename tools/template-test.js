#!/usr/bin/env node
/* ============================================================
   template-test.js — 内置模板画廊回归
   ------------------------------------------------------------
   逐个模板画一遍，检查：能落盘、元件数合理、有导线、有标题、
   电气检查无 error、能渲染出 SVG。
   ============================================================ */
'use strict';

global.window = global;
require('../js/symgeo.js');
require('../js/symlib.js');
require('../js/editor-model.js');
require('../js/advisor.js');
require('../js/api.js');
require('../js/circuits.js');
const T = require('../js/templates.js');
global.PLCTemplates = T;

const M = global.PLCEditorModel;
const A = global.PLCApi;

const CASES = [
  { name: '点动', kind: 'jog', min: 2 },
  { name: '起保停', kind: 'selflock', min: 3 },
  { name: '纯互锁', kind: 'interlock', min: 5 },
  { name: '纯互锁 + 自锁', kind: 'interlock', opts: { selflock: true }, min: 7 },
  { name: '正反转', kind: 'reverse', min: 6 },
  { name: '正反转不带互锁', kind: 'reverse', opts: { interlock: false }, min: 4 },
  { name: '正反转不带自锁', kind: 'reverse', opts: { selflock: false }, min: 4 },
  { name: '正反转 + 主电路', kind: 'reverse', opts: { main: true }, min: 20 },
  { name: '两地控制', kind: 'remote', min: 15 },
  {
    name: '星三角 + 主电路', kind: 'star', min: 20,
    check: function (doc, an, r, errs) {
      const coils = doc.comps.filter(function (c) { return c.type === 'coil'; })
        .map(function (c) { return c.key; });
      ['KM1', 'KM2', 'KM3'].forEach(function (k) {
        if (coils.indexOf(k) < 0) errs.push('缺接触器线圈 ' + k);
      });
      if (!doc.comps.some(function (c) { return c.type === 'ktCoil' && c.key === 'KT'; })) {
        errs.push('缺 KT 时间继电器');
      }
      const motor = doc.comps.filter(function (c) { return c.type === 'motor3W'; })[0];
      if (!motor) errs.push('缺 6 端子电机 motor3W');
      else if (M.pinsOfComp(motor).length !== 6) {
        errs.push('motor3W 引脚 ' + M.pinsOfComp(motor).length + ' ≠ 6');
      }
      if (!doc.comps.some(function (c) { return c.type === 'contactor3' && c.key === 'KM1'; })) {
        errs.push('缺 KM1 主触点组');
      }
      const terms = doc.marks.filter(function (m) { return m.kind === 'term'; });
      ['L1', 'L2', 'L3', 'N'].forEach(function (nm) {
        if (!doc.texts.some(function (t) { return t.text === nm; })) {
          errs.push('缺 ' + nm + ' 端子');
        }
      });
      if (terms.length < 4) errs.push('电源端子只有 ' + terms.length + ' 个');
      if (an.level !== 'ok') errs.push('level=' + an.level + '，期望 ok');
      if (an.issues.some(function (i) { return i.code === 'short'; })) errs.push('出现 short 短路');
    }
  },
  {
    name: '星三角只画控制部分', kind: 'star', opts: { main: false }, min: 8,
    check: function (doc, an, r, errs) {
      if (doc.comps.some(function (c) { return c.type === 'contactor3'; })) {
        errs.push('main:false 不应出现 contactor3 主触点组');
      }
      if (doc.comps.some(function (c) { return c.type === 'motor3W'; })) {
        errs.push('main:false 不应出现 6 端子电机');
      }
      if (doc.comps.some(function (c) { return c.type === 'thermal' || c.type === 'switch3'; })) {
        errs.push('main:false 不应出现主电路保护/隔离开关');
      }
      if (!doc.comps.some(function (c) { return c.type === 'ktCoil' && c.key === 'KT'; })) {
        errs.push('控制部分缺 KT');
      }
      if (!doc.texts.some(function (t) { return t.text === 'L1'; }) ||
          !doc.texts.some(function (t) { return t.text === 'N'; })) {
        errs.push('控制部分缺 L/N 端子');
      }
      if (an.level !== 'ok') errs.push('level=' + an.level + '，期望 ok');
      if (an.issues.some(function (i) { return i.code === 'short'; })) errs.push('出现 short 短路');
    }
  }
];

let pass = 0, fail = 0;

CASES.forEach(function (c) {
  const doc = M.blank(760, 500);
  const opts = Object.assign({ kind: c.kind }, c.opts || {});
  const r = A.drawTemplate(doc, opts);
  const an = A.analyze(doc);
  const svg = M.renderInner(doc);
  const errs = [];

  if (!r || !r.ok) errs.push('ok=false ' + ((r && (r.error || r.reply)) || ''));
  if (doc.comps.length < c.min) errs.push('元件 ' + doc.comps.length + ' < ' + c.min);
  if (!doc.wires.length) errs.push('没有导线');
  if (!doc.title) errs.push('没有标题');
  if (an.issues.some(function (i) { return i.level === 'error'; })) {
    errs.push('电气错误：' + an.issues.filter(function (i) { return i.level === 'error'; })
      .map(function (i) { return i.msg; }).join('；'));
  }
  if (svg.length < 200) errs.push('渲染为空');
  if (c.check) c.check(doc, an, r, errs);

  if (errs.length) {
    fail++;
    console.log('✗ ' + c.name);
    errs.forEach(function (e) { console.log('  · ' + e); });
  } else {
    pass++;
    console.log('✓ ' + c.name + '  →  ' + doc.comps.length + ' 元件 / ' +
      doc.wires.length + ' 导线 / level=' + an.level);
  }
});

/* main:false 必须是 main:true 的真子集（元件更少），不能把主电路偷偷画回来 */
(function () {
  const full = M.blank(760, 500);
  const ctrl = M.blank(760, 500);
  const rf = A.drawTemplate(full, { kind: 'star', main: true });
  const rc = A.drawTemplate(ctrl, { kind: 'star', main: false });
  const errs = [];
  if (!rf.ok) errs.push('main:true 失败：' + (rf.error || rf.reply));
  if (!rc.ok) errs.push('main:false 失败：' + (rc.error || rc.reply));
  if (!(ctrl.comps.length < full.comps.length)) {
    errs.push('main:false 元件 ' + ctrl.comps.length +
      ' 不少于 main:true 的 ' + full.comps.length);
  }
  if (ctrl.comps.some(function (c) { return c.type === 'contactor3'; })) {
    errs.push('main:false 仍含 contactor3');
  }
  if (errs.length) {
    fail++;
    console.log('✗ main:false 是 main:true 的真子集');
    errs.forEach(function (e) { console.log('  · ' + e); });
  } else {
    pass++;
    console.log('✓ main:false 是 main:true 的真子集  →  ' +
      ctrl.comps.length + ' < ' + full.comps.length + ' 元件');
  }
})();

console.log('');
console.log('通过 ' + pass + ' / ' + (CASES.length + 1) + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
