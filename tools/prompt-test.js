#!/usr/bin/env node
/* ============================================================
   prompt-test.js — 提示词与人设卡的静态回归
   ------------------------------------------------------------
   不调模型，只检查结构完整性：
     · 角色卡、工具纪律、失败处理、输出契约、风险边界都在
     · SYS 里提到的工具和 toolSpecs 一一对应
     · schema 有 enum / min / max，避免模型乱填
     · 提示词别膨胀到失控
   ============================================================ */
'use strict';

global.window = global;
require('../js/editor-model.js');
require('../js/advisor.js');
require('../js/api.js');
require('../js/circuits.js');
global.PLCRoute = require('../js/route.js');
const P = require('../js/prompt.js');
global.PLCPrompt = P;
global.PLCTemplates = require('../js/templates.js');
require('../js/chat.js');
const C = global.PLCChat;
const SYS = P.SYS || '';
const specs = C.toolSpecs();
const tools = specs.map(function (t) { return t.function.name; });

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '  →  ' + detail : '')); }
}

check('SYS 非空', SYS.length > 200, '长度 ' + SYS.length);
check('提示词长度 < 9000 字符', SYS.length < 9000, '长度 ' + SYS.length);
check('没有 TODO / FIXME', !/TODO|FIXME/.test(SYS));
check('工具数为 8', tools.length === 8, tools.join(', '));

[
  '【角色卡】',
  '【第一原则',
  '【工具纪律】',
  '【先读画布现状】',
  '【components 怎么写】',
  '【nodes 怎么写】',
  '【失败处理】',
  '【输出契约】',
  '【风险与边界】'
].forEach(function (sec) {
  check('包含段落 ' + sec, SYS.indexOf(sec) >= 0);
});

tools.forEach(function (name) {
  check('SYS 提到工具 ' + name, SYS.indexOf(name) >= 0);
});

check('要求只使用提供的工具',
  /不发明工具|不要调用未提供|只调用提供/.test(SYS));
check('有失败只修一次的约束',
  /只改一次|不要反复重试/.test(SYS));
check('有危险配置的提示', /相间短路|熔断器|热继电器/.test(SYS));
check('有输出契约的顺序', /做了什么/.test(SYS) && /没接上的地方/.test(SYS));

const draw = specs.filter(function (t) { return t.function.name === 'draw_plan'; })[0];
const drawItem = draw && draw.function.parameters.properties.components.items;
check('draw_plan 有元件类型 enum',
  !!(drawItem && Array.isArray(drawItem.properties.type.enum) &&
     drawItem.properties.type.enum.indexOf('coil') >= 0));
check('draw_plan 的 branch 有上下界',
  !!(drawItem && drawItem.properties.branch.minimum === 1 &&
     drawItem.properties.branch.maximum === 6));
check('draw_plan 的 nodes.pins 至少 2 个',
  !!(draw && draw.function.parameters.properties.nodes.items.properties.pins.minItems === 2));
check('draw_plan 有 terminals schema',
  !!(draw && draw.function.parameters.properties.terminals));
check('SYS 提到 terminals', SYS.indexOf('terminals') >= 0);

const place = specs.filter(function (t) { return t.function.name === 'place_component'; })[0];
check('place_component 有类型 enum',
  !!(place && Array.isArray(place.function.parameters.properties.type.enum)));

const tmpl = specs.filter(function (t) { return t.function.name === 'draw_template'; })[0];
check('draw_template 有 kind enum',
  !!(tmpl && Array.isArray(tmpl.function.parameters.properties.kind.enum) &&
     tmpl.function.parameters.properties.kind.enum.indexOf('reverse') >= 0));
check('draw_template 有 main 开关',
  !!(tmpl && tmpl.function.parameters.properties.main));
check('SYS 提到 main:true', SYS.indexOf('main:true') >= 0);
check('draw_template 有 remote 模板',
  !!(tmpl && tmpl.function.parameters.properties.kind.enum.indexOf('remote') >= 0));
check('SYS 提到 remote', SYS.indexOf('remote') >= 0);

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
console.log('');
process.exit(fail ? 1 : 0);
