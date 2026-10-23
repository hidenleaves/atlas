/* ============================================================
   templates.js — 内置电路模板的单一实现
   ------------------------------------------------------------
   路由（interpretV2）和模型工具（draw_template）都走这里，
   避免"内置规则画一套、模型画另一套"。
   每个模板返回：
     { ok, kind, title, reply, error? }
   画布修改由 PLCApi 完成；失败回滚由 api.drawTemplate 负责。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.PLCTemplates = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function api() { return root.PLCApi; }

  function fail(kind, title, msg) {
    return { ok: false, kind: kind, title: title, reply: msg, error: msg };
  }

  /* ---------------- 点动 ---------------- */
  function jog(doc) {
    var A = api();
    if (!A) return fail('jog', '', '画板 API 未加载');
    A.clear(doc);
    A.place(doc, 'btnNo', { key: 'SF1', x: 220, y: 120 });
    A.place(doc, 'coil', { key: 'QA1', x: 220, y: 250 });
    A.link(doc, 'SF1', 'QA1');
    A.lead(doc, 'SF1', 0, 220, 60);
    A.lead(doc, 'QA1', 1, 220, 400);
    doc.title = '点动控制';
    return {
      ok: true, kind: 'jog', title: doc.title,
      reply: '点动回路：按住 SF1 接触器吸合，松开就停。'
    };
  }

  /* ---------------- 起保停 / 自锁 ---------------- */
  function selflock(doc) {
    var A = api();
    if (!A) return fail('selflock', '', '画板 API 未加载');
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
    return {
      ok: true, kind: 'selflock', title: doc.title,
      reply: '起保停画好了：SF1 启动、SF2 停止、QA1 接触器，自锁触点已经并联在启动按钮两端 —— 松开按钮也能保持。'
    };
  }

  /* ---------------- 纯互锁 ---------------- */
  function interlock(doc) {
    var A = api();
    if (!A) return fail('interlock', '', '画板 API 未加载');
    A.clear(doc);
    A.place(doc, 'btnNo', { key: 'SF1', branch: 1 });
    A.place(doc, 'nc', { key: 'QA2', branch: 1 });
    A.place(doc, 'coil', { key: 'QA1', branch: 1 });
    A.place(doc, 'btnNo', { key: 'SF2', branch: 2, align: 'SF1' });
    A.place(doc, 'nc', { key: 'QA1', branch: 2 });
    A.place(doc, 'coil', { key: 'QA2', branch: 2 });

    var r = A.wireNodes(doc, [
      { name: 'L', pins: ['SF1#0', 'SF2#0'] },
      { name: 'A1', pins: ['SF1#1', 'nc:QA2#0'] },
      { name: 'A2', pins: ['nc:QA2#1', 'coil:QA1#0'] },
      { name: 'B1', pins: ['SF2#1', 'nc:QA1#0'] },
      { name: 'B2', pins: ['nc:QA1#1', 'coil:QA2#0'] },
      { name: 'N', pins: ['coil:QA1#1', 'coil:QA2#1'] }
    ]);
    doc.title = '互锁控制';
    if (!r.ok) {
      var bad = r.nodes.filter(function (n) { return !n.ok; })
        .map(function (n) { return n.node + '（' + n.error + '）'; }).join('；');
      return fail('interlock', doc.title, '互锁画好了，但有几根线没接上：' + bad);
    }
    return {
      ok: true, kind: 'interlock', title: doc.title,
      reply: '互锁画好了：SF1 和 SF2 各自串一个对方的常闭触点（nc:QA2 / nc:QA1），' +
        '两个线圈不会同时吸合。这是纯互锁，不含主电路和自锁 —— ' +
        '要正反转（换相序驱动电机）跟我说“画正反转”。'
    };
  }

  /* ---------------- 正反转（可关互锁 / 自锁） ---------------- */
  function reverse(doc, opts) {
    var A = api();
    if (!A) return fail('reverse', '', '画板 API 未加载');
    opts = opts || {};
    var lock = opts.interlock !== false;
    var self = opts.selflock !== false;
    A.clear(doc);

    A.place(doc, 'btnNo', { key: 'SF1', branch: 1 });
    if (lock) A.place(doc, 'nc', { key: 'QA2', branch: 1 });
    A.place(doc, 'coil', { key: 'QA1', branch: 1 });
    if (self) A.place(doc, 'no', { key: 'QA1', branch: 2, align: 'SF1' });

    A.place(doc, 'btnNo', { key: 'SF2', branch: 3 });
    if (lock) A.place(doc, 'nc', { key: 'QA1', branch: 3 });
    A.place(doc, 'coil', { key: 'QA2', branch: 3 });
    if (self) A.place(doc, 'no', { key: 'QA2', branch: 4, align: 'SF2' });

    var L = ['SF1#0', 'SF2#0'];
    if (self) L.push('no:QA1#0', 'no:QA2#0');

    var A1 = ['SF1#1'];
    if (self) A1.push('no:QA1#1');
    if (lock) A1.push('nc:QA2#0'); else A1.push('coil:QA1#0');

    var B1 = ['SF2#1'];
    if (self) B1.push('no:QA2#1');
    if (lock) B1.push('nc:QA1#0'); else B1.push('coil:QA2#0');

    var nodes = [{ name: 'L', pins: L }, { name: 'A1', pins: A1 }];
    if (lock) nodes.push({ name: 'A2', pins: ['nc:QA2#1', 'coil:QA1#0'] });
    nodes.push({ name: 'B1', pins: B1 });
    if (lock) nodes.push({ name: 'B2', pins: ['nc:QA1#1', 'coil:QA2#0'] });
    nodes.push({ name: 'N', pins: ['coil:QA1#1', 'coil:QA2#1'] });

    var r = A.wireNodes(doc, nodes);
    doc.title = '正反转控制' + (lock ? '' : '（不带互锁）') + (self ? '' : '（不带自锁）');
    if (!r.ok) {
      var bad = r.nodes.filter(function (n) { return !n.ok; })
        .map(function (n) { return n.node + '（' + n.error + '）'; }).join('；');
      return fail('reverse', doc.title, '正反转画好了，但有几根线没接上：' + bad);
    }

    var msg = '正反转画好了：SF1 正转、SF2 反转';
    msg += lock ? '，各串对方的常闭触点做互锁（正转时不能反转）' : '，按你的要求没有串互锁';
    msg += self ? '，自锁触点并联在按钮两端' : '，没有加自锁触点';
    msg += '，正转和反转两个回路已接好。';
    if (!lock) {
      msg += '\n注意：没有互锁时两个接触器可能同时吸合，造成相间短路，实际接线必须加互锁。';
    }
    return { ok: true, kind: 'reverse', title: doc.title, reply: msg };
  }

  var T = {
    jog: jog,
    selflock: selflock,
    interlock: interlock,
    reverse: reverse,
    build: function (doc, opts) {
      opts = opts || {};
      var kind = opts.kind;
      if (kind === 'jog' || kind === 'selflock' || kind === 'interlock' || kind === 'reverse') {
        return T[kind](doc, opts);
      }
      var msg = '没有这种模板：' + (kind || '（空）');
      return { ok: false, kind: kind || null, reply: msg, error: msg };
    }
  };

  return T;
});
