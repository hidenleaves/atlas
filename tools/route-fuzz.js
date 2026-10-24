#!/usr/bin/env node
/* ============================================================
   route-fuzz.js — 路由组合回归（确定性，不随机）
   ------------------------------------------------------------
   用动词 × 类型 × 否定 × 属性的组合喂 route()，检查：
     · 不抛异常
     · ok / steps / op / type / confidence 字段合法
     · 关键组合的语义符合预期
   ============================================================ */
'use strict';

const R = require('../js/route.js');

const TYPES = [
  ['起保停', 'selflock'],
  ['自锁', 'selflock'],
  ['互锁', 'interlock'],
  ['点动', 'jog'],
  ['正反转', 'reverse'],
  ['星三角', 'star'],
  ['两地控制', 'remote']
];
const VERBS = ['画', '做', '生成', '帮我画', '来个'];
const ATTRS = [
  ['互锁', 'interlock'],
  ['自锁', 'selflock'],
  ['主电路', 'main']
];
const NEGS = ['不要', '不带', '没有', '无'];

const ALLOWED_OP = {
  draw: 1, add: 1, remove: 1, clear: 1, check: 1,
  place: 1, connect: 1, none: 1, attrs: 1
};
const ALLOWED_TYPE = {
  reverse: 1, interlock: 1, selflock: 1, jog: 1, star: 1, remote: 1
};

function valid(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['结果不是对象'];
  if (typeof r.ok !== 'boolean') errs.push('ok 不是布尔值');
  if (!Array.isArray(r.steps)) errs.push('steps 不是数组');
  if (r.ok) {
    if (!ALLOWED_OP[r.op]) errs.push('未知 op：' + r.op);
    if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
      errs.push('confidence 越界：' + r.confidence);
    }
    if (r.op === 'draw' && !ALLOWED_TYPE[r.type]) errs.push('未知 type：' + r.type);
    if (r.attrs) {
      Object.keys(r.attrs).forEach(function (k) {
        if (typeof r.attrs[k] !== 'boolean') errs.push('attrs.' + k + ' 不是布尔值');
      });
    }
  }
  return errs;
}

const CASES = [];

VERBS.forEach(function (v) {
  TYPES.forEach(function (t) {
    const head = v + (v === '来个' ? '' : '一个') + t[0];
    CASES.push({ text: head, expect: { op: 'draw', type: t[1] } });
    CASES.push({ text: '清空，' + head, expect: { op: 'draw', type: t[1], clear: true } });
  });
});

TYPES.forEach(function (t) {
  // 自锁/互锁本身也是属性：单独否定时是明确的不动作，不是“听不懂”
  if (t[0] === '自锁' || t[0] === '互锁') {
    CASES.push({ text: '不要' + t[0], expect: { op: 'none' } });
  } else {
    CASES.push({ text: '不要' + t[0], expect: { ok: false } });
  }
});

ATTRS.forEach(function (a) {
  NEGS.forEach(function (neg) {
    CASES.push({
      text: '正反转' + neg + a[0],
      expect: { op: 'draw', type: 'reverse', attrs: { [a[1]]: false } }
    });
  });
});

