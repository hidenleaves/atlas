#!/usr/bin/env node
/* ============================================================
   route-test.js — 路由 v2 原型回归用例
   ------------------------------------------------------------
   用法： node tools/route-test.js
   只读 js/route.js，不加载画布、不碰 DOM。
   ============================================================ */
'use strict';

const R = require('../js/route.js');

const CASES = [
  { text: '清空', expect: { op: 'clear' } },
  { text: '画一个自锁', expect: { op: 'draw', type: 'selflock' } },
  { text: '画一个起保停', expect: { op: 'draw', type: 'selflock' } },
  { text: '画一个点动', expect: { op: 'draw', type: 'jog' } },
  { text: '互锁', expect: { op: 'draw', type: 'interlock' } },
  { text: '画一个互锁', expect: { op: 'draw', type: 'interlock' } },

  { text: '正反转', expect: { op: 'draw', type: 'reverse', attrs: { interlock: true, selflock: true } } },
  { text: '正反转带互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: true } } },
  { text: '正反转不带互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '正反转无互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '正反转带自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: true } } },
  { text: '正反转不带自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },

  { text: '去除互锁', expect: { op: 'remove', object: 'interlock' } },
  { text: '别把互锁删了', expect: { op: 'none' } },
  { text: '不要把互锁删了', expect: { op: 'none' } },
  { text: '互锁不要画', expect: { op: 'none' } },
  { text: '正反转不要画', expect: { op: 'none' } },
  { text: '不要画互锁', expect: { op: 'none' } },
  { text: '不想再画互锁', expect: { op: 'none' } },

  { text: '不要正反转，只要互锁', expect: { op: 'draw', type: 'interlock' } },
  { text: '不能没有互锁', expect: { op: 'draw', type: 'interlock' } },
  { text: '把互锁去掉，再画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false }, steps: ['draw'] } },
  { text: '清空，画一个互锁', expect: { op: 'draw', type: 'interlock', clear: true, steps: ['clear', 'draw'] } },
  { text: '清空再画互锁', expect: { op: 'draw', type: 'interlock', clear: true, steps: ['clear', 'draw'] } },

  { text: '画个正反转，不要自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '画个正反转，不带互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个互锁，自锁不要', expect: { op: 'draw', type: 'interlock', attrs: { selflock: false } } },
  { text: '正反转主电路不要', expect: { op: 'draw', type: 'reverse', attrs: { main: false } } },
  { text: '画个正反转，主电路要', expect: { op: 'draw', type: 'reverse', attrs: { main: true } } },
  { text: '互锁不要', expect: { op: 'none' } },
  { text: '先清空，再画个正反转', expect: { op: 'draw', type: 'reverse', steps: ['clear', 'draw'] } },
  { text: '画个起保停，然后加个自锁', expect: { op: 'add', object: 'selflock', steps: ['draw', 'add'] } },
  { text: '不要点动，画个自锁', expect: { op: 'draw', type: 'selflock' } },
  { text: '正反转没有互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '正反转不带互锁但带自锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true } } },
  { text: '主电路要，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { main: true } } },
  { text: '不要自锁，画个正反转', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '主电路不带热继电器，画个正反转带主电路', expect: {
    op: 'draw', type: 'reverse', attrs: { main: true, thermal: false }
  } },
  { text: '画个正反转别加互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，别加互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，不加自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '画个正反转带主电路，别画熔断器', expect: {
    op: 'draw', type: 'reverse', attrs: { main: true, fuse: false }
  } },
  { text: '画个正反转，去掉自锁', expect: { ok: false } },
  { text: '画个正反转，别删互锁', expect: { op: 'draw', type: 'reverse', steps: ['draw', 'none'] } },
  { text: '画个正反转（不要互锁）', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，不加互锁和自锁', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false }
  } },
  { text: '画个正反转，省掉自锁', expect: { op: 'draw', type: 'reverse', attrs: { selflock: false } } },
  { text: '画个正反转，省掉互锁', expect: { op: 'draw', type: 'reverse', attrs: { interlock: false } } },
  { text: '画个正反转，省掉自锁和互锁', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false }
  } },
  { text: '画个正反转，不要互锁要自锁', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true }
  } },
  { text: '画个正反转，不要自锁要互锁', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: true, selflock: false }
  } },
  { text: '画个正反转，不要互锁，要自锁', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: true }
  } },
  { text: '画个正反转，不要互锁和自锁', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false }
  } },
  { text: '画个正反转，互锁和自锁都不要', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false }
  } },
  { text: '画个正反转，互锁、自锁都不要', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false }
  } },
  { text: '画个正反转，自锁和互锁都别加', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false, selflock: false }
  } },
  { text: '请把互锁去掉，画个正反转', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false }, steps: ['draw']
  } },
  { text: '把互锁去掉，画个正反转', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false }, steps: ['draw']
  } },
  { text: '去掉互锁，画个正反转', expect: {
    op: 'draw', type: 'reverse', attrs: { interlock: false }, steps: ['draw']
  } },
  { text: '画个正反转，把互锁去掉', expect: {
    op: 'remove', object: 'interlock', steps: ['draw', 'remove']
  } },
  { text: '把互锁去掉，画个正反转带主电路', expect: {
    op: 'draw', type: 'reverse', attrs: { main: true, interlock: false }, steps: ['draw']
  } },
  { text: '画个正反转，带QA1和QA2', expect: { ok: false } },

  { text: '加个自锁', expect: { op: 'add', object: 'selflock' } },
  { text: '在现有图上加个自锁', expect: { op: 'add', object: 'selflock' } },
  { text: '放一个熔断器', expect: { op: 'place', component: 'fuse' } },
  { text: '加一个熔断器', expect: { op: 'place', component: 'fuse' } },
  { text: '把 QA1 接到 SF1', expect: { op: 'connect', from: 'QA1', to: 'SF1' } },
  { text: '删掉 QA1', expect: { op: 'remove', key: 'QA1' } },
  { text: '检查一下', expect: { op: 'check' } },

  { text: '画布上有什么', expect: { ok: false } },
  { text: '正反转带主电路', expect: {
    op: 'draw', type: 'reverse',
    attrs: { main: true }
  } },
  { text: '正反转带主电路不带热继电器', expect: {
    op: 'draw', type: 'reverse',
    attrs: { main: true, thermal: false }
  } },
  { text: '正反转带主电路、熔断器、热继电器、自锁', expect: {
    op: 'draw', type: 'reverse',
    attrs: { main: true, fuse: true, thermal: true, selflock: true }
  } },
  { text: '正反转主电路不带热继电器', expect: {
    op: 'draw', type: 'reverse',
    attrs: { main: true, thermal: false }
  } },
  { text: '不要主电路的正反转', expect: {
    op: 'draw', type: 'reverse',
    attrs: { main: false }
  } },
  { text: '重画一个正反转', expect: { op: 'draw', type: 'reverse', clear: true } },
  { text: '画一个星三角', expect: {
    op: 'draw', type: 'star',
    attrs: { main: true, interlock: true }
  } },
  { text: '画一个两地控制', expect: { op: 'draw', type: 'remote' } },
  { text: '多地控制', expect: { op: 'draw', type: 'remote' } }
];

