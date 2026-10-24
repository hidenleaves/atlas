'use strict';
/* 第 23 轮独立扰动审查 —— 只挑报告里没测的边界 */
global.window = global;
require('../js/editor-model.js');
require('../js/advisor.js');
require('../js/api.js');
require('../js/circuits.js');
global.PLCRoute = require('../js/route.js');
global.PLCPrompt = require('../js/prompt.js');
global.PLCTemplates = require('../js/templates.js');
require('../js/chat.js');
const M = global.PLCEditorModel, A = global.PLCApi, C = global.PLCChat, R = global.PLCRoute;

let bad = 0, good = 0, model = 0;

// 期望：nc/no 数量或 fuse 数量；'model' = 应回退模型；'none' = 不动作
const cases = [
  // A. 否定与时态/语气的组合（报告全没测）
  ['请把互锁去掉，画个正反转',       { model: true },  '宾语前置+动词被否'],
  ['画个正反转，不想要互锁',         { nc: 0 },        '"不想要"不在词表'],
  ['画个正反转，无需互锁',           { nc: 0 },        '"无需"在词表'],
  ['画个正反转，省掉自锁',           { no: 0 },        '"省掉"在词表'],

  // B. 否定作用域歧义（真难点）
  ['画个正反转，不要互锁要自锁',      { nc: 0, no: 2 }, '否定只在互锁上'],
  ['画个正反转，不要自锁要互锁',      { nc: 2, no: 0 }, '否定只在自锁上'],
  ['画个正反转，互锁和自锁都不要',    { nc: 0, no: 0 }, '后置否定+并列'],

  // C. 双重否定（报告点名让测，但没说期望）
  ['画个正反转，别不要互锁',         { nc: 2 },        '双重否定=要'],
  ['画个正反转不能没有互锁',         { nc: 2 },        '双重否定=要'],

  // D. 数字/单位干扰（findRefs 可能误吃）
  ['画个正反转，用2个接触器',        { type: 'reverse' },'数字不应干扰'],
  ['画个正反转，带QA1和QA2',         { type: 'reverse' },'代号不应干扰'],

  // E. 单引脚回路的极端形态
  ['__SINGLE_TWO_TERMS__',           { single: true }, '两端子单支路'],
  ['__SINGLE_NO_TERM__',             { singleNoTerm: true }, '无需端子'],

  // F. 空节点 / 全错引脚
  ['__EMPTY_NODE__',                 { emptyNode: true }, '空 pins 数组'],
  ['__BAD_PIN__',                    { badPin: true },  '引脚不存在'],

  // G. 模板接口层：报告说 thermal 静默忽略
  ['__TPL_THERMAL__',                { thermalIgnored: true }, 'drawTemplate thermal:false'],

  // H. 图集端子 name 缺失
  ['__ATLAS_TERM_NAME__',            { termName: true }, '图集端子是否有 name'],

  // I. 连续两次 draw_plan（状态污染）
  ['__TWO_PLANS__',                  { twoPlans: true }, '连续两次 draw_plan'],
];

