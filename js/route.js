/* ============================================================
   route.js — 意图路由 v2（原型，纯函数，不碰画布）
   ------------------------------------------------------------
   输入一句中文，输出结构化意图；解析和执行彻底分开：

     route(text) → {
       ok, op, type, attrs, object, component, key, from, to,
       clear, replace, confidence, reason, steps[]
     }

   设计要点（对应上一轮 review 里指出的问题）：
     1. 先切子句（标点 + 显式连接词），再做局部判定；
        不把"再"一律当边界，避免"不想再画互锁"被切坏。
     2. 否定按"前一个非否定 token"回溯并数奇偶，
        支持"不能没有互锁"这种双重否定。
     3. "别把互锁删了"这类把字句，否定作用于动词，不作用于对象。
     4. 主体 type 只取"未被否定"的；互锁/自锁在没有强主体时升级为主体。
     5. 规则接不住就 ok:false，交给模型，不硬猜。

   这个文件在浏览器里挂 window.PLCRoute，在 Node 里可 require()。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PLCRoute = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 词表 ---------------- */

  // 否定词：长的排前面，先吃长的，避免"不要"被拆成"不"+"要"。
  var NEG_WORDS = [
    '不需要', '不用', '不要', '不带', '不含', '没有', '无需', '省去', '省掉', '不能', '无法',
    '别', '不', '没', '无'
  ].sort(function (a, b) { return b.length - a.length; });

  // 操作动词。key 是语义，place/add/draw 的最终归属由宾语再判。
  var OP_WORDS = [
    ['全部删除', 'clear'], ['清空', 'clear'], ['清掉', 'clear'], ['清除', 'clear'], ['重置', 'clear'],
    ['有没有错', 'check'], ['对不对', 'check'], ['检查', 'check'], ['看一下', 'check'],
    ['看看', 'check'], ['诊断', 'check'], ['查一下', 'check'],
    ['连接到', 'connect'], ['接到', 'connect'], ['连到', 'connect'], ['接上', 'connect'],
    ['连上', 'connect'], ['连接', 'connect'],
    ['删除', 'remove'], ['删掉', 'remove'], ['去掉', 'remove'], ['去除', 'remove'],
    ['移除', 'remove'], ['取消', 'remove'], ['拿掉', 'remove'], ['删', 'remove'],
    ['重新画', 'draw'], ['重画', 'draw'], ['画', 'draw'], ['做', 'draw'], ['建', 'draw'],
    ['生成', 'draw'], ['设计', 'draw'], ['出图', 'draw'], ['来个', 'draw'], ['帮我弄', 'draw'],
    ['增加', 'add'], ['添加', 'add'], ['加', 'add'], ['补', 'add'], ['添', 'add'],
    ['放', 'place']
  ].sort(function (a, b) { return b[0].length - a[0].length; });

  // 术语：
  //   primary   —— 强主体（正反转/点动/星三角/起保停）
  //   secondary —— 既可能是主体也可能是属性（互锁/自锁）
  //   attrs     —— 只作为属性（主电路/熔断器/热继电器…）
  var TERMS = [
    { w: '起保停', primary: ['selflock'] },
    { w: '自保持', secondary: ['selflock'], attrs: ['selflock'] },
    { w: '自锁', secondary: ['selflock'], attrs: ['selflock'] },
    { w: '点动', primary: ['jog'] },
    { w: '正反转', primary: ['reverse'] },
    { w: '正反', primary: ['reverse'] },
    { w: '可逆', primary: ['reverse'] },
    { w: '星三角', primary: ['star'] },
    { w: '降压启动', primary: ['star'] },
    { w: '两地控制', primary: ['remote'] },
    { w: '多地控制', primary: ['remote'] },
    { w: '远程控制', primary: ['remote'] },
    { w: '互锁', secondary: ['interlock'], attrs: ['interlock'] },
    { w: '连锁', secondary: ['interlock'], attrs: ['interlock'] },
    { w: '主电路', attrs: ['main'] },
    { w: '主回路', attrs: ['main'] },
    { w: '熔断器', attrs: ['fuse'] },
    { w: '保险丝', attrs: ['fuse'] },
    { w: '保险', attrs: ['fuse'] },
    { w: '热继电器', attrs: ['thermal'] },
    { w: '热保护', attrs: ['thermal'] },
    { w: '热元件', attrs: ['thermal'] },
    { w: '电动机', attrs: ['motor'] },
    { w: '电机', attrs: ['motor'] }
  ].sort(function (a, b) { return b.w.length - a.w.length; });

  // 元件名词：出现在"放/加/画"后面时落到 place，而不是模板。
  var COMPONENT_WORDS = [
    ['时间继电器', 'ktCoil'], ['中间继电器', 'kCoil'], ['热继电器', 'thermal'],
    ['熔断器', 'fuse'], ['保险丝', 'fuse'], ['空气开关', 'breaker'], ['断路器', 'breaker'],
    ['接触器', 'coil'], ['线圈', 'coil'], ['电动机', 'motor'], ['电机', 'motor'],
    ['行程开关', 'limit'], ['急停', 'btnStop'], ['按钮', 'btnNo'],
    ['信号灯', 'lamp'], ['指示灯', 'lamp'], ['电铃', 'bell'], ['主触点', 'contactor3']
  ].sort(function (a, b) { return b[0].length - a[0].length; });

  var CONNECTORS = ['然后', '接着', '同时', '并且', '另外', '再', '并'];

  var DEFAULT_ATTRS = {
    reverse:   { interlock: true,  selflock: true,  main: false, fuse: false, thermal: false },
    interlock: { interlock: true,  selflock: false, main: false, fuse: false, thermal: false },
    selflock:  { interlock: false, selflock: true,  main: false, fuse: false, thermal: false },
    jog:       { interlock: false, selflock: false, main: false, fuse: false, thermal: false },
    star:      { interlock: true,  selflock: true,  main: true,  fuse: true,  thermal: true  },
    remote:    { interlock: false, selflock: false, main: false, fuse: false, thermal: false }
  };

  var REF_PREFIX = /^(QA|SF|KA|KT|FA|BB|FU|FR|QF|QS|SB|SQ|TC|TA|HL|YV|M)$/;

  /* ---------------- 扫描 ---------------- */

  function normalize(text) {
    return String(text || '')
      .replace(/画布/g, '图纸')      // 防止"画布"里的"画"被当成操作
      .replace(/画板/g, '图纸板')
      .replace(/\s+/g, '')
      .trim();
  }

  // 最长匹配扫描，返回 {word, at, end, key?, def?}
  function scan(text, words) {
    var out = [], i = 0;
    while (i < text.length) {
      var hit = null;
      for (var k = 0; k < words.length; k++) {
        var w = words[k].w || words[k][0] || words[k];
        if (text.substr(i, w.length) === w) {
          hit = { word: w, at: i, end: i + w.length };
          if (words[k].w) hit.def = words[k];
          if (words[k][1]) hit.key = words[k][1];
          break;
        }
      }
      if (hit) { out.push(hit); i = hit.end; }
      else i++;
    }
    return out;
  }

  // 数一段文本里的否定词（奇偶在调用处判）
  function countNegs(s) {
    var n = 0, i = 0;
    while (i < s.length) {
      var hit = null;
      for (var k = 0; k < NEG_WORDS.length; k++) {
        var w = NEG_WORDS[k];
        if (s.substr(i, w.length) !== w) continue;
        // "别"是常见否定词，但要排除"特别/分别/个别/区别/告别/类别/性别/别人"
        if (w === '别') {
          var prev = i > 0 ? s.charAt(i - 1) : '';
          var next = s.charAt(i + 1);
          if (/[特分个差告类性区别辨]/.test(prev)) continue;
          if (next === '人') continue;
        }
        hit = w;
        break;
      }
      if (hit) { n++; i += hit.length; }
      else i++;
    }
    return n;
  }

  /* ---------------- 切句 ---------------- */

  function splitClauses(text) {
    return text.split(/[，,。；;！!？?\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function hasTermOrOp(s) {
    return scan(s, TERMS).length > 0 || scan(s, OP_WORDS).length > 0;
  }

  function hasOp(s) {
    return scan(s, OP_WORDS).length > 0;
  }

  // 连接词切分：两边都"有东西"才切。
  // "清空再画互锁" → 切；"不想再画互锁" → 不切（左边只有否定词）。
  function splitCompound(clause) {
    for (var c = 0; c < CONNECTORS.length; c++) {
      var word = CONNECTORS[c];
      var idx = clause.indexOf(word);
      if (idx <= 0) continue;
      var left = clause.slice(0, idx);
      var right = clause.slice(idx + word.length);
      if (left && right && hasTermOrOp(left) && hasOp(right)) {
        return [left, right];
      }
    }
    return [clause];
  }

  // "清空画个互锁"（没有标点/连接词）→ ["清空", "画个互锁"]
  function splitClear(clause) {
    var ops = scan(clause, OP_WORDS).filter(function (o) { return o.key === 'clear'; });
    if (!ops.length) return [clause];
    var first = ops[0];
    var after = clause.slice(first.end);
    if (after && hasOp(after)) return [clause.slice(0, first.end), after];
    return [clause];
  }

  /* ---------------- 单个子句 ---------------- */

  function parseClause(clause, opts) {
    opts = opts || {};
    var ops = scan(clause, OP_WORDS);
    var terms = scan(clause, TERMS);

    // 统一 token 表，按位置排序；同位置长的在前。
    var tokens = [];
    ops.forEach(function (o) {
      tokens.push({
        kind: 'op', at: o.at, end: o.end, word: o.word, key: o.key,
        clear: o.word === '重画' || o.word === '重新画'
      });
    });
    terms.forEach(function (t) {
      tokens.push({ kind: 'term', at: t.at, end: t.end, word: t.word, def: t.def });
    });
    tokens.sort(function (a, b) { return a.at - b.at || b.end - a.end; });

    // 否定状态：回溯到前一个"非否定 token"，数它到当前 token 之间的否定词。
    tokens.forEach(function (t, idx) {
      var prev = null;
      for (var i = 0; i < idx; i++) prev = tokens[i];
      var from = prev ? prev.end : 0;
      t.neg = countNegs(clause.slice(from, t.at)) % 2 === 1;
    });

    // 后置否定：主电路不要 / 互锁不要。
    // 只有后面没有别的 token 时才翻转；"正反转不要互锁"里的"不要"属于互锁。
    tokens.forEach(function (t, idx) {
      if (t.kind !== 'term' || tokens[idx + 1]) return;
      if (countNegs(clause.slice(t.end)) % 2 === 1) t.neg = !t.neg;
    });

    // 把字句："别把互锁删了"否定的是"删"，不是"互锁"。
    var ba = clause.indexOf('把');
    if (ba >= 0) {
      var negBeforeBa = countNegs(clause.slice(0, ba)) % 2 === 1;
      var opAfterBa = tokens.filter(function (t) { return t.kind === 'op' && t.at > ba; })
        .sort(function (a, b) { return a.at - b.at; })[0];
      if (negBeforeBa && opAfterBa) {
        opAfterBa.neg = true;
        tokens.forEach(function (t) {
          if (t.kind === 'term' && t.at > ba && t.at < opAfterBa.at) t.neg = false;
        });
      }
    }

    // 动词否定传递：别加互锁 / 不加自锁 / 别画熔断器。
    // 语法上“别/不”否定的是 add/draw/place，但用户意图通常是否定其后的属性；
    // 把否定传给该动词后面的属性术语，再由 attrs 步骤处理。
    tokens.forEach(function (t, idx) {
      if (t.kind !== 'op' || !t.neg) return;
      if (t.key !== 'add' && t.key !== 'place' && t.key !== 'draw') return;
      for (var j = idx + 1; j < tokens.length; j++) {
        if (tokens[j].kind === 'op') break;
        if (tokens[j].kind !== 'term') continue;
        if (tokens[j].def.attrs && tokens[j].def.attrs.length) {
          tokens[j].neg = !tokens[j].neg;
        }
      }
    });

    // 并列否定：不要互锁和自锁 / 互锁、自锁都不要。
    for (var ci = tokens.length - 1; ci >= 1; ci--) {
      var ta = tokens[ci - 1], tb = tokens[ci];
      if (ta.kind !== 'term' || tb.kind !== 'term') continue;
      var between = clause.slice(ta.end, tb.at);
      if (!/^(和|与|及|跟|以及|、)$/.test(between)) continue;
      if (ta.neg || tb.neg) { ta.neg = true; tb.neg = true; }
    }

    // 反向动词否定：自锁和互锁都别加。
    // 否定词在动词上、动词后面没有宾语时，回传给前面通过并列连接的属性术语。
    tokens.forEach(function (t, idx) {
      if (t.kind !== 'op' || !t.neg) return;
      if (t.key !== 'add' && t.key !== 'place' && t.key !== 'draw') return;
      var hasTermAfter = false;
      for (var j = idx + 1; j < tokens.length; j++) {
        if (tokens[j].kind === 'term') { hasTermAfter = true; break; }
      }
      if (hasTermAfter) return;
      for (var k = idx - 1; k >= 0; k--) {
        if (tokens[k].kind === 'op') break;
        if (tokens[k].kind === 'term' && tokens[k].def.attrs && tokens[k].def.attrs.length) {
          tokens[k].neg = true;
        }
      }
    });

    var posOps = tokens.filter(function (t) { return t.kind === 'op' && !t.neg; });
    var negOps = tokens.filter(function (t) { return t.kind === 'op' && t.neg; });

    // 只有被否定的操作：如果已经转成属性否定，就继续走 attrs 步骤
    if (!posOps.length && negOps.length) {
      var hasAttrNeg = tokens.some(function (t) {
        return t.kind === 'term' && t.neg && t.def.attrs && t.def.attrs.length;
      });
      if (!hasAttrNeg) return { op: 'none', reason: '操作被否定', confidence: 0.9 };
    }

    // 主体和属性
    var primaryPos = [], primaryNeg = [], secondaryPos = [], secondaryNeg = [];
    var attrPos = {}, attrNeg = {};
    tokens.forEach(function (t) {
      if (t.kind !== 'term') return;
      var d = t.def;
      (d.primary || []).forEach(function (k) {
        (t.neg ? primaryNeg : primaryPos).push(k);
      });
      (d.secondary || []).forEach(function (k) {
        (t.neg ? secondaryNeg : secondaryPos).push(k);
        (t.neg ? attrNeg : attrPos)[k] = true;
      });
      (d.attrs || []).forEach(function (k) {
        (t.neg ? attrNeg : attrPos)[k] = true;
      });
    });

    // 排他 / 排除语义（第 25 轮 KNOWN 1/2）
    // 只要X：只保留 X，其它可控属性关闭；除了X都要：只关闭 X。
    var onlyAt = clause.indexOf('只要');
    var exceptAt = clause.indexOf('除了');
    var hasPrimary = primaryPos.length > 0;
    var CONTROLS = ['interlock', 'selflock', 'main', 'fuse', 'thermal'];

    function attrsAfter(at) {
      var out = {};
      tokens.forEach(function (t) {
        if (t.kind !== 'term' || t.at <= at || t.neg) return;
        (t.def.secondary || []).forEach(function (k) { out[k] = true; });
        (t.def.attrs || []).forEach(function (k) { out[k] = true; });
      });
      return out;
    }

    // 跟在上一张图后面：直接返回 attrs 步骤，由 route 合并
    if (opts.hasDraw && !hasPrimary) {
      if (onlyAt >= 0) {
        var allowedOnly = attrsAfter(onlyAt);
        if (Object.keys(allowedOnly).length) {
          var onlyPatch = {}, onlyEx = {};
          CONTROLS.forEach(function (k) {
            onlyPatch[k] = !!allowedOnly[k];
            onlyEx[k] = true;
          });
          return { op: 'attrs', attrs: onlyPatch, explicit: onlyEx, confidence: 0.85 };
        }
      }
      if (exceptAt >= 0) {
        var excludedOnly = attrsAfter(exceptAt);
        var exKeys = Object.keys(excludedOnly);
        if (exKeys.length) {
          var exceptPatch = {}, exceptEx = {};
          exKeys.forEach(function (k) { exceptPatch[k] = false; exceptEx[k] = true; });
          return { op: 'attrs', attrs: exceptPatch, explicit: exceptEx, confidence: 0.85 };
        }
      }
    }

    var subject = null;
    var subjectFromPrimary = false;
    var P = uniq(primaryPos);
    var S = uniq(secondaryPos);
    if (P.length > 1) return null;                 // 多个主类型，交模型
    if (P.length === 1) { subject = P[0]; subjectFromPrimary = true; }
    else if (S.length > 1) {
      // “自锁和互锁都要”跟在上一张图后面时是属性，不是又画一张
      if (!(opts.hasDraw && !posOps.length)) return null;
    } else if (S.length === 1) subject = S[0];

    var attrs = subject ? copy(DEFAULT_ATTRS[subject])
      : { interlock: false, selflock: false, main: false, fuse: false, thermal: false };
    secondaryPos.forEach(function (k) { if (k !== subject) attrs[k] = true; });
    secondaryNeg.forEach(function (k) { attrs[k] = false; });
    Object.keys(attrPos).forEach(function (k) { attrs[k] = true; });
    Object.keys(attrNeg).forEach(function (k) { attrs[k] = false; });
    if (subject === 'interlock' && !attrNeg.interlock) attrs.interlock = true;
    if (subject === 'selflock' && !attrNeg.selflock) attrs.selflock = true;

    // 同一子句内的排他/排除：直接改这张图的 attrs
    if (hasPrimary) {
      if (onlyAt >= 0) {
        var allowedDraw = attrsAfter(onlyAt);
        if (Object.keys(allowedDraw).length) {
          CONTROLS.forEach(function (k) {
            attrs[k] = !!allowedDraw[k];
            (allowedDraw[k] ? attrPos : attrNeg)[k] = true;
          });
        }
      }
      if (exceptAt >= 0) {
        var excludedDraw = attrsAfter(exceptAt);
        Object.keys(excludedDraw).forEach(function (k) {
          attrs[k] = false;
          attrNeg[k] = true;
        });
      }
    }

    var comp = scan(clause, COMPONENT_WORDS)[0];
    var refs = findRefs(clause);
    var opKey = posOps.length ? posOps[0].key : null;
    var multiOp = uniq(posOps.map(function (o) { return o.key; })).length > 1;
    var conf = multiOp ? 0.6 : 0.95;

    // 只有属性、没有主体/动词：交给 route 合并到上一张绘制步骤
    if (!subject && !opKey) {
      var patch = {};
      Object.keys(attrPos).forEach(function (k) { patch[k] = true; });
      Object.keys(attrNeg).forEach(function (k) { patch[k] = false; });
      if (Object.keys(patch).length) {
        var ex = {};
        Object.keys(patch).forEach(function (k) { ex[k] = true; });
        return { op: 'attrs', attrs: patch, explicit: ex, confidence: 0.8 };
      }
    }

    // 跟在上一张图后面的 secondary 属性：降级成 attrs，
    // 不要覆盖成 draw:selflock / draw:interlock。
    if (opts.hasDraw && !opKey && !subjectFromPrimary) {
      var patch2 = {};
      Object.keys(attrPos).forEach(function (k) { patch2[k] = true; });
      Object.keys(attrNeg).forEach(function (k) { patch2[k] = false; });
      if (Object.keys(patch2).length) {
        var ex2 = {};
        Object.keys(patch2).forEach(function (k) { ex2[k] = true; });
        return { op: 'attrs', attrs: patch2, explicit: ex2, confidence: 0.85 };
      }
    }

    /* ---- 按动词优先 ---- */

    if (opKey === 'check') return { op: 'check', confidence: 0.95 };
    if (opKey === 'clear') return { op: 'clear', clear: true, confidence: 0.95 };

    if (opKey === 'connect') {
      if (refs.length < 2) return null;
      return { op: 'connect', from: refs[0], to: refs[1], confidence: 0.95 };
    }

    if (opKey === 'remove') {
      // "去除互锁" = 删互锁触点，不是删一个叫互锁的元件
      if (secondaryPos.indexOf('interlock') >= 0 || /互锁|连锁/.test(clause)) {
        return { op: 'remove', object: 'interlock', confidence: 0.9 };
      }
      if (refs.length) return { op: 'remove', key: refs[0], confidence: 0.9 };
      if (comp) return { op: 'remove', component: comp.key, confidence: 0.75 };
      return null;
    }

    // 放元件 / 加元件
    if (opKey === 'place' || (opKey === 'add' && comp && !subject)) {
      if (!comp) return null;
      return { op: 'place', component: comp.key, key: refs[0] || null, confidence: 0.9 };
    }

    // "加个自锁" = 给现有线圈补自锁触点
    if (opKey === 'add' && subject && (subject === 'selflock' || subject === 'interlock')) {
      return { op: 'add', object: subject, attrs: attrs, confidence: 0.9 };
    }

    // 画模板 / 默认动词
    if (subject) {
      var clearFlag = !!(posOps[0] && posOps[0].clear);
      return {
        op: 'draw',
        type: subject,
        attrs: attrs,
        explicit: {
          main: !!(attrPos.main || attrNeg.main),
          fuse: !!(attrPos.fuse || attrNeg.fuse),
          thermal: !!(attrPos.thermal || attrNeg.thermal),
          selflock: !!(attrPos.selflock || attrNeg.selflock),
          interlock: !!(attrPos.interlock || attrNeg.interlock)
        },
        replace: opKey !== 'add',
        clear: clearFlag,
        confidence: opKey ? conf : 0.85
      };
    }

    // 没有模板主体，但点了一个元件
    if (comp && (opKey === 'draw' || opKey === 'add' || opKey === 'place' || !opKey)) {
      return { op: 'place', component: comp.key, key: refs[0] || null, confidence: 0.85 };
    }

    // "重画"单独出现 = 清空
    if (posOps[0] && posOps[0].clear) return { op: 'clear', clear: true, confidence: 0.8 };

    return null;
  }

  /* ---------------- 辅助 ---------------- */

  function uniq(a) {
    return a.filter(function (v, i) { return a.indexOf(v) === i; });
  }

  function copy(o) {
    var r = {};
    for (var k in o) r[k] = o[k];
    return r;
  }

  function findRefs(s) {
    var m = s.match(/[A-Za-z]{1,3}\d+/g) || [];
    return m.map(function (x) { return x.toUpperCase(); })
      .filter(function (x) { return REF_PREFIX.test(x.replace(/\d+$/, '')); });
  }

  /* ---------------- 总入口 ---------------- */

  function route(text) {
    var norm = normalize(text);
    if (!norm) return { ok: false, reason: '空输入', confidence: 0, steps: [] };

    var clauses = [];
    splitClauses(norm).forEach(function (c) {
      splitCompound(c).forEach(function (s) {
        splitClear(s).forEach(function (x) { if (x) clauses.push(x); });
      });
    });

    var steps = [];
    var unparsed = [];
    var pendingAttrs = null, pendingExplicit = null;
    var hadAttrs = false;

    function mergeAttrs(target, r) {
      var at = target.attrs || {};
      Object.keys(r.attrs).forEach(function (k) { at[k] = r.attrs[k]; });
      target.attrs = at;
      var ex = target.explicit || {};
      if (r.explicit) Object.keys(r.explicit).forEach(function (k) { ex[k] = true; });
      target.explicit = ex;
    }

    clauses.forEach(function (c) {
      var hasDraw = steps.some(function (s) { return s.op === 'draw'; });
      var r = parseClause(c, { hasDraw: hasDraw });
      if (!r) {
        // 只对“看起来像操作”的子句报未解析；纯语气词/否定类型不打断整句
        if (scan(c, OP_WORDS).length || scan(c, COMPONENT_WORDS).length || findRefs(c).length) {
          unparsed.push(c);
        }
        return;
      }
      if (r.op === 'attrs') {
        hadAttrs = true;
        // 优先附着到上一张绘制步骤；没有就暂存，等下一张绘制
        var target = null;
        for (var i = steps.length - 1; i >= 0; i--) {
          if (steps[i].op === 'draw') { target = steps[i]; break; }
        }
        if (target) {
          mergeAttrs(target, r);
        } else {
          pendingAttrs = pendingAttrs || {};
          Object.keys(r.attrs).forEach(function (k) { pendingAttrs[k] = r.attrs[k]; });
          pendingExplicit = pendingExplicit || {};
          if (r.explicit) {
            Object.keys(r.explicit).forEach(function (k) { pendingExplicit[k] = true; });
          }
        }
        return;
      }
      if (r.op === 'draw' && pendingAttrs) {
        r.attrs = r.attrs || {};
        Object.keys(pendingAttrs).forEach(function (k) { r.attrs[k] = pendingAttrs[k]; });
        r.explicit = r.explicit || {};
        Object.keys(pendingExplicit || {}).forEach(function (k) { r.explicit[k] = true; });
        pendingAttrs = null;
        pendingExplicit = null;
      }
      steps.push(r);
    });

    // “把互锁去掉，画个正反转”：remove 先于 draw 时，把“去掉互锁”
    // 记到后续 draw 的 attrs 上，避免 draw 的默认值又把它画回来。
    for (var ri = 0; ri < steps.length - 1; ri++) {
      var rm = steps[ri];
      if (rm.op !== 'remove' || rm.object !== 'interlock') continue;
      var di = ri + 1;
      while (di < steps.length && (steps[di].op === 'none' || steps[di].op === 'attrs')) di++;
      var dr = steps[di];
      if (!dr || dr.op !== 'draw' || dr.type !== 'reverse') continue;
      // 后面明确要互锁时，以后面为准
      if (dr.explicit && dr.explicit.interlock && dr.attrs && dr.attrs.interlock === true) continue;
      dr.attrs = dr.attrs || {};
      dr.attrs.interlock = false;
      dr.explicit = dr.explicit || {};
      dr.explicit.interlock = true;
      steps.splice(ri, 1);
      ri--;
    }

    if (unparsed.length) {
      return {
        ok: false,
        reason: '有没理解的片段：' + unparsed.join('；'),
        confidence: 0.2,
        steps: steps
      };
    }

    var meaningful = steps.filter(function (s) {
      return s.op && s.op !== 'none' && s.op !== 'attrs';
    });

    // 只有属性否定、没有可作用的图：是明确的不动作，而不是“没听懂”
    if (!meaningful.length && hadAttrs) {
      return {
        ok: true, op: 'none', reason: '只有属性否定，没有可作用的对象',
        confidence: 0.7, steps: []
      };
    }
    if (!meaningful.length) {
      if (steps.length) return finalize(steps[0], steps, 0.9);
      return { ok: false, reason: '没有识别出可执行的操作', confidence: 0, steps: [] };
    }

    var last = meaningful[meaningful.length - 1];
    var minConf = Math.min.apply(null, meaningful.map(function (s) { return s.confidence; }));
    var out = finalize(last, steps, minConf);
    out.clear = meaningful.some(function (s) { return s.op === 'clear' || s.clear; });
    return out;
  }

  function finalize(primary, steps, conf) {
    return {
      ok: true,
      op: primary.op,
      type: primary.type || null,
      attrs: primary.attrs || null,
      object: primary.object || null,
      component: primary.component || null,
      key: primary.key || null,
      from: primary.from || null,
      to: primary.to || null,
      clear: !!primary.clear,
      replace: primary.replace !== false,
      confidence: Math.round(conf * 100) / 100,
      reason: primary.reason || '',
      steps: steps.map(function (s) {
        return {
          op: s.op, type: s.type || null, object: s.object || null,
          component: s.component || null, key: s.key || null,
          from: s.from || null, to: s.to || null,
          attrs: s.attrs || null,
          explicit: s.explicit || null,
          replace: s.replace !== false,
          clear: !!s.clear,
          reason: s.reason || ''
        };
      })
    };
  }

  return {
    route: route,
    // 给测试用，正式接入时可以删掉
    _internals: { normalize: normalize, splitClauses: splitClauses, parseClause: parseClause }
  };
});
