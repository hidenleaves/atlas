/* ============================================================
   plc-atlas · 画布语义 API (PLCApi)
   ------------------------------------------------------------
   给"模型"用的接口层。模型只表达意图（放什么、连什么），
   坐标、走线、吸附、绑定全部由这一层算 —— 模型不碰几何。

   设计原则：
   1. 每个方法都是纯数据进出，不碰 DOM，可在浏览器和 Node 里跑
   2. 统一返回 { ok, ... } ，失败带 error 文本，方便模型自我纠正
   3. ref 一律支持 "代号"（QA1）或内部 id，模型用代号最自然
   ============================================================ */
(function (global) {
  'use strict';

  var M = global.PLCEditorModel;
  if (!M) return;

  var GRID = 10;
  var GAP_X = 120;   // 左右摆放间距
  var GAP_Y = 90;    // 上下摆放间距

  /* ---------------- 基础工具 ---------------- */

  function snap(v) { return Math.round(v / GRID) * GRID; }

  function ortho(from, to) {
    var fx = snap(from[0]), fy = snap(from[1]);
    var tx = snap(to[0]), ty = snap(to[1]);
    if (Math.abs(fx - tx) < 0.5 || Math.abs(fy - ty) < 0.5) return [[tx, ty]];
    // 先横后竖，和手工画线的手感一致
    return [[tx, fy], [tx, ty]];
  }

  function findRef(doc, ref) {
    if (!doc || ref == null) return null;
    var s = String(ref).trim();

    // type:key 形式 —— 同名元件必须能区分（线圈 QA1 与自锁触点 QA1 是两回事）
    var tm = s.match(/^([a-zA-Z][a-zA-Z0-9]*):(.+)$/);
    if (tm) {
      var hit = doc.comps.filter(function (c) {
        return c.type === tm[1] && (c.key || '') === tm[2];
      });
      if (hit.length) return hit[0];
    }

    var byId = doc.comps.filter(function (c) { return c.id === s; })[0];
    if (byId) return byId;
    var byKey = doc.comps.filter(function (c) { return (c.key || '') === s; });
    if (byKey.length === 1) return byKey[0];
    // 同名多个（如 QA1 的线圈 + 3 个主触点）优先返回线圈类
    if (byKey.length > 1) {
      var coil = byKey.filter(function (c) {
        return /coil/i.test(c.type);
      })[0];
      return coil || byKey[0];
    }
    return null;
  }

  function boxOf(c) { return M.boxOf(c); }
  function pinsOf(c) { return M.pinsOfComp(c); }

  function overlaps(doc, box) {
    return doc.comps.some(function (c) {
      var b = boxOf(c);
      return !(b.x >= box.x + box.w || b.x + b.w <= box.x ||
               b.y >= box.y + box.h || b.y + b.h <= box.y);
    });
  }

  /* ---------------- 定位：给元件找个不打架的位置 ---------------- */

  function placeSpot(doc, type, opt) {
    opt = opt || {};
    var t = M.TYPES[type];
    var probe = t.make(0, 0);
    probe.type = type;

    // 1) 明确给了坐标
    if (opt.x != null && opt.y != null) {
      probe = t.make(snap(opt.x), snap(opt.y));
      probe.type = type;
      return { x: probe.x, y: probe.y };
    }

    // 2) 以某个元件为锚点（没指定就用最后一个）
    var anchor = findRef(doc, opt.near) ||
      (doc.comps.length ? doc.comps[doc.comps.length - 1] : null);
    // 默认往下排：控制回路本来就是一串竖着的，横着排会导致长线穿过元件
    var side = opt.side || 'below';

    if (!anchor) {
      // 空画布：从左上角开始
      return { x: snap(doc.w * 0.25), y: snap(doc.h * 0.25) };
    }

    var ab = boxOf(anchor);
    var w = 40, h = probe.h || 40;
    var tries = 0, cand;

    while (tries++ < 10) {
      if (side === 'right')      cand = { x: ab.x + ab.w + GAP_X, y: ab.y };
      else if (side === 'left')  cand = { x: ab.x - GAP_X, y: ab.y };
      // 上下摆放时按"中心对齐"，竖排才是一条直线，不会左右漂移
      else if (side === 'below') cand = { x: ab.x + ab.w / 2, y: ab.y + ab.h + GAP_Y };
      else                       cand = { x: ab.x + ab.w / 2, y: ab.y - GAP_Y - h };

      cand.x = snap(cand.x);
      cand.y = snap(cand.y);
      var box = { x: cand.x - 20, y: cand.y - 8, w: 40, h: h + 16 };
      if (!overlaps(doc, box)) return cand;

      // 撞了就往同一方向再挪一格
      if (side === 'right') ab = { x: ab.x + GAP_X, y: ab.y, w: ab.w, h: ab.h };
      else if (side === 'left') ab = { x: ab.x - GAP_X, y: ab.y, w: ab.w, h: ab.h };
      else if (side === 'below') ab = { x: ab.x, y: ab.y + GAP_Y, w: ab.w, h: ab.h };
      else ab = { x: ab.x, y: ab.y - GAP_Y, w: ab.w, h: ab.h };
    }
    return { x: snap(ab.x), y: snap(ab.y) };
  }

  function nextKey(doc, type) {
    var prefix = (M.TYPES[type] || {}).tryKey || '';
    if (!prefix) return '';
    var max = 0, re = new RegExp('^' + prefix + '(\\d+)$');
    doc.comps.forEach(function (c) {
      var m = (c.key || '').match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    // 线圈和主触点共用代号，所以只要全图有这个前缀就继续往上加
    return prefix + (max + 1);
  }

  /* ---------------- 引脚解析 ---------------- */

  // ref 形式：'QA1'（默认上脚） | 'QA1#1'（下脚） | 'QA1#0' | 内部 id
  function parsePin(doc, ref) {
    var s = String(ref || '').trim();
    var idx = null;
    var m = s.match(/^(.*)#(\d+)$/);
    if (m) { s = m[1]; idx = parseInt(m[2], 10); }
    var c = findRef(doc, s);
    if (!c) return { error: '找不到元件 ' + s };
    var ps = pinsOf(c);
    if (!ps.length) return { error: s + ' 没有可接线的引脚' };
    var i = idx == null ? 0 : idx;
    if (!ps[i]) return { error: s + ' 没有第 ' + (i + 1) + ' 个引脚（共 ' + ps.length + ' 个）' };
    return { comp: c, i: i, pt: ps[i], pins: ps };
  }

  /* ---------------- 连通性 ---------------- */

  function netsOf(doc) {
    if (!global.PLCAdvisor) return null;
    try { return global.PLCAdvisor.buildNets(doc); } catch (e) { return null; }
  }

  function sameNet(doc, a, b) {
    var nb = netsOf(doc);
    if (!nb) return false;
    var k1 = (Math.round(a[0] * 2) / 2) + ',' + (Math.round(a[1] * 2) / 2);
    var k2 = (Math.round(b[0] * 2) / 2) + ',' + (Math.round(b[1] * 2) / 2);
    return nb.net.find(k1) === nb.net.find(k2);
  }

  /* ============================================================
     对外 API
     ============================================================ */

  var api = {};

  /* ---- 读 ---- */

  api.summary = function (doc) {
    var comps = doc.comps.map(function (c) {
      var t = M.TYPES[c.type] || {};
      var b = boxOf(c);
      return {
        id: c.id, type: c.type, name: t.name || c.type,
        key: c.key || '', x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2),
        pins: pinsOf(c).length
      };
    });
    var res = global.PLCAdvisor ? global.PLCAdvisor.analyze(doc) : null;
    return {
      title: doc.title || '', no: doc.no || '',
      size: { w: doc.w, h: doc.h },
      comps: comps,
      wireCount: doc.wires.length,
      intent: res && res.intent ? res.intent.name : null,
      issues: res ? res.issues.map(function (x) {
        return { level: x.level, msg: x.msg };
      }) : []
    };
  };

  api.comps = function (doc, type) {
    return doc.comps.filter(function (c) {
      return !type || c.type === type;
    }).map(function (c) {
      return { id: c.id, type: c.type, key: c.key || '', name: (M.TYPES[c.type] || {}).name };
    });
  };

  api.pins = function (doc, ref) {
    var p = parsePin(doc, ref);
    if (p.error) return { ok: false, error: p.error };
    return {
      ok: true,
      comp: p.comp.key || p.comp.id,
      pins: p.pins.map(function (pt, i) { return { index: i, x: pt[0], y: pt[1] }; })
    };
  };

  api.analyze = function (doc) {
    if (!global.PLCAdvisor) return { ok: false, error: 'advisor 未加载' };
    var r = global.PLCAdvisor.analyze(doc);
    return {
      ok: r.level === 'ok',
      level: r.level,
      intent: r.intent ? r.intent.name : null,
      issues: r.issues.map(function (x) {
        return { level: x.level, msg: x.msg, code: x.code };
      })
    };
  };

  /* ---- 写 ---- */

  api.place = function (doc, type, opt) {
    opt = opt || {};
    var t = M.TYPES[type];
    if (!t) {
      return {
        ok: false,
        error: '没有这种元件：' + type,
        types: Object.keys(M.TYPES).map(function (k) {
          return k + '(' + M.TYPES[k].name + ')';
        })
      };
    }
    var spot = placeSpot(doc, type, opt);
    var c = t.make(spot.x, spot.y);
    c.type = type;
    c.id = M.uid('c');
    c.key = opt.key || nextKey(doc, type);
    if (t.label && c.key) {
      c.label = {
        text: c.key, ox: t.label.ox, oy: t.label.oy,
        anchor: t.label.anchor, size: t.label.size
      };
    }
    doc.comps.push(c);
    var b = boxOf(c);
    return {
      ok: true, id: c.id, key: c.key,
      type: type, name: t.name,
      x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2),
      pinCount: pinsOf(c).length
    };
  };

  api.connect = function (doc, from, to, opt) {
    opt = opt || {};
    var A = parsePin(doc, from), B = parsePin(doc, to);
    if (A.error) return { ok: false, error: A.error };
    if (B.error) return { ok: false, error: B.error };
    if (A.comp.id === B.comp.id) {
      return { ok: false, error: '同一个元件的两个引脚不能互连（会短路）' };
    }
    if (sameNet(doc, A.pt, B.pt)) {
      return { ok: false, error: '这两个点已经连通了，不用再连' };
    }

    var pts = [[A.pt[0], A.pt[1]]].concat(ortho(A.pt, B.pt));
    var w = { id: M.uid('w'), pts: pts, a: { c: A.comp.id, i: A.i }, b: { c: B.comp.id, i: B.i } };
    M.resolveWire(doc, w);
    doc.wires.push(w);
    return {
      ok: true, wireId: w.id, points: w.pts.length,
      from: (A.comp.key || A.comp.id) + '#' + A.i,
      to: (B.comp.key || B.comp.id) + '#' + B.i
    };
  };

  // 从某个引脚引一段线到空点（画母线 / 引出线用，另一端不绑定）
  api.lead = function (doc, ref, pinIdx, x, y) {
    var r = String(ref);
    if (pinIdx != null) r += '#' + pinIdx;
    var p = parsePin(doc, r);
    if (p.error) return { ok: false, error: p.error };
    var pts = [[p.pt[0], p.pt[1]]].concat(ortho(p.pt, [x, y]));
    var w = { id: M.uid('w'), pts: pts, a: { c: p.comp.id, i: p.i } };
    M.resolveWire(doc, w);
    doc.wires.push(w);
    return { ok: true, wireId: w.id };
  };

  /* 按节点表连线。
     nodes = [{ name:'L', pins:['SF1#0','no:QA1#0'] }, ...]
     同一节点里的所有引脚属于同一根线，具体怎么铺由这里算。
     模型只要描述电气拓扑，不用再算"哪个脚连哪个脚"，
     复杂图也不会漏 —— 这是画完接不上的根因。 */
  api.wireNodes = function (doc, nodes) {
    var out = [];
    (nodes || []).forEach(function (node, ni) {
      var name = node.name || ('节点' + (ni + 1));
      var list = [], errs = [];

      (node.pins || []).forEach(function (ref) {
        var p = parsePin(doc, ref);
        if (p.error) { errs.push(ref + '：' + p.error); return; }
        list.push(p);
      });

      if (list.length < 2) {
        out.push({
          node: name, ok: false,
          error: errs.length ? errs.join('；') : '这个节点少于 2 个引脚，不需要连'
        });
        return;
      }

      // 先按 x 分组：同一列的引脚竖向串起来（这正是教材图的画法），
      // 不同列之间再用横线接到主干上。
      // 如果直接按 y 排序串联，横线会从元件身上穿过去。
      var cols = {};
      list.forEach(function (p) {
        var cx = Math.round(p.pt[0]);
        (cols[cx] = cols[cx] || []).push(p);
      });
      var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });

      var made = 0, fail = [];
      function join(A, B) {
        if (sameNet(doc, A.pt, B.pt)) return;
        var r = api.connect(doc, A.comp.id + '#' + A.i, B.comp.id + '#' + B.i);
        if (r.ok) made++;
        else fail.push(r.error);
      }

      // 列内：竖向串联
      colKeys.forEach(function (k) {
        var g = cols[k].sort(function (a, b) { return a.pt[1] - b.pt[1]; });
        for (var i = 1; i < g.length; i++) join(g[i - 1], g[i]);
      });

      // 列间：用每列最上面那点做横向主干
      if (colKeys.length > 1) {
        var tops = colKeys.map(function (k) {
          return cols[k].sort(function (a, b) { return a.pt[1] - b.pt[1]; })[0];
        });
        for (var t = 1; t < tops.length; t++) join(tops[0], tops[t]);
      }

      out.push({
        node: name, ok: fail.length === 0,
        pins: list.length, wires: made,
        error: fail.length ? fail.join('；') : undefined
      });
    });

    var bad = out.filter(function (x) { return !x.ok; });
    return { ok: bad.length === 0, total: out.length, failed: bad.length, nodes: out };
  };

  // 按代号把两个元件"自然连起来"：上→下，跨水平就 A 下脚到 B 上脚
  api.link = function (doc, aRef, bRef) {
    var A = findRef(doc, aRef), B = findRef(doc, bRef);
    if (!A || !B) return { ok: false, error: '找不到元件 ' + (!A ? aRef : bRef) };
    var pa = pinsOf(A), pb = pinsOf(B);
    if (pa.length < 2 || pb.length < 2) return { ok: false, error: '有元件只有一个引脚' };
    var ab = boxOf(A), bb = boxOf(B);
    // B 在 A 下方：A 下脚 → B 上脚；否则 A 上脚 → B 上脚
    var fromIdx = (bb.y >= ab.y) ? 1 : 0;
    var toIdx = 0;
    return api.connect(doc, A.id + '#' + fromIdx, B.id + '#' + toIdx);
  };

  api.remove = function (doc, ref) {
    var c = findRef(doc, ref);
    if (!c) return { ok: false, error: '找不到元件 ' + ref };
    var id = c.id, key = c.key || id;
    doc.comps = doc.comps.filter(function (x) { return x.id !== id; });
    // 连着它的线一并删掉，不然会留下悬空线头
    var before = doc.wires.length;
    doc.wires = doc.wires.filter(function (w) {
      return !(w.a && w.a.c === id) && !(w.b && w.b.c === id);
    });
    return { ok: true, removed: key, wiresRemoved: before - doc.wires.length };
  };

  api.move = function (doc, ref, x, y) {
    var c = findRef(doc, ref);
    if (!c) return { ok: false, error: '找不到元件 ' + ref };
    if (c.cx != null) { c.cx = snap(x); c.cy = snap(y); }
    else { c.x = snap(x); c.y = snap(y); }
    M.resolveWires(doc);
    return { ok: true, key: c.key || c.id, x: snap(x), y: snap(y) };
  };

  api.setKey = function (doc, ref, key) {
    var c = findRef(doc, ref);
    if (!c) return { ok: false, error: '找不到元件 ' + ref };
    var old = c.key || '';
    c.key = String(key || '').trim();
    if (c.label) c.label.text = c.key;
    else {
      var t = M.TYPES[c.type];
      if (t && t.label && c.key) {
        c.label = {
          text: c.key, ox: t.label.ox, oy: t.label.oy,
          anchor: t.label.anchor, size: t.label.size
        };
      }
    }
    return { ok: true, from: old, to: c.key };
  };

  // 给某个线圈补一个同名辅助触点（并联在某个操作件两端）
  api.addSelfLock = function (doc, coilRef, buttonRef) {
    var coil = findRef(doc, coilRef);
    if (!coil) return { ok: false, error: '找不到线圈 ' + coilRef };
    var key = coil.key;
    if (!key) return { ok: false, error: '这个线圈还没有代号，先给它编个代号' };
    var has = doc.comps.some(function (c) { return c.type === 'no' && c.key === key; });
    if (has) return { ok: false, error: key + ' 已经有常开触点了' };

    var btn = findRef(doc, buttonRef) ||
      doc.comps.filter(function (c) {
        return (c.type === 'btnNo' || /^no$/.test(c.type)) && /^S/i.test(c.key || '');
      })[0];
    if (!btn) return { ok: false, error: '找不到要并联的按钮' };

    // 并联在按钮右侧：纵向与按钮对齐，横向留出足够空间，别让并联线压住代号
    var bb = boxOf(btn);
    var px = bb.x + bb.w + 80, py = bb.y + 6;
    var guard = 0;
    while (guard++ < 6 && overlaps(doc, { x: px - 24, y: py - 8, w: 48, h: 56 })) {
      px += 80;
    }
    var r = api.place(doc, 'no', { key: key, x: px, y: py });
    if (!r.ok) return r;
    var c = findRef(doc, r.id);
    if (c.label) { c.label.ox = 16; c.label.oy = 20; c.label.anchor = 'start'; }
    var bp = pinsOf(btn), cp = pinsOf(c);
    var w1 = api.connect(doc, btn.id + '#0', c.id + '#0');
    var w2 = api.connect(doc, c.id + '#1', btn.id + '#1');
    return {
      ok: w1.ok && w2.ok,
      key: key, comp: r.id, x: r.x, y: r.y,
      wires: [w1.ok, w2.ok]
    };
  };

  api.clear = function (doc) {
    var n = doc.comps.length;
    doc.comps = [];
    doc.wires = [];
    doc.marks = [];
    doc.texts = [];
    return { ok: true, removed: n };
  };

  /* ---- 批量：一次调用做多件事，减少往返 ---- */
  api.batch = function (doc, ops) {
    var out = [];
    (ops || []).forEach(function (op) {
      var fn = api[op.op];
      if (!fn) { out.push({ ok: false, error: '未知操作 ' + op.op }); return; }
      var args = (op.args || []).slice();
      args.unshift(doc);
      try { out.push(fn.apply(null, args)); }
      catch (e) { out.push({ ok: false, error: String(e.message || e) }); }
    });
    return { ok: out.every(function (r) { return r.ok; }), results: out };
  };

  /* ---- 描述：给模型看的工具说明 ---- */
  api.manifest = function () {
    var types = Object.keys(M.TYPES).map(function (k) {
      var t = M.TYPES[k];
      return k + ' = ' + t.name + (t.tryKey ? '（代号前缀 ' + t.tryKey + '）' : '');
    });
    return {
      version: 1,
      elementTypes: types,
      note: '模型只需给出"放什么、连什么"，坐标由画板自动布局'
    };
  };

  global.PLCApi = api;
})(typeof window !== 'undefined' ? window : global);
