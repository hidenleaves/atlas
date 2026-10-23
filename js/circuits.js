/* ============================================================
   circuits.js — 电路数据层
   换电路 = 改这个文件。每条电路只需描述：图元 + 场景（演示步骤）
   ============================================================ */
(function (global) {
  'use strict';

  var RAILS = [66, 122, 178];

  /* ---------- 通用绘制小工具 ---------- */

  // 竖直支路：从 y 起依次叠加元件，返回末端 y
  function chain(S, x, y, items) {
    var cur = y;
    items.forEach(function (it) {
      var pad = it.pad == null ? 14 : it.pad;
      if (pad > 0) S.wire(x, cur, x, cur + pad);
      var top = cur + pad;
      var h = it.h || (it.t === 'coil' ? 26 : it.t === 'fuse' ? 32 : 40);
      if (it.t === 'no' || it.t === 'nc') S.contact(x, top, h, it);
      else if (it.t === 'coil') S.coil(x, top, h, it);
      else if (it.t === 'fuse') S.fuseV(x, top, h);
      if (it.label) S.label(x - (it.t === 'coil' ? 20 : 11), top + h / 2, it.label,
        { anchor: 'end', mono: true, size: 12 });
      cur = top + h;
    });
    return cur;
  }

  // 并联支路（自锁触点）：跨接在 yTop–yBot 之间
  function shunt(S, x, yTop, yBot, off, item) {
    var it = {};
    for (var k in item) it[k] = item[k];
    S.wire(x, yTop, x + off, yTop);
    S.contact(x + off, yTop, yBot - yTop, it);
    S.wire(x + off, yBot, x, yBot);
    if (item.label) S.label(x + off + 22, (yTop + yBot) / 2, item.label,
      { anchor: 'start', mono: true, size: 11 });
  }

  // 三相收拢进电动机
  function feedMotor(S, xs, yFrom, cy, r, key) {
    var x1 = xs[0], x2 = xs[1], x3 = xs[2];
    var busY = cy - r - 2;
    var yb = yFrom + Math.min(20, (busY - yFrom) * 0.42);
    S.wire(x1, yFrom, x1, yb);
    S.wire(x1, yb, x2 - 14, busY);
    S.wire(x2, yFrom, x2, busY);
    S.wire(x3, yFrom, x3, yb);
    S.wire(x3, yb, x2 + 14, busY);
    S.wire(x2 - 14, busY, x2 + 14, busY);
    S.wire(x2, busY, x2, cy - r);
    S.motor(x2, cy, r, { key: key });
  }

  /* ---------- 主电路模板 ---------- */

  // 单电机、单向
  function mainSingle(S) {
    RAILS.forEach(function (x, i) {
      S.term(x, 34);
      S.label(x, 21, 'L' + (i + 1), { anchor: 'middle', mono: true, size: 12 });
      S.wire(x, 34, x, 58);
    });
    S.switch3(RAILS, 58, 40);
    RAILS.forEach(function (x) { S.wire(x, 98, x, 118); });
    RAILS.forEach(function (x) { S.fuseV(x, 118, 40); });
    S.label(204, 132, 'FA1', { mono: true });
    S.label(204, 79, 'QB', { mono: true });
    RAILS.forEach(function (x) { S.wire(x, 158, x, 178); });
    RAILS.forEach(function (x) { S.contact(x, 178, 40, { kind: 'no', key: 'QA1' }); });
    S.dash(RAILS[0] - 9, 198, RAILS[2] + 9, 198);
    S.label(204, 198, 'QA1', { mono: true });
    RAILS.forEach(function (x) { S.wire(x, 218, x, 248); });
    S.thermal(RAILS, 248, 40);
    S.label(204, 268, 'BB', { mono: true });
    RAILS.forEach(function (x) { S.wire(x, 288, x, 300); });
    feedMotor(S, RAILS, 300, 372, 32, 'QA1');
    S.wire(154, 372, 180, 372);
    S.wire(180, 372, 180, 404);
    S.ground(180, 404);
    S.label(192, 404, 'PE', { mono: true, size: 11 });
  }

  // 单电机、正反转（含相序交换）
  function mainReverse(S) {
    RAILS.forEach(function (x, i) {
      S.term(x, 34);
      S.label(x, 21, 'L' + (i + 1), { anchor: 'middle', mono: true, size: 12 });
      S.wire(x, 34, x, 58);
    });
    S.switch3(RAILS, 58, 40);
    RAILS.forEach(function (x) { S.wire(x, 98, x, 118); });
    RAILS.forEach(function (x) { S.fuseV(x, 118, 40); });
    S.label(204, 132, 'FA1', { mono: true });
    S.label(204, 79, 'QB', { mono: true });
    RAILS.forEach(function (x) { S.wire(x, 158, x, 178); });

    RAILS.forEach(function (x) { S.contact(x, 178, 40, { kind: 'no', key: 'QA1' }); });
    S.dash(RAILS[0] - 9, 198, RAILS[2] + 9, 198);
    S.label(204, 198, 'QA1', { mono: true });

    RAILS.forEach(function (x) { S.wire(x, 208, x, 236); });
    RAILS.forEach(function (x) { S.contact(x, 236, 40, { kind: 'no', key: 'QA2' }); });
    S.dash(RAILS[0] - 9, 256, RAILS[2] + 9, 256);
    S.label(204, 256, 'QA2', { mono: true });

    // 相序交换
    S.wire(RAILS[0], 276, RAILS[1], 302);
    S.wire(RAILS[1], 276, RAILS[0], 302);
    S.wire(RAILS[2], 276, RAILS[2], 302);
    S.wire(RAILS[0], 302, RAILS[0], 318);
    S.wire(RAILS[1], 302, RAILS[1], 318);

    S.thermal(RAILS, 318, 40);
    S.label(204, 338, 'BB', { mono: true });
    RAILS.forEach(function (x) { S.wire(x, 358, x, 368); });
    feedMotor(S, RAILS, 368, 430, 32, 'QA1');
    S.wire(154, 430, 182, 430);
    S.wire(182, 430, 182, 462);
    S.ground(182, 462);
    S.label(194, 462, 'PE', { mono: true, size: 11 });
  }

  /* ---------- 控制电路：单支路（点动 / 自锁） ---------- */
  function ctrlSingle(S, withShunt) {
    S.label(316, 80, 'L1', { anchor: 'end', mono: true });
    S.term(330, 80);
    S.wire(330, 80, 346, 80);
    S.fuseH(80, 346, 40);
    S.label(362, 61, 'FA2', { anchor: 'middle', mono: true });
    S.wire(378, 80, 430, 80);
    S.wire(430, 80, 430, 102);

    S.contact(430, 102, 40, { kind: 'nc', key: 'SF1' });
    S.label(419, 122, 'SF1', { anchor: 'end', mono: true });
    S.wire(430, 142, 430, 162);

    S.contact(430, 162, 40, { kind: 'no', key: 'SF2' });
    S.label(419, 182, 'SF2', { anchor: 'end', mono: true });
    if (withShunt) shunt(S, 430, 162, 202, 56, { kind: 'no', key: 'QA1', label: 'QA1' });

    S.wire(430, 202, 430, 222);
    S.coil(430, 222, 26, { key: 'QA1' });
    S.label(419, 235, 'QA1', { anchor: 'end', mono: true });
    S.wire(430, 248, 430, 300);

    S.wire(430, 300, 616, 300);
    S.fuseH(300, 616, 40);
    S.wire(648, 300, 680, 300);
    S.term(680, 300);
    S.label(692, 300, 'L2', { mono: true });
  }

  /* ---------- 控制电路：正反转 ---------- */
  function ctrlReverse(S, double) {
    S.label(316, 60, 'L1', { anchor: 'end', mono: true });
    S.term(330, 60);
    S.wire(330, 60, 346, 60);
    S.fuseH(60, 346, 40);
    S.label(362, 41, 'FA2', { anchor: 'middle', mono: true });
    S.wire(378, 60, 430, 60);
    S.wire(430, 60, 430, 90);

    S.contact(430, 90, 40, { kind: 'nc', key: 'SF1' });
    S.label(419, 110, 'SF1', { anchor: 'end', mono: true });
    S.wire(430, 130, 430, 156);

    S.wire(348, 156, 578, 156);
    S.dot(430, 156);
    S.wire(348, 156, 348, 180);
    S.wire(578, 156, 578, 180);

    var fwd = double
      ? [{ t: 'nc', key: 'SF3', label: 'SF3', pad: 0 },
         { t: 'no', key: 'SF2', label: 'SF2' },
         { t: 'nc', key: 'QA2', label: 'QA2' },
         { t: 'coil', key: 'QA1', label: 'QA1' }]
      : [{ t: 'no', key: 'SF2', label: 'SF2', pad: 0 },
         { t: 'nc', key: 'QA2', label: 'QA2' },
         { t: 'coil', key: 'QA1', label: 'QA1' }];

    var rev = double
      ? [{ t: 'nc', key: 'SF2', label: 'SF2', pad: 0 },
         { t: 'no', key: 'SF3', label: 'SF3' },
         { t: 'nc', key: 'QA1', label: 'QA1' },
         { t: 'coil', key: 'QA2', label: 'QA2' }]
      : [{ t: 'no', key: 'SF3', label: 'SF3', pad: 0 },
         { t: 'nc', key: 'QA1', label: 'QA1' },
         { t: 'coil', key: 'QA2', label: 'QA2' }];

    var endF = chain(S, 348, 180, fwd);
    var endR = chain(S, 578, 180, rev);

    var startY = double ? 234 : 180;
    var startBtn = double ? 'SF2' : 'SF2';
    shunt(S, 348, startY, startY + 40, 56, { kind: 'no', key: 'QA1', label: 'QA1' });
    shunt(S, 578, double ? 234 : 180, (double ? 234 : 180) + 40, 56,
      { kind: 'no', key: 'QA2', label: 'QA2' });

    S.wire(348, endF, 348, 470);
    S.wire(578, endR, 578, 470);
    S.wire(348, 470, 640, 470);
    S.dot(578, 470);
    S.fuseH(470, 640, 40);
    S.wire(672, 470, 706, 470);
    S.term(706, 470);
    S.label(718, 470, 'L2', { mono: true });
  }

  /* ---------- 控制电路：两地控制 ---------- */
  function ctrlRemote(S) {
    S.label(316, 60, 'L1', { anchor: 'end', mono: true });
    S.term(330, 60);
    S.wire(330, 60, 346, 60);
    S.fuseH(60, 346, 40);
    S.label(362, 41, 'FA2', { anchor: 'middle', mono: true });
    S.wire(378, 60, 430, 60);
    S.wire(430, 60, 430, 90);

    // 两只停止按钮串联在干路上
    S.contact(430, 90, 40, { kind: 'nc', key: 'SF11' });
    S.label(419, 110, 'SF11', { anchor: 'end', mono: true });
    S.wire(430, 130, 430, 146);

    S.contact(430, 146, 40, { kind: 'nc', key: 'SF21' });
    S.label(419, 166, 'SF21', { anchor: 'end', mono: true });
    S.wire(430, 186, 430, 210);

    // 三支并联：甲地启动 / 乙地启动 / 自锁
    S.wire(358, 210, 502, 210);
    S.dot(430, 210);
    S.contact(358, 210, 40, { kind: 'no', key: 'SF12' });
    S.contact(430, 210, 40, { kind: 'no', key: 'SF22' });
    S.contact(502, 210, 40, { kind: 'no', key: 'QA1' });
    S.label(346, 230, 'SF12', { anchor: 'end', mono: true, size: 11 });
    S.label(418, 230, 'SF22', { anchor: 'end', mono: true, size: 11 });
    S.label(490, 230, 'QA1', { anchor: 'end', mono: true, size: 11 });

    S.wire(358, 250, 358, 300);
    S.wire(430, 250, 430, 300);
    S.wire(502, 250, 502, 300);
    S.wire(358, 300, 502, 300);
    S.dot(430, 300);
    S.wire(430, 300, 430, 320);

    S.coil(430, 320, 26, { key: 'QA1' });
    S.label(410, 333, 'QA1', { anchor: 'end', mono: true });
    S.wire(430, 346, 430, 400);

    S.wire(430, 400, 616, 400);
    S.fuseH(400, 616, 40);
    S.wire(648, 400, 680, 400);
    S.term(680, 400);
    S.label(692, 400, 'L2', { mono: true });
  }

  /* ============================================================
     电路清单
     ============================================================ */
  var list = [
    {
      id: 'jog', no: '1-06', cat: 'jog',
      title: '点动控制电路',
      tags: ['基础环节'],
      meta: '主电路 380 V 3~ 50 Hz　·　控制电路 220 V　·　无自锁',
      ratio: '1 : 1',
      w: 760, h: 440, split: 275,
      draw: function (S) {
        S.grp('main', function () { mainSingle(S); });
        S.grp('ctrl', function () { ctrlSingle(S, false); });
        S.grp('chrome', function () {
          S.label(0, 9, '主电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.label(300, 9, '控制电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.divider(270, 32, 424);
        });
      },
      scenes: [
        { label: '待机', status: '电动机 停转', running: false, on: [],
          desc: '合上 QB，控制回路带电。SF1 常闭保持通路，SF2 常开断开，QA1 未得电。' },
        { label: '按下 SF2', status: '电动机 点动运转', running: true, on: ['SF2', 'QA1'],
          desc: 'SF2 常开闭合，QA1 线圈得电吸合，主触点闭合，电动机点动运转。' },
        { label: '松开 SF2', status: '电动机 停转', running: false, on: [],
          desc: '手一松开，SF2 复位断开，QA1 立即释放，主触点断开，电动机停转。' }
      ],
      note: {
        title: '点动为什么不能自保持',
        body: '控制回路里只有启动按钮 SF2 的常开触点，没有并联接触器自己的自锁触点。手一松，线圈回路就断了，所以只能按住才转。'
      }
    },

    {
      id: 'selflock', no: '1-08', cat: 'jog',
      title: '自锁（长动）控制电路',
      tags: ['自锁'],
      meta: '主电路 380 V 3~ 50 Hz　·　控制电路 220 V　·　QA1 常开触点自锁',
      ratio: '1 : 1',
      w: 760, h: 440, split: 275,
      draw: function (S) {
        S.grp('main', function () { mainSingle(S); });
        S.grp('ctrl', function () { ctrlSingle(S, true); });
        S.grp('chrome', function () {
          S.label(0, 9, '主电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.label(300, 9, '控制电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.divider(270, 32, 424);
        });
      },
      scenes: [
        { label: '待机', status: '电动机 停转', running: false, on: [],
          desc: 'SF1 常闭、SF2 常开，QA1 未得电，自锁触点也是断开的。' },
        { label: '按下 SF2', status: '电动机 启动中', running: true, on: ['SF2', 'QA1'],
          desc: 'QA1 线圈得电，主触点闭合；同时并联在 SF2 两端的 QA1 常开辅助触点闭合。' },
        { label: '松开 SF2', status: '电动机 持续运转', running: true, on: ['QA1'],
          desc: 'SF2 已复位，但 QA1 通过自己的辅助触点维持线圈通路——松开按钮仍继续运行，这就是自锁。' },
        { label: '按下 SF1', status: '电动机 停转', running: false, on: [],
          desc: 'SF1 串在干路上，按下即切断整个控制回路，QA1 释放，自锁一并解除。' }
      ],
      note: {
        title: '自锁触点接在哪里',
        body: 'QA1 的常开辅助触点并联在启动按钮 SF2 两端，不是串联。并联才能绕过按钮供电；串联只会让电路永远接不通。'
      }
    },

    {
      id: 'rev-lock', no: '1-11', cat: 'rev',
      title: '接触器互锁正反转控制电路',
      tags: ['互锁'],
      meta: '主电路 380 V 3~ 50 Hz　·　控制电路 220 V　·　仅接触器辅助触点互锁',
      ratio: '1 : 1',
      w: 760, h: 500, split: 275,
      draw: function (S) {
        S.grp('main', function () { mainReverse(S); });
        S.grp('ctrl', function () { ctrlReverse(S, false); });
        S.grp('chrome', function () {
          S.label(0, 9, '主电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.label(300, 9, '控制电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.divider(270, 32, 484);
        });
      },
      scenes: [
        { label: '待机', status: '电动机 停转', running: false, on: [],
          desc: '两条支路都通到线圈，但 QA1、QA2 的常闭触点都在闭合位置，谁先得电谁动作。' },
        { label: '按下 SF2', status: '电动机 正转', running: true, on: ['SF2', 'QA1'],
          desc: 'QA1 得电吸合，主触点按 L1-L2-L3 顺序接通，电动机正转；QA1 常闭触点同时断开反转支路。' },
        { label: '直接按 SF3', status: '电动机 正转（无响应）', running: true, on: ['SF3', 'QA1'],
          desc: 'SF3 虽然按下，但 QA1 的常闭触点已经断开，QA2 线圈构不成回路，电动机保持正转。' },
        { label: '按下 SF1', status: '电动机 停转', running: false, on: [],
          desc: '切断控制回路，QA1 释放，其常闭触点复位——现在反转支路才重新接通。' },
        { label: '再按 SF3', status: '电动机 反转', running: true, on: ['SF3', 'QA2'],
          desc: 'QA2 得电，主触点把 L1、L2 两相对调后接入电动机，旋转磁场反向，电动机反转。' }
      ],
      note: {
        title: '只有接触器互锁的代价',
        body: '换向必须先按 SF1 停机。也就是说这套电路做不到「不停机直接换向」——想要那样，得再加按钮互锁，也就是下一张图。'
      }
    },

    {
      id: 'rev-double', no: '1-12', cat: 'rev',
      title: '双重互锁正反转控制电路',
      tags: ['双重互锁', '经典'],
      meta: '主电路 380 V 3~ 50 Hz　·　控制电路 220 V　·　按钮 + 接触器双重互锁',
      ratio: '1 : 1',
      w: 760, h: 500, split: 275,
      draw: function (S) {
        S.grp('main', function () { mainReverse(S); });
        S.grp('ctrl', function () { ctrlReverse(S, true); });
        S.grp('chrome', function () {
          S.label(0, 9, '主电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.label(300, 9, '控制电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.divider(270, 32, 484);
        });
      },
      scenes: [
        { label: '待机', status: '电动机 停转', running: false, on: [],
          desc: '合上 QB，控制回路带电。两条支路各有一只按钮的常闭触点串联，互锁已就位。' },
        { label: '按下 SF2', status: '电动机 正转', running: true, on: ['SF2', 'QA1'],
          desc: 'QA1 得电，主触点闭合、自锁触点闭合，电动机正转；QA1 常闭触点断开反转支路。' },
        { label: '直接按 SF3', status: '电动机 反转', running: true, on: ['SF3', 'QA2'],
          desc: 'SF3 的常闭触点先断开，QA1 立刻释放；紧接着 SF3 常开闭合，QA2 得电，电动机直接反转。' },
        { label: '按下 SF1', status: '电动机 停转', running: false, on: [],
          desc: '停止按钮切断干路，QA1 / QA2 无论谁吸合都失电释放，电动机停转。' }
      ],
      note: {
        title: '为什么是「双重」互锁',
        body: '按钮互锁让 SF3 常闭先断、后通，可以不停机直接换向；接触器互锁防止主触点熔焊时另一台接触器吸合，造成相间短路。两者作用不同，缺一不可。'
      }
    },

    {
      id: 'remote', no: '1-14', cat: 'remote',
      title: '两地控制电路',
      tags: ['多地控制'],
      meta: '主电路 380 V 3~ 50 Hz　·　控制电路 220 V　·　启动并联 / 停止串联',
      ratio: '1 : 1',
      w: 760, h: 500, split: 275,
      draw: function (S) {
        S.grp('main', function () { mainSingle(S); });
        S.grp('ctrl', function () { ctrlRemote(S); });
        S.grp('chrome', function () {
          S.label(0, 9, '主电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.label(300, 9, '控制电路', { size: 10, color: '#A0A5AC', spacing: 1 });
          S.divider(270, 32, 484);
        });
      },
      scenes: [
        { label: '待机', status: '电动机 停转', running: false, on: [],
          desc: '甲地的 SF11 与乙地的 SF21 串联在干路上，两处都闭合；三只启动触点都断开。' },
        { label: '甲地按 SF12', status: '电动机 运转', running: true, on: ['SF12', 'QA1'],
          desc: '甲地启动按钮 SF12 闭合，QA1 线圈得电，主触点闭合，电动机启动。' },
        { label: '松开 SF12', status: '电动机 持续运转', running: true, on: ['QA1'],
          desc: 'QA1 的自锁触点并联在三只启动触点两端，松开按钮后由自锁维持运行。' },
        { label: '乙地按 SF21', status: '电动机 停转', running: false, on: ['SF21'],
          desc: '乙地的停止按钮 SF21 串在干路上，在乙地也能直接停机；甲地的 SF11 同样有效。' },
        { label: '乙地按 SF22', status: '电动机 运转', running: true, on: ['SF22', 'QA1'],
          desc: '乙地的启动按钮 SF22 与 SF12 并联，从乙地同样能启动——这就是「两地控制」。' }
      ],
      note: {
        title: '两地控制的接法',
        body: '启动按钮并联、停止按钮串联。并联的启动按钮保证任一地点都能启动；串联的停止按钮保证任一地点都能停机，两处互不干扰。'
      }
    }
  ];

  var cats = [
    { id: 'jog', name: '点动与自锁' },
    { id: 'rev', name: '正反转控制' },
    { id: 'remote', name: '多地控制' }
  ];

  global.PLCCircuits = { list: list, cats: cats };
})(window);
