/* ============================================================
   symbols.js — 电气原理图符号库 + 图页构建器
   所有坐标均为 SVG 用户单位，1 单位 = 1px
   ============================================================ */
(function (global) {
  'use strict';

  var INK = '#1A1C1F';
  var SANS = "'Noto Sans SC','PingFang SC','Microsoft YaHei','Source Han Sans CN',system-ui,sans-serif";
  var MONO = "'IBM Plex Mono','Consolas','SF Mono','Courier New',monospace";

  function n(v) { return Math.round(v * 100) / 100; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- Sheet ---------------- */
  function Sheet(w, h) {
    this.w = w;
    this.h = h;
    this.groups = { main: [], ctrl: [], chrome: [] };
    this.cur = 'main';
  }

  Sheet.prototype.grp = function (name, fn) {
    var prev = this.cur;
    this.cur = name;
    if (!this.groups[name]) this.groups[name] = [];
    if (fn) fn();
    this.cur = prev;
    return this;
  };

  Sheet.prototype._push = function (s) {
    this.groups[this.cur].push(s);
    return this;
  };

  /* ---------- 导线 ---------- */
  Sheet.prototype.wire = function (x1, y1, x2, y2) {
    return this._push('<line class="wire" x1="' + n(x1) + '" y1="' + n(y1) +
      '" x2="' + n(x2) + '" y2="' + n(y2) +
      '" fill="none" stroke="' + INK + '" stroke-width="1.7"/>');
  };

  Sheet.prototype.path = function (pts) {
    var d = 'M' + pts.map(function (p) { return n(p[0]) + ' ' + n(p[1]); }).join('L');
    return this._push('<path class="wire" d="' + d +
      '" fill="none" stroke="' + INK + '" stroke-width="1.7"/>');
  };

  /* ---------- 接点 / 端子 ---------- */
  Sheet.prototype.dot = function (x, y) {
    return this._push('<circle class="junc" cx="' + n(x) + '" cy="' + n(y) +
      '" r="3" fill="' + INK + '" stroke="none"/>');
  };

  Sheet.prototype.term = function (x, y) {
    return this._push('<circle class="term" cx="' + n(x) + '" cy="' + n(y) +
      '" r="2.8" fill="#FFFFFF" stroke="' + INK + '" stroke-width="1.6"/>');
  };

  /* ---------- 触点（竖排）  y = 上端子, y+h = 下端子 ---------- */
  Sheet.prototype.contact = function (x, y, h, o) {
    o = o || {};
    var kind = o.kind === 'nc' ? 'nc' : 'no';
    return this._push(SYMLIB.draw(kind, x, y, h, {
      kind: kind, cls: 'contact', key: o.key || '',
      flipBlade: !!o.flip && kind === 'nc'
    }));
  };

  /* ---------- 线圈 ---------- */
  Sheet.prototype.coil = function (x, y, h, o) {
    return this._push(SYMLIB.draw('coil', x, y, h, { cls: 'coil', key: (o && o.key) || '' }));
  };

  /* ---------- 熔断器：矩形 + 贯穿熔丝线 ---------- */
  Sheet.prototype.fuseV = function (x, y, h) {
    return this._push(SYMLIB.draw('fuse', x, y, h, { cls: 'fuse' }));
  };

  Sheet.prototype.fuseH = function (y, x, w) {
    return this._push('<g class="sym fuse" transform="translate(' + n(x) + ',' + n(y) +
      ') rotate(-90)">' + SYMLIB.draw('fuse', 0, 0, w) + '</g>');
  };

  /* ---------- 三极隔离开关（含虚线联动） ---------- */
  Sheet.prototype.switch3 = function (xs, y, h) {
    var out = '', i;
    for (i = 0; i < xs.length; i++) {
      out += SYMLIB.draw('disc', xs[i], y, h, { kind: 'no', cls: 'contact' });
    }
    out += '<line class="dash" x1="' + n(xs[0] - 8) + '" y1="' + n(y + h * 0.55) +
      '" x2="' + n(xs[xs.length - 1] + 8) + '" y2="' + n(y + h * 0.55) + '"/>';
    return this._push(out);
  };

  /* ---------- 三组发热元件（热继电器） ---------- */
  Sheet.prototype.thermal = function (xs, y, h) {
    var out = '', i;
    for (i = 0; i < xs.length; i++) {
      out += SYMLIB.draw('tempsw', xs[i], y, h, { kind: 'nc', cls: 'contact' });
    }
    out += '<line class="dash" x1="' + n(xs[0] - 8) + '" y1="' + n(y + h * 0.55) +
      '" x2="' + n(xs[xs.length - 1] + 8) + '" y2="' + n(y + h * 0.55) + '"/>';
    return this._push(out);
  };

  /* ---------- 电动机 ---------- */
  Sheet.prototype.motor = function (cx, cy, r, o) {
    o = o || {};
    // 库里的电机符号：圆只占包围盒高度的 3/4，上面是三相进线，按此还原圆的真实半径
    return this._push(SYMLIB.draw('motor3', cx, cy - r * 2, r * 8 / 3, {
      cls: 'motor', key: o.key || ''
    }));
  };

  /* ---------- 接地 ---------- */
  Sheet.prototype.ground = function (x, y) {
    return this._push(SYMLIB.draw('gnd', x, y, 22, { cls: 'gnd' }));
  };

  /* ---------- 文字 ---------- */
  Sheet.prototype.label = function (x, y, text, o) {
    o = o || {};
    var size = o.size || 12;
    var color = o.color || INK;
    var anchor = o.anchor || 'start';
    var fam = o.mono ? MONO : SANS;
    var weight = o.weight || (o.mono ? 500 : 400);
    var ls = o.spacing ? ' letter-spacing="' + o.spacing + '"' : '';
    return this._push('<text x="' + n(x) + '" y="' + n(y) + '" font-family="' + fam +
      '" font-size="' + size + '" font-weight="' + weight + '" fill="' + color +
      '" text-anchor="' + anchor + '" dominant-baseline="central"' + ls + '>' + esc(text) + '</text>');
  };

  /* ---------- 虚线 ---------- */
  Sheet.prototype.dash = function (x1, y1, x2, y2) {
    return this._push('<line class="dash" x1="' + n(x1) + '" y1="' + n(y1) +
      '" x2="' + n(x2) + '" y2="' + n(y2) +
      '" fill="none" stroke="#8A8E96" stroke-width="1.2" stroke-dasharray="4 3"/>');
  };

  /* ---------- 分区标题 + 分隔虚线 ---------- */
  Sheet.prototype.divider = function (x, y1, y2) {
    return this._push('<line class="divider" x1="' + n(x) + '" y1="' + n(y1) +
      '" x2="' + n(x) + '" y2="' + n(y2) +
      '" fill="none" stroke="#C9CBD1" stroke-width="1.2" stroke-dasharray="6 5"/>');
  };

  /* ---------- 输出 ---------- */
  Sheet.prototype.build = function () {
    var out = '';
    ['main', 'ctrl', 'chrome'].forEach(function (k) {
      var list = this.groups[k] || [];
      if (!list.length) return;
      out += '<g class="grp grp-' + k + '" data-grp="' + k + '">' + list.join('') + '</g>';
    }, this);
    return '<svg class="sheet-svg" viewBox="0 0 ' + this.w + ' ' + this.h +
      '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' + out + '</svg>';
  };

  global.PLCSym = { Sheet: Sheet, INK: INK, SANS: SANS, MONO: MONO };
})(window);
