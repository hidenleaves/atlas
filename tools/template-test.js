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
  { name: '正反转', kind: 'reverse', min: 6 },
  { name: '正反转不带互锁', kind: 'reverse', opts: { interlock: false }, min: 4 },
  { name: '正反转不带自锁', kind: 'reverse', opts: { selflock: false }, min: 4 },
  { name: '正反转 + 主电路', kind: 'reverse', opts: { main: true }, min: 20 },
  { name: '两地控制', kind: 'remote', min: 15 }
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

console.log('');
console.log('通过 ' + pass + ' / ' + CASES.length + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
