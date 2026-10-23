/* ============================================================
   editor-model.js — 画板的数据模型、符号定义、渲染与转换
   doc = { id, no, title, w, h, comps[], wires[], marks[], deco[], texts[] }
   ============================================================ */
(function (global) {
  'use strict';

  var INK = '#1A1C1F';
  var SANS = "'Noto Sans SC','PingFang SC','Microsoft YaHei','Source Han Sans CN',system-ui,sans-serif";
  var MONO = "'IBM Plex Mono','Consolas','SF Mono','Courier New',monospace";
  var GRID = 10;

  function n(v) { return Math.round(v * 100) / 100; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  var uidN = 0;
  function uid(p) { uidN++; return (p || 'e') + uidN.toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------------- 文本 ---------------- */
  function txt(x, y, s, o) {
    o = o || {};
    var size = o.size || 12;
    var anchor = o.anchor || 'start';
    var fam = o.mono ? MONO : SANS;
    var weight = o.weight || (o.mono ? 500 : 400);
    var ls = o.spacing ? ' letter-spacing="' + o.spacing + '"' : '';
    return '<text x="' + n(x) + '" y="' + n(y) + '" font-family="' + fam +
      '" font-size="' + size + '" font-weight="' + weight +
      '" fill="' + (o.color || INK) + '" text-anchor="' + anchor +
      '" dominant-baseline="central"' + ls + '>' + esc(s) + '</text>';
  }

  /* ---------------- 符号绘制 ----------------
     画法对齐 GB/T 4728（等同 IEC 60617）：
     线宽统一，端点全部落在 10px 网格上，方头收笔；
     每个符号自带一小段引线，视觉上和导线连成一根，而不是悬空两笔。
  */
  var SW = 1.7;          // 符号主线宽
  var LEAD = 'stroke="' + INK + '" stroke-width="' + SW + '" stroke-linecap="square"';

  function contactSvg(c, kind) {
    var x = c.x, y = c.y, h = c.h;
    var pad = Math.min(9, h * 0.28);       // 支路很短时自动收窄
    var top = y + pad, bot = y + h - pad;  // 固定触点位置 / 动刀转轴
    var g = '<g class="sym contact" data-kind="' + kind + '">';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(y) + '" x2="' + n(x) + '" y2="' + n(top) + '" ' + LEAD + '/>';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(y + h) + '" ' + LEAD + '/>';
    // 固定触点：从引线末端向一侧伸出的一小截（IEC 60617：单侧，不是左右对称）
    g += '<line class="tick" x1="' + n(x) + '" y1="' + n(top) + '" x2="' + n(x + 10) + '" y2="' + n(top) + '"/>';
    // 动触点：常开向左上翘（离开固定触点），常闭向右上穿过去（接触）
    g += '<line class="blade" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(top - 5) +
      '" style="transform-box:view-box;transform-origin:' + n(x) + 'px ' + n(bot) + 'px"/>';
    g += '</g>';
    return g;
  }

  function coilSvg(c) {
    // 接触器线圈：一个矩形（不含端子引线，由导线接进来）
    return '<g class="sym coil"><rect x="' + n(c.x - 15) + '" y="' + n(c.y) +
      '" width="30" height="' + n(c.h) + '"/></g>';
  }

  // 熔断器：矩形 + 一条贯穿全长的熔丝线
  function fuseVSvg(c) {
    return '<g class="sym fuse">' +
      '<rect x="' + n(c.x - 7) + '" y="' + n(c.y) + '" width="14" height="' + n(c.h) + '"/>' +
      '<line class="core" x1="' + n(c.x) + '" y1="' + n(c.y) +
      '" x2="' + n(c.x) + '" y2="' + n(c.y + c.h) +
      '" stroke="' + INK + '" stroke-width="1.6" stroke-linecap="square"/>' +
      '</g>';
  }

  function fuseHSvg(c) {
    return '<g class="sym fuse">' +
      '<rect x="' + n(c.x) + '" y="' + n(c.y - 7) + '" width="' + n(c.w) + '" height="14"/>' +
      '<line class="core" x1="' + n(c.x) + '" y1="' + n(c.y) +
      '" x2="' + n(c.x + c.w) + '" y2="' + n(c.y) +
      '" stroke="' + INK + '" stroke-width="1.6" stroke-linecap="square"/>' +
      '</g>';
  }

  function polesSvg(c, kind) {
    var g = '', i, x;
    var padp = Math.min(6, c.h * 0.2);
    var top = c.y + padp, bot = c.y + c.h - padp;
    if (kind === 'switch3') {
      // 三极隔离开关：引线 + 固定触点 + 斜刀 + 虚线联动
      for (i = 0; i < c.poles; i++) {
        x = c.x + i * c.pitch;
        g += '<line class="lead" x1="' + n(x) + '" y1="' + n(c.y) + '" x2="' + n(x) + '" y2="' + n(top) + '" ' + LEAD + '/>';
        g += '<line class="lead" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(c.y + c.h) + '" ' + LEAD + '/>';
        g += '<line class="tick" x1="' + n(x - 7) + '" y1="' + n(top) + '" x2="' + n(x + 7) + '" y2="' + n(top) + '"/>';
        g += '<line class="blade open" x1="' + n(x) + '" y1="' + n(bot) +
          '" x2="' + n(x + 13) + '" y2="' + n(top) + '"/>';
      }
    } else if (kind === 'contactor') {
      // 三极主触点：常开，每极独立刀口（通电时一起闭合）
      g += '<g class="sym contact" data-kind="no">';
      for (i = 0; i < c.poles; i++) {
        x = c.x + i * c.pitch;
        g += '<line class="lead" x1="' + n(x) + '" y1="' + n(c.y) + '" x2="' + n(x) + '" y2="' + n(top) + '" ' + LEAD + '/>';
        g += '<line class="lead" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(c.y + c.h) + '" ' + LEAD + '/>';
        g += '<line class="tick" x1="' + n(x) + '" y1="' + n(top) + '" x2="' + n(x + 10) + '" y2="' + n(top) + '"/>';
        g += '<line class="blade" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(top - 5) +
          '" style="transform-box:view-box;transform-origin:' + n(x) + 'px ' + n(bot) + 'px"/>';
      }
      g += '</g>';
    } else if (kind === 'fuse3') {
      // 三极熔断器
      g += '<g class="sym fuse">';
      for (i = 0; i < c.poles; i++) {
        x = c.x + i * c.pitch;
        g += '<rect x="' + n(x - 7) + '" y="' + n(c.y) + '" width="14" height="' + n(c.h) + '"/>';
        g += '<line x1="' + n(x) + '" y1="' + n(c.y) + '" x2="' + n(x) + '" y2="' + n(c.y + c.h) +
          '" stroke="' + INK + '" stroke-width="1.6"/>';
      }
      g += '</g>';
    } else {
      g += '<g class="sym fuse">';
      for (i = 0; i < c.poles; i++) {
        x = c.x + i * c.pitch;
        g += '<rect x="' + n(x - 7) + '" y="' + n(c.y) + '" width="14" height="' + n(c.h) + '"/>';
        g += '<path class="heat" d="M' + n(x) + ' ' + n(c.y + 5) +
          'L' + n(x) + ' ' + n(c.y + c.h * 0.5 - 5) +
          'L' + n(x + 5) + ' ' + n(c.y + c.h * 0.5) +
          'L' + n(x) + ' ' + n(c.y + c.h * 0.5 + 5) +
          'L' + n(x) + ' ' + n(c.y + c.h - 5) +
          '" fill="none" stroke="' + INK + '" stroke-width="1.5" stroke-linejoin="round"/>';
      }
      g += '</g>';
    }
    var x0 = c.x, x1 = c.x + (c.poles - 1) * c.pitch;
    g += '<line class="dash" x1="' + n(x0 - 8) + '" y1="' + n(c.y + c.h * 0.5) +
      '" x2="' + n(x1 + 8) + '" y2="' + n(c.y + c.h * 0.5) + '"/>';
    return g;
  }

  function motorSvg(c) {
    var cx = c.cx, cy = c.cy, r = c.r;
    var g = '<g class="sym motor">';
    g += '<circle class="ring" cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r + 7) + '"/>';
    g += '<circle class="body" cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r) + '"/>';
    g += '<text x="' + n(cx) + '" y="' + n(cy - r * 0.18) + '" font-family="' + SANS +
      '" font-size="' + n(r * 0.62) + '" font-weight="600" fill="' + INK +
      '" text-anchor="middle" dominant-baseline="central">M</text>';
    g += '<text x="' + n(cx) + '" y="' + n(cy + r * 0.42) + '" font-family="' + MONO +
      '" font-size="' + n(r * 0.36) + '" fill="' + INK +
      '" text-anchor="middle" dominant-baseline="central">3~</text>';
    g += '</g>';
    return g;
  }

  function groundSvg(c) {
    var x = c.x, y = c.y;
    return '<g class="sym gnd">' +
      '<line class="wire" x1="' + n(x - 13) + '" y1="' + n(y) + '" x2="' + n(x + 13) + '" y2="' + n(y) + '"/>' +
      '<line class="wire" x1="' + n(x - 8) + '" y1="' + n(y + 6) + '" x2="' + n(x + 8) + '" y2="' + n(y + 6) + '"/>' +
      '<line class="wire" x1="' + n(x - 4) + '" y1="' + n(y + 12) + '" x2="' + n(x + 4) + '" y2="' + n(y + 12) + '"/>' +
      '</g>';
  }

  /* ---------- 按钮：触点上方加按钮帽和推杆 ---------- */
  function buttonSvg(c, kind) {
    var x = c.x, y = c.y, h = c.h;
    var cap = y + 4, top = y + 15, bot = y + h - 9;
    var g = '<g class="sym contact" data-kind="' + kind + '">';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(y) + '" x2="' + n(x) + '" y2="' + n(cap) + '" ' + LEAD + '/>';
    // 按钮帽 + 短推杆（杆只伸到刀尖上方，别和动触点粘在一起）
    g += '<line class="cap" x1="' + n(x - 6) + '" y1="' + n(cap) + '" x2="' + n(x + 6) + '" y2="' + n(cap) + '" ' + LEAD + '/>';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(cap) + '" x2="' + n(x) + '" y2="' + n(cap + 5) + '" ' + LEAD + '/>';
    g += '<line class="tick" x1="' + n(x) + '" y1="' + n(top) + '" x2="' + n(x + 10) + '" y2="' + n(top) + '"/>';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(y + h) + '" ' + LEAD + '/>';
    g += '<line class="blade" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(top - 5) +
      '" style="transform-box:view-box;transform-origin:' + n(x) + 'px ' + n(bot) + 'px"/>';
    g += '</g>';
    return g;
  }

  /* ---------- 行程开关：按钮换成滚轮 ---------- */
  function limitSvg(c, kind) {
    var x = c.x, y = c.y, h = c.h;
    var top = y + 15, bot = y + h - 9;
    var g = '<g class="sym contact" data-kind="' + kind + '">';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(y) + '" x2="' + n(x) + '" y2="' + n(top - 8) + '" ' + LEAD + '/>';
    // 滚轮
    g += '<circle class="wheel" cx="' + n(x) + '" cy="' + n(y + 8) + '" r="4" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.5"/>';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(y + 12) + '" x2="' + n(x) + '" y2="' + n(top - 6) + '" ' + LEAD + '/>';
    g += '<line class="tick" x1="' + n(x) + '" y1="' + n(top) + '" x2="' + n(x + 10) + '" y2="' + n(top) + '"/>';
    g += '<line class="lead" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(y + h) + '" ' + LEAD + '/>';
    g += '<line class="blade" x1="' + n(x) + '" y1="' + n(bot) + '" x2="' + n(x) + '" y2="' + n(top - 5) +
      '" style="transform-box:view-box;transform-origin:' + n(x) + 'px ' + n(bot) + 'px"/>';
    g += '</g>';
    return g;
  }

  /* ---------- 时间继电器线圈：矩形内加延时标记 ---------- */
  function ktCoilSvg(c) {
    var x = c.x, y = c.y, h = c.h;
    return '<g class="sym coil">' +
      '<rect x="' + n(x - 15) + '" y="' + n(y) + '" width="30" height="' + n(h) + '"/>' +
      // 通电延时标记：一道弧
      '<path d="M' + n(x - 9) + ' ' + n(y + h * 0.5 + 5) +
      'A9 9 0 0 1 ' + n(x + 9) + ' ' + n(y + h * 0.5 + 5) + '" fill="none" stroke="' + INK + '" stroke-width="1.3"/>' +
      '</g>';
  }

  /* ---------- 信号灯 ---------- */
  function lampSvg(c) {
    var x = c.x, y = c.y, cy = y + 20, r = 10;
    var k = r * 0.65;
    return '<g class="sym lamp">' +
      '<line class="lead" x1="' + n(x) + '" y1="' + n(y) + '" x2="' + n(x) + '" y2="' + n(cy - r) + '" ' + LEAD + '/>' +
      '<circle cx="' + n(x) + '" cy="' + n(cy) + '" r="' + n(r) +
      '" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.7"/>' +
      '<path d="M' + n(x - k) + ' ' + n(cy - k) + 'L' + n(x + k) + ' ' + n(cy + k) +
      'M' + n(x + k) + ' ' + n(cy - k) + 'L' + n(x - k) + ' ' + n(cy + k) +
      '" fill="none" stroke="' + INK + '" stroke-width="1.4"/>' +
      '<line class="lead" x1="' + n(x) + '" y1="' + n(cy + r) + '" x2="' + n(x) + '" y2="' + n(y + 40) + '" ' + LEAD + '/>' +
      '</g>';
  }

  /* ---------- 电铃 ---------- */
  function bellSvg(c) {
    var x = c.x, y = c.y, cy = y + 24, r = 10;
    return '<g class="sym bell">' +
      '<line class="lead" x1="' + n(x) + '" y1="' + n(y) + '" x2="' + n(x) + '" y2="' + n(cy - r) + '" ' + LEAD + '/>' +
      // 铃碗：半圆
      '<path d="M' + n(x - r) + ' ' + n(cy) + 'A' + n(r) + ' ' + n(r) + ' 0 0 1 ' + n(x + r) + ' ' + n(cy) +
      'Z" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.7"/>' +
      // 铃锤
      '<line x1="' + n(x) + '" y1="' + n(cy) + '" x2="' + n(x) + '" y2="' + n(cy + 6) +
      '" stroke="' + INK + '" stroke-width="1.5"/>' +
      '<circle cx="' + n(x) + '" cy="' + n(cy + 7) + '" r="1.8" fill="' + INK + '"/>' +
      '<line class="lead" x1="' + n(x) + '" y1="' + n(cy + 8) + '" x2="' + n(x) + '" y2="' + n(y + 40) + '" ' + LEAD + '/>' +
      '</g>';
  }

  /* ---------- 电磁铁 / 电磁阀线圈 ---------- */
  function solenoidSvg(c) {
    var x = c.x, y = c.y, h = c.h;
    return '<g class="sym fuse">' +
      '<rect x="' + n(x - 11) + '" y="' + n(y) + '" width="22" height="' + n(h) + '"/>' +
      // 铁芯（偏左）＋ 衔铁引出杆
      '<line x1="' + n(x - 4) + '" y1="' + n(y) + '" x2="' + n(x - 4) + '" y2="' + n(y + h) +
      '" stroke="' + INK + '" stroke-width="1.6"/>' +
      '<line x1="' + n(x + 11) + '" y1="' + n(y + h * 0.5) + '" x2="' + n(x + 19) + '" y2="' + n(y + h * 0.5) +
      '" stroke="' + INK + '" stroke-width="1.6"/>' +
      '</g>';
  }

  /* ---------- 二极管 ---------- */
  function diodeSvg(c) {
    var x = c.x, y = c.y, cy = y + 20;
    return '<g class="sym diode">' +
      '<line class="lead" x1="' + n(x) + '" y1="' + n(y) + '" x2="' + n(x) + '" y2="' + n(cy - 8) + '" ' + LEAD + '/>' +
      '<path d="M' + n(x - 8) + ' ' + n(cy - 8) + 'L' + n(x + 8) + ' ' + n(cy - 8) + 'L' + n(x) + ' ' + n(cy + 8) +
      'Z" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.5"/>' +
      '<line x1="' + n(x - 8) + '" y1="' + n(cy + 8) + '" x2="' + n(x + 8) + '" y2="' + n(cy + 8) +
      '" stroke="' + INK + '" stroke-width="1.7"/>' +
      '<line class="lead" x1="' + n(x) + '" y1="' + n(cy + 8) + '" x2="' + n(x) + '" y2="' + n(y + 40) + '" ' + LEAD + '/>' +
      '</g>';
  }

  /* ---------- PLC 主机（左右各四个端子，端子线朝外接导线） ---------- */
  function plcBoxSvg(c) {
    var x = c.x, y = c.y, w = c.w, h = c.h;
    var xs = x + w * 0.5;
    var g = '<g class="sym plc">';
    g += '<rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) +
      '" rx="2" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.7"/>';
    var i, py;
    for (i = 0; i < 4; i++) {
      py = y + 22 + i * 24;
      // 端子线朝外 10px，导线接在外面
      g += '<line x1="' + n(x) + '" y1="' + n(py) + '" x2="' + n(x - 10) + '" y2="' + n(py) +
        '" stroke="' + INK + '" stroke-width="1.5"/>';
      g += '<line x1="' + n(x + w) + '" y1="' + n(py) + '" x2="' + n(x + w + 10) + '" y2="' + n(py) +
        '" stroke="' + INK + '" stroke-width="1.5"/>';
      // 端子点压在框线上
      g += '<circle cx="' + n(x) + '" cy="' + n(py) + '" r="2.1" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.4"/>';
      g += '<circle cx="' + n(x + w) + '" cy="' + n(py) + '" r="2.1" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.4"/>';
    }
    g += '<text x="' + n(xs) + '" y="' + n(y + 112) + '" font-family="' + MONO +
      '" font-size="13" font-weight="500" fill="' + INK + '" text-anchor="middle">PLC</text>';
    g += '<text x="' + n(xs) + '" y="' + n(y + 126) + '" font-family="' + SANS +
      '" font-size="8.5" fill="#8A8E96" text-anchor="middle">S7-1200</text>';
    g += '</g>';
    return g;
  }

  /* ---------------- 类型表 ---------------- */
  var TYPES = {
    no: {
      name: '常开触点', grp: 'ct', tryKey: 'SF',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -11, oy: 20, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 16, y: c.y - 8, w: 32, h: c.h + 16 }; },
      svg: function (c) { return SYMLIB.draw('no', c.x, c.y, c.h, { kind: 'no' }); }
    },
    nc: {
      name: '常闭触点', grp: 'ct', tryKey: 'SF',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -11, oy: 20, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 16, y: c.y - 8, w: 32, h: c.h + 16 }; },
      svg: function (c) { return SYMLIB.draw('nc', c.x, c.y, c.h, { kind: 'nc' }); }
    },
    coil: {
      name: '接触器线圈', grp: 'coil', tryKey: 'QA',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -20, oy: 15, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 18, y: c.y - 6, w: 36, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('coil', c.x, c.y, c.h); }
    },
    fuse: {
      name: '熔断器', grp: 'prot', tryKey: 'FA',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -11, oy: 22, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 6, w: 24, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('fuse', c.x, c.y, c.h); }
    },
    fuseH: {
      name: '熔断器（横）', grp: 'prot', tryKey: 'FA',
      make: function (x, y) { return { x: x, y: y, w: 40, key: '' }; },
      label: { ox: 16, oy: -18, anchor: 'middle', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x + c.w, c.y]]; },
      box: function (c) { return { x: c.x - 6, y: c.y - 12, w: c.w + 12, h: 24 }; },
      svg: function (c) { return '<g transform="translate(' + n(c.x) + ',' + n(c.y) + ') rotate(-90)">' + SYMLIB.draw('fuse', 0, 0, c.w) + '</g>'; }
    },
    switch3: {
      name: '三极隔离开关', grp: 'main', tryKey: 'QB',
      make: function (x, y) { return { x: x, y: y, h: 40, pitch: 56, poles: 3, key: '' }; },
      label: { ox: -14, oy: 21, anchor: 'end', size: 12 },
      pins: function (c) {
        var out = [], i;
        for (i = 0; i < c.poles; i++) {
          out.push([c.x + i * c.pitch, c.y]);
          out.push([c.x + i * c.pitch, c.y + c.h]);
        }
        return out;
      },
      box: function (c) {
        return { x: c.x - 16, y: c.y - 8, w: (c.poles - 1) * c.pitch + 32, h: c.h + 16 };
      },
      svg: function (c) { return SYMLIB.poles('disc', c.x, c.y, c.h, c.poles, c.pitch, { kind: 'no' }); }
    },
    thermal: {
      name: '热继电器', grp: 'prot', tryKey: 'BB',
      make: function (x, y) { return { x: x, y: y, h: 40, pitch: 56, poles: 3, key: '' }; },
      label: { ox: -16, oy: 16, anchor: 'end', size: 12 },
      pins: function (c) {
        var out = [], i;
        for (i = 0; i < c.poles; i++) {
          out.push([c.x + i * c.pitch, c.y]);
          out.push([c.x + i * c.pitch, c.y + c.h]);
        }
        return out;
      },
      box: function (c) {
        return { x: c.x - 16, y: c.y - 8, w: (c.poles - 1) * c.pitch + 32, h: c.h + 16 };
      },
      svg: function (c) { return SYMLIB.poles('tempsw', c.x, c.y, c.h, c.poles, c.pitch, { kind: 'nc' }); }
    },
    motor: {
      name: '三相电动机', grp: 'main', tryKey: '',
      make: function (x, y) { return { cx: x, cy: y, r: 30, key: '' }; },
      label: null,
      pins: function (c) { return [[c.cx, c.cy - c.r], [c.cx, c.cy + c.r]]; },
      box: function (c) { var r = c.r + 9; return { x: c.cx - r, y: c.cy - r, w: r * 2, h: r * 2 }; },
      svg: function (c) { return SYMLIB.draw('motor3', c.cx, c.cy - c.r * 2, c.r * 8 / 3, { cls: 'motor' }); }
    },
    ground: {
      name: '接地', grp: 'prot', tryKey: '',
      make: function (x, y) { return { x: x, y: y, key: '' }; },
      label: { ox: 18, oy: 0, anchor: 'start', size: 11 },
      pins: function (c) { return [[c.x, c.y]]; },
      box: function (c) { return { x: c.x - 15, y: c.y - 6, w: 30, h: 22 }; },
      svg: function (c) { return SYMLIB.draw('gnd', c.x, c.y, 24); }
    },
    btnNo: {
      name: '按钮（常开）', grp: 'ct', tryKey: 'SF',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 17, oy: 2, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 4, w: 26, h: c.h + 8 }; },
      svg: function (c) { return SYMLIB.draw('btnNo', c.x, c.y, c.h, { kind: 'no' }); }
    },
    btnNc: {
      name: '按钮（常闭）', grp: 'ct', tryKey: 'SF',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 17, oy: 2, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 4, w: 26, h: c.h + 8 }; },
      svg: function (c) { return SYMLIB.draw('btnNo', c.x, c.y, c.h, { kind: 'nc', flipBlade: true }); }
    },
    limit: {
      name: '行程开关', grp: 'ct', tryKey: 'SQ',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 17, oy: 4, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 4, w: 26, h: c.h + 8 }; },
      svg: function (c) { return SYMLIB.draw('limit', c.x, c.y, c.h, { kind: 'no' }); }
    },
    kCoil: {
      name: '中间继电器线圈', grp: 'coil', tryKey: 'KA',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -20, oy: 14, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 18, y: c.y - 6, w: 36, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('coil', c.x, c.y, c.h); }
    },
    ktCoil: {
      name: '时间继电器线圈', grp: 'coil', tryKey: 'KT',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -20, oy: 15, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 18, y: c.y - 6, w: 36, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('coilSlowO', c.x, c.y, c.h); }
    },
    contactor3: {
      name: '三极主触点', grp: 'main', tryKey: 'QA',
      make: function (x, y) { return { x: x, y: y, h: 40, pitch: 56, poles: 3, key: '' }; },
      label: { ox: -14, oy: 21, anchor: 'end', size: 12 },
      pins: function (c) {
        var out = [], i;
        for (i = 0; i < c.poles; i++) {
          out.push([c.x + i * c.pitch, c.y]);
          out.push([c.x + i * c.pitch, c.y + c.h]);
        }
        return out;
      },
      box: function (c) {
        return { x: c.x - 16, y: c.y - 8, w: (c.poles - 1) * c.pitch + 32, h: c.h + 16 };
      },
      svg: function (c) { return SYMLIB.poles('contactor1', c.x, c.y, c.h, c.poles, c.pitch, { kind: 'no' }); }
    },
    fuse3: {
      name: '三极熔断器', grp: 'prot', tryKey: 'FA',
      make: function (x, y) { return { x: x, y: y, h: 40, pitch: 56, poles: 3, key: '' }; },
      label: { ox: -16, oy: 16, anchor: 'end', size: 12 },
      pins: function (c) {
        var out = [], i;
        for (i = 0; i < c.poles; i++) {
          out.push([c.x + i * c.pitch, c.y]);
          out.push([c.x + i * c.pitch, c.y + c.h]);
        }
        return out;
      },
      box: function (c) {
        return { x: c.x - 16, y: c.y - 8, w: (c.poles - 1) * c.pitch + 32, h: c.h + 16 };
      },
      svg: function (c) { return SYMLIB.poles('fuse', c.x, c.y, c.h, c.poles, c.pitch); }
    },
    lamp: {
      name: '信号灯', grp: 'sig', tryKey: 'HL',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 15, oy: 20, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 2, w: 24, h: c.h + 4 }; },
      svg: function (c) { return SYMLIB.draw('lamp', c.x, c.y, c.h); }
    },
    bell: {
      name: '电铃', grp: 'sig', tryKey: 'HA',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 15, oy: 24, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 2, w: 24, h: c.h + 4 }; },
      svg: function (c) { return bellSvg(c); }
    },
    solenoid: {
      name: '电磁铁 / 阀', grp: 'sig', tryKey: 'YV',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 15, oy: 15, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 13, y: c.y - 5, w: 26, h: c.h + 10 }; },
      svg: function (c) { return solenoidSvg(c); }
    },
    diode: {
      name: '二极管', grp: 'sig', tryKey: 'V',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 13, oy: 20, anchor: 'start', size: 11 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 11, y: c.y - 2, w: 22, h: c.h + 4 }; },
      svg: function (c) { return SYMLIB.draw('diode', c.x, c.y, c.h); }
    },
    plcBox: {
      name: 'PLC 主机', grp: 'plc', tryKey: '',
      make: function (x, y) { return { x: x, y: y, w: 112, h: 132, key: '' }; },
      label: { ox: 56, oy: -10, anchor: 'middle', size: 12 },
      pins: function (c) {
        var out = [], i, py;
        for (i = 0; i < 4; i++) {
          py = c.y + 22 + i * 24;
          out.push([c.x - 10, py]);
          out.push([c.x + c.w + 10, py]);
        }
        return out;
      },
      box: function (c) { return { x: c.x - 14, y: c.y - 8, w: c.w + 28, h: c.h + 16 }; },
      svg: function (c) { return plcBoxSvg(c); }
    },
    breaker: {
      name: '断路器', grp: 'prot', tryKey: 'QF',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -12, oy: 22, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 14, y: c.y - 6, w: 28, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('breaker', c.x, c.y, c.h); }
    },
    sw: {
      name: '手动开关', grp: 'main', tryKey: 'QS',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: -12, oy: 22, anchor: 'end', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 14, y: c.y - 6, w: 28, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('sw', c.x, c.y, c.h); }
    },
    prox: {
      name: '接近开关', grp: 'ct', tryKey: 'SQ',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 16, oy: 22, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 14, y: c.y - 6, w: 28, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('prox', c.x, c.y, c.h); }
    },
    btnStop: {
      name: '急停按钮', grp: 'ct', tryKey: 'SB',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 16, oy: 4, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 16, y: c.y - 6, w: 32, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('btnStop', c.x, c.y, c.h); }
    },
    led: {
      name: '发光二极管', grp: 'sig', tryKey: 'HL',
      make: function (x, y) { return { x: x, y: y, h: 40, key: '' }; },
      label: { ox: 14, oy: 20, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 12, y: c.y - 6, w: 24, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('led', c.x, c.y, c.h); }
    },
    trans2: {
      name: '控制变压器', grp: 'main', tryKey: 'TC',
      make: function (x, y) { return { x: x, y: y, h: 60, key: '' }; },
      label: { ox: 22, oy: 34, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 22, y: c.y - 6, w: 44, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('trans2', c.x, c.y, c.h); }
    },
    ct: {
      name: '电流互感器', grp: 'prot', tryKey: 'TA',
      make: function (x, y) { return { x: x, y: y, h: 60, key: '' }; },
      label: { ox: 24, oy: 30, anchor: 'start', size: 12 },
      pins: function (c) { return [[c.x, c.y], [c.x, c.y + c.h]]; },
      box: function (c) { return { x: c.x - 24, y: c.y - 6, w: 48, h: c.h + 12 }; },
      svg: function (c) { return SYMLIB.draw('ct', c.x, c.y, c.h); }
    }
  };

  var LIB = [
    { name: '触点 / 按钮', items: ['no', 'nc', 'btnNo', 'btnNc', 'btnStop', 'limit'] },
    { name: '开关 / 检测', items: ['sw', 'breaker', 'prox', 'switch3'] },
    { name: '线圈', items: ['coil', 'kCoil', 'ktCoil'] },
    { name: '主电路', items: ['contactor3', 'fuse3', 'thermal', 'motor', 'trans2'] },
    { name: '保护元件', items: ['fuse', 'fuseH', 'ct', 'ground'] },
    { name: '信号 / 执行', items: ['lamp', 'led', 'bell', 'solenoid', 'diode'] },
    { name: 'PLC', items: ['plcBox'] }
  ];
  /* ---------------- 几何 ---------------- */
  function anchorOf(c) {
    if (c.cx != null) return { x: c.cx, y: c.cy };
    return { x: c.x, y: c.y };
  }

  // 旋转角度规整到 0/90/180/270
  function rotOf(c) { return ((c.rot || 0) % 360 + 360) % 360; }

  // 绕 (ax,ay) 转 deg 度（SVG 坐标 y 向下，正角为顺时针）
  function rotPt(ax, ay, x, y, deg) {
    if (!deg) return [x, y];
    var t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
    var dx = x - ax, dy = y - ay;
    return [ax + dx * cs - dy * sn, ay + dx * sn + dy * cs];
  }

  // 旋转轴心：取端点的包围盒中心，转起来元件原地转、不会甩出去
  function pivotOf(c) {
    var t = TYPES[c.type];
    if (!t) return anchorOf(c);
    var ps = t.pins(c);
    if (!ps.length) return anchorOf(c);
    var x0 = ps[0][0], x1 = ps[0][0], y0 = ps[0][1], y1 = ps[0][1];
    ps.forEach(function (p) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    });
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }

  function boxOf(c) {
    var t = TYPES[c.type];
    if (!t) return { x: c.x - 10, y: c.y - 10, w: 20, h: 20 };
    var b = t.box(c);
    var r = rotOf(c);
    if (!r) return b;
    var a = pivotOf(c);
    var pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
      .map(function (p) { return rotPt(a.x, a.y, p[0], p[1], r); });
    var x0 = Math.min(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
    var y0 = Math.min(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
    var x1 = Math.max(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
    var y1 = Math.max(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function pinsOfComp(c) {
    var t = TYPES[c.type];
    if (!t) return [];
    var out = t.pins(c);
    var r = rotOf(c);
    if (!r) return out;
    var a = pivotOf(c);
    return out.map(function (p) { return rotPt(a.x, a.y, p[0], p[1], r); });
  }

  function pinsOf(doc) {
    var out = [];
    doc.comps.forEach(function (c) {
      pinsOfComp(c).forEach(function (p, i) { out.push({ id: c.id, i: i, x: p[0], y: p[1] }); });
    });
    return out;
  }

  function pinIndex(doc) {
    var map = {};
    pinsOf(doc).forEach(function (p) {
      map[p.x + ',' + p.y] = map[p.x + ',' + p.y] || [];
      map[p.x + ',' + p.y].push(p);
    });
    return map;
  }

  function snap(v) { return Math.round(v / GRID) * GRID; }

  function nearestPin(doc, x, y, tol) {
    var best = null, bd = tol == null ? 13 : tol;
    pinsOf(doc).forEach(function (p) {
      var d = Math.hypot(p.x - x, p.y - y);
      if (d <= bd) { bd = d; best = p; }
    });
    return best;
  }

  // 就近捕捉：元件端点 / 接点端子 / 已有导线端点
  // bind 是用来把导线端点"焊"在引脚上的引用，日后元件怎么移，线都会跟着走
  function snapPoint(doc, x, y, tol) {
    var best = null, bd = tol;
    function take(px, py, kind, bind) {
      var d = Math.hypot(px - x, py - y);
      if (d <= bd) { bd = d; best = { x: px, y: py, kind: kind, bind: bind || null }; }
    }
    pinsOf(doc).forEach(function (p) {
      take(p.x, p.y, 'pin', { c: p.id, i: p.i });
    });
    doc.marks.forEach(function (m) { take(m.x, m.y, 'mark', { m: m.id }); });
    doc.wires.forEach(function (w) {
      if (!w.pts.length) return;
      take(w.pts[0][0], w.pts[0][1], 'end');
      take(w.pts[w.pts.length - 1][0], w.pts[w.pts.length - 1][1], 'end');
    });
    return best;
  }

  /* ---------------- 导线端点绑定 ----------------
     每条导线可以带 a / b 两个绑定：
       { c: 元件id, i: 引脚序号 }  —— 接在元件引脚上
       { m: 接点id }               —— 接在端子/接点上
     绑定生效时，端点坐标永远由引脚实时算出来，元件一移线就跟着走。 */

  function compById(doc, id) {
    for (var i = 0; i < doc.comps.length; i++) {
      if (doc.comps[i].id === id) return doc.comps[i];
    }
    return null;
  }

  function bindPos(doc, b) {
    if (!b) return null;
    if (b.c) {
      var c = compById(doc, b.c);
      if (!c) return null;
      var pins = pinsOfComp(c);
      var p = pins[b.i];
      return p ? [p[0], p[1]] : null;
    }
    if (b.m) {
      for (var i = 0; i < doc.marks.length; i++) {
        if (doc.marks[i].id === b.m) return [doc.marks[i].x, doc.marks[i].y];
      }
    }
    return null;
  }

  function samePt(a, b) { return Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5; }

  // 斜段补成直角（插一个拐点），保证整条线始终正交
  function fixOrtho(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], prev = out[out.length - 1];
      if (prev && Math.abs(prev[0] - p[0]) > 0.5 && Math.abs(prev[1] - p[1]) > 0.5) {
        out.push([prev[0], p[1]]);
      }
      out.push([p[0], p[1]]);
    }
    return out;
  }

  // 去掉重复点与三点共线的多余拐点
  function prunePts(pts) {
    var a = [], i;
    for (i = 0; i < pts.length; i++) {
      if (!a.length || !samePt(a[a.length - 1], pts[i])) a.push([pts[i][0], pts[i][1]]);
    }
    if (a.length < 3) return a;
    var out = [a[0]];
    for (i = 1; i < a.length - 1; i++) {
      var p = out[out.length - 1], q = a[i], r = a[i + 1];
      var colH = Math.abs(p[1] - q[1]) < 0.5 && Math.abs(q[1] - r[1]) < 0.5;
      var colV = Math.abs(p[0] - q[0]) < 0.5 && Math.abs(q[0] - r[0]) < 0.5;
      if (colH || colV) continue;
      out.push(q);
    }
    out.push(a[a.length - 1]);
    return out;
  }

  // 老图纸没有绑定信息：如果端点正好压在引脚/接点上（容差 0.35px），自动补绑。
  // 电路图里端点重合本来就是"接上了"，所以补绑不会误判，还能让旧图也能跟着元件走。
  function autoBindEnd(doc, w, which) {
    var pts = w.pts;
    var p = which === 'a' ? pts[0] : pts[pts.length - 1];
    if (!p) return null;
    var best = null, bd = 0.35;
    (_pinCache || pinsOf(doc)).forEach(function (q) {
      var d = Math.hypot(q.x - p[0], q.y - p[1]);
      if (d <= bd) { bd = d; best = { c: q.id, i: q.i }; }
    });
    if (best) return best;
    doc.marks.forEach(function (m) {
      var d = Math.hypot(m.x - p[0], m.y - p[1]);
      if (d <= bd) { bd = d; best = { m: m.id }; }
    });
    return best;
  }

  function resolveWire(doc, w) {
    var pts = w.pts;
    if (!pts || pts.length < 2) return;
    if (!w.a) w.a = autoBindEnd(doc, w, 'a');
    if (!w.b) w.b = autoBindEnd(doc, w, 'b');
    var A = bindPos(doc, w.a), B = bindPos(doc, w.b);
    // 绑定的元件被删掉了 → 解除绑定，端点留在最后的位置
    if (w.a && !A) w.a = null;
    if (w.b && !B) w.b = null;
    if (!A && !B) return;

    // 首端：把首点搬到引脚；只改第二点在首段法向上的分量，
    // 这样既保持首段正交，又不会把下一段拉斜
    if (A) {
      var h0 = Math.abs(pts[1][1] - pts[0][1]) < 0.5;
      pts[0] = [A[0], A[1]];
      if (pts.length > 2) {
        if (h0) pts[1][1] = A[1]; else pts[1][0] = A[0];
      }
    }
    if (B) {
      var n = pts.length;
      var hb = Math.abs(pts[n - 1][1] - pts[n - 2][1]) < 0.5;
      pts[n - 1] = [B[0], B[1]];
      if (n > 2) {
        if (hb) pts[n - 2][1] = B[1]; else pts[n - 2][0] = B[0];
      }
    }
    w.pts = prunePts(fixOrtho(pts));
  }

  // 整张图纸刷新一遍绑定端点（渲染前统一调用，改坐标/拖动/旋转都不用各自处理）
  var _pinCache = null;
  function resolveWires(doc) {
    _pinCache = pinsOf(doc);   // 拖动时每帧都会走这里，引脚表算一次就够
    try {
      (doc.wires || []).forEach(function (w) { resolveWire(doc, w); });
    } finally {
      _pinCache = null;
    }
  }

  /* ---------------- 渲染 ---------------- */
  function polyPts(pts) {
    return pts.map(function (p) { return n(p[0]) + ',' + n(p[1]); }).join(' ');
  }

  function junctionDots(doc) {
    var ends = {};
    function key(p) { return n(p[0]) + ',' + n(p[1]); }
    doc.wires.forEach(function (w) {
      if (!w.pts.length) return;
      [w.pts[0], w.pts[w.pts.length - 1]].forEach(function (p) {
        var k = key(p);
        ends[k] = (ends[k] || 0) + 1;
      });
    });
    var out = '';
    Object.keys(ends).forEach(function (k) {
      var p = k.split(',');
      var x = +p[0], y = +p[1];
      var cnt = ends[k];
      var tee = false;
      if (cnt < 3) {
        // 端点落在别的导线的中间 → T 形接点
        for (var i = 0; i < doc.wires.length && !tee; i++) {
          var pts = doc.wires[i].pts;
          for (var j = 0; j < pts.length - 1; j++) {
            if (onSeg(pts[j], pts[j + 1], x, y)) { tee = true; break; }
          }
        }
      }
      if (cnt >= 3 || tee) out += '<circle class="junc" cx="' + x + '" cy="' + y + '" r="3"/>';
    });
    return out;
  }

  function onSeg(a, b, x, y) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0) {
      if (Math.abs(x - a[0]) > 0.5) return false;
      var lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      return y > lo + 0.5 && y < hi - 0.5;
    }
    if (Math.abs(dy) < 0.01) {
      if (Math.abs(y - a[1]) > 0.5) return false;
      var lo2 = Math.min(a[0], b[0]), hi2 = Math.max(a[0], b[0]);
      return x > lo2 + 0.5 && x < hi2 - 0.5;
    }
    return false;
  }

  function compSvg(c) {
    var t = TYPES[c.type];
    if (!t) return '';
    var r = rotOf(c), a = anchorOf(c), pv = pivotOf(c);
    var g = '<g class="cmp" data-id="' + c.id + '" data-type="' + c.type + '"' +
      ' data-rot="' + r + '"' +
      (c.key ? ' data-key="' + esc(c.key) + '"' : '') + '>';
    // 透明命中框：符号本体多是细线，没有它点不中（拖动/选中全靠它）；用旋转后的外接框，保持轴对齐
    var bx = boxOf(c);
    g += '<rect class="cmp-hit" x="' + n(bx.x) + '" y="' + n(bx.y) + '" width="' + n(bx.w) +
      '" height="' + n(bx.h) + '" fill="transparent" stroke="none"/>';
    g += r ? '<g class="rot" transform="rotate(' + r + ' ' + n(pv.x) + ' ' + n(pv.y) + ')">' +
      t.svg(c) + '</g>' : t.svg(c);
    if (c.label) {
      // 代号本身不跟着转（始终保持水平可读），只把位置绕同一轴心转过去
      var lp = [a.x + c.label.ox, a.y + c.label.oy];
      if (r) lp = rotPt(pv.x, pv.y, lp[0], lp[1], r);
      var anc = (r === 90 || r === 270) ? 'middle' : c.label.anchor;
      g += txt(lp[0], lp[1], c.label.text,
        { anchor: anc, size: c.label.size, mono: true });
    }
    return g + '</g>';
  }

  function renderInner(doc) {
    var out = '';

    // 元件可能刚被拖动/改坐标/旋转过，先把绑在引脚上的导线端点搬到新位置
    resolveWires(doc);

    // 导线
    doc.wires.forEach(function (w) {
      var p = polyPts(w.pts);
      out += '<polyline class="hit" data-id="' + w.id + '" data-kind="wire" points="' + p + '"/>';
      out += '<polyline class="wire" data-id="' + w.id + '" data-kind="wire" points="' + p +
        '" fill="none" stroke="' + INK + '" stroke-width="1.7" stroke-linecap="square"/>';
    });

    // 虚线 / 分区
    doc.deco.forEach(function (d) {
      out += '<line class="' + (d.kind === 'divider' ? 'divider' : 'dash') +
        '" data-id="' + d.id + '" data-kind="deco" x1="' + n(d.x1) + '" y1="' + n(d.y1) +
        '" x2="' + n(d.x2) + '" y2="' + n(d.y2) + '"/>';
    });

    // 接点自动补
    out += '<g class="autojunc">' + junctionDots(doc) + '</g>';

    // 显式接点 / 端子
    doc.marks.forEach(function (m) {
      if (m.kind === 'dot') {
        out += '<circle class="junc" data-id="' + m.id + '" data-kind="mark" cx="' + n(m.x) +
          '" cy="' + n(m.y) + '" r="3"/>';
      } else {
        out += '<circle class="term" data-id="' + m.id + '" data-kind="mark" cx="' + n(m.x) +
          '" cy="' + n(m.y) + '" r="2.8"/>';
      }
      // 同上：接点太小，补一个透明命中圈
      out += '<circle class="mark-hit" data-id="' + m.id + '" data-kind="mark" cx="' + n(m.x) +
        '" cy="' + n(m.y) + '" r="7" fill="transparent" stroke="none"/>';
    });

    // 元件
    doc.comps.forEach(function (c) { out += compSvg(c); });

    // 独立文字
    doc.texts.forEach(function (t) {
      out += '<g class="tx" data-id="' + t.id + '" data-kind="text">' +
        txt(t.x, t.y, t.text, { anchor: t.anchor, size: t.size, mono: t.mono, color: t.color, spacing: t.spacing }) +
        '<rect class="txhit" x="' + n(t.x - (t.anchor === 'end' ? t.text.length * t.size * 0.6 : 0)) +
        '" y="' + n(t.y - t.size * 0.7) + '" width="' + n(t.text.length * t.size * 0.62) +
        '" height="' + n(t.size * 1.4) + '" fill="transparent"/></g>';
    });

    return out;
  }

  function svgWrap(doc, inner) {
    return '<svg class="sheet-svg ed-svg" viewBox="0 0 ' + doc.w + ' ' + doc.h +
      '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
      inner + '</svg>';
  }

  /* ---------------- 文档 ---------------- */
  function blank(w, h) {
    return {
      id: uid('doc'), no: '1-01', title: '未命名电路',
      w: w || 760, h: h || 500,
      comps: [], wires: [], marks: [], deco: [], texts: []
    };
  }

  function clone(doc) {
    var d = JSON.parse(JSON.stringify(doc));
    return d;
  }

  /* ---------------- 旧电路 → 可编辑文档 ---------------- */
  function captureSheet(recs) {
    function add(o) { recs.push(o); return self; }
    var self = {};
    self.grp = function (name, fn) { if (fn) fn(); return self; };
    self.wire = function (x1, y1, x2, y2) { return add({ k: 'wire', pts: [[x1, y1], [x2, y2]] }); };
    self.path = function (pts) {
      return add({ k: 'wire', pts: pts.map(function (p) { return [p[0], p[1]]; }) });
    };
    self.dot = function (x, y) { return add({ k: 'dot', x: x, y: y }); };
    self.term = function (x, y) { return add({ k: 'term', x: x, y: y }); };
    self.contact = function (x, y, h, o) {
      o = o || {};
      return add({ k: 'comp', type: o.kind === 'nc' ? 'nc' : 'no', x: x, y: y, h: h, key: o.key || '' });
    };
    self.coil = function (x, y, h, o) {
      return add({ k: 'comp', type: 'coil', x: x, y: y, h: h, key: (o && o.key) || '' });
    };
    self.fuseV = function (x, y, h) { return add({ k: 'comp', type: 'fuse', x: x, y: y, h: h }); };
    self.fuseH = function (y, x, w) { return add({ k: 'comp', type: 'fuseH', x: x, y: y, w: w }); };
    self.switch3 = function (xs, y, h) {
      return add({ k: 'comp', type: 'switch3', x: xs[0], y: y, h: h,
        pitch: (xs[1] - xs[0]) || 56, poles: xs.length });
    };
    self.thermal = function (xs, y, h) {
      return add({ k: 'comp', type: 'thermal', x: xs[0], y: y, h: h,
        pitch: (xs[1] - xs[0]) || 56, poles: xs.length });
    };
    self.motor = function (cx, cy, r, o) {
      return add({ k: 'comp', type: 'motor', cx: cx, cy: cy, r: r, key: (o && o.key) || '' });
    };
    self.ground = function (x, y) { return add({ k: 'comp', type: 'ground', x: x, y: y }); };
    self.label = function (x, y, text, o) {
      o = o || {};
      return add({ k: 'text', x: x, y: y, text: String(text), size: o.size || 12,
        mono: !!o.mono, anchor: o.anchor || 'start', color: o.color, spacing: o.spacing });
    };
    self.dash = function (x1, y1, x2, y2) {
      return add({ k: 'dash', x1: x1, y1: y1, x2: x2, y2: y2 });
    };
    self.divider = function (x, y1, y2) {
      return add({ k: 'divider', x1: x, y1: y1, x2: x, y2: y2 });
    };
    self.build = function () { return ''; };
    return self;
  }

  function fromCircuit(circ) {
    var recs = [];
    circ.draw(captureSheet(recs));

    var doc = blank(circ.w, circ.h);
    doc.no = circ.no;
    doc.title = circ.title;

    var pending = [];
    recs.forEach(function (r) {
      if (r.k === 'comp') {
        var c = { id: uid('c'), type: r.type, key: r.key || '' };
        ['x', 'y', 'h', 'w', 'pitch', 'poles', 'cx', 'cy', 'r'].forEach(function (k) {
          if (r[k] != null) c[k] = r[k];
        });
        doc.comps.push(c);
      } else if (r.k === 'wire') {
        doc.wires.push({ id: uid('w'), pts: r.pts });
      } else if (r.k === 'dot' || r.k === 'term') {
        doc.marks.push({ id: uid('m'), kind: r.k, x: r.x, y: r.y });
      } else if (r.k === 'dash' || r.k === 'divider') {
        doc.deco.push({ id: uid('d'), kind: r.k, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
      } else if (r.k === 'text') {
        pending.push(r);
      }
    });

    // 与代号同名的文字 → 挂到最近的元件上，跟着元件走
    pending.forEach(function (t) {
      var best = null, bd = 999;
      if (t.mono) {
        doc.comps.forEach(function (c) {
          if (!c.key || c.label || c.key !== t.text) return;
          var a = anchorOf(c);
          var d = Math.abs(a.x - t.x) + Math.abs(a.y - t.y);
          if (d < bd && d < 90) { bd = d; best = c; }
        });
      }
      if (best) {
        var a2 = anchorOf(best);
        best.label = { text: t.text, ox: t.x - a2.x, oy: t.y - a2.y,
          anchor: t.anchor, size: t.size };
      } else {
        doc.texts.push({ id: uid('t'), x: t.x, y: t.y, text: t.text, size: t.size,
          mono: t.mono, anchor: t.anchor, color: t.color, spacing: t.spacing });
      }
    });

    return doc;
  }

  /* ---------------- 存储 ---------------- */
  var KEY = 'plc-atlas.docs.v1';

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch (e) { return null; }
  }

  function save(docs) {
    try { localStorage.setItem(KEY, JSON.stringify(docs)); return true; }
    catch (e) { return false; }
  }

  global.PLCEditorModel = {
    GRID: GRID, TYPES: TYPES, LIB: LIB, INK: INK, MONO: MONO, SANS: SANS,
    uid: uid, n: n, esc: esc, txt: txt,
    anchorOf: anchorOf, boxOf: boxOf, pinsOf: pinsOf, pinIndex: pinIndex,
    rotOf: rotOf, rotPt: rotPt, pinsOfComp: pinsOfComp, pivotOf: pivotOf,
    snap: snap, nearestPin: nearestPin, snapPoint: snapPoint, onSeg: onSeg,
    bindPos: bindPos, resolveWire: resolveWire, resolveWires: resolveWires,
    compById: compById,
    renderInner: renderInner, svgWrap: svgWrap, compSvg: compSvg,
    blank: blank, clone: clone, fromCircuit: fromCircuit,
    load: load, save: save
  };
})(window);
