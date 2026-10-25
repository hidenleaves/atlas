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
    var r = A.drawTemplate(doc, { kind: 'jog' });
    return r.reply || r.error || '模板绘制失败';
  }

  function buildSelfLock(doc) {
    var r = A.drawTemplate(doc, { kind: 'selflock' });
    return r.reply || r.error || '模板绘制失败';
  }

  function buildReverse(doc, opts) {
    opts = opts || {};
    var r = A.drawTemplate(doc, {
      kind: 'reverse',
      interlock: opts.interlock !== false,
      selflock: opts.selflock !== false
    });
    return r.reply || r.error || '模板绘制失败';
  }

  function buildInterlock(doc) {
    var r = A.drawTemplate(doc, { kind: 'interlock' });
    return r.reply || r.error || '模板绘制失败';
  }

  /* ---------------- 内置解析 ---------------- */

  function interpret(text, doc, ui) {
    var s = String(text || '').trim();
    if (!s) return null;

    // 清空
    // 清空：注意"清空，画一个互锁"是复合指令，清完还要接着画，
    // 原来的写法直接 return，后半句就被吞了。
    var mClear = s.match(/(清空|清掉|清除|全部删除)/);
    if (mClear && !/(新建|重来).*(画|加)/.test(s)) {
      var rest = s
        .replace(/.*?(清空|清掉|清除|全部删除)[掉画布一下]*[，,。；;]?\s*/, '')
        .replace(/^(然后|再|接着)/, '')
        .trim();
      var n = A.clear(doc).removed;
      if (rest.length >= 2) {
        var sub = interpret(rest, doc, ui);
        if (sub) {
          return { reply: '清空了（' + n + ' 个元件）。' + sub.reply, changed: true };
        }
      }
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
    // 否定式先说：不要正反转、只要互锁
    if (/(不要|不用|别|不是).*(正反转|正反|可逆)/.test(s) && /互锁/.test(s)) {
      return { reply: buildInterlock(doc), changed: true };
    }
    // 纯互锁：不换相序、不驱动电机。带主电路/电机要求的才算正反转
    if (/(互锁|连锁)/.test(s) &&
        !/(正反转|正反|可逆|主电路|电机|热继电器|熔断器|星三角|降压)/.test(s)) {
      return { reply: buildInterlock(doc), changed: true };
    }
    // 只接住"纯正反转"，带附加要求（主电路、热继电器、星三角…）的交给模型
    if (/正反转|正反|可逆/.test(s) &&
        !/(主电路|热继电器|熔断器|电机|星三角|降压|再加|还要|同时)/.test(s)) {
      return { reply: buildReverse(doc), changed: true };
    }

    // 补自锁
    if (/自锁/.test(s) && /(加|补|放|添)/.test(s)) {
      var coilKey = (s.match(/(QA|KA|KM)\d*/i) || [])[0] || null;
      var r = A.addSelfLock(doc, coilKey || autoCoilKey(doc), null);
      if (!r.ok) return { reply: '没补上：' + r.error, changed: false };
      if (r.skipped) return { reply: r.skipped, changed: false };
      return { reply: '给 ' + r.key + ' 补了常开触点，并联在按钮两端，现在松手也能保持。', changed: true };
    }

    // 检查
    if (/(检查|看一下|对不对|有没有错|诊断)/.test(s)) {
      var chk = A.analyze(doc);
      if (!chk.issues.length) return { reply: '检查过了，接法没问题。', changed: false };
      var lines = chk.issues.map(function (x) { return '· ' + x.msg; }).join('\n');
      if (chk.level === 'ok') {
        return { reply: '局部接法没发现问题，但有一点要说明：\n' + lines, changed: false };
      }
      return { reply: '发现 ' + chk.issues.length + ' 处：\n' + lines, changed: false };
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

  /* ---------------- 路由 v2：解析 → 执行 ----------------
     route.js 只把话解析成 intent，这里才碰画布。
     规则接不住的（主电路、星三角、复杂组合）返回 null，交给模型。 */
  var ROUTE_V2 = true;

  function canRunStep(s) {
    if (!s || s.op === 'none') return true;
    var at = s.attrs || {};
    if (s.op === 'draw') {
      if (s.replace === false) return false;   // "加一个正反转"交给模型，别清空重画
      if (s.type === 'reverse') {
        if (!at.main) return !at.fuse && !at.thermal;
        // 主电路模板是固定版；用户明确不要其中某个元件时交给模型
        var ex = s.explicit || {};
        if (ex.fuse && at.fuse === false) return false;
        if (ex.thermal && at.thermal === false) return false;
        if (ex.selflock && at.selflock === false) return false;
        if (ex.interlock && at.interlock === false) return false;
        return true;
      }
      if (s.type === 'interlock') return !at.main && !at.fuse && !at.thermal;
      if (s.type === 'selflock') return !at.main && !at.fuse && !at.thermal && !at.interlock;
      if (s.type === 'jog') return !at.main && !at.fuse && !at.thermal && !at.interlock && !at.selflock;
      if (s.type === 'remote') return !at.interlock;   // 两地控制模板固定含主电路/自锁
      return false;   // 星三角等暂时交给模型
    }
    if (s.op === 'add') return s.object === 'selflock';
    if (s.op === 'remove') return s.object === 'interlock' || !!s.key || !!s.component;
    return true;
  }

  function execStep(s, doc, text) {
    if (!s || s.op === 'none') {
      return { reply: '好的，不动。', changed: false, ok: true };
    }
    if (s.op === 'clear') {
      var n = A.clear(doc).removed;
      return { reply: '清空了，删掉 ' + n + ' 个元件。', changed: true, ok: true };
    }
    if (s.op === 'check') {
      var chk = A.analyze(doc);
      if (!chk.issues.length) {
        return { reply: '检查过了，接法没问题。', changed: false, ok: true };
      }
      var lines = chk.issues.map(function (x) { return '· ' + x.msg; }).join('\n');
      if (chk.level === 'ok') {
        return {
          reply: '局部接法没发现问题，但有一点要说明：\n' + lines,
          changed: false, ok: true
        };
      }
      return {
        reply: '发现 ' + chk.issues.length + ' 处：\n' + lines,
        changed: false, ok: true
      };
    }
    if (s.op === 'connect') {
      var c = A.connect(doc, s.from, s.to);
      return c.ok
        ? { reply: '接好了：' + c.from + ' → ' + c.to + '。', changed: true, ok: true }
        : { reply: '没连上：' + (c.error || '未知原因'), changed: false, ok: false };
    }
    if (s.op === 'remove') {
      if (s.object === 'interlock') {
        var ri = A.removeInterlock(doc);
        // 复合指令里"没有互锁可删"不该挡住后面的"再画个正反转"
        if (!ri.ok) return { reply: (ri.error || '没找到互锁触点') + '。', changed: false, ok: true };
        return {
          reply: '去掉了互锁触点：' + ri.removed.join('、') + '，并把两侧重新接通。',
          changed: true, ok: true
        };
      }
      if (s.key) {
        var d = A.remove(doc, s.key);
        return d.ok
          ? { reply: '删掉了 ' + d.removed + '，连带 ' + d.wiresRemoved + ' 根线一起清理。', changed: true, ok: true }
          : { reply: d.error || '没找到 ' + s.key, changed: false, ok: false };
      }
      if (s.component) {
        var list = doc.comps.filter(function (x) { return x.type === s.component; });
        if (list.length === 1) {
          var d2 = A.remove(doc, list[0].id);
          return d2.ok
            ? { reply: '删掉了 ' + (list[0].key || typeName(s.component)) + '。', changed: true, ok: true }
            : { reply: d2.error || '删除失败', changed: false, ok: false };
        }
        if (!list.length) {
          return { reply: '图上没有' + typeName(s.component) + '。', changed: false, ok: false };
        }
        return {
          reply: '图上有 ' + list.length + ' 个' + typeName(s.component) + '，请说具体代号。',
          changed: false, ok: false
        };
      }
      return { reply: '没说删什么。', changed: false, ok: false };
    }
    if (s.op === 'place') {
      var pr = A.place(doc, s.component, { key: s.key || undefined });
      return pr.ok
        ? {
            reply: '放了' + pr.name + (pr.key ? '（' + pr.key + '）' : '') + '。',
            changed: true, ok: true
          }
        : { reply: pr.error || '放不上去', changed: false, ok: false };
    }
    if (s.op === 'add' && s.object === 'selflock') {
      var km = String(text || '').match(/(QA|KA|KT)\d+/i);
      var coilKey = km ? km[0].toUpperCase() : autoCoilKey(doc);
      if (!coilKey) {
        return { reply: '图上还没有线圈，先画一个回路再加自锁。', changed: false, ok: false };
      }
      var ar = A.addSelfLock(doc, coilKey, null);
      if (!ar.ok) return { reply: '没补上：' + (ar.error || '找不到线圈'), changed: false, ok: false };
      if (ar.skipped) return { reply: ar.skipped, changed: false, ok: true };
      return {
        reply: '给 ' + ar.key + ' 补了常开触点，并联在按钮两端，现在松手也能保持。',
        changed: true, ok: true
      };
    }
    if (s.op === 'draw') {
      var o = s.attrs || {};
      var top = { kind: s.type };
      if (s.type === 'reverse') {
        top.main = !!o.main;
        top.interlock = o.interlock !== false;
        top.selflock = o.selflock !== false;
      }
      if (s.type === 'interlock') {
        top.selflock = o.selflock === true;
      }
      if (s.type === 'reverse' || s.type === 'interlock' ||
          s.type === 'selflock' || s.type === 'jog' || s.type === 'remote') {
        var tr = A.drawTemplate(doc, top);
        return {
          reply: tr.reply || tr.error || '模板绘制失败',
          changed: !tr.rolledBack,
          ok: !!tr.ok
        };
      }
    }
    return null;
  }

  function interpretV2(text, doc) {
    if (!global.PLCRoute) return null;
    var r = global.PLCRoute.route(text);
    if (!r || !r.ok) return null;

    var steps = r.steps && r.steps.length ? r.steps : [r];
    // 先整体校验，避免"清空"执行完才发现后面画不了
    for (var i = 0; i < steps.length; i++) {
      if (!canRunStep(steps[i])) return null;
    }

    var replies = [], changed = false;
    var hasMeaningful = steps.some(function (s) {
      return s.op && s.op !== 'none' && s.op !== 'attrs';
    });
    for (var j = 0; j < steps.length; j++) {
      // 前面已经画过图时，继续输出“好的，不动”会误导用户
      if (steps[j].op === 'none' && hasMeaningful) continue;
      var res = execStep(steps[j], doc, text);
      if (!res) return null;
      if (res.reply) replies.push(res.reply);
      changed = changed || res.changed;
      if (!res.ok) break;
    }
    return { reply: replies.join('\n'), changed: changed };
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

  // 工具 schema 里用 enum 收敛取值，比在描述里罗列更可靠
  var COMPONENT_TYPES = [
    'coil', 'no', 'nc', 'btnNo', 'btnNc', 'btnStop', 'limit',
    'fuse', 'fuseH', 'fuse3', 'thermal', 'breaker',
    'motor', 'switch3', 'contactor3',
    'kCoil', 'ktCoil', 'lamp', 'bell', 'solenoid', 'diode', 'led',
    'prox', 'sw', 'ground', 'trans2', 'ct', 'plcBox'
  ];

  function toolSpecs() {
    return [
      {
        type: 'function',
        function: {
          name: 'draw_plan',
          description: '【首选】一次画完整张图：放好所有元件 + 连好所有线 + 自动自检。' +
            '画新电路一律用它，不要用 place_component 一个个放。' +
            '元件按支路给 branch（第几列），连线用节点表（同一节点里的引脚属于同一根线）。' +
            '不要在只加一个元件时用它；返回 {ok, placed, wiring, nodes, issues}，' +
            'ok:false 时读 nodes 里带 X 的行。失败会回滚（rolledBack:true），不会留下半张图。',
          parameters: {
            type: 'object',
            properties: {
              clear: { type: 'boolean', description: '先清空画布。用户说"重画/清空"时给 true' },
              components: {
                type: 'array',
                minItems: 1,
                description: '元件清单',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: COMPONENT_TYPES, description: '元件类型' },
                    key: { type: 'string', description: '代号，如 SF1、QA1。只写代号，不要带类型前缀' },
                    branch: { type: 'number', minimum: 1, maximum: 6, description: '第几列，从 1 开始。同列自动往下排' },
                    poles: { type: 'number', minimum: 1, maximum: 6, description: '可选。三极元件（fuse3/thermal/contactor3）只要一极时写 1' },
                    align: { type: 'string', description: '可选。与被并联的元件同行（填它的代号）' }
                  },
                  required: ['type', 'branch']
                }
              },
              nodes: {
                type: 'array',
                minItems: 1,
                description: '节点表：每个节点是一根等电位线',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '节点名，如 L、N、A1' },
                    pins: {
                      type: 'array',
                      minItems: 2,
                      items: { type: 'string' },
                      description: '属于这根线的引脚，如 ["SF1#0","no:QA1#0"]。#0 上脚，#1 下脚'
                    }
                  },
                  required: ['name', 'pins']
                }
              },
              terminals: {
                type: 'array',
                description: '可选。电源端子：放在某个节点上，用于判断线圈回路是否闭合',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '端子名，如 L1、N' },
                    node: { type: 'string', description: '节点名，必须是 nodes 里的 name' }
                  },
                  required: ['name', 'node']
                }
              }
            },
            required: ['components', 'nodes']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'draw_template',
          description: '用内置模板画一整张图。用户说“点动 / 起保停 / 自锁 / 互锁 / 正反转”时优先用它，' +
            '比 draw_plan 更稳。会替换当前图；失败会回滚（rolledBack:true）。' +
            '主电路、星三角等模板外的图用 draw_plan。',
          parameters: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['jog', 'selflock', 'interlock', 'reverse', 'remote'],
                description: 'jog 点动 / selflock 起保停 / interlock 纯互锁 / reverse 正反转 / remote 两地控制'
              },
              interlock: {
                type: 'boolean',
                description: 'reverse 专用：是否串对方的常闭触点，默认 true'
              },
              selflock: {
                type: 'boolean',
                description: 'reverse / interlock：是否带自锁触点；reverse 默认 true，interlock 默认 false'
              },
              main: {
                type: 'boolean',
                description: 'reverse 专用：同时画教材版主电路（熔断器、接触器主触点、热继电器、电机、相序交换）。' +
                  '主电路固定是双重互锁 + 自锁，不能再单独关互锁/自锁。'
              }
            },
            required: ['kind']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'place_component',
          description: '在现有图纸上增量放一个电气元件。必须给 branch（第几列，从 1 开始）：' +
            '同一列自动往下排，不同列往右开新列。主回路一列、并联支路另一列。' +
            '新画一整张图请用 draw_plan，不要用它一个个摆。',
          parameters: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: COMPONENT_TYPES, description: '元件类型' },
              key: { type: 'string', description: '代号，如 QA1、SF2（只写代号，不要带类型前缀）' },
              branch: { type: 'number', minimum: 1, maximum: 6, description: '第几列，从 1 开始。主回路 1，右侧并联支路 2' },
              poles: { type: 'number', minimum: 1, maximum: 6, description: '可选。三极元件只要一极时写 1' },
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
          name: 'remove',
          description: '删除一个元件（连带它的导线）。ref 支持代号或 类型:代号；' +
            '同名元件有多个时必须用 类型:代号，例如 no:QA1。',
          parameters: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: '元件代号或 类型:代号，如 QA1、no:QA1' }
            },
            required: ['ref']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'wire_nodes',
          description: '按节点表一次性连好现有的线。把电路描述成"哪些引脚属于同一根线"，' +
            '比逐个 connect 可靠得多，复杂图也不会漏。draw_plan 已经连好线，不要重复调用。' +
            '同名元件必须带类型前缀：coil:QA1 是线圈，no:QA1 是自锁触点，nc:QA1 是常闭触点。',
          parameters: {
            type: 'object',
            properties: {
              nodes: {
                type: 'array',
                minItems: 1,
                description: '节点列表，每个节点是一根等电位线',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '节点名，如 L、N、A' },
                    pins: {
                      type: 'array',
                      minItems: 2,
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
          description: '检查当前接线，返回电气问题列表。draw_plan 已自带自检，' +
            '只在用户明确要求检查、或你想确认现有图时调用。',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_lead',
          description: '从某个引脚引一段线出去（画母线、电源线、引出端用）。' +
            'draw_plan 会自动画母线和引出线，一般不需要单独调用。',
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
          description: '清空整张图纸。只在用户明确说“清空/重画”时使用；' +
            '“再加一个/再放一个”是增量，不要清空。',
          parameters: { type: 'object', properties: {} }
        }
      }
    ];
  }

  function runTool(name, args, doc) {
    switch (name) {
      case 'place_component': return A.place(doc, args.type, args);
      // clear 和失败回滚都在 drawPlan / drawTemplate 内部处理
      case 'draw_plan': return A.drawPlan(doc, args);
      case 'draw_template': return A.drawTemplate(doc, args);
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

  // 人设卡与规则在 js/prompt.js，改提示词去那里改
  var SYS = (global.PLCPrompt && global.PLCPrompt.SYS) ||
    '你是 PLC 电气图纸助手，把用户的中文意图变成画布上的电路图。';

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
      'removed', 'wiresRemoved', 'wireId', 'level', 'from', 'to', 'points',
      'rolledBack', 'placed', 'components', 'wiring', 'terminalsPlaced', 'kind', 'reply']
      .forEach(function (k) {
        if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
      });
    if (r.placeErrors) o.placeErrors = r.placeErrors.slice(0, 6);
    if (typeof o.components === 'string' && o.components.length > 240) {
      o.components = o.components.slice(0, 240) + '…';
    }
    if (typeof o.reply === 'string' && o.reply.length > 300) {
      o.reply = o.reply.slice(0, 300) + '…';
    }
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
        changed: false, via: 'rule'
      });
    }

    var sel = hooks.getSel ? hooks.getSel() : null;
    var messages = [
      { role: 'system', content: SYS },
      { role: 'system', content: snapshot(doc, sel) }
    ].concat(conv.slice(-8)).concat([{ role: 'user', content: text }]);
    var touched = false;
    var finished = false;      // draw_plan 成功后就收尾，不再让它继续动

    function step(n) {
      // 原来的 3 轮根本不够：模型习惯"先放元件、再补自锁、再连线"，
      // 实测 4 轮就用完了，wire_nodes 一次都没轮上，图永远是散的。
      if (n > 8) {
        return Promise.resolve({
          reply: '我做了几步但没能收尾，画布上可能是散的。' +
            '你可以说"重画一个正反转"，我用内置模板直接出图。',
          changed: touched, via: 'model'
        });
      }
      // 走到第 5 轮还没画完，直接把话挑明，别再放元件了
      if (n === 5 && !finished) {
        messages.push({
          role: 'system',
          content: '【提醒】已经用掉 5 轮，图还没连完。现在立刻调用 draw_plan 或 wire_nodes ' +
            '把线全部接上。不要再 place_component、不要 remove。'
        });
      }
      var activeTools = finished ? null : toolSpecs();
      return postStream(messages, activeTools, onText).then(function (acc) {
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
            usage: acc.usage, via: 'model'
          };
        }

        messages.push({
          role: 'assistant',
          content: acc.content || '',
          tool_calls: calls
        });

        calls.forEach(function (call, i) {
          if (!call.id) call.id = 'call_' + n + '_' + i;
          // draw_plan 成功后，同一轮的 remove/place 等调用一律跳过，
          // 否则会把刚画好的图删掉或改坏。仍要给每个 tool_call 回一条结果。
          if (finished) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ ok: false, error: 'draw_plan 已成功，跳过本轮剩余调用' })
            });
            return;
          }
          var name = call.function.name;
          var args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
          var r;
          try { r = runTool(name, args, doc); }
          catch (e) { r = { ok: false, error: String(e.message || e) }; }
          if (r && r.ok) touched = true;
          // draw_plan 成功 = 图已经完整落盘，再让模型折腾只会把它改坏
          if ((name === 'draw_plan' || name === 'draw_template') &&
              r && r.ok && r.level !== 'error') finished = true;
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
        changed: touched, via: 'model'
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

  // 让用户看得见这句是规则答的还是模型答的 ——
  // 规则毫秒级、模型三五秒，标出来才不会以为是"卡了"或者"没走模型"。
  function tagVia(node, via) {
    var t = document.createElement('span');
    t.className = 'chat-via ' + (via === 'model' ? 'model' : 'rule');
    t.textContent = via === 'model' ? '模型' : '内置';
    t.title = via === 'model'
      ? '这句交给了 DeepSeek，能处理自由描述'
      : '这句由内置规则直接处理，不用联网、毫秒级';
    node.appendChild(t);
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
      var host = streamEl || b;
      if (host && res.via) tagVia(host, res.via);
      if (res.changed && hooks.refresh) hooks.refresh();
      busy = false;
    }

    var local = ROUTE_V2 ? interpretV2(text, doc) : interpret(text, doc, {});
    if (local) {
      local.via = 'rule';
      setTimeout(function () { done(local); }, 60);
      return;
    }

    callModel(text, doc, onText).then(function (res) {
      if (res) { done(res); return; }
      // 分两种：说了"画…"但没配模型 → 告诉它为什么画不出来，别让用户以为是听不懂
      var wantDraw = /(画|做|建|生成|来个|帮我弄)/.test(text) &&
        !/(画布|画板|有什么|是什么)/.test(text);
      done({
        reply: wantDraw
          ? '这句话要靠模型来画，但还没配 API Key。\n点标题栏的「模型」填一个 DeepSeek Key（只存本机），之后这类带附加要求的描述就能画。\n' +
            '不填也行，内置模板认得这么说：画一个起保停 / 点动 / 互锁 / 正反转。'
          : '这句话我还没学会。能试试："画一个起保停"、"画一个互锁"、"加个自锁"、"检查一下"。',
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

    // 快捷指令：不让用户记说法；点击直接发送
    if (!document.getElementById('chatQuick')) {
      var quick = document.createElement('div');
      quick.className = 'chat-quick';
      quick.id = 'chatQuick';
      var lab = document.createElement('span');
      lab.className = 'chat-quick-label';
      lab.textContent = '试试';
      quick.appendChild(lab);
      [
        ['起保停', '画一个起保停'],
        ['互锁', '画一个互锁'],
        ['正反转', '画一个正反转'],
        ['正反转+主电路', '画一个正反转带主电路'],
        ['两地控制', '画一个两地控制'],
        ['点动', '画一个点动'],
        ['加自锁', '加个自锁'],
        ['检查', '检查一下']
      ].forEach(function (q) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = q[0];
        b.title = q[1];
        b.setAttribute('data-q', q[1]);
        b.addEventListener('click', function () {
          if (busy) return;
          el.input.value = q[1];
          submit();
        });
        quick.appendChild(b);
      });
      el.input.parentNode.parentNode.insertBefore(quick, el.input.parentNode);
    }

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
      bubble('bot', '我是接线助手。可以直接说：画一个起保停、加个自锁、放一个熔断器、把 QA1 接到 SF1。也可以点下面的快捷指令。');
    }
  }

  global.PLCChat = {
    mount: mount,
    interpret: interpret,
    interpretV2: interpretV2,
    // 评测用：暴露真实模型链路（工具循环 + 收尾判定），
    // 让 tools/model-eval.js 跑的是线上同一段代码，而不是复刻品。
    callModel: callModel,
    runTool: runTool,
    // 评测用：按快照取日志，避免跨用例互相污染
    getDebug: function () { return DBG.slice(); },
    clearDebug: function () { DBG = []; },
    systemPrompt: SYS,
    snapshot: snapshot,
    buildJog: buildJog,
    buildSelfLock: buildSelfLock,
    buildReverse: buildReverse,
    buildInterlock: buildInterlock,
    toolSpecs: toolSpecs,
    defaults: DEFAULTS,
    cfg: cfg,
    saveCfg: saveCfg
  };
})(window);
