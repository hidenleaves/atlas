/* symlib.js —— 把 symgeo.js 里的 IEC 几何数据渲染成 SVG
 *
 * 设计原则：
 *   1. 形状完全来自标准库，这里一行几何都不自己编；
 *   2. 只做「坐标映射」——把符号的原生跨度缩放到元件给定的高度 h；
 *   3. 通电时的刀口动画靠 .blade 类 + transform-origin，角度由 CSS 给。
 *
 * 坐标约定：
 *   库符号以端子定义方向，取最上/最下两个端子，映射到 (x, y) 和 (x, y + h)。
 *   这样无论元件多高，引线端点总是正好落在接点上，导线能接住。
 */
(function (global) {
  'use strict';

  var G = global.SYMGEO || {};

  function r2(v) { return Math.round(v * 100) / 100; }

  /* 求映射：库坐标 -> 元件坐标
   * 竖向用符号包围盒（含所有图元与端子），横向以端子平均位置为中轴。
   * 这样 (x, y, h) 的含义稳定：y 是符号最高点，x 是符号中轴，h 是总高。 */
  function mapper(g, x, y, h) {
    var bb = g.bbox || [0, 0, 0, 0];
    var y0 = bb[1], span = bb[3] - bb[1];
    var s = span > 0.001 ? h / span : 1;
    var ps = g.pins || [], ax;
    if (ps.length) {
      var sum = 0;
      for (var i = 0; i < ps.length; i++) sum += ps[i][0];
      ax = sum / ps.length;
    } else {
      ax = (bb[0] + bb[2]) / 2;
    }
    return {
      s: s,
      X: function (lx) { return x + (lx - ax) * s; },
      Y: function (ly) { return y + (ly - y0) * s; }
    };
  }

  /* 画一条折线点串 */
  function poly(a, cls, m, close) {
    var d = '', i;
    for (i = 0; i + 1 < a.length; i += 2) {
      d += (i ? 'L' : 'M') + r2(m.X(a[i])) + ' ' + r2(m.Y(a[i + 1]));
    }
    return '<path class="' + cls + '" d="' + d + (close ? 'Z' : '') + '"/>';
  }

  /* 主渲染
   * key    symgeo 里的键
   * x, y   元件上端接点
   * h      元件总高
   * opt    { kind, cls, dx }   kind 用于 CSS 区分常开/常闭；dx 为横向整体偏移
   */
  function draw(key, x, y, h, opt) {
    opt = opt || {};
    var g = G[key];
    if (!g) return '';

    var m = mapper(g, x, y, h);
    var blades = {};
    (g.blade || []).forEach(function (b) { blades[b.i] = b; });

    var out = '', i, sh, a, t;
    for (i = 0; i < g.shapes.length; i++) {
      sh = g.shapes[i];
      t = sh[0];
      // L/R/C/E 是扁平数字串，P/G 是点数组
      a = (t === 'P' || t === 'G') ? sh[1] : sh.slice(1);

      if (t === 'L') {
        var x1 = r2(m.X(a[0])), y1 = r2(m.Y(a[1]));
        var x2 = r2(m.X(a[2])), y2 = r2(m.Y(a[3]));
        if (blades[i]) {
          var pv = blades[i].p;
          var px = r2(m.X(pv[0])), py = r2(m.Y(pv[1]));
          // 常闭按钮：库只提供「按钮+常开触点」，把刀绕铰点镜像就是常闭，
          // 几何仍来自标准线段，不额外画一笔。
          if (opt.flipBlade) x2 = r2(2 * px - x2);
          out += '<line class="blade" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
            '" style="transform-box:view-box;transform-origin:' + px + 'px ' + py + 'px"/>';
        } else {
          out += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>';
        }
      } else if (t === 'R') {
        out += '<rect x="' + r2(m.X(a[0])) + '" y="' + r2(m.Y(a[1])) +
          '" width="' + r2(a[2] * m.s) + '" height="' + r2(a[3] * m.s) + '"/>';
      } else if (t === 'C') {
        out += '<circle cx="' + r2(m.X(a[0])) + '" cy="' + r2(m.Y(a[1])) +
          '" r="' + r2(a[2] * m.s) + '"/>';
      } else if (t === 'E') {
        out += '<ellipse cx="' + r2(m.X(a[0])) + '" cy="' + r2(m.Y(a[1])) +
          '" rx="' + r2(a[2] * m.s) + '" ry="' + r2(a[3] * m.s) + '"/>';
      } else if (t === 'P') {
        out += poly(a, 'pl', m, false);
      } else if (t === 'G') {
        out += poly(a, 'pg', m, true);
      }
    }

    var cls = 'sym' + (opt.cls ? ' ' + opt.cls : '');
    var kind = opt.kind ? ' data-kind="' + opt.kind + '"' : '';
    var key = opt.key ? ' data-key="' + String(opt.key).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"' : '';
    return '<g class="' + cls + '"' + kind + key + '>' + out + '</g>';
  }

  /* 多极：把同一个单极符号按间距重复，再补一条联动虚线 */
  function poles(key, x, y, h, n, pitch, opt) {
    opt = opt || {};
    var out = '', i;
    for (i = 0; i < n; i++) {
      out += draw(key, x + i * pitch, y, h, opt);
    }
    var cx0 = x, cx1 = x + (n - 1) * pitch;
    out += '<line class="dash" x1="' + r2(cx0 - 8) + '" y1="' + r2(y + h * 0.55) +
      '" x2="' + r2(cx1 + 8) + '" y2="' + r2(y + h * 0.55) + '"/>';
    return out;
  }

  /* 取符号在给定高度下的实际宽度，用于排版和命中框 */
  function widthOf(key, h) {
    var g = G[key];
    if (!g) return h;
    var m = mapper(g, 0, 0, h);
    return (g.bbox[2] - g.bbox[0]) * m.s;
  }

  /* 该符号是否有刀口（用于判断要不要响应通电动画） */
  function hasBlade(key) {
    var g = G[key];
    return !!(g && g.blade && g.blade.length);
  }

  function has(key) { return !!G[key]; }

  global.SYMLIB = {
    draw: draw,
    poles: poles,
    widthOf: widthOf,
    hasBlade: hasBlade,
    has: has,
    data: G
  };
})(window);