function check(r, exp) {
  const errs = [];
  if (exp.ok === false) {
    if (r.ok) errs.push('期望识别失败，实际成功');
    return errs;
  }
  if (!r || !r.ok) {
    errs.push('识别失败：' + (r && r.reason || 'unknown'));
    return errs;
  }
  for (const k of Object.keys(exp)) {
    if (k === 'ok') continue;
    if (k === 'attrs') {
      for (const a of Object.keys(exp.attrs)) {
        const got = r.attrs && r.attrs[a];
        if (got !== exp.attrs[a]) {
          errs.push(`attrs.${a}=${String(got)}，期望 ${String(exp.attrs[a])}`);
        }
      }
    } else if (k === 'steps') {
      const got = (r.steps || []).map(s => s.op);
      const want = exp.steps;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        errs.push(`steps=${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
      }
    } else if (r[k] !== exp[k]) {
      errs.push(`${k}=${JSON.stringify(r[k])}，期望 ${JSON.stringify(exp[k])}`);
    }
  }
  return errs;
}

function short(r) {
  if (!r || !r.ok) return 'FAIL';
  const bits = [r.op];
  if (r.type) bits.push(r.type);
  if (r.object) bits.push('object=' + r.object);
  if (r.component) bits.push('component=' + r.component);
  if (r.key) bits.push('key=' + r.key);
  if (r.from) bits.push(r.from + '→' + r.to);
  if (r.clear) bits.push('clear');
  if (r.attrs) {
    const on = Object.keys(r.attrs).filter(k => r.attrs[k]);
    if (on.length) bits.push('[' + on.join(',') + ']');
  }
  return bits.join(' ');
}

let pass = 0, fail = 0;

console.log('');
console.log('路由 v2 原型 · 回归用例');
console.log('='.repeat(78));

CASES.forEach((c, i) => {
  const r = R.route(c.text);
  const errs = check(r, c.expect);
  const n = String(i + 1).padStart(2, ' ');
  if (errs.length) {
    fail++;
    console.log(`${n}. ✗ ${c.text}`);
    console.log(`      实际：${short(r)}`);
    errs.forEach(e => console.log(`      · ${e}`));
  } else {
    pass++;
    const label = c.expect.ok === false ? '（按预期不识别，交模型）' : short(r);
    console.log(`${n}. ✓ ${c.text}  →  ${label}`);
  }
});

console.log('='.repeat(78));
console.log(`通过 ${pass} / ${CASES.length}，失败 ${fail}`);
console.log('');

process.exit(fail ? 1 : 0);