function run(q, exp) {
  // 特殊探针
  if (q === '__SINGLE_TWO_TERMS__') {
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
      detail: `ok=${r.ok} terms=${terms.length} 有引线=${wiresOk} 压引脚=${onPin} level=${r.level}` };
  }
  if (q === '__SINGLE_NO_TERM__') {
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1', near: 'SF1' }],
      nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }]
    });
    return { ok: r.ok, detail: `ok=${r.ok} comps=${d.comps.length} wires=${d.wires.length} level=${r.level}` };
  }
  if (q === '__EMPTY_NODE__') {
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1', near: 'SF1' }],
      nodes: [{ name: 'L', pins: [] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }]
    });
    return { ok: r.ok === false && r.rolledBack === true,
      detail: `ok=${r.ok} rolledBack=${r.rolledBack} 应拒绝空节点` };
  }
  if (q === '__BAD_PIN__') {
    const d = M.blank();
    const r = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }],
      nodes: [{ name: 'L', pins: ['SF1#0', 'SF1#9'] }]
    });
    return { ok: r.ok === false, detail: `ok=${r.ok} rolledBack=${r.rolledBack} err=${String(r.error).slice(0, 40)}` };
  }
  if (q === '__TPL_THERMAL__') {
    const d = M.blank();
    const r = A.drawTemplate(d, { kind: 'reverse', main: true, thermal: false });
    const thermal = d.comps.filter(c => c.type === 'thermal').length;
    return { ok: false, detail: `ok=${r.ok} thermal元件=${thermal} → 参数被${thermal ? '静默忽略(已知)' : '采纳'}` };
  }
  if (q === '__ATLAS_TERM_NAME__') {
    const d = M.blank();
    A.drawTemplate(d, { kind: 'remote' });
    const terms = d.marks.filter(m => m.kind === 'term');
    const named = terms.filter(t => t.name).length;
    return { ok: false, detail: `${terms.length} 个端子，有 name 的 ${named} 个(已知差异)` };
  }
  if (q === '__TWO_PLANS__') {
    const d = M.blank();
    const r1 = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF1' }, { type: 'coil', key: 'QA1', near: 'SF1' }],
      nodes: [{ name: 'L', pins: ['SF1#0'] }, { name: 'A', pins: ['SF1#1', 'QA1#0'] }, { name: 'N', pins: ['QA1#1'] }]
    });
    const c1 = d.comps.length;
    const r2 = A.drawPlan(d, {
      components: [{ type: 'btnNo', key: 'SF2' }, { type: 'coil', key: 'QA2', near: 'SF2' }],
      nodes: [{ name: 'L', pins: ['SF2#0'] }, { name: 'A', pins: ['SF2#1', 'QA2#0'] }, { name: 'N', pins: ['QA2#1'] }]
    });
    return { ok: r1.ok && r2.ok && d.comps.length === 4,
      detail: `r1=${r1.ok} r2=${r2.ok} comps ${c1}→${d.comps.length}` };
  }

  // 普通路由用例
  const d = M.blank();
  const rt = R.route(q);
  const res = C.interpretV2(q, d);
  const nc = d.comps.filter(c => c.type === 'nc').length;
  const no = d.comps.filter(c => c.type === 'no').length;
  const fuse = d.comps.filter(c => /fuse/.test(c.type)).length;

  if (exp.model) {
    return { ok: res === null, detail: res ? `未回退模型！画了 comps=${d.comps.length} nc=${nc}` : '正确回退模型' };
  }
  if (res === null) return { ok: !!exp.model, detail: '回退模型', kind: 'model' };
  const bads = [];
  if (exp.nc != null && nc !== exp.nc) bads.push(`nc=${nc}≠${exp.nc}`);
  if (exp.no != null && no !== exp.no) bads.push(`no=${no}≠${exp.no}`);
  if (exp.type && rt.type !== exp.type) bads.push(`type=${rt.type}≠${exp.type}`);
  const contradiction = /好的，不动/.test(res.reply);
  if (contradiction && /画好了/.test(res.reply)) bads.push('回复自相矛盾');
  return { ok: !bads.length, detail: `nc=${nc} no=${no} comps=${d.comps.length}` + (bads.length ? ' ✗ ' + bads.join(',') : '') };
}

console.log('=== 第 23 轮独立扰动（' + cases.length + ' 条，与报告不重复）===');
for (const [q, exp, why] of cases) {
  let r;
  try { r = run(q, exp); } catch (e) { r = { ok: false, detail: 'EXCEPTION ' + e.message }; }
  const mark = r.ok ? '✓' : '✗';
  if (r.ok) good++; else if (r.kind === 'model') model++; else bad++;
  const label = q.startsWith('__') ? q.replace(/__/g, '') : q;
  console.log(mark, label.padEnd(26), '|', r.detail, '|', why);
}
console.log('\n通过 ' + good + ' / 失败 ' + bad + ' / 回退模型 ' + model + '  共 ' + cases.length);
