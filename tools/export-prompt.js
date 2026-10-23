#!/usr/bin/env node
/* ============================================================
   export-prompt.js — 把 js/prompt.js 的 SYS 原样导出到 提示词.md
   ------------------------------------------------------------
   用法： node tools/export-prompt.js
   以前 提示词.md 是手抄的，示例被压扁、和代码不同步；现在只生成，不改。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

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
const root = path.join(__dirname, '..');
const out = path.join(root, '提示词.md');

const tools = C.toolSpecs().map(function (t) { return t.function; });
const d = C.defaults || {};

const md = [
  '# 对话作图 · 系统提示词与工具清单',
  '',
  '> 由 `tools/export-prompt.js` 生成，**请勿手改**。',
  '> 改人设/规则请改 `js/prompt.js`；改工具 schema 请改 `js/chat.js`。',
  '',
  '## 当前接入',
  '',
  '- 端点：`' + (d.endpoint || '—') + '`',
  '- 模型：`' + (d.model || '—') + '`',
  '- 流式：开启（`stream_options.include_usage`）',
  '- 工具数：' + tools.length,
  '',
  '## 工具清单',
  '',
].concat(tools.map(function (t) {
  return '- **' + t.name + '** — ' + String(t.description || '').split('\n')[0];
})).concat([
  '',
  '## 系统提示词全文',
  '',
  '```text',
  P.SYS,
  '```',
  ''
]).join('\n');

fs.writeFileSync(out, md, 'utf8');
console.log('生成 ' + path.relative(root, out));
console.log('  提示词 ' + P.SYS.length + ' 字符，工具 ' + tools.length + ' 个');
