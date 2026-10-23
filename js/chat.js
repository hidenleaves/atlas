/* ============================================================
   plc-atlas · 对话式作图 (PLCChat)
   ------------------------------------------------------------
   输入一句话 → 识别意图 → 调 PLCApi 落到画布 → 自检汇报。

   两级识别：
     1. 内置解析（毫秒级，离线可用，覆盖高频说法）
     2. 语言模型（可选，OpenAI 兼容端点 / Ollama），适合开放式描述

   模型只负责"选哪个工具、传什么参数"，坐标和走线一律由
   PLCApi 决定 —— 所以模型再弱也不会画出歪线。
   ============================================================ */
(function (global) {
  'use strict';

  var A = global.PLCApi;
  if (!A) return;

  var CFG_KEY = 'plc-atlas.llm.v1';

  /* ---------------- 词表 ---------------- */

  var TYPE_WORDS = [
    [/接触器线圈|主线圈|接触器/, 'coil'],
    [/中间继电器/, 'kCoil'],
    [/时间继电器/, 'ktCoil'],
    [/线圈/, 'coil'],
    [/常闭按钮/, 'btnNc'],
    [/急停/, 'btnStop'],
    [/行程/, 'limit'],
    [/常闭(触点)?|动断/, 'nc'],
    [/常开(触点)?|动合/, 'no'],
    [/按钮|按键/, 'btnNo'],
    [/熔断器|保险丝|保险/, 'fuse'],
    [/热继电器|热保护|热元件/, 'thermal'],
    [/断路器|空气开关/, 'breaker'],
    [/电机|电动机|马达/, 'motor'],
    [/信号灯|指示灯|灯/, 'lamp'],
    [/电铃|铃/, 'bell'],
    [/接地/, 'ground'],
    [/主触点|三相触点/, 'contactor3']
  ];

  function detectType(s) {
    for (var i = 0; i < TYPE_WORDS.length; i++) {
      if (TYPE_WORDS[i][0].test(s)) return TYPE_WORDS[i][1];
    }
    return null;
  }

  function typeName(t) {
    var T = global.PLCEditorModel.TYPES[t];
    return T ? T.name : t;
  }

  /* ---------------- 模板电路 ---------------- */

  function buildJog(doc) {
    A.clear(doc);
    A.place(doc, 'btnNo', { key: 'SF1', x: 220, y: 120 });
    A.place(doc, 'coil', { key: 'QA1', x: 220, y: 250 });
    A.link(doc, 'SF1', 'QA1');
    A.lead(doc, 'SF1', 0, 220, 60);
    A.lead(doc, 'QA1', 1, 220, 400);
    doc.title = '点动控制';
    return '点动回路：按住 SF1 接触器吸合，松开就停。';
  }

  function buildSelfLock(doc) {
    A.clear(doc);
    A.place(doc, 'btnNo', { key: 'SF1', x: 220, y: 120 });
    A.place(doc, 'btnNc', { key: 'SF2', x: 220, y: 230 });
    A.place(doc, 'coil', { key: 'QA1', x: 220, y: 340 });
    A.link(doc, 'SF1', 'SF2');
    A.link(doc, 'SF2', 'QA1');
    A.addSelfLock(doc, 'QA1', 'SF1');
    A.lead(doc, 'SF1', 0, 220, 60);
    A.lead(doc, 'QA1', 1, 220, 460);
    doc.title = '起保停控制';
    return '起保停画好了：SF1 启动、SF2 停止、QA1 接触器，自锁触点已经并联在启动按钮两端 —— 松开按钮也能保持。';
  }

  /* ---------------- 内置解析 ---------------- */

  function interpret(text, doc, ui) {
    var s = String(text || '').trim();
    if (!s) return null;

    // 清空
    if (/(清空|清掉|全部删除|重来|新建)/.test(s) && !/(新建|重来).*(画|加)/.test(s)) {
      var n = A.clear(doc).removed;
      return { reply: '清空了，删掉 ' + n + ' 个元件。', changed: true };
    }

    // 生成模板
    if (/(画|做|建|生成|来个|帮我弄).*(起保停|自锁|自保持)/.test(s) ||
        /^(起保停|自锁)/.test(s)) {
      return { reply: buildSelfLock(doc), changed: true };
    }
    if (/(画|做|建|生成|来个|帮我弄).*(点动)/.test(s) || /^点动/.test(s)) {
      return { reply: buildJog(doc), changed: true };
    }

    // 补自锁
    if (/自锁/.test(s) && /(加|补|放|添)/.test(s)) {
      var coilKey = (s.match(/(QA|KA|KM)\d*/i) || [])[0] || null;
      var r = A.addSelfLock(doc, coilKey || autoCoilKey(doc), null);
      if (!r.ok) return { reply: '没补上：' + r.error, changed: false };
      return { reply: '给 ' + r.key + ' 补了常开触点，并联在按钮两端，现在松手也能保持。', changed: true };
    }

    // 检查
    if (/(检查|看一下|对不对|有没有错|诊断)/.test(s)) {
      var chk = A.analyze(doc);
      if (chk.ok) return { reply: '检查过了，接法没问题。', changed: false };
      return {
        reply: '发现 ' + chk.issues.length + ' 处：\n' +
          chk.issues.map(function (x) { return '· ' + x.msg; }).join('\n'),
        changed: false
      };
    }

    // 删除
    var delM = s.match(/(删|去掉|移除)\D*((QA|SF|KA|KT|FA|BB|M)\d+)/i);
    if (delM) {
      var d = A.remove(doc, delM[2]);
      return d.ok
        ? { reply: '删掉了 ' + delM[2] + '，连带 ' + d.wiresRemoved + ' 根线一起清理。', changed: true }
        : { reply: '没找到 ' + delM[2] + '。', changed: false };
    }

    // 连线
    var lk = s.match(/(接|连)上?\s*((QA|SF|KA|KT|FA|BB)\d+)\s*(到|和|跟)\s*((QA|SF|KA|KT|FA|BB)\d+)/i);
    if (lk) {
      var c = A.link(doc, lk[2], lk[5]);
      return c.ok
        ? { reply: '接好了：' + c.from + ' → ' + c.to + '。', changed: true }
        : { reply: '没连上：' + c.error, changed: false };
    }

    // 放元件
    if (/(加|放|添加|来个|添)/.test(s)) {
      var type = detectType(s);
      if (type) {
        var key = (s.match(/\b(QA|SF|KA|KT|FA|BB|M|HL|YV)\d+/i) || [])[0] || null;
        var nearM = s.match(/(?:在|靠近|接到)\s*((QA|SF|KA|KT|FA|BB)\d+)\s*(下面|上面|左边|右边|旁)/i);
        var side = 'right';
        if (nearM) {
          side = /下面/.test(nearM[3]) ? 'below'
            : /上面/.test(nearM[3]) ? 'above'
            : /左边/.test(nearM[3]) ? 'left' : 'right';
        }
        var pr = A.place(doc, type, {
          key: key || undefined,
          near: nearM ? nearM[1] : undefined,
          side: side
        });
        if (!pr.ok) return { reply: pr.error, changed: false };
        return {
          reply: '放了' + (pr.name) + (pr.key ? '（' + pr.key + '）' : '') +
            '，在 ' + pr.x + ',' + pr.y + '。要接的话跟我说"把 X 接到 Y"。',
          changed: true
        };
      }
    }

    return null;
  }

  function autoCoilKey(doc) {
    var c = doc.comps.filter(function (x) { return /coil/i.test(x.type); })[0];
    return c ? c.key : null;
  }

  /* ---------------- 模型接入（可选） ---------------- */

  function cfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveCfg(o) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(o)); return true; }
    catch (e) { return false; }
  }

  function toolSpecs() {
    return [
      {
        type: 'function',
        function: {
          name: 'place_component',
          description: '在图纸上放一个电气元件，位置由画板自动安排',
          parameters: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'coil=接触器线圈, no=常开触点, nc=常闭触点, btnNo=按钮, btnNc=常闭按钮, fuse=熔断器, thermal=热继电器, motor=电机, lamp=信号灯' },
              key: { type: 'string', description: '代号，如 QA1、SF2' },
              near: { type: 'string', description: '放在哪个元件旁边（代号）' },
              side: { type: 'string', enum: ['right', 'left', 'below', 'above'] }
            },
            required: ['type']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'connect',
          description: '把两个引脚用导线连起来，走线由画板自动正交',
          parameters: {
            type: 'object',
            properties: {
              from: { type: 'string', description: '如 QA1#1（1 表示下脚，0 表示上脚）' },
              to: { type: 'string', description: '如 SF1#0' }
            },
            required: ['from', 'to']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'link',
          description: '按代号把两个元件自然连接（自动选上下脚）',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'string' }, b: { type: 'string' }
            },
            required: ['a', 'b']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_self_lock',
          description: '给某个线圈补一个同名常开触点，并联到按钮两端实现自锁',
          parameters: {
            type: 'object',
            properties: {
              coil: { type: 'string', description: '线圈代号' },
              button: { type: 'string', description: '要并联的按钮代号' }
            },
            required: ['coil']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'remove',
          description: '删除一个元件（连带它的导线）',
          parameters: {
            type: 'object', properties: { ref: { type: 'string' } }, required: ['ref']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'check',
          description: '检查当前接线，返回电气问题列表',
          parameters: { type: 'object', properties: {} }
        }
      }
    ];
  }

  function runTool(name, args, doc) {
    switch (name) {
      case 'place_component': return A.place(doc, args.type, args);
      case 'connect': return A.connect(doc, args.from, args.to);
      case 'link': return A.link(doc, args.a, args.b);
      case 'add_self_lock': return A.addSelfLock(doc, args.coil, args.button);
      case 'remove': return A.remove(doc, args.ref);
      case 'check': return A.analyze(doc);
      default: return { ok: false, error: '没有这个工具 ' + name };
    }
  }

  function callModel(text, doc) {
    var c = cfg();
    if (!c.endpoint || typeof fetch !== 'function') return Promise.resolve(null);
    var body = {
      model: c.model || 'qwen3:4b',
      messages: [
        {
          role: 'system',
          content: '你是 PLC 电气图纸助手。用户会用中文描述想画的电路。' +
            '你只能调用提供的工具来完成，绝对不要自己编造坐标。' +
            '常用元件 type：coil 接触器线圈、no 常开触点、nc 常闭触点、btnNo 按钮、btnNc 常闭按钮、fuse 熔断器、thermal 热继电器、motor 电机。' +
            '画起保停的顺序：放 btnNo(SF1) → 放 btnNc(SF2) → 放 coil(QA1) → link SF1 到 SF2 → link SF2 到 QA1 → add_self_lock(QA1, SF1)。' +
            '做完后用 check 工具确认没有错误。'
        },
        { role: 'user', content: text }
      ],
      tools: toolSpecs(),
      stream: false
    };
    return fetch(c.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var msg = (j.choices && j.choices[0] && j.choices[0].message) || null;
      if (!msg) return null;
      var calls = msg.tool_calls || [];
      if (!calls.length) {
        return { reply: msg.content || '我没理解你的意思，换个说法试试？', changed: false };
      }
      var log = [];
      calls.forEach(function (call) {
        var name = call.function && call.function.name;
        var args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
        var r = runTool(name, args, doc);
        log.push((r.ok ? '✓ ' : '✗ ') + name + (r.error ? '（' + r.error + '）' : ''));
      });
      return { reply: msg.content || ('按你说的做了：\n' + log.join('\n')), changed: true };
    }).catch(function (e) {
      return { reply: '模型没连上（' + e.message + '），我先用内置规则处理。', changed: false, fallback: true };
    });
  }

  /* ---------------- UI ---------------- */

  var el = {}, hooks = {};
  var busy = false;

  function bubble(role, text) {
    var d = document.createElement('div');
    d.className = 'chat-msg ' + role;
    d.textContent = text;
    el.log.appendChild(d);
    el.log.scrollTop = el.log.scrollHeight;
    return d;
  }

  function submit() {
    if (busy) return;
    var text = (el.input.value || '').trim();
    if (!text) return;
    el.input.value = '';
    bubble('me', text);

    var doc = hooks.getDoc && hooks.getDoc();
    if (!doc) { bubble('bot', '先切到画板再说话。'); return; }

    busy = true;
    var thinking = bubble('bot', '…');

    function done(res) {
      thinking.remove();
      bubble('bot', res.reply);
      if (res.changed && hooks.refresh) hooks.refresh();
      busy = false;
    }

    var local = interpret(text, doc, {});
    if (local) { setTimeout(function () { done(local); }, 60); return; }

    callModel(text, doc).then(function (res) {
      if (res) { done(res); return; }
      done({
        reply: '这句话我还没学会。能试试："画一个起保停"、"加个自锁"、"放一个熔断器"、"把 QA1 接到 SF1"、"检查一下"。\n' +
          '（想让我听懂更自由的描述，可以在设置里填模型地址）',
        changed: false
      });
    });
  }

  function openCfg() {
    var c = cfg();
    var endpoint = prompt('模型地址（OpenAI 兼容，留空则只用内置规则）\n例如 http://127.0.0.1:11434/v1/chat/completions', c.endpoint || '');
    if (endpoint === null) return;
    var model = prompt('模型名（Ollama 用 qwen3:4b）', c.model || 'qwen3:4b');
    if (model === null) return;
    saveCfg({ endpoint: endpoint.trim(), model: model.trim() });
    bubble('bot', endpoint.trim()
      ? '记下了，接下来会用 ' + model + ' 理解你的话。'
      : '已切回内置规则模式。');
  }

  function mount(opts) {
    hooks = opts || {};
    el.root = document.getElementById('edChat');
    if (!el.root) return;
    el.fab = document.getElementById('chatFab');
    el.panel = document.getElementById('chatPanel');
    el.log = document.getElementById('chatLog');
    el.input = document.getElementById('chatInput');
    el.send = document.getElementById('chatSend');
    el.close = document.getElementById('chatClose');
    el.cfg = document.getElementById('chatCfg');

    el.fab.addEventListener('click', function () {
      el.panel.hidden = !el.panel.hidden;
      if (!el.panel.hidden) el.input.focus();
    });
    el.close.addEventListener('click', function () { el.panel.hidden = true; });
    el.send.addEventListener('click', submit);
    if (el.cfg) el.cfg.addEventListener('click', openCfg);

    // 中文输入法：回车正在选字时不要发送
    var composing = false;
    el.input.addEventListener('compositionstart', function () { composing = true; });
    el.input.addEventListener('compositionend', function () { composing = false; });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !composing) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') el.panel.hidden = true;
    });

    if (!el.log.childNodes.length) {
      bubble('bot', '我是接线助手。可以直接说：画一个起保停、加个自锁、放一个熔断器、把 QA1 接到 SF1。');
    }
  }

  global.PLCChat = {
    mount: mount,
    interpret: interpret,
    buildJog: buildJog,
    buildSelfLock: buildSelfLock,
    cfg: cfg,
    saveCfg: saveCfg
  };
})(window);
