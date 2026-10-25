#!/usr/bin/env node
/* ============================================================
   chat-claim-test.js — 验证 callModel 真的会拦截“嘴上画完”
   ------------------------------------------------------------
   不联网：用假 fetch 返回一段“点动电路已画好”的文本，
   但一个工具都不调用。callModel 必须在返回前把它改成
   “我没能画出来”，而不是把假话交给界面。
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
const C = global.PLCChat;

global.localStorage = {
  _v: {},
  getItem: function (k) { return this._v[k] == null ? null : this._v[k]; },
  setItem: function (k, v) { this._v[k] = String(v); }
};
C.saveCfg({
  endpoint: 'http://fake.local/v1/chat/completions',
  apiKey: 'sk-test',
  model: 'fake'
});

var chunks = [
  { choices: [{ delta: { content: '点动电路已画好：SF1 按钮直接串到 QA1 线圈。' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 } }
];
var sse = chunks.map(function (j) { return 'data: ' + JSON.stringify(j) + '\n'; }).join('') +
  'data: [DONE]\n';

global.fetch = function () {
  return Promise.resolve({
    ok: true,
    body: null,
    text: function () { return Promise.resolve(sse); }
  });
};

var doc = M.blank(760, 500);
C.callModel('画个点动', doc, null).then(function (res) {
  var ok = true;
  function assert(cond, msg) {
    if (!cond) { ok = false; console.log('✗ ' + msg); }
    else { console.log('✓ ' + msg); }
  }
  assert(res && res.via === 'model', '应走模型链路，实际 ' + JSON.stringify(res));
  assert(res && !res.changed, '本轮不应 changed');
  assert(res && /^我没能画出来/.test(res.reply), '应改成明确失败，实际：' + (res && res.reply));
  assert(res && /模型原话/.test(res.reply), '应保留模型原话');
  assert(doc.comps.length === 0, '画布不应有元件');
  console.log('');
  console.log(ok ? '通过 5 / 5' : '失败');
  process.exit(ok ? 0 : 1);
}).catch(function (e) {
  console.log('✗ 调用异常：' + (e && e.stack || e));
  process.exit(1);
});