[
  { text: '正反转带主电路', expect: { op: 'draw', type: 'reverse', attrs: { main: true } } },
  { text: '正反转带主电路不带热继电器', expect: { op: 'draw', type: 'reverse', attrs: { main: true, thermal: false } } },
  { text: '主电路要，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { main: true } } },
  { text: '不要自锁，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '主电路不带热继电器，画个正反转带主电路', expect: { op: 'draw', type: 'reverse', attrs: { main: true, thermal: false } } },
  { text: '画个正反转别加互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，别加互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，不加自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '画个正反转，去掉自锁', expect: { ok: false } },
  { text: '画个正反转（不要互锁）', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，不加互锁和自锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false } } },
  { text: '画个正反转，只要自锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true } } },
  { text: '画个正反转，除了互锁都要', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true } } },
  { text: '画个正反转，除了自锁都要', expect: { op: 'draw', type: 'reverse', attrs: { interlock: true, selflock: false } } },
  { text: '画个互锁，要自锁', expect: { op: 'draw', type: 'interlock', attrs: { selflock: true } } },
  { text: '画个正反转，省掉自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '画个正反转，省掉互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，省掉自锁和互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false } } },
  { text: '画个正反转，不要互锁要自锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true } } },
  { text: '画个正反转，不要自锁要互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: true, selflock: false } } },
  { text: '画个正反转，不要互锁，要自锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true } } },
  { text: '画个正反转，不要互锁和自锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false } } },
  { text: '画个正反转，互锁和自锁都不要', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false } } },
  { text: '画个正反转，互锁、自锁都不要', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false } } },
  { text: '画个正反转，自锁和互锁都别加', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false } } },
  { text: '请把互锁去掉，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '把互锁去掉，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '去掉互锁，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，把互锁去掉', expect: { op: 'remove', object: 'interlock' } },
  { text: '把互锁去掉，画个正反转带主电路', expect: { op: 'draw', type: 'reverse', attrs: { main: true, interlock: false } } },
  { text: '画个正反转，带QA1和QA2', expect: { ok: false } },
  { text: '把 QA1 接到 SF1', expect: { op: 'connect', from: 'QA1', to: 'SF1' } },
  { text: '删掉 QA1', expect: { op: 'remove', key: 'QA1' } },
  { text: '放一个熔断器', expect: { op: 'place', component: 'fuse' } },
  { text: '检查一下', expect: { op: 'check' } },
  { text: '清空', expect: { op: 'clear' } },
  { text: '画布上有什么', expect: { ok: false } },
  { text: '别把互锁删了', expect: { op: 'none' } },
  { text: '把互锁去掉', expect: { op: 'remove', object: 'interlock' } }
].forEach(function (c) { CASES.push(c); });

let pass = 0, fail = 0;

CASES.forEach(function (c) {
  let r, errs = [];
  try {
    r = R.route(c.text);
    errs = valid(r);
  } catch (e) {
    errs = ['抛异常：' + (e && e.message)];
  }

  const e = c.expect || {};
  if (!errs.length) {
    if (e.ok === false) {
      if (r.ok) errs.push('期望不识别，实际 ok=true');
    } else {
      if (!r.ok) errs.push('期望 ok=true，实际 false');
      if (e.op && r.op !== e.op) errs.push('op=' + r.op + '，期望 ' + e.op);
      if (e.type && r.type !== e.type) errs.push('type=' + r.type + '，期望 ' + e.type);
      if (e.clear && !r.clear) errs.push('期望 clear=true');
      if (e.key && r.key !== e.key) errs.push('key=' + r.key + '，期望 ' + e.key);
      if (e.from && r.from !== e.from) errs.push('from=' + r.from + '，期望 ' + e.from);
      if (e.to && r.to !== e.to) errs.push('to=' + r.to + '，期望 ' + e.to);
      if (e.object && r.object !== e.object) errs.push('object=' + r.object + '，期望 ' + e.object);
      if (e.component && r.component !== e.component) errs.push('component=' + r.component + '，期望 ' + e.component);
      if (e.attrs) {
        Object.keys(e.attrs).forEach(function (k) {
          if (!r.attrs || r.attrs[k] !== e.attrs[k]) {
            errs.push('attrs.' + k + '=' + (r.attrs && r.attrs[k]) + '，期望 ' + e.attrs[k]);
          }
        });
      }
    }
  }

  if (errs.length) {
    fail++;
    console.log('✗ ' + c.text);
    errs.forEach(function (x) { console.log('  · ' + x); });
  } else {
    pass++;
  }
});

console.log('');
console.log('通过 ' + pass + ' / ' + CASES.length + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
