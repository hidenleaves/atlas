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

  /* 正反转：两条支路各自串一个对方的常闭触点做互锁，各带一个自锁触点。
     这是教材里的标准画法，也是"复杂图"的入门档 —— 内置一份，
     模型不给力时至少这条路能立刻出图。 */
  function buildReverse(doc) {
    A.clear(doc);
    // branch 1：正转支路（按钮 → 反转互锁 → 正转线圈）
    A.place(doc, 'btnNo', { key: 'SF1', branch: 1 });
    A.place(doc, 'nc', { key: 'QA2', branch: 1 });
    A.place(doc, 'coil', { key: 'QA1', branch: 1 });
    // branch 2：SF1 的自锁触点，与 SF1 同行
    A.place(doc, 'no', { key: 'QA1', branch: 2, align: 'SF1' });
    // branch 3：反转支路
    A.place(doc, 'btnNo', { key: 'SF2', branch: 3 });
    A.place(doc, 'nc', { key: 'QA1', branch: 3 });
    A.place(doc, 'coil', { key: 'QA2', branch: 3 });
    // branch 4：SF2 的自锁触点
    A.place(doc, 'no', { key: 'QA2', branch: 4, align: 'SF2' });

    var r = A.wireNodes(doc, [
      { name: 'L', pins: ['SF1#0', 'SF2#0', 'no:QA1#0', 'no:QA2#0'] },
      { name: 'A1', pins: ['SF1#1', 'no:QA1#1', 'nc:QA2#0'] },
      { name: 'A2', pins: ['nc:QA2#1', 'coil:QA1#0'] },
      { name: 'B1', pins: ['SF2#1', 'no:QA2#1', 'nc:QA1#0'] },
      { name: 'B2', pins: ['nc:QA1#1', 'coil:QA2#0'] },
      { name: 'N', pins: ['coil:QA1#1', 'coil:QA2#1'] }
    ]);
    doc.title = '正反转控制';
    if (!r.ok) {
      return '正反转画好了，但有几根线没接上：' +
        r.nodes.filter(function (n) { return !n.ok; })
          .map(function (n) { return n.node + '（' + n.error + '）'; }).join('；');
    }
    return '正反转画好了：SF1 正转、SF2 反转，各串对方的常闭触点做互锁（正转时不能反转），' +
      '自锁触点并联在按钮两端，正转和反转两个回路已接好。';
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
    // 只接住"纯正反转"，带附加要求（主电路、热继电器、星三角…）的交给模型
    if (/正反转|正反|互锁|可逆/.test(s) &&
        !/(主电路|热继电器|熔断器|电机|星三角|降压|再加|还要|同时)/.test(s)) {
      return { reply: buildReverse(doc), changed: true };
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

  var DEFAULTS = {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-v4-flash'
  };

  function toolSpecs() {
    return [
      {
        type: 'function',
        function: {
          name: 'place_component',
          description: '在图纸上放一个电气元件。必须给 branch（第几列，从 1 开始）：' +
            '同一列自动往下排，不同列往右开新列。主回路一列、并联支路另一列。',
          parameters: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'coil=接触器线圈, no=常开触点, nc=常闭触点, btnNo=按钮, btnNc=常闭按钮, fuse=熔断器, thermal=热继电器, motor=电机, lamp=信号灯' },
              key: { type: 'string', description: '代号，如 QA1、SF2（只写代号，不要带类型前缀）' },
              branch: { type: 'number', description: '第几列，从 1 开始。主回路 1，右侧并联支路 2' },
              align: { type: 'string', description: '可选。与被并联的元件同行（填它的代号），并联支路必须用它' },
              near: { type: 'string', description: '可选，放在哪个元件旁边（代号）' },
              side: { type: 'string', enum: ['right', 'left', 'below', 'above'] }
            },
            required: ['type', 'branch']
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
          name: 'wire_nodes',
          description: '按节点表一次性连好整张图的线。把电路描述成"哪些引脚属于同一根线"，' +
            '比逐个 connect 可靠得多，复杂图也不会漏。' +
            '同名元件必须带类型前缀：coil:QA1 是线圈，no:QA1 是自锁触点，nc:QA1 是常闭触点。',
          parameters: {
            type: 'object',
            properties: {
              nodes: {
                type: 'array',
                description: '节点列表，每个节点是一根等电位线',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '节点名，如 L、N、A' },
                    pins: {
                      type: 'array',
                      items: { type: 'string' },
                      description: '属于这根线的引脚，如 ["SF1#0","no:QA1#0"]。#0 上脚，#1 下脚'
                    }
                  },
                  required: ['name', 'pins']
                }
              }
            },
            required: ['nodes']
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
      },
      {
        type: 'function',
        function: {
          name: 'add_lead',
          description: '从某个引脚引一段线出去（画母线、电源线、引出端用）',
          parameters: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: '元件代号，如 SF1' },
              pin: { type: 'number', description: '0=上脚，1=下脚，默认 0' },
              dir: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '引出方向' },
              length: { type: 'number', description: '长度像素，默认 60' }
            },
            required: ['ref', 'dir']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'clear_drawing',
          description: '清空整张图纸（只在用户明确要求重画、清空时使用）',
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
      case 'wire_nodes': return A.wireNodes(doc, args.nodes);
      case 'clear_drawing': return A.clear(doc);
      case 'add_lead': {
        var pin = args.pin == null ? 0 : args.pin;
        var pr = A.pins(doc, args.ref + '#' + pin);
        if (!pr.ok) return pr;
        var pt = pr.pins[pin] || pr.pins[0];
        var len = args.length || 60;
        var x = pt.x, y = pt.y;
        if (args.dir === 'up') y -= len;
        else if (args.dir === 'down') y += len;
        else if (args.dir === 'left') x -= len;
        else x += len;
        return A.lead(doc, args.ref, pin, x, y);
      }
      default: return { ok: false, error: '没有这个工具 ' + name };
    }
  }

  /* ---------- 流式请求 ----------
     边收边显示，tool_calls 会分散在多个分片里，按 index 累积拼接。 */
  function postStream(messages, tools, onText) {
    var c = cfg();
    var endpoint = c.endpoint || DEFAULTS.endpoint;
    dbg('req', '模型=' + (c.model || DEFAULTS.model) +
      ' 消息=' + messages.length +
      ' [' + messages.map(function (m) { return m.role; }).join(',') + ']' +
      ' 工具=' + (tools ? tools.length : 0));
    var body = {
      model: c.model || DEFAULTS.model,
      messages: messages,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (tools) body.tools = tools;

    var headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;

    return fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = 'HTTP ' + r.status;
          try {
            var j = JSON.parse(t);
            msg += '：' + ((j.error && j.error.message) || t.slice(0, 120));
          } catch (e) { msg += '：' + t.slice(0, 120); }
          throw new Error(msg);
        });
      }
      if (!r.body || !r.body.getReader) {
        // 极端情况兜底：拿不到流就整包读
        return r.text().then(function (t) {
          var acc = { content: '', toolCalls: [], usage: null };
          t.split('\n').forEach(function (line) {
            if (line.indexOf('data:') !== 0) return;
            var d = line.slice(5).trim();
            if (!d || d === '[DONE]') return;
            try { absorb(JSON.parse(d), acc, null); } catch (e) {}
          });
          return acc;
        });
      }

      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var acc = { content: '', toolCalls: [], usage: null };

      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return acc;
          buf += dec.decode(res.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            var j;
            try { j = JSON.parse(data); } catch (e) { continue; }
            absorb(j, acc, onText);
          }
          return pump();
        });
      }
      return pump();
    });
  }

  // 把一片 SSE 数据并进累积器
  function absorb(j, acc, onText) {
    if (j.usage) acc.usage = j.usage;
    var ch = j.choices && j.choices[0];
    if (!ch) return;
    var d = ch.delta || {};
    if (d.content) {
      acc.content += d.content;
      if (onText) onText(acc.content);
    }
    if (d.tool_calls) {
      d.tool_calls.forEach(function (tc) {
        var i = tc.index == null ? 0 : tc.index;
        if (!acc.toolCalls[i]) {
          acc.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        var slot = acc.toolCalls[i];
        if (tc.id) slot.id = tc.id;
        if (tc.function) {
          if (tc.function.name) slot.function.name += tc.function.name;
          if (tc.function.arguments) slot.function.arguments += tc.function.arguments;
        }
      });
    }
  }

  /* ---------- token 计量 ---------- */
  // deepseek-v4-flash 官方价：$0.15 / 1M 输入，$0.60 / 1M 输出
  var PRICE = { input: 0.15, output: 0.60, fx: 7.2 };
  var sessionUsage = { prompt: 0, completion: 0 };

  function fmtNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function usageLine(u) {
    if (!u) return '';
    var p = u.prompt_tokens || 0, c = u.completion_tokens || 0;
    var cny = (p * PRICE.input + c * PRICE.output) / 1000000 * PRICE.fx;
    return '↑' + fmtNum(p) + '  ↓' + fmtNum(c) + '  ≈ ¥' + cny.toFixed(4);
  }

  function addUsage(u) {
    if (!u) return;
    sessionUsage.prompt += u.prompt_tokens || 0;
    sessionUsage.completion += u.completion_tokens || 0;
    updateStat();
  }

  function updateStat() {
    if (!el.stat) return;
    if (!sessionUsage.prompt && !sessionUsage.completion) {
      el.stat.hidden = true;
      return;
    }
    el.stat.hidden = false;
    el.stat.textContent = '本次会话  ↑' + fmtNum(sessionUsage.prompt) +
      '  ↓' + fmtNum(sessionUsage.completion) + '  ≈ ¥' +
      ((sessionUsage.prompt * PRICE.input + sessionUsage.completion * PRICE.output) /
        1000000 * PRICE.fx).toFixed(4);
  }

  var SYS = '你是 PLC 电气图纸助手，把用户的中文意图变成画布上的电路图。\n' +
    '\n【每条请求都带一条「画布现状」，先读再用】\n' +
    '· 已存在的元件不要重复放；用户说"这个""它"指「当前选中」的元件\n' +
    '· "加一个""再来"是增量，不要清空；只有明确说"重画/清空"才清\n' +
    '\n【硬流程：放 → 连 → 查，三步不能省】\n' +
    '第 1 步 放元件：所有元件在**同一轮里一次性放完**，不要放两个就停。\n' +
    '  place_component 必须给 branch（第几列，从 1 开始）。\n' +
    '  同一 branch 自动往下排成一条竖线；不同支路换 branch（1、2、3…）。\n' +
    '  并联在某个元件两端时，用 align 填被并联的元件代号，放在紧邻的新 branch 上。\n' +
    '第 2 步 连线：调**一次** wire_nodes，把整张图的所有节点一起传进去。\n' +
    '  绝对不要用一条条 connect —— 已经取消了，只能 wire_nodes。\n' +
    '第 3 步 检查：调 check。只有 error 级别要处理，warn/info 可以先不管。\n' +
    '\n【wire_nodes 怎么写】\n' +
    '把电路写成"等电位表"：同一个节点里的引脚属于同一根线。\n' +
    '引脚格式 "元件#脚"，脚从 0 开始：0 是上脚，1 是下脚。\n' +
    '同名元件必须带类型前缀，否则分不清是哪一个：\n' +
    '  coil:QA1 = QA1 的线圈；no:QA1 = QA1 的常开触点（自锁用）；nc:QA1 = QA1 的常闭触点（互锁用）\n' +
    '独占的代号（SF1、BB1）可以只写 SF1#0。\n' +
    '\n【返回结果怎么读】\n' +
    'wire_nodes 返回 ok:false 时，看 nodes 里带 X 的行，后面写着具体原因：\n' +
    '· "找不到元件 X" → 这个元件还没放，补 place_component 后再调一次 wire_nodes\n' +
    '· "和节点 Y 被连成了同一根线（短路）" → 元件摆错列了，把同列的元件改到不同 branch 重放\n' +
    '· "有 N 个引脚没接进这根线" → 该引脚引用写错了，检查 #0/#1 和类型前缀\n' +
    '修一次就够了，不要反复重试；仍然失败就如实告诉用户哪里卡住。\n' +
    '\n【示例：正反转（两个方向互锁）】\n' +
    '8 个元件，按支路分列。自锁触点紧挨被并联的按钮放，用 align 保持同行：\n' +
    '  branch 1 竖排：btnNo(SF1) → nc(QA2) → coil(QA1)   ← 正转支路\n' +
    '  branch 2 单件：no(QA1) align:SF1                   ← SF1 的自锁触点\n' +
    '  branch 3 竖排：btnNo(SF2) → nc(QA1) → coil(QA2)   ← 反转支路\n' +
    '  branch 4 单件：no(QA2) align:SF2                   ← SF2 的自锁触点\n' +
    'wire_nodes：\n' +
    '  L  = ["SF1#0","SF2#0","no:QA1#0","no:QA2#0"]\n' +
    '  A1 = ["SF1#1","no:QA1#1","nc:QA2#0"]\n' +
    '  A2 = ["nc:QA2#1","coil:QA1#0"]\n' +
    '  B1 = ["SF2#1","no:QA2#1","nc:QA1#0"]\n' +
    '  B2 = ["nc:QA1#1","coil:QA2#0"]\n' +
    '  N  = ["coil:QA1#1","coil:QA2#1"]\n' +
    '\n【示例：起保停】\n' +
    '  branch 1 竖排：btnNo(SF1) → btnNc(SF2) → coil(QA1)\n' +
    '  branch 2 单件：no(QA1) align:SF1\n' +
    '  L = ["SF1#0","no:QA1#0"]\n' +
    '  A = ["SF1#1","no:QA1#1","SF2#0"]\n' +
    '  B = ["SF2#1","coil:QA1#0"]\n' +
    '\n更复杂的电路照这个模式自己写：先把元件按支路分好列，再把每个"等电位点"列成一行。\n' +
    'wire_nodes 会自动画水平母线和竖直引出线，不需要再手动 add_lead。\n' +
    '回复用简短中文，说清做了什么、有没有没接上的地方，不要罗列工具名。';

  /* ---------- 给模型看的画布快照 ----------
     模型看不见画布，必须每次把"现在有什么"压缩成几行喂进去，
     否则它会重复放元件、认不出"这个""它"，也可能把已有的线再连一遍。 */
  function snapshot(doc, sel) {
    var M = global.PLCEditorModel;
    var names = doc.comps.map(function (c) {
      var nm = c.key || '未命名';
      return nm + '(' + c.type + ')';
    });
    var shown = names.slice(0, 40).join('、');
    if (names.length > 40) shown += ' …共 ' + names.length + ' 个';

    var lines = [];
    lines.push('【画布现状】' + (doc.title || '未命名') + '，画布 ' + doc.w + '×' + doc.h);
    lines.push('元件：' + (shown || '空'));
    lines.push('导线：' + doc.wires.length + ' 根');

    if (sel && sel.kind === 'comp') {
      var sc = doc.comps.filter(function (x) { return x.id === sel.id; })[0];
      if (sc) lines.push('当前选中：' + (sc.key || '未命名') + '(' + sc.type + ')');
    }

    var res = global.PLCAdvisor ? global.PLCAdvisor.analyze(doc) : null;
    if (res && res.issues.length) {
      lines.push('已有问题：' + res.issues.slice(0, 3).map(function (x) {
        return x.msg;
      }).join('；'));
    }
    return lines.join('\n');
  }

  // 工具结果只回关键字段，别把失败时的类型清单整坨塞回去
  function brief(r) {
    if (!r) return '{}';
    var o = {};
    ['ok', 'error', 'failed', 'total', 'key', 'id', 'type', 'x', 'y',
      'removed', 'wiresRemoved', 'wireId', 'level', 'from', 'to', 'points']
      .forEach(function (k) {
        if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
      });
    // wire_nodes 的失败原因全在 nodes 里，不传回去模型就只能看到 ok:false，
    // 它不知道该修哪个节点，于是重试或放弃 —— 这是"线连不上"没法自愈的主因。
    if (r.nodes) {
      o.nodes = r.nodes.map(function (n) {
        return (n.ok ? 'OK ' : 'X ') + (n.node || n.name || '?') +
          (n.wires ? '(' + n.wires + '根)' : '') +
          (n.error ? ' ' + n.error : '');
      }).slice(0, 10);
    }
    if (r.types) {
      o.types = r.types.map(function (t) { return String(t).split('(')[0]; })
        .slice(0, 24).join(',');
    }
    if (r.issues) {
      o.issues = r.issues.slice(0, 6).map(function (x) { return x.level + ':' + x.msg; });
    }
    return JSON.stringify(o);
  }

  // 多轮对话历史（不含 system），让"再往右一点""把它删掉"能接得上
  var conv = [];

  function callModel(text, doc, onText) {
    var c = cfg();
    if (!c.endpoint && !c.apiKey) return Promise.resolve(null);
    if (!c.apiKey && /deepseek|openai|moonshot|dashscope/i.test(c.endpoint || '')) {
      return Promise.resolve({
        reply: '还没填 API Key。点上面的「模型」把 key 填进去就能听懂更自由的描述了。',
        changed: false
      });
    }

    var sel = hooks.getSel ? hooks.getSel() : null;
    var messages = [
      { role: 'system', content: SYS },
      { role: 'system', content: snapshot(doc, sel) }
    ].concat(conv.slice(-8)).concat([{ role: 'user', content: text }]);
    var touched = false;

    function step(n) {
      if (n > 3) {
        return Promise.resolve({ reply: '做了几步但还没收尾，你先看看画布。', changed: touched });
      }
      return postStream(messages, toolSpecs(), onText).then(function (acc) {
        addUsage(acc.usage);
        var calls = (acc.toolCalls || []).filter(function (x) {
          return x && x.function && x.function.name;
        });

        dbg('llm', '文本=' + JSON.stringify((acc.content || '').slice(0, 70)) +
          ' 工具=' + (calls.length
            ? calls.map(function (x) {
                return x.function.name + '(' + String(x.function.arguments || '').slice(0, 90) + ')';
              }).join(' | ')
            : '无') +
          ' tokens=' + (acc.usage ? acc.usage.total_tokens : '-'));

        if (!calls.length) {
          return {
            reply: (acc.content || '').trim() || '完成。',
            changed: touched,
            usage: acc.usage
          };
        }

        messages.push({
          role: 'assistant',
          content: acc.content || '',
          tool_calls: calls
        });

        calls.forEach(function (call, i) {
          var name = call.function.name;
          var args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
          if (!call.id) call.id = 'call_' + n + '_' + i;
          var r;
          try { r = runTool(name, args, doc); }
          catch (e) { r = { ok: false, error: String(e.message || e) }; }
          if (r && r.ok) touched = true;
          dbg('tool', name + ' ' + (r && r.ok ? 'OK' : 'FAIL') + ' → ' +
            brief(r).slice(0, 260));
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: brief(r)
          });
        });
        return step(n + 1);
      });
    }

    return step(0).then(function (res) {
      // 记进历史，下一句"再往右一点""把它删掉"才接得上
      if (res && res.reply) {
        conv.push({ role: 'user', content: text });
        conv.push({ role: 'assistant', content: res.reply });
        if (conv.length > 16) conv = conv.slice(-16);
      }
      return res;
    }).catch(function (e) {
      dbg('err', (e && e.message) || String(e));
      var where = (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) &&
        /^(127\.0\.0\.1|localhost)$/.test(location.hostname))
        ? '\n提示：当前是本地服务/应用预览打开的页面，那种环境常常禁外网。请直接双击 index.html（地址栏应是 file:// 开头）再试。'
        : '';
      return {
        reply: '调用模型失败：' + e.message +
          '\n自查：① 点「模型」→「测试」看断在哪一层；② F12 → Network 看 net::ERR_xxx；③ 确认地址栏是 file:// 打开的文件。' +
          where,
        changed: touched
      };
    });
  }

  /* ---------------- UI ---------------- */

  var el = {}, hooks = {};
  var busy = false;

  /* ---------------- 运行日志 ----------------
     出问题时用户没法把控制台贴过来，所以把"发了什么、模型怎么回的、
     每个工具执行结果"都记下来，一键复制发给开发者。 */
  var DBG_KEY = 'plc-atlas.log.v1';
  var DBG = [];
  try { DBG = JSON.parse(localStorage.getItem(DBG_KEY) || '[]') || []; } catch (e) { DBG = []; }

  function dbg(kind, text) {
    DBG.push('[' + new Date().toTimeString().slice(0, 8) + '][' + kind + '] ' + text);
    if (DBG.length > 160) DBG = DBG.slice(-160);
    try { localStorage.setItem(DBG_KEY, JSON.stringify(DBG)); } catch (e) {}
    if (el.dbgText && !el.dbg.hidden) renderDbg();
  }

  function renderDbg() {
    if (!el.dbgText) return;
    el.dbgText.textContent = DBG.join('\n') || '（还没有记录）';
    el.dbgText.scrollTop = el.dbgText.scrollHeight;
    if (el.dbgN) el.dbgN.textContent = DBG.length + ' 条';
  }

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
    dbg('user', text);

    var doc = hooks.getDoc && hooks.getDoc();
    if (!doc) { bubble('bot', '先切到画板再说话。'); return; }

    busy = true;
    var thinking = bubble('bot', '…');
    var streamEl = null;

    // 流式：一旦收到第一个字就把「…」换掉，边收边写
    function onText(partial) {
      if (!streamEl) {
        thinking.remove();
        streamEl = bubble('bot', '');
      }
      streamEl.textContent = partial;
      el.log.scrollTop = el.log.scrollHeight;
    }

    function done(res) {
      if (streamEl) {
        streamEl.textContent = res.reply;
        if (res.usage) appendUsage(streamEl, res.usage);
      } else {
        thinking.remove();
        var b = bubble('bot', res.reply);
        if (res.usage) appendUsage(b, res.usage);
      }
      if (res.changed && hooks.refresh) hooks.refresh();
      busy = false;
    }

    var local = interpret(text, doc, {});
    if (local) { setTimeout(function () { done(local); }, 60); return; }

    callModel(text, doc, onText).then(function (res) {
      if (res) { done(res); return; }
      done({
        reply: '这句话我还没学会。能试试："画一个起保停"、"加个自锁"、"放一个熔断器"、"把 QA1 接到 SF1"、"检查一下"。\n' +
          '（想让我听懂更自由的描述，可以在设置里填模型地址）',
        changed: false
      });
    });
  }

  function appendUsage(parent, u) {
    var line = usageLine(u);
    if (!line) return;
    var d = document.createElement('div');
    d.className = 'chat-usage';
    d.textContent = line;
    parent.appendChild(d);
  }

  function openCfg() {
    var c = cfg();
    el.cfgPanel.hidden = !el.cfgPanel.hidden;
    if (el.cfgPanel.hidden) return;
    el.cfgUrl.value = c.endpoint || DEFAULTS.endpoint;
    el.cfgModel.value = c.model || DEFAULTS.model;
    el.cfgKey.value = c.apiKey || '';
    el.cfgKey.focus();
  }

  function saveCfgFromForm() {
    var o = {
      endpoint: el.cfgUrl.value.trim(),
      model: el.cfgModel.value.trim(),
      apiKey: el.cfgKey.value.trim()
    };
    saveCfg(o);
    el.cfgPanel.hidden = true;
    if (o.apiKey) bubble('bot', '配置好了，接下来能听懂更自由的描述。试试"画一个正反转"。');
    else bubble('bot', '没填 Key，还是用内置规则。');
  }

  /* ---------- 连接测试：分层定位断在哪 ---------- */
  function testConn() {
    var url = (el.cfgUrl.value || DEFAULTS.endpoint).trim();
    var model = (el.cfgModel.value || DEFAULTS.model).trim();
    var key = (el.cfgKey.value || '').trim();
    var lines = ['① 地址：' + url];
    var reached = false;

    if (!/^https?:\/\//i.test(url)) {
      bubble('bot', '地址要以 http:// 或 https:// 开头。');
      return;
    }

    // no-cors 只探网络层：不触发预检，能返回就说明包发出去了
    fetch(url, {
      method: 'POST', mode: 'no-cors', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}'
    }).then(function () {
      reached = true;
      lines.push('② 网络层：能连到服务器 ✅');
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (key || 'sk-none')
        },
        body: JSON.stringify({
          model: model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1
        })
      });
    }).then(function (r) {
      lines.push('③ 跨域：通过 ✅（HTTP ' + r.status + '）');
      return r.text().then(function (t) {
        var low = t.toLowerCase();
        if (r.status === 401 || /authentication|api key/i.test(t)) {
          lines.push('④ key 被拒 ❌ 检查是否复制完整、有没有多余空格');
        } else if (r.status === 400 && /model/.test(low)) {
          lines.push('④ 模型名不对 ❌ 用 deepseek-v4-flash');
        } else if (r.status === 402 || /insufficient|balance|quota/.test(low)) {
          lines.push('④ 余额不足 ❌');
        } else if (r.status === 200) {
          lines.push('④ 一切正常 ✅ 可以用了');
        } else {
          lines.push('④ 服务器返回 HTTP ' + r.status + '：' + t.slice(0, 120));
        }
        bubble('bot', '连接测试\n' + lines.join('\n'));
      });
    }).catch(function (e) {
      if (!reached) {
        lines.push('② 网络层：连不上服务器 ❌');
        lines.push('');
        lines.push('这不是 key 的问题，是这台机器出不去：');
        lines.push('· 系统代理：设置 → 网络和 Internet → 代理，如果开着"手动代理"但代理软件已经关了，把它关掉（最常见）');
        lines.push('· 防火墙 / 安全软件拦了浏览器');
        lines.push('· 换手机热点再试一次，能通就是网络环境的问题');
      } else {
        lines.push('③ 跨域被拦 ❌（服务器能连上，但拒绝了浏览器跨域）');
        lines.push('· 地址可能不是官方端点，第三方中转常常不放行 CORS');
      }
      lines.push('');
      lines.push('原始错误：' + e.message);
      bubble('bot', '连接测试\n' + lines.join('\n'));
    });
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
    el.cfgPanel = document.getElementById('chatCfgPanel');
    el.cfgUrl = document.getElementById('cfgUrl');
    el.cfgModel = document.getElementById('cfgModel');
    el.cfgKey = document.getElementById('cfgKey');
    el.cfgSave = document.getElementById('cfgSave');
    el.cfgTest = document.getElementById('cfgTest');
    el.stat = document.getElementById('chatStat');
    el.dbgBtn = document.getElementById('chatDbgBtn');
    el.dbg = document.getElementById('chatDbg');
    el.dbgText = document.getElementById('chatDbgText');
    el.dbgN = document.getElementById('chatDbgN');

    if (el.dbgBtn) {
      el.dbgBtn.addEventListener('click', function () {
        el.dbg.hidden = !el.dbg.hidden;
        if (!el.dbg.hidden) renderDbg();
      });
      document.getElementById('dbgClose').addEventListener('click', function () {
        el.dbg.hidden = true;
      });
      document.getElementById('dbgClear').addEventListener('click', function () {
        DBG = [];
        try { localStorage.removeItem(DBG_KEY); } catch (e) {}
        renderDbg();
      });
      document.getElementById('dbgCopy').addEventListener('click', function () {
        var txt = DBG.join('\n');
        var btn = this;
        function done(ok) {
          btn.textContent = ok ? '已复制' : '复制失败';
          setTimeout(function () { btn.textContent = '复制'; }, 1400);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () { done(true); },
            function () { done(false); });
        } else {
          var ta = document.createElement('textarea');
          ta.value = txt;
          document.body.appendChild(ta);
          ta.select();
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
          document.body.removeChild(ta);
          done(ok);
        }
      });
    }

    el.fab.addEventListener('click', function () {
      el.panel.hidden = !el.panel.hidden;
      if (!el.panel.hidden) el.input.focus();
    });
    el.close.addEventListener('click', function () { el.panel.hidden = true; });
    el.send.addEventListener('click', submit);
    if (el.cfg) el.cfg.addEventListener('click', openCfg);
    if (el.cfgSave) el.cfgSave.addEventListener('click', saveCfgFromForm);
    if (el.cfgTest) el.cfgTest.addEventListener('click', testConn);

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
