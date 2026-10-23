/* ============================================================
   editor-ui.js — 画板交互层
   ============================================================ */
(function (global) {
  'use strict';

  var M = global.PLCEditorModel;

  var st = {
    mode: 'atlas',
    docs: [], curId: null, doc: null,
    sel: null, place: null, wire: null, drag: null,
    hover: null, placePos: null,
    hist: [], hi: -1,
    zoom: 1, q: '',
    sim: false, energized: {},
    guides: [], guideHint: '',
    snapOn: true, grid: true, menu: null,
    advOpen: true, adv: null, flash: null
  };

  var el = {};

  function $(s) { return document.querySelector(s); }
  // 网格吸附开关关掉时原样返回（端点吸附不受影响）
  function SN(v) { return st.snapOn ? M.snap(v) : v; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------- 初始化 ---------------- */
  function cache() {
    el.app = $('#edApp');
    el.canvas = $('#edCanvas');
    el.list = $('#docList');
    el.lib = $('#libList');
    el.insp = $('#edInsp');
    el.adv = $('#edAdv');
    el.foot = $('#edInspFoot');
    el.title = $('#edTitle');
    el.eyebrow = $('#edEyebrow');
    el.hint = $('#edHint');
    el.menu = $('#edMenu');
    el.count = $('#edCount');
    el.chip = $('#edChip');
    el.chipText = $('#edChipText');
    el.placeBar = $('#edPlaceBar');
  }

  function boot() {
    cache();
    var saved = M.load();
    st.docs = saved && saved.length ? saved : [];
    if (!st.docs.length) st.docs.push(M.blank(760, 500));
    st.curId = st.docs[0].id;
    st.doc = st.docs[0];

    if (!M.save(st.docs)) {
      HINT = '当前浏览器不允许本页保存，请用「导出 .json」备份图纸';
      if (el.hint) el.hint.textContent = HINT;
    }

    renderLib();
    bind();
    renderDocList();
    loadDoc(st.curId, true);
  }

  /* ---------------- 文档 ---------------- */
  function saveAll() { M.save(st.docs); }

  function loadDoc(id, silent) {
    var d = null;
    st.docs.forEach(function (x) { if (x.id === id) d = x; });
    if (!d) return;
    st.doc = d;
    st.curId = id;
    st.sel = null; st.wire = null; st.drag = null; st.place = null;
    st.flash = null; clearTimeout(st._flashT);
    st.energized = {};
    st.hist = []; st.hi = -1;
    commit(true);
    fitZoom();
    paint();
    renderInspector();
    renderDocList();
    if (!silent) updateHead();
    updateHead();
  }

  function newDoc(doc) {
    st.docs.unshift(doc);
    saveAll();
    loadDoc(doc.id);
  }

  function deleteDoc(id) {
    if (st.docs.length <= 1) { flash('至少保留一张图纸'); return; }
    st.docs = st.docs.filter(function (d) { return d.id !== id; });
    saveAll();
    loadDoc(st.docs[0].id);
  }

  /* ---------------- 历史 ---------------- */
  function snapshot() {
    if (!st.doc) return '';
    return JSON.stringify({
      comps: st.doc.comps, wires: st.doc.wires, marks: st.doc.marks,
      deco: st.doc.deco, texts: st.doc.texts, no: st.doc.no,
      title: st.doc.title, w: st.doc.w, h: st.doc.h
    });
  }

  function commit(silent) {
    if (!st.doc) return;
    var s = snapshot();
    if (st.hist[st.hi] === s) return;
    st.hist = st.hist.slice(0, st.hi + 1);
    st.hist.push(s);
    if (st.hist.length > 80) st.hist.shift();
    st.hi = st.hist.length - 1;
    saveAll();
    if (!silent) updateHead();
  }

  function restore(s) {
    var o = JSON.parse(s);
    st.doc.comps = o.comps; st.doc.wires = o.wires; st.doc.marks = o.marks;
    st.doc.deco = o.deco; st.doc.texts = o.texts;
    st.doc.no = o.no; st.doc.title = o.title; st.doc.w = o.w; st.doc.h = o.h;
    st.sel = null; st.wire = null;
    paint(); renderInspector(); updateHead();
  }

  function undo() { if (st.hi > 0) { st.hi--; restore(st.hist[st.hi]); } }
  function redo() { if (st.hi < st.hist.length - 1) { st.hi++; restore(st.hist[st.hi]); } }

  /* ---------------- 头部 / 状态 ---------------- */
  function updateHead() {
    if (!st.doc) return;
    el.title.textContent = st.doc.title || '未命名电路';
    el.eyebrow.textContent = '画板　·　图 ' + (st.doc.no || '—') + '　·　' +
      st.doc.comps.length + ' 个元件 / ' + st.doc.wires.length + ' 段导线';
    el.count.textContent = st.doc.w + ' × ' + st.doc.h;
  }

  function updateStatus() {
    var d = st.doc;
    if (!d) return;
    var dangling = danglingPins();
    var txt;
    if (st.sim) {
      var on = Object.keys(st.energized).filter(function (k) { return st.energized[k]; });
      txt = on.length ? '通电：' + on.join(' / ') : '未通电';
    } else if (st.wire) {
      txt = '连线中：点下一个端点收尾，Esc 取消';
    } else if (st.guideHint) {
      txt = '⇔ ' + st.guideHint;
    } else if (st.place) {
      txt = '放置 ' + M.TYPES[st.place].name + '：在图纸上单击，Esc 退出';
    } else if (dangling) {
      txt = dangling + ' 个端点未接线';
    } else {
      txt = '元件 ' + d.comps.length + ' · 导线 ' + d.wires.length;
    }
    el.chipText.textContent = txt;
    el.chip.classList.toggle('running', !!st.sim);
    el.placeBar.hidden = !st.place;
    if (st.place) el.placeBar.querySelector('span').textContent = '正在放置：' + M.TYPES[st.place].name;
  }

  function danglingPins() {
    var d = st.doc;
    var ends = {};
    d.wires.forEach(function (w) {
      if (!w.pts.length) return;
      [w.pts[0], w.pts[w.pts.length - 1]].forEach(function (p) {
        ends[p[0] + ',' + p[1]] = 1;
      });
    });
    var cnt = 0;
    M.pinsOf(d).forEach(function (p) {
      if (ends[p.x + ',' + p.y]) return;
      // 端点落在导线中段也算接上
      var hit = false;
      for (var i = 0; i < d.wires.length && !hit; i++) {
        var pts = d.wires[i].pts;
        for (var j = 0; j < pts.length - 1; j++) {
          if (M.onSeg(pts[j], pts[j + 1], p.x, p.y)) { hit = true; break; }
        }
      }
      if (!hit) cnt++;
    });
    return cnt;
  }

  function flash(msg) {
    el.hint.textContent = msg;
    setTimeout(function () { el.hint.textContent = HINT; }, 1800);
  }
  var HINT = '点元件端点起线 → 点目标端点收笔　·　Delete 删除　·　Ctrl+Z 撤销';

  /* ---------------- 左栏：我的图纸 ---------------- */
  function renderDocList() {
    var q = st.q.trim().toLowerCase();
    var items = st.docs.filter(function (d) {
      if (!q) return true;
      return ((d.title || '') + ' ' + (d.no || '')).toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) {
      el.list.innerHTML = '<div class="side-empty">没有匹配的图纸。</div>';
      return;
    }
    el.list.innerHTML = items.map(function (d) {
      return '<button class="nav-item' + (d.id === st.curId ? ' active' : '') +
        '" data-doc="' + d.id + '">' +
        '<span class="nav-no">' + (d.no || '—') + '</span>' +
        '<span class="nav-t">' + (d.title || '未命名电路') + '</span></button>';
    }).join('');
  }

  /* ---------------- 左栏：元件库 ---------------- */
  function libIcon(type) {
    var t = M.TYPES[type];
    var c = t.make(0, 0);
    c.id = 'ico';
    // 多极元件在 38px 见方的图标里会糊成一团，把极间距离收窄一点
    if (c.pitch) c.pitch = 18;
    var b = t.box(c);
    var vb = (b.x - 5) + ' ' + (b.y - 5) + ' ' + (b.w + 10) + ' ' + (b.h + 10);
    return '<svg class="lib-svg sheet-svg" viewBox="' + vb + '" xmlns="http://www.w3.org/2000/svg">' +
      t.svg(c) + '</svg>';
  }

  var EXTRAS = [
    { type: 'text', name: '文字标注' },
    { type: 'dot', name: '接点' },
    { type: 'term', name: '端子' }
  ];

  // 一键模板：和对话作图共用 api.drawTemplate
  var TPLS = [
    { kind: 'jog', name: '点动' },
    { kind: 'selflock', name: '起保停' },
    { kind: 'interlock', name: '互锁' },
    { kind: 'reverse', name: '正反转' },
    { kind: 'reverse', name: '正反转+主电路', main: true },
    { kind: 'remote', name: '两地控制' }
  ];

  function tplIcon() {
    return '<svg class="lib-svg sheet-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="#2447C9" stroke-width="1.4"/>' +
      '<path d="M8 8h8M8 12h8M8 16h5" stroke="#2447C9" stroke-width="1.4" stroke-linecap="round"/>' +
      '</svg>';
  }

  function renderLib() {
    var html = '<div class="lib-grp"><div class="cat-name"><span>模板</span></div>';
    TPLS.forEach(function (t) {
      html += '<button class="lib-item tpl" data-tpl="' + t.kind + '"' +
        (t.main ? ' data-main="1"' : '') +
        ' title="用模板替换当前图纸">' +
        '<span class="lib-ico">' + tplIcon() + '</span>' +
        '<span class="lib-name">' + t.name + '</span></button>';
    });
    html += '</div>';
    M.LIB.forEach(function (g) {
      html += '<div class="lib-grp"><div class="cat-name"><span>' + g.name + '</span></div>';
      g.items.forEach(function (type) {
        html += '<button class="lib-item" data-type="' + type + '">' +
          '<span class="lib-ico">' + libIcon(type) + '</span>' +
          '<span class="lib-name">' + M.TYPES[type].name + '</span></button>';
      });
      html += '</div>';
    });
    html += '<div class="lib-grp"><div class="cat-name"><span>标注</span></div>';
    EXTRAS.forEach(function (x) {
      html += '<button class="lib-item" data-extra="' + x.type + '">' +
        '<span class="lib-ico">' + extraIcon(x.type) + '</span>' +
        '<span class="lib-name">' + x.name + '</span></button>';
    });
    html += '</div>';
    el.lib.innerHTML = html;
  }

  function extraIcon(kind) {
    var s = '<svg class="lib-svg sheet-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">';
    if (kind === 'text') s += '<path d="M6 6h12M12 6v12" stroke="#1A1C1F" stroke-width="1.8" stroke-linecap="round"/>';
    else if (kind === 'dot') s += '<circle cx="12" cy="12" r="3.2" fill="#1A1C1F"/>';
    else s += '<circle cx="12" cy="12" r="3.4" fill="#fff" stroke="#1A1C1F" stroke-width="1.6"/>';
    return s + '</svg>';
  }

  /* ---------------- 画布绘制 ---------------- */
  function paint() {
    var d = st.doc;
    if (!d) return;
    var base = M.renderInner(d);   // 顺带把绑在引脚上的导线端点刷新到最新位置
    // 诊断在这里同步算一次：画布标记和右侧面板共用，几十个元件 1ms 量级
    st.adv = window.PLCAdvisor ? window.PLCAdvisor.analyze(d) : null;
    var inner = base + '<g class="ovl">' + overlaySvg() + '</g>';
    el.canvas.innerHTML = M.svgWrap(d, inner);
    var svg = el.canvas.querySelector('svg');
    svg.classList.toggle('sim', !!st.sim);
    svg.style.width = (d.w * st.zoom) + 'px';
    svg.style.height = (d.h * st.zoom) + 'px';
    var g1 = Math.max(6, Math.round(M.GRID * st.zoom));
    var g5 = g1 * 5;
    if (!st.grid) {
      svg.style.backgroundImage = 'none';
    } else {
      svg.style.backgroundImage =
        'linear-gradient(to right,#E4E4DC 1px,transparent 1px),' +
        'linear-gradient(to bottom,#E4E4DC 1px,transparent 1px),' +
        'linear-gradient(to right,#F3F3EC 1px,transparent 1px),' +
        'linear-gradient(to bottom,#F3F3EC 1px,transparent 1px)';
      svg.style.backgroundSize = g5 + 'px ' + g5 + 'px,' + g5 + 'px ' + g5 + 'px,' +
        g1 + 'px ' + g1 + 'px,' + g1 + 'px ' + g1 + 'px';
    }
    applySim();
    updateStatus();
    scheduleAdvisor();
  }

  function applySim() {
    var svg = el.canvas.querySelector('svg');
    if (!svg) return;
    var any = false;
    Object.keys(st.energized).forEach(function (k) { if (st.energized[k]) any = true; });
    var nodes = svg.querySelectorAll('.cmp');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-key');
      var on = !!st.energized[k];
      if (!on && nodes[i].getAttribute('data-type') === 'motor' && !k) on = any;
      var sym = nodes[i].querySelector('.contact, .coil, .motor, .lamp, .bell');
      if (sym) sym.classList.toggle('on', on);
    }
  }

  function selBox() {
    if (!st.sel) return null;
    var d = st.doc;
    if (st.sel.kind === 'comp') {
      var c = findComp(st.sel.id);
      return c ? M.boxOf(c) : null;
    }
    if (st.sel.kind === 'text') {
      var t = findText(st.sel.id);
      if (!t) return null;
      var w = Math.max(24, t.text.length * t.size * 0.62);
      var x0 = t.anchor === 'end' ? t.x - w : t.anchor === 'middle' ? t.x - w / 2 : t.x;
      return { x: x0 - 3, y: t.y - t.size * 0.72, w: w + 6, h: t.size * 1.44 };
    }
    if (st.sel.kind === 'wire') {
      var wr = null;
      d.wires.forEach(function (w) { if (w.id === st.sel.id) wr = w; });
      if (!wr) return null;
      var xs = wr.pts.map(function (p) { return p[0]; });
      var ys = wr.pts.map(function (p) { return p[1]; });
      return { x: Math.min.apply(null, xs) - 5, y: Math.min.apply(null, ys) - 5,
        w: Math.max.apply(null, xs) - Math.min.apply(null, xs) + 10,
        h: Math.max.apply(null, ys) - Math.min.apply(null, ys) + 10 };
    }
    if (st.sel.kind === 'mark' || st.sel.kind === 'deco') {
      var m = findMark(st.sel.id) || findDeco(st.sel.id);
      if (!m) return null;
      var bx = m.x != null ? m.x : m.x1, by = m.y != null ? m.y : m.y1;
      var ex = m.x2 != null ? m.x2 : bx, ey = m.y2 != null ? m.y2 : by;
      return { x: Math.min(bx, ex) - 6, y: Math.min(by, ey) - 6,
        w: Math.abs(ex - bx) + 12, h: Math.abs(ey - by) + 12 };
    }
    return null;
  }

  function overlaySvg() {
    var o = '';
    var d = st.doc;
    if (d && !d.comps.length && !d.wires.length && !d.texts.length) {
      o += '<text x="' + (d.w / 2) + '" y="' + (d.h / 2 - 10) + '" font-family="' + M.SANS +
        '" font-size="13" fill="#A0A5AC" text-anchor="middle">从左栏点一个元件，在这里单击放置</text>';
      o += '<text x="' + (d.w / 2) + '" y="' + (d.h / 2 + 14) + '" font-family="' + M.SANS +
        '" font-size="11.5" fill="#B4B8BE" text-anchor="middle">单击元件端点的圆点起线，再点目标端点收笔，导线自动走直角</text>';
    }
    var r = selBox();
    if (r) o += '<rect class="sel-box" x="' + M.n(r.x) + '" y="' + M.n(r.y) +
      '" width="' + M.n(r.w) + '" height="' + M.n(r.h) + '"/>';

    // 问题定位脉冲：只画在 overlay 上，不参与命中
    if (st.flash) {
      var fb = M.targetBox(st.doc, st.flash.kind, st.flash.id);
      if (fb) {
        o += '<rect class="flash-box" x="' + M.n(fb.x - 4) + '" y="' + M.n(fb.y - 4) +
          '" width="' + M.n(fb.w + 8) + '" height="' + M.n(fb.h + 8) + '" rx="4"/>';
      }
    }

    // 接线助手的问题标记：直接标在出问题的元件角上，不用来回看右栏
    if (st.adv && st.adv.issues && st.adv.issues.length) {
      var marked = 0;
      st.adv.issues.forEach(function (it) {
        if (marked >= 8 || it.level === 'info') return;
        if (!it.target || it.target.kind !== 'comp') return;
        var c = findComp(it.target.id);
        if (!c) return;
        var b = M.boxOf(c);
        var mx = b.x + b.w + 3, my = b.y - 3;
        var col = it.level === 'error' ? '#D6436B' : '#DE9C0E';
        o += '<g class="adv-mark">' +
          '<circle cx="' + M.n(mx) + '" cy="' + M.n(my) + '" r="7.2" fill="#FFFFFF" stroke="' +
          col + '" stroke-width="1.5"/>' +
          '<text x="' + M.n(mx) + '" y="' + M.n(my + 3.4) + '" font-size="9.5" font-weight="700" fill="' +
          col + '" text-anchor="middle" font-family="' + M.SANS + '">' +
          (it.level === 'error' ? '\u00d7' : '!') + '</text>' +
          '</g>';
        marked++;
      });
    }

    // 对齐参考线：拖元件时的共线提示
    if (st.guides && st.guides.length) {
      st.guides.forEach(function (g) {
        if (g.axis === 'x') {
          o += '<line class="guide" x1="' + M.n(g.at) + '" y1="' + M.n(g.from) +
            '" x2="' + M.n(g.at) + '" y2="' + M.n(g.to) + '"/>';
        } else {
          o += '<line class="guide" x1="' + M.n(g.from) + '" y1="' + M.n(g.at) +
            '" x2="' + M.n(g.to) + '" y2="' + M.n(g.at) + '"/>';
        }
      });
    }

    if (st.hover && !st.drag && !st.wire && !st.place) {
      var c = findComp(st.hover);
      if (c) {
        M.pinsOf({ comps: [c] }).forEach(function (p) {
          o += '<circle class="pin-hint" cx="' + M.n(p.x) + '" cy="' + M.n(p.y) + '" r="3.6"/>';
        });
      }
    }

    if (st.wire) {
      var pts = st.wire.pts.slice();
      if (st.wire.cur) pts = pts.concat(orthoPath(pts[pts.length - 1], st.wire.cur));
      o += '<polyline class="wire-prev" points="' + pts.map(function (p) {
        return M.n(p[0]) + ',' + M.n(p[1]);
      }).join(' ') + '"/>';
      o += '<circle class="pin-live" cx="' + M.n(st.wire.pts[0][0]) + '" cy="' +
        M.n(st.wire.pts[0][1]) + '" r="3.8"/>';
    }

    if (st.place && st.placePos) {
      var t = M.TYPES[st.place];
      var c0 = t.make(0, 0);
      var b = t.box(c0);
      o += '<rect class="ghost" x="' + M.n(st.placePos[0] + b.x) + '" y="' +
        M.n(st.placePos[1] + b.y) + '" width="' + M.n(b.w) + '" height="' + M.n(b.h) + '"/>';
    }
    return o;
  }

  /* ---------------- 查找 ---------------- */
  function findComp(id) {
    var r = null;
    st.doc.comps.forEach(function (c) { if (c.id === id) r = c; });
    return r;
  }
  /* ---------------- 对齐参考 ----------------
     拖动元件时，若它的端点或锚点与别的元件的端点、锚点、画布中线共线，
     就吸附过去并画一条参考线，同时把「和谁共线」显示在状态栏。 */
  function alignSnap(doc, selfId, nx, ny) {
    var TOL = 6 / Math.max(st.zoom, 0.4);
    var self = findComp(selfId);
    if (!self || !M.TYPES[self.type]) return { x: nx, y: ny, guides: [], hint: '' };

    var pts = [];
    doc.comps.forEach(function (c) {
      if (c.id === selfId || !M.TYPES[c.type]) return;
      var who = c.key || M.TYPES[c.type].name;
      var a = M.anchorOf(c);
      pts.push({ x: a.x, y: a.y, who: who });
      M.pinsOfComp(c).forEach(function (q) { pts.push({ x: q[0], y: q[1], who: who }); });
    });
    pts.push({ x: doc.w / 2, y: doc.h / 2, who: '画布中线' });

    // 自身关键点：按拖动后的位置先摆一遍
    var probe = {};
    for (var k in self) probe[k] = self[k];
    if (probe.cx != null) { probe.cx = nx; probe.cy = ny; } else { probe.x = nx; probe.y = ny; }
    var mine = M.pinsOfComp(probe).map(function (q) { return { x: q[0], y: q[1] }; });
    var ma = M.anchorOf(probe);
    mine.push({ x: ma.x, y: ma.y });

    var bx = null, by = null;
    mine.forEach(function (p) {
      pts.forEach(function (q) {
        var dx = q.x - p.x;
        if (Math.abs(dx) <= TOL && (!bx || Math.abs(dx) < Math.abs(bx.d))) bx = { d: dx, p: p, q: q };
        var dy = q.y - p.y;
        if (Math.abs(dy) <= TOL && (!by || Math.abs(dy) < Math.abs(by.d))) by = { d: dy, p: p, q: q };
      });
    });

    var out = { x: nx, y: ny, guides: [], hint: '', hitX: false, hitY: false };
    if (bx) {
      out.x = nx + bx.d;
      out.guides.push({ axis: 'x', at: bx.q.x,
        from: Math.min(bx.p.y, bx.q.y) - 12, to: Math.max(bx.p.y, bx.q.y) + 12 });
      out.hitX = true;
      out.hint = '与 ' + bx.q.who + ' 竖向共线';
    }
    if (by) {
      out.y = ny + by.d;
      out.guides.push({ axis: 'y', at: by.q.y,
        from: Math.min(by.p.x, by.q.x) - 12, to: Math.max(by.p.x, by.q.x) + 12 });
      out.hitY = true;
      out.hint = (out.hint ? out.hint + ' · ' : '') + '与 ' + by.q.who + ' 横向共线';
    }
    return out;
  }

  function findText(id) {
    var r = null;
    st.doc.texts.forEach(function (t) { if (t.id === id) r = t; });
    return r;
  }
  function findMark(id) {
    var r = null;
    st.doc.marks.forEach(function (m) { if (m.id === id) r = m; });
    return r;
  }
  function findDeco(id) {
    var r = null;
    st.doc.deco.forEach(function (m) { if (m.id === id) r = m; });
    return r;
  }

  /* ---------------- 坐标 ---------------- */
  function toDoc(e) {
    var svg = el.canvas.querySelector('svg');
    if (!svg) return { x: 0, y: 0 };
    var r = svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * st.doc.w,
      y: (e.clientY - r.top) / r.height * st.doc.h
    };
  }

  function orthoPath(from, to) {
    if (Math.abs(from[0] - to[0]) < 0.5 || Math.abs(from[1] - to[1]) < 0.5) return [[to[0], to[1]]];
    var dx = to[0] - from[0], dy = to[1] - from[1];
    if (Math.abs(dx) >= Math.abs(dy)) return [[to[0], from[1]], [to[0], to[1]]];
    return [[from[0], to[1]], [to[0], to[1]]];
  }

  function fitZoom() {
    if (!st.doc || !el.canvas) return;
    var box = el.canvas.getBoundingClientRect();
    var aw = box.width - 8, ah = box.height - 8;
    if (aw <= 0 || ah <= 0) { st.zoom = 1; return; }
    var z = Math.min(aw / st.doc.w, ah / st.doc.h);
    st.zoom = Math.max(0.3, Math.min(1.6, Math.round(z * 20) / 20));
    var zl = $('#edZoomVal');
    if (zl) zl.textContent = Math.round(st.zoom * 100) + '%';
  }

  /* ---------------- 旋转 ---------------- */
  // 端点挪位后可能出现斜线段 / 重复点，整理成干净的正交折线
  function orthoFix(pts) {
    var a = [];
    pts.forEach(function (p) {
      var l = a[a.length - 1];
      if (!l || Math.abs(l[0] - p[0]) > 0.5 || Math.abs(l[1] - p[1]) > 0.5) a.push([p[0], p[1]]);
    });
    if (a.length < 2) return a;

    // 去掉共线的中间点
    var b = [];
    for (var i = 0; i < a.length; i++) {
      if (i > 0 && i < a.length - 1) {
        var pv = a[i - 1], cu = a[i], nx = a[i + 1];
        var sameX = Math.abs(pv[0] - cu[0]) < 0.5 && Math.abs(cu[0] - nx[0]) < 0.5;
        var sameY = Math.abs(pv[1] - cu[1]) < 0.5 && Math.abs(cu[1] - nx[1]) < 0.5;
        if (sameX || sameY) continue;
      }
      b.push(a[i]);
    }

    // 斜线段补一个拐点，优先顺着上一段的方向走
    var out = [b[0]];
    for (var j = 1; j < b.length; j++) {
      var p = b[j], pr = out[out.length - 1];
      if (Math.abs(pr[0] - p[0]) > 0.5 && Math.abs(pr[1] - p[1]) > 0.5) {
        var vertical = out.length >= 2 && Math.abs(out[out.length - 2][0] - pr[0]) < 0.5;
        out.push(vertical ? [pr[0], p[1]] : [p[0], pr[1]]);
      }
      out.push(p);
    }
    return out;
  }

  function rotateSel(delta) {
    if (!st.sel || st.sel.kind !== 'comp' || !delta) return;
    var c = findComp(st.sel.id);
    if (!c) return;
    var before = M.pinsOfComp(c);
    c.rot = (((c.rot || 0) + delta) % 360 + 360) % 360;
    var after = M.pinsOfComp(c);
    // 连在旧端点上的导线跟着挪到新端点，免得转一下就脱开
    st.doc.wires.forEach(function (w) {
      var moved = false;
      var pts = w.pts.map(function (p) {
        for (var i = 0; i < before.length; i++) {
          if (Math.abs(p[0] - before[i][0]) < 0.6 && Math.abs(p[1] - before[i][1]) < 0.6) {
            moved = true;
            return [after[i][0], after[i][1]];
          }
        }
        return p;
      });
      if (moved) w.pts = orthoFix(pts);
    });
    commit();
    paint();
    renderInspector();
  }

  function setRot(deg) {
    if (!st.sel || st.sel.kind !== 'comp') return;
    var c = findComp(st.sel.id);
    if (!c) return;
    var d = ((deg - M.rotOf(c)) % 360 + 360) % 360;
    rotateSel(d);
  }

  /* ---------------- 右键菜单 ---------------- */
  function closeMenu() {
    st.menu = null;
    if (el.menu) { el.menu.hidden = true; el.menu.innerHTML = ''; }
  }

  function openMenu(x, y, items) {
    if (!el.menu) return;
    el.menu.innerHTML = items.map(function (it) {
      if (it.sep) return '<div class="ctx-sep"></div>';
      if (it.head) return '<div class="ctx-head">' + M.esc(it.txt) + '</div>';
      return '<button class="ctx-item' + (it.on ? ' on' : '') + '" data-act="' + it.act + '"' +
        (it.dis ? ' disabled' : '') + '>' +
        '<span class="ctx-ico">' + (it.on ? '\u2713' : '') + '</span>' +
        '<span class="ctx-txt">' + it.txt + '</span>' +
        '<span class="ctx-key">' + (it.key || '') + '</span></button>';
    }).join('');
    el.menu.hidden = false;
    el.menu.style.left = '0px';
    el.menu.style.top = '0px';
    var r = el.menu.getBoundingClientRect();
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    el.menu.style.left = Math.max(6, Math.min(x, vw - r.width - 8)) + 'px';
    el.menu.style.top = Math.max(6, Math.min(y, vh - r.height - 8)) + 'px';
    st.menu = { x: x, y: y };
  }
  function menuItems(kind, id) {
    var items = [];
    if (kind === 'comp') {
      var c = findComp(id);
      if (!c) return items;
      var t = M.TYPES[c.type];
      items.push({ head: true, txt: t.name + (c.key ? '　' + c.key : '') + '　' + M.rotOf(c) + '°' });
      items.push({ txt: '顺时针转 90°', key: 'R', act: 'rotcw' });
      items.push({ txt: '逆时针转 90°', key: 'Shift+R', act: 'rotccw' });
      items.push({ txt: '角度回正', act: 'rot0', dis: !M.rotOf(c) });
      items.push({ sep: true });
      items.push({ txt: '复制一个', key: 'Ctrl+D', act: 'dup' });
      items.push({ txt: '在图上显示代号', act: 'showlabel', on: !!c.label });
      items.push({ txt: '居中对齐到网格', act: 'snapto' });
      items.push({ sep: true });
      items.push({ txt: '删除', key: 'Del', act: 'del' });
    } else if (kind === 'wire') {
      items.push({ head: true, txt: '导线' });
      items.push({ txt: '删除这根导线', key: 'Del', act: 'del' });
    } else if (kind === 'text') {
      items.push({ head: true, txt: '文字' });
      items.push({ txt: '下移一层', act: 'back' });
      items.push({ txt: '删除', key: 'Del', act: 'del' });
    } else if (kind === 'mark' || kind === 'deco') {
      items.push({ head: true, txt: kind === 'mark' ? '接点' : '虚线' });
      items.push({ txt: '删除', key: 'Del', act: 'del' });
    } else {
      items.push({ head: true, txt: '图纸' + (st.doc.no ? '　' + st.doc.no : '') });
      items.push({ txt: '适应画布', key: 'F', act: 'fit' });
      items.push({ txt: '显示网格', act: 'grid', on: st.grid });
      items.push({ txt: '网格吸附', act: 'snap', on: st.snapOn });
      items.push({ sep: true });
      items.push({ txt: '保存到本机', act: 'save' });
      items.push({ txt: '导出 SVG', act: 'export' });
    }
    return items;
  }

  function onCtx(e) {
    if (st.mode !== 'draw') return;
    e.preventDefault();
    var host = e.target.closest ? e.target.closest('[data-id]') : null;
    var kind = host ? (host.getAttribute('data-kind') || 'comp') : null;
    var id = host ? host.getAttribute('data-id') : null;

    st.sel = kind ? { kind: kind, id: id } : null;
    st.place = null;
    st.wire = null;
    syncLibActive();
    paint();
    renderInspector();
    openMenu(e.clientX, e.clientY, menuItems(kind, id));
    if (st.menu) { st.menu.kind = kind; st.menu.id = id; }
  }

  function onMenuClick(e) {
    var b = e.target.closest ? e.target.closest('.ctx-item') : null;
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    var s = st.sel;
    var keepOpen = (act === 'grid' || act === 'snap' || act === 'showlabel');
    if (!keepOpen) closeMenu();
    if (act === 'rotcw') rotateSel(90);
    else if (act === 'rotccw') rotateSel(-90);
    else if (act === 'rot0') setRot(0);
    else if (act === 'dup') duplicateSel();
    else if (act === 'del') deleteSel();
    else if (act === 'showlabel') toggleLabel();
    else if (act === 'snapto') snapToGrid();
    else if (act === 'fit') { fitZoom(); paint(); }
    else if (act === 'grid') { st.grid = !st.grid; paint(); }
    else if (act === 'snap') { st.snapOn = !st.snapOn; flash(st.snapOn ? '网格吸附：开' : '网格吸附：关'); }
    else if (act === 'save') { flash(M.save(st.docs) ? '已保存到本机' : '浏览器不让写本地存储'); }
    else if (act === 'export') exportSvg();
    else if (act === 'back' && s) {
      var t2 = findText(s.id);
      if (t2) { st.doc.texts.splice(st.doc.texts.indexOf(t2), 1); st.doc.texts.unshift(t2); commit(); paint(); }
    }
    // 勾选类项目原地刷新，不用重新右键
    if (keepOpen && st.menu) {
      var mk = st.menu;
      openMenu(mk.x, mk.y, menuItems(mk.kind, mk.id));
      if (st.menu) { st.menu.kind = mk.kind; st.menu.id = mk.id; }
    }
  }

  function toggleLabel() {
    if (!st.sel || st.sel.kind !== 'comp') return;
    var c = findComp(st.sel.id);
    if (!c) return;
    if (c.label) { c.label = null; }
    else if (c.key) {
      var t = M.TYPES[c.type];
      c.label = t.label ? { text: c.key, ox: t.label.ox, oy: t.label.oy,
        anchor: t.label.anchor, size: t.label.size } : { text: c.key, ox: 16, oy: -12, anchor: 'start', size: 12 };
    } else { flash('先给它填个代号'); return; }
    commit(); paint(); renderInspector();
  }

  function snapToGrid() {
    if (!st.sel) return;
    if (st.sel.kind === 'comp') {
      var c = findComp(st.sel.id);
      if (!c) return;
      if (c.cx != null) { c.cx = M.snap(c.cx); c.cy = M.snap(c.cy); }
      else { c.x = M.snap(c.x); c.y = M.snap(c.y); }
    } else if (st.sel.kind === 'text') {
      var t = findText(st.sel.id);
      if (!t) return;
      t.x = M.snap(t.x); t.y = M.snap(t.y);
    } else return;
    commit(); paint(); renderInspector();
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    el.canvas.addEventListener('pointerdown', onDown);
    el.canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.canvas.addEventListener('dblclick', function () {
      if (st.wire) { finishWire(); paint(); }
    });
    el.canvas.addEventListener('pointerleave', function () {
      if (st.hover) { st.hover = null; paint(); }
    });

    el.canvas.addEventListener('contextmenu', onCtx);
    el.canvas.addEventListener('wheel', closeMenu, { passive: true });
    if (el.menu) el.menu.addEventListener('click', onMenuClick);
    // 点别处就收菜单（capture 阶段先于画布的 pointerdown）
    document.addEventListener('pointerdown', function (e) {
      if (!st.menu) return;
      if (el.menu && el.menu.contains(e.target)) return;
      closeMenu();
    }, true);
    window.addEventListener('blur', closeMenu);

    el.lib.addEventListener('click', function (e) {
      var b = e.target.closest('.lib-item');
      if (!b) return;
      var tpl = b.getAttribute('data-tpl');
      if (tpl) { applyTemplate(tpl, b.getAttribute('data-main') === '1'); return; }
      var type = b.getAttribute('data-type');
      var extra = b.getAttribute('data-extra');
      if (extra) { addExtra(extra); return; }
      st.place = st.place === type ? null : type;
      st.wire = null;
      var items = el.lib.querySelectorAll('.lib-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('active', items[i].getAttribute('data-type') === st.place);
      }
      paint();
    });

    el.list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-doc]');
      if (b) loadDoc(b.getAttribute('data-doc'));
    });

    el.insp.addEventListener('click', onInspClick);
    el.insp.addEventListener('input', onInspInput);
    el.insp.addEventListener('change', onInspInput);
    if (el.adv) el.adv.addEventListener('click', onAdvClick);

    $('#btnNewDoc').addEventListener('click', function () {
      var d = M.blank(760, 500);
      d.title = '未命名电路';
      d.no = '1-' + pad(st.docs.length + 1);
      newDoc(d);
    });

    $('#edUndo').addEventListener('click', undo);
    $('#edRedo').addEventListener('click', redo);
    $('#edZoomIn').addEventListener('click', function () { zoom(1); });
    $('#edZoomOut').addEventListener('click', function () { zoom(-1); });
    $('#edFit').addEventListener('click', function () {
      fitZoom(); paint();
    });
    $('#edExport').addEventListener('click', exportSvg);
    $('#btnImport').addEventListener('click', function () { $('#edImportFile').click(); });
    $('#edImportFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importJson(f);
      e.target.value = '';
    });
    $('#edExportJson').addEventListener('click', exportJson);
    $('#edSim').addEventListener('click', toggleSim);
    $('#edPlaceDone').addEventListener('click', function () {
      st.place = null; syncLibActive(); paint();
    });

    $('#searchInput').addEventListener('input', function (e) {
      if (st.mode !== 'draw') return;
      st.q = e.target.value;
      renderDocList();
    });

    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function () {
      if (st.mode === 'draw') { fitZoom(); paint(); }
    });

    // 对话作图：一句话落到画布上
    if (window.PLCChat) {
      window.PLCChat.mount({
        getDoc: function () { return st.doc; },
        getSel: function () { return st.sel; },
        refresh: function () {
          commit();
          paint();
          renderInspector();
        }
      });
    }
  }

  function zoom(d) {
    var step = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8];
    var i = 0, bd = 9;
    step.forEach(function (v, k) { var dd = Math.abs(v - st.zoom); if (dd < bd) { bd = dd; i = k; } });
    i = Math.max(0, Math.min(step.length - 1, i + d));
    st.zoom = step[i];
    $('#edZoomVal').textContent = Math.round(st.zoom * 100) + '%';
    paint();
  }

  function syncLibActive() {
    var items = el.lib.querySelectorAll('.lib-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-type') === st.place);
    }
  }

  /* ---------------- 指针 ---------------- */
  function onDown(e) {
    if (e.button !== 0) return;
    if (st.mode !== 'draw') return;
    var p = toDoc(e);
    // 连线中放宽端点判定；平时收紧，免得点符号中间被当成起线
    var tol = (st.wire ? 16 : 9) / Math.max(st.zoom, 0.4);
    var snap = M.snapPoint(st.doc, p.x, p.y, tol);
    var host = e.target.closest ? e.target.closest('[data-id]') : null;

    if (st.place) {
      doPlace(snap ? [snap.x, snap.y] : [SN(p.x), SN(p.y)]);
      return;
    }

    if (st.wire) {
      var cur = st.wire.pts[st.wire.pts.length - 1];
      var target = snap ? [snap.x, snap.y] : [SN(p.x), SN(p.y)];
      var same = Math.abs(cur[0] - target[0]) < 0.5 && Math.abs(cur[1] - target[1]) < 0.5;
      if (same && st.wire.pts.length > 1) { finishWire(); paint(); return; }
      orthoPath(cur, target).forEach(function (pt) { st.wire.pts.push(pt); });
      if (snap) finishWire(snap.bind);
      paint();
      return;
    }

    // 正对圆点中心 → 选中/拖动接点；稍微偏开仍按起线处理
    if (host && host.getAttribute('data-kind') === 'mark') {
      var mm = findMark(host.getAttribute('data-id'));
      if (mm && Math.hypot(mm.x - p.x, mm.y - p.y) <= 4.5 / Math.max(st.zoom, 0.4)) {
        select({ kind: 'mark', id: mm.id });
        beginDrag('mark', mm.id, p);
        paint();
        return;
      }
    }

    if (snap) {
      // 从元件引脚 / 端子起线时把这一端焊上去，之后元件移动线会跟着走
      st.wire = { pts: [[snap.x, snap.y]], cur: [snap.x, snap.y], a: snap.bind || null };
      st.sel = null;
      renderInspector();
      paint();
      return;
    }

    if (host) {
      var kind = host.getAttribute('data-kind') || 'comp';
      var id = host.getAttribute('data-id');
      if (st.sim && kind === 'comp') {
        var cc = findComp(id);
        if (cc && cc.type === 'coil' && cc.key) {
          st.energized[cc.key] = !st.energized[cc.key];
          applySim();
          updateStatus();
          return;
        }
      }
      select({ kind: kind, id: id });
      if (kind === 'comp' || kind === 'text' || kind === 'mark') beginDrag(kind, id, p);
      paint();
      return;
    }

    select(null);
    paint();
  }

  function beginDrag(kind, id, p) {
    var o = kind === 'comp' ? findComp(id) : kind === 'text' ? findText(id) : findMark(id);
    if (!o) return;
    st.drag = {
      kind: kind, id: id, start: p,
      ox: o.cx != null ? o.cx : (o.x != null ? o.x : 0),
      oy: o.cy != null ? o.cy : (o.y != null ? o.y : 0),
      moved: false
    };
  }

  function onMove(e) {
    if (st.mode !== 'draw') return;
    var p = toDoc(e);

    var tol0 = (st.wire ? 16 : 9) / Math.max(st.zoom, 0.4);
    if (st.place) {
      var sp = M.snapPoint(st.doc, p.x, p.y, tol0);
      st.placePos = sp ? [sp.x, sp.y] : [SN(p.x), SN(p.y)];
      paint();
      return;
    }

    if (st.wire) {
      var sp2 = M.snapPoint(st.doc, p.x, p.y, tol0);
      st.wire.cur = sp2 ? [sp2.x, sp2.y] : [SN(p.x), SN(p.y)];
      paint();
      return;
    }

    if (st.drag) {
      var dx = p.x - st.drag.start.x, dy = p.y - st.drag.start.y;
      if (!st.drag.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      st.drag.moved = true;
      var rawX = st.drag.ox + dx, rawY = st.drag.oy + dy;
      var nx = SN(rawX), ny = SN(rawY);
      var o = st.drag.kind === 'comp' ? findComp(st.drag.id)
        : st.drag.kind === 'text' ? findText(st.drag.id) : findMark(st.drag.id);
      if (!o) return;
      // 元件参与对齐吸附：先判共线（容差 6px），没对上再落到网格
      // 顺序不能反 —— 先 SN 取整会把 6px 的对齐容差吃掉
      if (st.drag.kind === 'comp') {
        var al = alignSnap(st.doc, st.drag.id, rawX, rawY);
        nx = al.hitX ? al.x : SN(rawX);
        ny = al.hitY ? al.y : SN(rawY);
        st.guides = al.guides;
        st.guideHint = al.hint;
      } else {
        st.guides = []; st.guideHint = '';
      }
      if (o.cx != null) { o.cx = nx; o.cy = ny; }
      else { o.x = nx; o.y = ny; }
      // 拖动中让右栏坐标跟着走（重建整个面板太慢，只刷两个输入框）
      var xi = el.insp && el.insp.querySelector('input[data-bind="x"]');
      var yi = el.insp && el.insp.querySelector('input[data-bind="y"]');
      if (xi) xi.value = Math.round(nx);
      if (yi) yi.value = Math.round(ny);
      updateStatus();
      paint();
      return;
    }

    // hover：显示可接线端点
    var host = e.target.closest ? e.target.closest('.cmp') : null;
    var hid = host ? host.getAttribute('data-id') : null;
    if (hid !== st.hover) { st.hover = hid; paint(); }
  }

  function onUp() {
    if (st.mode !== 'draw') return;
    if (st.drag) {
      if (st.drag.moved) {
        commit();
        renderInspector();
      }
      st.drag = null;
      st.guides = [];
      st.guideHint = '';
      updateStatus();
      paint();
    }
  }

  function finishWire(endBind) {
    var w = st.wire;
    st.wire = null;
    if (!w || w.pts.length < 2) return;
    // 去掉重复点
    var pts = [];
    w.pts.forEach(function (p) {
      var last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 0.5 || Math.abs(last[1] - p[1]) > 0.5) pts.push(p);
    });
    if (pts.length < 2) return;
    var wire = { id: M.uid('w'), pts: pts };
    if (w.a) wire.a = w.a;
    if (endBind) wire.b = endBind;
    st.doc.wires.push(wire);
    // 两端都焊在引脚上时，落点可能和引脚差一点，立刻对齐一次
    M.resolveWire(st.doc, wire);
    commit();
  }

  /* ---------------- 放置 ---------------- */
  function doPlace(pt) {
    var type = st.place;
    var t = M.TYPES[type];
    var c = t.make(pt[0], pt[1]);
    c.type = type;
    c.id = M.uid('c');
    c.key = nextKey(type);
    if (t.label && c.key) {
      c.label = { text: c.key, ox: t.label.ox, oy: t.label.oy, anchor: t.label.anchor, size: t.label.size };
    }
    st.doc.comps.push(c);
    st.sel = { kind: 'comp', id: c.id };
    commit();
    paint();
    renderInspector();
  }

  function nextKey(type) {
    var prefix = M.TYPES[type].tryKey || '';
    if (!prefix) return '';
    var max = 0;
    var re = new RegExp('^' + prefix + '(\\d+)$');
    st.doc.comps.forEach(function (c) {
      var m = c.key && String(c.key).match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + (max + 1);
  }

  function applyTemplate(kind, main) {
    if (!st.doc || !window.PLCApi) return;
    if (st.doc.comps.length && !confirm('用模板替换当前图纸？')) return;
    var r = window.PLCApi.drawTemplate(st.doc, { kind: kind, main: !!main });
    if (!r || !r.ok) {
      flash((r && (r.error || r.reply)) || '模板没画出来');
      return;
    }
    st.sel = null; st.place = null; st.wire = null; st.flash = null;
    syncLibActive();
    commit();
    paint();
    renderInspector();
    renderDocList();
    flash((r.reply || '模板画好了').split('\n')[0]);
  }

  function addExtra(kind) {
    var cx = Math.round(st.doc.w / 2 / M.GRID) * M.GRID;
    var cy = Math.round(st.doc.h / 2 / M.GRID) * M.GRID;
    if (kind === 'text') {
      var t = { id: M.uid('t'), x: cx, y: cy, text: '说明文字', size: 12, mono: false, anchor: 'middle' };
      st.doc.texts.push(t);
      st.sel = { kind: 'text', id: t.id };
    } else {
      var m = { id: M.uid('m'), kind: kind, x: cx, y: cy };
      st.doc.marks.push(m);
      st.sel = { kind: 'mark', id: m.id };
    }
    commit(); paint(); renderInspector();
  }

  /* ---------------- 选择 / 删除 ---------------- */
  function select(sel) {
    st.flash = null;
    clearTimeout(st._flashT);
    st.sel = sel;
    renderInspector();
    updateStatus();
  }

  // 接线助手点问题时，选中并短暂高亮目标，方便在复杂图上找到位置
  function flashTarget(kind, id) {
    st.flash = { kind: kind, id: id };
    paint();
    clearTimeout(st._flashT);
    st._flashT = setTimeout(function () {
      st.flash = null;
      paint();
    }, 1500);
  }

  function deleteSel() {
    if (!st.sel) return;
    var d = st.doc, id = st.sel.id, k = st.sel.kind;
    if (k === 'comp') d.comps = d.comps.filter(function (c) { return c.id !== id; });
    else if (k === 'wire') d.wires = d.wires.filter(function (w) { return w.id !== id; });
    else if (k === 'text') d.texts = d.texts.filter(function (t) { return t.id !== id; });
    else if (k === 'mark') d.marks = d.marks.filter(function (m) { return m.id !== id; });
    else if (k === 'deco') d.deco = d.deco.filter(function (m) { return m.id !== id; });
    st.sel = null;
    commit(); paint(); renderInspector();
  }

  function duplicateSel() {
    if (!st.sel || st.sel.kind !== 'comp') return;
    var c = findComp(st.sel.id);
    if (!c) return;
    var n = JSON.parse(JSON.stringify(c));
    n.id = M.uid('c');
    if (n.cx != null) { n.cx += 30; n.cy += 30; } else { n.x += 30; n.y += 30; }
    if (n.key) n.key = nextKey(n.type);
    if (n.label) n.label.text = n.key;
    st.doc.comps.push(n);
    st.sel = { kind: 'comp', id: n.id };
    commit(); paint(); renderInspector();
  }

  function nudge(dx, dy) {
    if (!st.sel) return;
    var k = st.sel.kind, id = st.sel.id;
    if (k === 'comp') {
      var c = findComp(id); if (!c) return;
      if (c.cx != null) { c.cx += dx; c.cy += dy; } else { c.x += dx; c.y += dy; }
    } else if (k === 'text') {
      var t = findText(id); if (!t) return; t.x += dx; t.y += dy;
    } else if (k === 'mark') {
      var m = findMark(id); if (!m) return; m.x += dx; m.y += dy;
    } else if (k === 'wire') {
      var w = null;
      st.doc.wires.forEach(function (x) { if (x.id === id) w = x; });
      if (!w) return;
      // 两端都接在元件上的线由元件位置决定，平移没有意义
      if (w.a && w.b) { flash('导线两端都接着元件，移动元件即可'); return; }
      w.pts = w.pts.map(function (p) { return [p[0] + dx, p[1] + dy]; });
      M.resolveWire(st.doc, w);
    } else return;
    paint(); renderInspector();
    clearTimeout(st._nt);
    st._nt = setTimeout(function () { commit(); }, 350);
  }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (st.mode !== 'draw') return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    var meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (meta && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSel(); return; }

    if (e.key === 'Escape') {
      closeMenu();
      st.place = null; st.wire = null; st.drag = null;
      st.guides = []; st.guideHint = '';
      syncLibActive(); updateStatus(); paint(); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); return; }
    if (e.key === 'Enter' && st.wire) { finishWire(); paint(); return; }
    if ((e.key === 'r' || e.key === 'R') && st.sel && st.sel.kind === 'comp') {
      e.preventDefault(); rotateSel(e.shiftKey ? -90 : 90); return;
    }
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
      fitZoom(); paint(); return;
    }

    var step = e.shiftKey ? M.GRID : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, step); }
  }

  /* ---------------- 右栏 ---------------- */
  function field(label, inner) {
    return '<label class="fld"><span class="fld-k">' + label + '</span>' +
      '<span class="fld-v">' + inner + '</span></label>';
  }

  function renderInspector() {
    if (!st.doc) return;
    var h = '';

    if (st.sel && st.sel.kind === 'comp') {
      var c = findComp(st.sel.id);
      if (c) {
        var t = M.TYPES[c.type];
        h += '<div class="sec-label">元件属性</div>';
        h += '<div class="pcard">';
        h += '<div class="pkv"><span class="pk">类型</span><span class="pv">' + t.name + '</span></div>';
        h += field('代号', '<input class="pin" data-bind="key" value="' + M.esc(c.key || '') +
          '" placeholder="例如 QA1" spellcheck="false">');
        h += '<label class="chk"><input type="checkbox" data-bind="showLabel"' +
          (c.label ? ' checked' : '') + '><span>在图上显示代号</span></label>';
        var deg = M.rotOf(c);
        h += '<div class="rot-row"><span class="pk">旋转</span>' +
          '<button class="pbtn mini" data-act="rotccw" title="逆时针 90°">↺</button>' +
          '<span class="pv deg">' + deg + '°</span>' +
          '<button class="pbtn mini" data-act="rotcw" title="顺时针 90°">↻</button>' +
          (deg ? '<button class="pbtn mini ghost" data-act="rot0" title="角度回正">回正</button>' : '') +
          '</div>';
        var px = c.cx != null ? c.cx : c.x;
        var py = c.cy != null ? c.cy : c.y;
        h += '<div class="fld-row">';
        h += field('X', '<input class="pnum" type="number" step="1" data-bind="x" value="' + Math.round(px) + '">');
        h += field('Y', '<input class="pnum" type="number" step="1" data-bind="y" value="' + Math.round(py) + '">');
        h += '</div>';
        if (c.type === 'no' || c.type === 'nc') {
          h += '<div class="pnote">点动、启动、停止都用触点：常开＝按下接通，常闭＝按下断开。代号与线圈一致时才会联动。</div>';
        } else if (c.type === 'coil') {
          h += '<div class="pnote">线圈的代号要和它自己的触点一致（如都用 QA1），按下「代号联动」后点线圈即可试动作。</div>';
        }
        h += '<div class="pbtn-row"><button class="pbtn" data-act="dup">复制一个</button>' +
          '<button class="pbtn danger" data-act="del">删除</button></div>';
        h += '</div>';
      }
    } else if (st.sel && st.sel.kind === 'wire') {
      var w = null;
      st.doc.wires.forEach(function (x) { if (x.id === st.sel.id) w = x; });
      if (w) {
        h += '<div class="sec-label">导线</div><div class="pcard">';
        h += '<div class="pkv"><span class="pk">段数</span><span class="pv">' + (w.pts.length - 1) + '</span></div>';
        h += '<div class="pnote">方向键可整体微调，Shift+方向键一次走 10。</div>';
        h += '<div class="pbtn-row"><button class="pbtn danger" data-act="del">删除导线</button></div>';
        h += '</div>';
      }
    } else if (st.sel && (st.sel.kind === 'text' || st.sel.kind === 'mark' || st.sel.kind === 'deco')) {
      var tx = st.sel.kind === 'text' ? findText(st.sel.id) : null;
      h += '<div class="sec-label">' + (st.sel.kind === 'text' ? '文字' : '标记') + '</div><div class="pcard">';
      if (tx) {
        h += field('内容', '<input class="pin" data-bind="ttext" value="' + M.esc(tx.text) + '" spellcheck="false">');
        h += '<div class="fld-row">';
        h += field('字号', '<input class="pnum" type="number" min="8" max="28" data-bind="tsize" value="' + tx.size + '">');
        h += field('X', '<input class="pnum" type="number" data-bind="tx" value="' + Math.round(tx.x) + '">');
        h += '</div>';
      }
      h += '<div class="pbtn-row"><button class="pbtn danger" data-act="del">删除</button></div>';
      h += '</div>';
    } else {
      h += '<div class="sec-label">图纸信息</div>';
      h += '<div class="pcard">';
      h += field('图号', '<input class="pin" data-bind="no" value="' + M.esc(st.doc.no || '') + '" spellcheck="false">');
      h += field('名称', '<input class="pin" data-bind="title" value="' + M.esc(st.doc.title || '') + '" spellcheck="false">');
      h += '</div>';
      h += '<div class="sec-label" style="margin-top:16px">画布尺寸</div>';
      h += '<div class="pcard"><div class="fld-row">';
      h += field('宽', '<input class="pnum" type="number" step="20" data-bind="w" value="' + st.doc.w + '">');
      h += field('高', '<input class="pnum" type="number" step="20" data-bind="h" value="' + st.doc.h + '">');
      h += '</div><div class="pnote">默认 760 × 500，和本章图纸一致。</div>';
      h += '<div class="pbtn-row"><button class="pbtn danger" data-act="clear">清空这张图纸</button>' +
        '<button class="pbtn danger" data-act="drop">删除这张图纸</button></div></div>';
      h += '<div class="sec-label" style="margin-top:16px">统计</div>';
      h += '<div class="pcard"><div class="pkv"><span class="pk">元件</span><span class="pv">' +
        st.doc.comps.length + ' 个</span></div>';
      h += '<div class="pkv"><span class="pk">导线</span><span class="pv">' + st.doc.wires.length +
        ' 段</span></div>';
      h += '<div class="pkv"><span class="pk">未接线端点</span><span class="pv">' +
        danglingPins() + ' 个</span></div></div>';
    }

    el.insp.innerHTML = h;
    el.foot.innerHTML = '<div class="sec-label">操作提示</div>' +
      '<div class="tips">' +
      '<div>· 左栏点元件 → 在图纸上单击放置</div>' +
      '<div>· 单击元件端点起线，再点目标端点收笔</div>' +
      '<div>· 线一旦接上端点就跟着元件走，移元件不断线</div>' +
      '<div>· 单击元件中部选中，按住可拖动</div>' +
      '<div>· 右键点元件 → 旋转 / 复制 / 删除</div>' +
      '<div>· R 转 90°，Shift+R 反向转</div>' +
      '<div>· 右键点空白 → 网格、适应画布、导出</div>' +
      '<div>· 选中后按 Delete 删除，Ctrl+D 复制</div>' +
      '<div>· Ctrl+Z / Ctrl+Shift+Z 撤销重做</div>' +
      '</div>' +
      '<div class="tips-src">' +
      '<div>元件图形取自 QElectroTech 官方符号库，</div>' +
      '<div>标准为 IEC 60617（等同 GB∕T 4728），非手绘。</div>' +
      '</div>';
  }

  /* ---------------- 接线助手 ----------------
     每帧重绘只做节流刷新，分析本身是纯计算，几十个元件也在 1ms 量级 */
  var _advT = null;
  function scheduleAdvisor() {
    clearTimeout(_advT);
    _advT = setTimeout(renderAdvisor, 90);
  }

  var ADV_ICON = { error: '×', warn: '!', info: '·' };

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderAdvisor() {
    if (!el.adv) return;
    if (st.mode !== 'draw' || !st.doc || !window.PLCAdvisor) {
      el.adv.innerHTML = '';
      return;
    }
    var res = st.adv || window.PLCAdvisor.analyze(st.doc);
    st.adv = res;

    var dot = res.level === 'error' ? 'bad' : (res.level === 'warn' ? 'warn' : 'ok');
    var head = '<div class="adv-head">' +
      '<span class="adv-dot ' + dot + '"></span>' +
      '<b>接线助手</b>' +
      (res.intent
        ? '<span class="adv-tag" style="color:' + res.intent.color + '">' + escHtml(res.intent.name) + '</span>'
        : '') +
      '<span class="adv-sp"></span>' +
      (res.issues.length ? '<span class="adv-n">' + res.issues.length + '</span>' : '') +
      '<button class="adv-toggle" type="button">' + (st.advOpen ? '收起' : '展开') + '</button>' +
      '</div>';

    if (!st.advOpen) { el.adv.innerHTML = head; return; }

    // 能自动补的常见场景：点动回路还差一个自锁触点
    var auto = canAutoSelfLock();
    var act = auto
      ? '<div class="adv-act"><span>差一个自锁触点</span>' +
        '<button type="button" data-act="selflock">帮我放上</button></div>'
      : '';

    var body = '';
    if (!res.issues.length) {
      body = '<div class="adv-empty">接法没问题，可以继续。</div>';
    } else {
      res.issues.slice(0, 6).forEach(function (it) {
        var t = it.target;
        body += '<div class="adv-item ' + it.level + '"' +
          (t ? ' data-kind="' + t.kind + '" data-id="' + t.id + '" title="点一下定位"' : '') + '>' +
          '<i>' + (ADV_ICON[it.level] || '·') + '</i>' +
          '<span>' + escHtml(it.msg) + '</span></div>';
      });
      if (res.issues.length > 6) {
        body += '<div class="adv-more">另外还有 ' + (res.issues.length - 6) + ' 条</div>';
      }
    }
    el.adv.innerHTML = head + act + '<div class="adv-body">' + body + '</div>';
  }

  /* ---------- 一键补齐：给点动回路加自锁触点 ---------- */
  function canAutoSelfLock() {
    var res = st.adv;
    if (!res || !res.intent || res.intent.key !== 'jog' || !st.doc) return null;
    var btn = null, coil = null;
    st.doc.comps.forEach(function (c) {
      if (!btn && (c.type === 'btnNo' || (c.type === 'no' && /^S[A-Z]?/i.test(c.key || '')))) btn = c;
      if (!coil && (c.type === 'coil' || c.type === 'kCoil') && c.key) coil = c;
    });
    if (!btn || !coil) return null;
    // 已经同名的常开触点存在就不再多放
    var has = st.doc.comps.some(function (c) {
      return c.type === 'no' && c.key === coil.key;
    });
    if (has) return null;
    return { btn: btn, coil: coil };
  }

  function occupiedAt(box) {
    return st.doc.comps.some(function (c) {
      var b = M.boxOf(c);
      return !(b.x > box.x + box.w || b.x + b.w < box.x || b.y > box.y + box.h || b.y + b.h < box.y);
    });
  }

  function wireBetween(a, b, ba, bb) {
    var pts = [[a[0], a[1]]].concat(orthoPath([a[0], a[1]], [b[0], b[1]]));
    var w = { id: M.uid('w'), pts: pts };
    if (ba) w.a = ba;
    if (bb) w.b = bb;
    M.resolveWire(st.doc, w);
    st.doc.wires.push(w);
  }

  function addSelfLock() {
    var p = canAutoSelfLock();
    if (!p) return;
    var t = M.TYPES.no;
    var probe = t.make(p.btn.x + 120, p.btn.y);
    probe.type = 'no';
    var tries = 0;
    while (tries++ < 8 && occupiedAt(M.boxOf(probe))) {
      probe.x += 70;
      if (probe.x > st.doc.w - 90) { probe.x = p.btn.x - 120; }
    }
    var c = t.make(probe.x, probe.y);
    c.type = 'no';
    c.id = M.uid('c');
    c.key = p.coil.key;
    c.label = {
      text: c.key, ox: t.label.ox, oy: t.label.oy,
      anchor: t.label.anchor, size: t.label.size
    };
    st.doc.comps.push(c);

    // 并联在按钮两端：按钮上脚 ↔ 自锁上脚，自锁下脚 ↔ 按钮下脚
    var bp = M.pinsOfComp(p.btn), cp = M.pinsOfComp(c);
    wireBetween(bp[0], cp[0], { c: p.btn.id, i: 0 }, { c: c.id, i: 0 });
    wireBetween(cp[1], bp[1], { c: c.id, i: 1 }, { c: p.btn.id, i: 1 });

    st.sel = { kind: 'comp', id: c.id };
    commit();
    paint();
    renderInspector();
    flash('已补上 ' + c.key + ' 自锁触点，并联在按钮两端');
  }

  function onAdvClick(e) {
    var tg = e.target.closest ? e.target.closest('.adv-toggle') : null;
    if (tg) { st.advOpen = !st.advOpen; renderAdvisor(); return; }
    var ab = e.target.closest ? e.target.closest('.adv-act button') : null;
    if (ab) { addSelfLock(); return; }
    var it = e.target.closest ? e.target.closest('.adv-item') : null;
    if (!it) return;
    var k = it.getAttribute('data-kind'), id = it.getAttribute('data-id');
    if (!k || !id) return;
    if (k === 'comp' || k === 'wire' || k === 'mark' || k === 'text' || k === 'deco') {
      select({ kind: k, id: id });
      flashTarget(k, id);
    }
  }

  function onInspClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'del') deleteSel();
    else if (act === 'dup') duplicateSel();
    else if (act === 'rotcw') rotateSel(90);
    else if (act === 'rotccw') rotateSel(-90);
    else if (act === 'rot0') setRot(0);
    else if (act === 'clear') {
      if (!confirm('清空图纸上所有元件和导线？')) return;
      st.doc.comps = []; st.doc.wires = []; st.doc.marks = [];
      st.doc.deco = []; st.doc.texts = [];
      st.sel = null;
      commit(); paint(); renderInspector();
    } else if (act === 'drop') {
      if (!confirm('删除这张图纸？此操作不可撤销。')) return;
      deleteDoc(st.curId);
    }
  }

  function onInspInput(e) {
    var t = e.target;
    var bind = t.getAttribute && t.getAttribute('data-bind');
    if (!bind) return;
    var d = st.doc;

    if (bind === 'no' || bind === 'title' || bind === 'w' || bind === 'h') {
      if (bind === 'w' || bind === 'h') {
        var v = Math.max(200, Math.min(2000, parseInt(t.value, 10) || 0));
        d[bind] = v;
      } else {
        d[bind] = t.value;
      }
      updateHead(); saveAll();
      if (bind === 'w' || bind === 'h') { fitZoom(); }
      paint(); renderDocList();
      clearTimeout(st._ct); st._ct = setTimeout(commit, 400);
      return;
    }

    if (!st.sel) return;
    var kind = st.sel.kind, id = st.sel.id;

    if (kind === 'comp') {
      var c = findComp(id);
      if (!c) return;
      if (bind === 'key') {
        c.key = t.value.trim();
        if (c.label) c.label.text = c.key;
        else if (c.key) {
          var def = M.TYPES[c.type].label;
          if (def) c.label = { text: c.key, ox: def.ox, oy: def.oy, anchor: def.anchor, size: def.size };
        }
      } else if (bind === 'showLabel') {
        if (t.checked) {
          var def2 = M.TYPES[c.type].label;
          if (def2) c.label = { text: c.key || '', ox: def2.ox, oy: def2.oy, anchor: def2.anchor, size: def2.size };
        } else c.label = null;
      } else if (bind === 'x' || bind === 'y') {
        var val = parseFloat(t.value);
        if (isNaN(val)) return;
        if (c.cx != null) { if (bind === 'x') c.cx = val; else c.cy = val; }
        else { if (bind === 'x') c.x = val; else c.y = val; }
      }
      paint();
      clearTimeout(st._ct); st._ct = setTimeout(commit, 400);
      return;
    }

    if (kind === 'text') {
      var tx = findText(id);
      if (!tx) return;
      if (bind === 'ttext') tx.text = t.value;
      else if (bind === 'tsize') tx.size = Math.max(8, Math.min(30, parseInt(t.value, 10) || 12));
      else if (bind === 'tx') { var vx = parseFloat(t.value); if (!isNaN(vx)) tx.x = vx; }
      paint();
      clearTimeout(st._ct); st._ct = setTimeout(commit, 400);
    }
  }

  /* ---------------- 联动 ---------------- */
  function toggleSim() {
    st.sim = !st.sim;
    if (!st.sim) st.energized = {};
    var b = $('#edSim');
    b.textContent = st.sim ? '退出联动' : '代号联动';
    b.classList.toggle('playing', st.sim);
    var svg = el.canvas.querySelector('svg');
    if (svg) svg.classList.toggle('sim', st.sim);
    applySim();
    updateStatus();
    renderInspector();
  }

  /* ---------------- 导出 ---------------- */
  var EXPORT_CSS = [
    '.wire{stroke:#1A1C1F;stroke-width:1.7;fill:none;stroke-linecap:square}',
    '.hit{display:none}',
    '.tick,.ncmk{stroke:#1A1C1F;stroke-width:1.7;stroke-linecap:round}',
    '.blade{stroke:#1A1C1F;stroke-width:1.7;stroke-linecap:round}',
    '.contact[data-kind="no"] .blade{transform:rotate(-19deg)}',
    '.contact[data-kind="nc"] .blade{transform:rotate(19deg)}',
    '.dash{stroke:#8A8E96;stroke-width:1.2;stroke-dasharray:4 3;fill:none}',
    '.divider{stroke:#C9CBD1;stroke-width:1.2;stroke-dasharray:6 5;fill:none}',
    '.junc{fill:#1A1C1F}',
    '.term{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.6}',
    '.fuse rect{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.6}',
    '.coil rect{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.6}',
    '.motor .body{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.9}',
    '.motor .ring{fill:none;stroke:#2447C9;stroke-width:1.5;stroke-dasharray:4 6;opacity:0}',
    '.txhit{display:none}',
    '.ovl{display:none}'
  ].join('');

  function exportSvg() {
    var d = st.doc;
    var inner = M.renderInner(d)
      // 命中区只服务于编辑交互，导出时去掉
      .replace(/<polyline class="hit"[^>]*\/>/g, '')
      .replace(/<rect class="cmp-hit"[^>]*\/>/g, '')
      .replace(/<circle class="mark-hit"[^>]*\/>/g, '')
      .replace(/<rect class="txhit"[^>]*\/>/g, '');
    var svg = M.svgWrap(d, inner);
    var doc = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    doc.setAttribute('width', d.w);
    doc.setAttribute('height', d.h);
    doc.removeAttribute('style');
    var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = EXPORT_CSS;
    doc.insertBefore(style, doc.firstChild);
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(doc);
    download('PLC-' + (d.no || '') + '-' + (d.title || '电路') + '.svg',
      new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  }

  function exportJson() {
    var d = st.doc;
    download('PLC-' + (d.no || '') + '-' + (d.title || '电路') + '.json',
      new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
  }

  function importJson(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var d = null;
      try { d = JSON.parse(fr.result); } catch (err) { d = null; }
      if (!d || !Array.isArray(d.comps)) { flash('这个文件不是画板导出的图纸'); return; }
      d.id = M.uid('doc');
      d.w = d.w || 760;
      d.h = d.h || 500;
      ['wires', 'marks', 'deco', 'texts'].forEach(function (k) {
        if (!Array.isArray(d[k])) d[k] = [];
      });
      d.comps.forEach(function (c) { if (!c.id) c.id = M.uid('c'); });
      newDoc(d);
      flash('已导入：' + (d.title || '未命名电路'));
    };
    fr.readAsText(file);
  }

  function download(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  /* ---------------- 模式 ---------------- */
  function setMode(m) {
    st.mode = m;
    document.body.setAttribute('data-mode', m);
    var atlas = $('#atlasApp');
    if (atlas) atlas.hidden = m === 'draw';
    if (el.app) el.app.hidden = m !== 'draw';
    var btns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === m);
    }
    var s = $('#searchInput');
    if (s) {
      s.value = '';
      s.placeholder = m === 'draw' ? '搜索我的图纸' : '搜索电路名称、图号或代号';
    }
    st.q = '';
    if (m === 'draw') {
      renderDocList();
      renderLib();
      fitZoom();
      paint();
      renderInspector();
      updateHead();
    }
  }

  /* ---------------- 对外 ---------------- */
  function openTemplate(circuitId) {
    var list = global.PLCCircuits ? global.PLCCircuits.list : [];
    var circ = null;
    list.forEach(function (c) { if (c.id === circuitId) circ = c; });
    if (!circ) return;
    var doc = M.fromCircuit(circ);
    doc.title = circ.title + '（副本）';
    doc.id = M.uid('doc');
    newDoc(doc);
    setMode('draw');
    flash('已按「' + circ.title + '」生成可编辑图纸');
  }

  function mount() {
    boot();
    var btns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        setMode(this.getAttribute('data-mode'));
      });
    }
    document.body.setAttribute('data-mode', 'atlas');
    if (location.hash === '#draw') setMode('draw');
    setTimeout(function () { fitZoom(); if (st.mode === 'draw') paint(); }, 60);
  }

  mount();

  global.PLCEditor = {
    mount: mount, setMode: setMode, openTemplate: openTemplate,
    exportSvg: exportSvg, paint: paint, commit: commit, select: select,
    flashTarget: flashTarget,
    applySim: applySim,
    state: st,
    _newBlank: function () { var d = M.blank(760, 500); newDoc(d); setMode('draw'); }
  };
})(window);
