/* ============================================================
   plc-atlas · 接线助手 (PLCAdvisor)
   ------------------------------------------------------------
   作图时的实时陪练：把画布解析成"网表图"，再跑电气规则和
   电路意图模板，给出「哪里没接 / 哪里错了 / 下一步该放什么」。

   注意：这里不走图像识别，也不训练模型 —— 画板里的元件、
   引脚、导线本来就是结构化数据，直接建图是确定性的，毫秒级
   而且 100% 可解释。大模型只在需要"用自然语言解释"时兜底。
   ============================================================ */
(function (global) {
  'use strict';

  var M = global.PLCEditorModel;
  if (!M) return;

  /* ---------- 并查集：把所有导体合成 net ---------- */
  function Net() {
    this.parent = {};
    this.nodes = {};
  }
  Net.prototype.find = function (k) {
    if (this.parent[k] === undefined) { this.parent[k] = k; return k; }
    var p = this.parent[k];
    if (p === k) return k;
    var r = this.find(p);
    this.parent[k] = r;
    return r;
  };
  Net.prototype.union = function (a, b) {
    var ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  };
  Net.prototype.touch = function (k, info) {
    this.find(k);
    this.nodes[k] = this.nodes[k] || [];
    if (info) this.nodes[k].push(info);
    return k;
  };

  function pkey(x, y) {
    return (Math.round(x * 2) / 2) + ',' + (Math.round(y * 2) / 2);
  }

  /* ---------- 建网表 ---------- */
  function buildNets(doc) {
    var net = new Net();
    var w = 0, i, j;

    // 1) 每条导线内部是连续导体：所有顶点同 net
    var wires = [];
    doc.wires.forEach(function (wd) {
      var pts = wd.pts || [];
      if (pts.length < 2) return;
      var keys = pts.map(function (p) { return pkey(p[0], p[1]); });
      for (i = 1; i < keys.length; i++) net.union(keys[0], keys[i]);
      wires.push({ ref: wd, keys: keys, pts: pts });
    });

    // 2) T 接：某条导线的端点落在另一条导线的线段中间 → 连通
    //    （两线交叉但都不在端点 = 不连通，这是电路图的语义，不能连）
    wires.forEach(function (a) {
      [a.pts[0], a.pts[a.pts.length - 1]].forEach(function (p) {
        var ka = pkey(p[0], p[1]);
        wires.forEach(function (b) {
          if (a === b) return;
          for (var s = 0; s < b.pts.length - 1; s++) {
            if (M.onSeg(b.pts[s], b.pts[s + 1], p[0], p[1])) {
              net.union(ka, b.keys[s]);
              return;
            }
          }
        });
      });
    });

    // 3) 元件引脚、接点端子挂到 net 上
    var pins = [];
    doc.comps.forEach(function (c) {
      M.pinsOfComp(c).forEach(function (pt, idx) {
        var k = pkey(pt[0], pt[1]);
        net.touch(k, { kind: 'pin', c: c, i: idx });
        pins.push({ c: c, i: idx, x: pt[0], y: pt[1], key: k });
      });
    });
    doc.marks.forEach(function (m) {
      net.touch(pkey(m.x, m.y), { kind: 'mark', m: m });
    });

    // 4) 引脚压在导线中段也算接上（教材图常见）
    pins.forEach(function (p) {
      if (!net.nodes[p.key] || !net.nodes[p.key].length) return;
      wires.forEach(function (b) {
        for (var s = 0; s < b.pts.length - 1; s++) {
          if (M.onSeg(b.pts[s], b.pts[s + 1], p.x, p.y)) { net.union(p.key, b.keys[s]); return; }
        }
      });
    });

    // 汇总：root -> { pins, marks, wires, keys }
    var groups = {};
    function addTo(k) {
      var r = net.find(k);
      if (!groups[r]) groups[r] = { pins: [], marks: [], wires: [], keys: [] };
      groups[r].keys.push(k);
      (net.nodes[k] || []).forEach(function (o) {
        if (o.kind === 'pin') groups[r].pins.push(o);
        else groups[r].marks.push(o);
      });
      return groups[r];
    }
    Object.keys(net.nodes).forEach(addTo);
    wires.forEach(function (a) {
      var r = net.find(a.keys[0]);
      if (groups[r] && groups[r].wires.indexOf(a.ref) < 0) groups[r].wires.push(a.ref);
    });

    return { net: net, groups: groups, pins: pins, wires: wires };
  }

  /* ---------- 元件分类 ---------- */
  // 这些元件必须有完整的往返回路（线圈得电靠两端）
  var COILISH = { coil: 1, kCoil: 1, ktCoil: 1, solenoid: 1, lamp: 1, bell: 1, led: 1 };
  var PROTECT = { fuse: 1, fuse3: 1, fuseH: 1, thermal: 1, breaker: 1 };
  var CONTACT = { no: 1, nc: 1, btnNo: 1, btnNc: 1, btnStop: 1, limit: 1, prox: 1, contactor3: 1 };
  // 只有接触器的辅助触点/主触点才必须"有同名线圈"；按钮、行程开关本身就是操作件，不需要
  var NEED_COIL = { no: 1, nc: 1, contactor3: 1 };
  var MAIN = { motor: 1, contactor3: 1, thermal: 1, fuse3: 1, breaker: 1, switch3: 1 };

  // "可能导通"的路径分析里，开关/触点/保护件算导体。
  // 只判断"有没有可能形成回路"，不判断开关当前状态。
  var CONDUCTIVE = {
    no: 1, nc: 1, btnNo: 1, btnNc: 1, btnStop: 1, limit: 1, prox: 1, sw: 1,
    fuse: 1, fuse3: 1, fuseH: 1, thermal: 1, breaker: 1, switch3: 1, contactor3: 1
  };

  // 代号前缀判断：SF/SB/SQ 这类是"人去操作"的元件，不该有同名线圈。
  // 图集里的按钮也是按 no 类型画的，只能靠代号区分，没法只看类型。
  function isOperator(key) {
    return /^(SF|SB|SQ|SA|SE|ST|SL)/i.test(String(key || ''));
  }

  function tn(c) { return (M.TYPES[c.type] || {}).name || c.type; }

  /* ---------- 断号：元件是否每一个引脚都接上了 ---------- */
  function isLoose(info, pinKey, groups, net) {
    var r = net.find(pinKey);
    var g = groups[r];
    if (!g) return true;
    return g.wires.length === 0;   // 该 net 上一根导线都没有 → 这个脚没接
  }

  /* ---------- 电路意图模板 ---------- */
  function detectIntent(comps) {
    var n = { btnNo: 0, btnNc: 0, btnStop: 0, coil: 0, kCoil: 0, ktCoil: 0, motor: 0, contactor3: 0, thermal: 0, no: 0, nc: 0 };
    comps.forEach(function (c) { if (n[c.type] !== undefined) n[c.type]++; });

    if (n.ktCoil >= 1 && n.coil >= 2) {
      return { key: 'yd', name: '星三角 / 降压启动', color: '#7A5BC9' };
    }
    if (n.coil >= 2 && n.btnNo >= 2) {
      return { key: 'rev', name: '正反转控制', color: '#C9793B' };
    }
    // 两地/多地控制：一个线圈 + 两个常闭停止 + 三个常开（两地启动 + 自锁）
    if (n.coil === 1 && n.nc >= 2 && n.no >= 3) {
      return { key: 'remote', name: '两地控制', color: '#2E7D5B' };
    }
    if (n.coil === 1 && (n.btnNo >= 1 || n.btnNc >= 1)) {
      var lock = comps.some(function (c) { return c.type === 'no'; });
      if (lock) return { key: 'selflock', name: '起保停（自锁）', color: '#2E7D5B' };
      return { key: 'jog', name: '点动控制', color: '#2E7D5B' };
    }
    if (n.coil >= 1) return { key: 'coil', name: '线圈驱动回路', color: '#2E7D5B' };
    if (n.btnNo || n.btnNc) return { key: 'draft', name: '控制回路（起步）', color: '#6B7178' };
    return null;
  }

  /* ---------- 主分析 ---------- */
  function analyze(doc) {
    var issues = [];
    if (!doc || !doc.comps) return { issues: issues, intent: null, nets: 0, ok: true };

    var built = buildNets(doc);
    var net = built.net, groups = built.groups;

    function push(level, code, msg, target) {
      issues.push({ level: level, code: code, msg: msg, target: target || null });
    }

    var comps = doc.comps.filter(function (c) { return M.TYPES[c.type]; });

    /* --- 1. 引脚悬空 --- */
    var loose = [];
    built.pins.forEach(function (p) {
      // 三相电机下端本来就不一定接线（星形/三角形在内部接好），只要求进线端接上
      if (p.c.type === 'motor' && p.i > 0) return;
      var g = groups[net.find(p.key)];
      if (!g || g.wires.length === 0) loose.push(p);
    });
    // 按元件聚合，一个元件只报一次
    var looseBy = {};
    loose.forEach(function (p) {
      var k = p.c.id;
      looseBy[k] = looseBy[k] || { c: p.c, idx: [] };
      looseBy[k].idx.push(p.i);
    });
    Object.keys(looseBy).forEach(function (k) {
      var o = looseBy[k];
      var c = o.c;
      var label = c.key || tn(c);
      if (M.pinsOfComp(c).length <= 1) return;   // 单脚元件（接地）不算没接
      var all = o.idx.length === M.pinsOfComp(c).length;
      // 线圈类只缺一端时交给第 6 条统一说，避免同一件事报两遍
      if (COILISH[c.type] && !all) return;
      push(all ? 'warn' : 'info', 'loose',
        label + ' ' + (all ? '还没接线' : '有一端还没接'),
        { kind: 'comp', id: c.id });
    });

    /* --- 2. 元件两端被同一根线短接 --- */
    comps.forEach(function (c) {
      var pins = M.pinsOfComp(c);
      if (pins.length < 2) return;
      var r0 = net.find(pkey(pins[0][0], pins[0][1]));
      var same = true;
      for (var i = 1; i < pins.length; i++) {
        if (net.find(pkey(pins[i][0], pins[i][1])) !== r0) { same = false; break; }
      }
      if (same) {
        var g = groups[r0];
        if (g && g.wires.length > 0) {
          push('error', 'short',
            (c.key || tn(c)) + ' 两端被接在同一根线上，等于短路',
            { kind: 'comp', id: c.id });
        }
      }
    });

    /* --- 3. 导线线头没接东西 --- */
    var dangling = 0, firstDangling = null;
    built.wires.forEach(function (a) {
      [a.pts[0], a.pts[a.pts.length - 1]].forEach(function (p) {
        var g = groups[net.find(pkey(p[0], p[1]))];
        if (!g) return;
        if (g.pins.length === 0 && g.marks.length === 0) {
          // 这个 net 上一个元件脚都没有 → 线头空着
          if (g.wires.length === 1) {
            dangling++;
            if (!firstDangling) firstDangling = a.ref.id;
          }
        }
      });
    });
    if (dangling > 0) {
      push('warn', 'dangling',
        '有 ' + dangling + ' 处线头没有接到元件，检查一下是不是漏接',
        firstDangling ? { kind: 'wire', id: firstDangling } : null);
    }

    /* --- 4. 线圈类元件只有一端接通 --- */
    comps.forEach(function (c) {
      if (!COILISH[c.type]) return;
      var pins = M.pinsOfComp(c);
      if (pins.length < 2) return;
      var g0 = groups[net.find(pkey(pins[0][0], pins[0][1]))];
      var g1 = groups[net.find(pkey(pins[1][0], pins[1][1]))];
      var ok0 = g0 && g0.wires.length > 0;
      var ok1 = g1 && g1.wires.length > 0;
      if (!ok0 && !ok1) return;             // 完全没接，前面已经报过
      if (!ok0 || !ok1) {
        push('warn', 'half',
          (c.key || tn(c)) + ' 只接了一端，另一端悬空，回路不通',
          { kind: 'comp', id: c.id });
      }
    });

    /* --- 5. 代号对不上（触点有、线圈没有，或反过来） --- */
    var coils = {}, contacts = {};
    comps.forEach(function (c) {
      var k = (c.key || '').trim();
      if (!k) return;
      if (COILISH[c.type]) coils[k] = (coils[k] || 0) + 1;
      if (NEED_COIL[c.type] && !isOperator(k)) contacts[k] = (contacts[k] || 0) + 1;
    });
    // 先判断这是不是“主电路单独成图”：图上有电机/主触点/主电路保护，
    // 但整张图一个线圈都没有。星三角、正反转主电路都是这么画的，
    // 线圈在另一张控制图上，不能把“本图没有线圈”判成漏画。
    //
    // 边界很重要：只有“一个线圈都没有”才跳过。一旦图里有线圈，
    // 就说明这是控制图或混合图，某个触点找不到同代号线圈仍然是
    // 真漏画，必须保持 error。不要把这条规则简化成“有主元件就放过”。
    var hasMainPart = comps.some(function (c) {
      return c.type === 'motor' || c.type === 'contactor3' ||
             c.type === 'fuse3' || c.type === 'switch3';
    });
    var mainOnly = hasMainPart && Object.keys(coils).length === 0;

    if (mainOnly) {
      push('info', 'coil-offsheet',
        '这是一张主电路图，接触器线圈不在本图（在控制回路那张）', null);
    } else {
      Object.keys(contacts).forEach(function (k) {
        if (!coils[k]) {
          push('error', 'keyless',
            '触点是 ' + k + '，但图上没有 ' + k + ' 的线圈，按下不会动作',
            null);
        }
      });
    }
    Object.keys(coils).forEach(function (k) {
      if (!contacts[k]) {
        push('info', 'nocontact',
          coils[k] + ' 个 ' + k + ' 线圈没有对应的触点，暂时只通电不动作',
          null);
      }
    });

    /* --- 6. 主电路缺保护 --- */
    var hasMotor = comps.some(function (c) { return c.type === 'motor'; });
    var hasFuse = comps.some(function (c) { return c.type === 'fuse' || c.type === 'fuse3' || c.type === 'fuseH'; });
    var hasThermal = comps.some(function (c) { return c.type === 'thermal'; });
    if (hasMotor && !hasFuse) {
      push('warn', 'nofuse', '有电机但没看到熔断器，主电路缺短路保护', null);
    }
    if (hasMotor && !hasThermal) {
      push('info', 'nothermal', '有电机但没看到热继电器，长时间过载没有保护', null);
    }

    /* --- 7. 未命名元件 --- */
    var unnamed = comps.filter(function (c) { return !c.key && c.type !== 'motor' && c.type !== 'plcBox'; });
    if (unnamed.length && comps.length > unnamed.length) {
      push('info', 'unnamed',
        '还有 ' + unnamed.length + ' 个元件没代号（代号联动靠它识别，方便的话补上）', null);
    }

    /* --- 8. 电源端子 / 回路闭合 ---
       线圈两端必须能沿导线和可导通元件走到 term 标记。
       只做“可能性”判断：按钮/触点算可导通，不判断当前状态。 */
    var terms = doc.marks.filter(function (m) { return m.kind === 'term'; });
    var coilsMissing = [];
    var hasCoil = comps.some(function (c) { return COILISH[c.type]; });
    if (hasCoil) {
      if (!terms.length) {
        push('info', 'power',
          '图上没有电源端子，无法判断线圈回路是否闭合', null);
      } else {
        var reachedTerm = function (startKey) {
          var seen = {}, q = [startKey];
          while (q.length) {
            var k = q.shift();
            if (seen[k]) continue;
            seen[k] = true;
            var g = groups[net.find(k)];
            if (!g) continue;
            if (g.marks.some(function (o) { return o.m.kind === 'term'; })) return true;
            g.keys.forEach(function (x) { if (!seen[x]) q.push(x); });
            g.pins.forEach(function (p) {
              if (!CONDUCTIVE[p.c.type]) return;
              var ps = M.pinsOfComp(p.c);
              if (ps.length === 2) {
                var other = p.i === 0 ? 1 : 0;
                q.push(pkey(ps[other][0], ps[other][1]));
              } else if (ps.length > 1) {
                var pair = p.i % 2 === 0 ? p.i + 1 : p.i - 1;
                if (ps[pair]) q.push(pkey(ps[pair][0], ps[pair][1]));
              }
            });
          }
          return false;
        };

        comps.forEach(function (c) {
          if (!COILISH[c.type]) return;
          var ps = M.pinsOfComp(c);
          if (ps.length < 2) return;
          var k0 = pkey(ps[0][0], ps[0][1]);
          var k1 = pkey(ps[1][0], ps[1][1]);
          var g0 = groups[net.find(k0)];
          var g1 = groups[net.find(k1)];
          // 完全没接的线圈交给前面的"悬空/只接一端"规则，不重复报
          if (!g0 || !g1 || !g0.wires.length || !g1.wires.length) return;
          if (!reachedTerm(k0) || !reachedTerm(k1)) {
            coilsMissing.push(c.key || tn(c));
          }
        });
        if (coilsMissing.length) {
          push('warn', 'power',
            coilsMissing.join('、') + ' 的线圈回路没有回到电源（缺 L 或 N 端子）', null);
        }
      }
    }
    var power = { terminals: terms.length, coilsMissing: coilsMissing.length };

    /* --- 9. 意图模板：缺什么 --- */
    var intent = detectIntent(comps);
    if (intent && intent.key === 'jog') {
      var hasNo = comps.some(function (c) { return c.type === 'no'; });
      if (!hasNo) {
        push('info', 'suggest',
          '想做成"起保停"的话，再加一个与线圈同名的常开触点并联在按钮上就能自锁',
          null);
      }
    }
    if (intent && intent.key === 'rev') {
      var ncs = comps.filter(function (c) { return c.type === 'nc'; }).length;
      if (ncs < 2) {
        push('info', 'suggest',
          '正反转要两个常闭触点互锁，否则同时按下会短路',
          null);
      }
    }

    // 同样的提示只说一次（同代号的多极元件会重复触发）
    var seen = {};
    issues = issues.filter(function (it) {
      if (seen[it.msg]) return false;
      seen[it.msg] = 1;
      return true;
    });

    // 排序：错误 > 提醒 > 提示
    var rank = { error: 0, warn: 1, info: 2 };
    issues.sort(function (a, b) { return rank[a.level] - rank[b.level]; });

    var hasErr = issues.some(function (x) { return x.level === 'error'; });
    var hasWarn = issues.some(function (x) { return x.level === 'warn'; });

    return {
      issues: issues,
      intent: intent,
      nets: Object.keys(groups).length,
      level: hasErr ? 'error' : (hasWarn ? 'warn' : 'ok'),
      ok: !hasErr,
      power: power
    };
  }

  global.PLCAdvisor = {
    analyze: analyze,
    buildNets: buildNets,
    detectIntent: detectIntent
  };
})(window);
