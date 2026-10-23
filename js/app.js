/* ============================================================
   app.js — 交互层
   ============================================================ */
(function () {
  'use strict';

  var CC = window.PLCCircuits;
  var SY = window.PLCSym;

  var state = { id: null, scene: 0, playing: false, view: 'all', zoom: 1, q: '', timer: null };
  var ZOOMS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
  var ZOOM_I = 4;

  var CHAPTER_CATS = 6;   // 第 1 章规划的电路分类总数

  var CODES = [
    ['QA', '交流接触器'],
    ['SF', '按钮开关'],
    ['FA', '熔断器'],
    ['BB', '热继电器'],
    ['QB', '隔离开关'],
    ['M', '三相异步电动机']
  ];

  function $(s) { return document.querySelector(s); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function byId(id) {
    for (var i = 0; i < CC.list.length; i++) if (CC.list[i].id === id) return CC.list[i];
    return null;
  }

  /* ---------------- 左栏 ---------------- */
  function renderCatalog() {
    var host = $('#catalog');
    var q = state.q.trim().toLowerCase();
    var html = '';
    var shown = 0;

    CC.cats.forEach(function (cat) {
      var items = CC.list.filter(function (c) {
        if (c.cat !== cat.id) return false;
        if (!q) return true;
        return (c.title + ' ' + c.no + ' ' + c.tags.join(' ')).toLowerCase().indexOf(q) >= 0;
      });
      if (!items.length) return;
      shown += items.length;

      html += '<div class="cat"><div class="cat-name"><span>' + cat.name +
        '</span><span class="cat-count">' + pad(items.length) + '</span></div>';
      items.forEach(function (c) {
        html += '<button class="nav-item' + (c.id === state.id ? ' active' : '') +
          '" data-id="' + c.id + '"><span class="nav-no">' + c.no +
          '</span><span class="nav-t">' + c.title + '</span></button>';
      });
      html += '</div>';
    });

    if (!shown) {
      html = '<div class="side-empty">没有匹配的电路。试试「正反转」或「1-12」。</div>';
    }
    host.innerHTML = html;
  }

  function renderCodes() {
    $('#codes').innerHTML = CODES.map(function (r) {
      return '<div class="code-row"><span class="code-k">' + r[0] +
        '</span><span class="code-v">' + r[1] + '</span></div>';
    }).join('');
  }

  function renderProgress() {
    var pct = Math.round(CC.cats.length / CHAPTER_CATS * 100);
    $('#pcFill').style.width = pct + '%';
    $('#pcMeta').textContent = CC.cats.length + ' / ' + CHAPTER_CATS +
      ' 个分类已收录　·　' + CC.list.length + ' 张图纸';
  }

  /* ---------------- 中栏 ---------------- */
  function select(id) {
    var c = byId(id);
    if (!c) return;
    stop();
    state.id = id;
    state.scene = 0;
    state.view = 'all';

    var S = new SY.Sheet(c.w, c.h);
    c.draw(S);
    $('#sheetInner').innerHTML = S.build();

    var idx = CC.list.indexOf(c);
    $('#eyebrow').textContent = c.tags.join(' · ') + '　·　图 ' + c.no;
    $('#title').textContent = c.title;
    $('#meta').textContent = c.meta;
    $('#capLeft').textContent = '图 ' + c.no + '　' + c.title + '　·　符号依据 GB/T 4728';
    $('#capRight').textContent = pad(idx + 1) + ' / ' + pad(CC.list.length);

    renderSteps(c);
    renderCallout(c);
    renderRelated(c);
    renderInfo(c);
    renderCatalog();

    syncViewButtons();
    applyView();
    applyZoom();
    applyScene(0);
  }

  function renderSteps(c) {
    $('#steps').innerHTML = c.scenes.map(function (sc, i) {
      return '<li class="step" data-i="' + i + '">' +
        '<span class="step-no">' + (i + 1) + '</span>' +
        '<div class="step-main"><div class="step-t">' + sc.label + '</div>' +
        '<div class="step-d">' + sc.desc + '</div></div></li>';
    }).join('');
  }

  function renderCallout(c) {
    $('#callout').innerHTML = '<div class="callout-title">' + c.note.title +
      '</div><div class="callout-body">' + c.note.body + '</div>';
  }

  function renderRelated(c) {
    var sibs = CC.list.filter(function (x) { return x.cat === c.cat && x.id !== c.id; });
    if (!sibs.length) {
      $('#related').innerHTML = '<li class="side-empty">本章节暂无其他电路。</li>';
      return;
    }
    $('#related').innerHTML = sibs.map(function (x) {
      return '<li><button data-id="' + x.id + '"><span class="r-no">' + x.no +
        '</span><span class="r-t">' + x.title + '</span></button></li>';
    }).join('');
  }

  function renderInfo(c) {
    var catName = (CC.cats.filter(function (k) { return k.id === c.cat; })[0] || {}).name || '—';
    var rows = [
      ['图号', c.no],
      ['比例', c.ratio],
      ['依据', 'GB/T 4728 · GB/T 5094'],
      ['分类', catName]
    ];
    $('#info').innerHTML = rows.map(function (r) {
      return '<div class="info-row"><span class="info-k">' + r[0] +
        '</span><span class="info-v">' + r[1] + '</span></div>';
    }).join('');
  }

  /* ---------------- 场景状态 ---------------- */
  function applyScene(i) {
    var c = byId(state.id);
    if (!c) return;
    i = Math.max(0, Math.min(c.scenes.length - 1, i));
    state.scene = i;
    var sc = c.scenes[i];

    var on = {};
    sc.on.forEach(function (k) { on[k] = true; });

    var svg = $('#sheetInner svg');
    if (svg) {
      var nodes = svg.querySelectorAll('[data-key]');
      for (var k = 0; k < nodes.length; k++) {
        nodes[k].classList.toggle('on', !!on[nodes[k].getAttribute('data-key')]);
      }
    }

    $('#statusText').textContent = sc.status;
    $('#statusChip').classList.toggle('running', !!sc.running);

    var steps = document.querySelectorAll('.step');
    for (var j = 0; j < steps.length; j++) {
      steps[j].classList.toggle('active', j === i);
    }
  }

  function play() {
    if (state.playing) { stop(); return; }
    var c = byId(state.id);
    if (!c || c.scenes.length < 2) return;
    state.playing = true;
    $('#btnDemo').textContent = '暂停演示';
    $('#btnDemo').classList.add('playing');
    applyScene(0);
    state.timer = setInterval(function () {
      if (state.scene >= c.scenes.length - 1) { stop(); return; }
      applyScene(state.scene + 1);
    }, 2200);
  }

  function stop() {
    state.playing = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    var b = $('#btnDemo');
    b.textContent = '动作演示';
    b.classList.remove('playing');
  }

  /* ---------------- 视图 / 缩放 ---------------- */
  function syncViewButtons() {
    var items = document.querySelectorAll('.seg-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-view') === state.view);
    }
  }

  function applyView() {
    var c = byId(state.id);
    var svg = $('#sheetInner svg');
    if (!svg || !c) return;
    var split = c.split || 275;

    var grps = svg.querySelectorAll('.grp');
    for (var i = 0; i < grps.length; i++) {
      var k = grps[i].getAttribute('data-grp');
      grps[i].style.display = (state.view === 'all' || k === state.view) ? '' : 'none';
    }

    if (state.view === 'main') svg.setAttribute('viewBox', '0 0 ' + split + ' ' + c.h);
    else if (state.view === 'ctrl') svg.setAttribute('viewBox', split + ' 0 ' + (c.w - split) + ' ' + c.h);
    else svg.setAttribute('viewBox', '0 0 ' + c.w + ' ' + c.h);
  }

  function applyZoom() {
    var svg = $('#sheetInner svg');
    if (svg) svg.style.transform = 'scale(' + state.zoom + ')';
    $('#zoomVal').textContent = Math.round(state.zoom * 100) + '%';
  }

  function zoomBy(d) {
    ZOOM_I = Math.max(0, Math.min(ZOOMS.length - 1, ZOOM_I + d));
    state.zoom = ZOOMS[ZOOM_I];
    applyZoom();
  }

  /* ---------------- 导出 ---------------- */
  var EXPORT_CSS = [
    '.wire{stroke:#1A1C1F;stroke-width:1.7;fill:none;stroke-linecap:square}',
    '.tick,.ncmk{stroke:#1A1C1F;stroke-width:1.7;stroke-linecap:round}',
    '.blade{stroke:#1A1C1F;stroke-width:1.7;stroke-linecap:round}',
    '.contact[data-kind="no"] .blade{transform:rotate(26deg)}',
    '.contact[data-kind="nc"] .blade{transform:rotate(8deg)}',
    '.contact[data-flip="1"][data-kind="no"] .blade{transform:rotate(-26deg)}',
    '.contact[data-flip="1"][data-kind="nc"] .blade{transform:rotate(-8deg)}',
    '.dash{stroke:#8A8E96;stroke-width:1.2;stroke-dasharray:4 3;fill:none}',
    '.divider{stroke:#C9CBD1;stroke-width:1.2;stroke-dasharray:6 5;fill:none}',
    '.junc{fill:#1A1C1F}',
    '.term{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.6}',
    '.fuse rect{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.6}',
    '.coil rect{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.6}',
    '.motor .body{fill:#FFFFFF;stroke:#1A1C1F;stroke-width:1.9}',
    '.motor .ring{fill:none;stroke:#2447C9;stroke-width:1.5;stroke-dasharray:4 6;opacity:0}'
  ].join('');

  function exportSvg() {
    var c = byId(state.id);
    var svg = $('#sheetInner svg');
    if (!svg || !c) return;

    var clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', c.w);
    clone.setAttribute('height', c.h);
    clone.removeAttribute('style');

    var grps = clone.querySelectorAll('.grp');
    for (var i = 0; i < grps.length; i++) grps[i].style.display = '';

    var ons = clone.querySelectorAll('.on');
    for (var j = 0; j < ons.length; j++) ons[j].classList.remove('on');

    var st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = EXPORT_CSS;
    clone.insertBefore(st, clone.firstChild);

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(clone);
    var blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'PLC-' + c.no + '-' + c.title + '.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('#catalog').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-item');
      if (b) select(b.getAttribute('data-id'));
    });

    $('#related').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]');
      if (b) select(b.getAttribute('data-id'));
    });

    $('#steps').addEventListener('click', function (e) {
      var li = e.target.closest('.step');
      if (!li) return;
      stop();
      applyScene(parseInt(li.getAttribute('data-i'), 10));
    });

    $('#segView').addEventListener('click', function (e) {
      var b = e.target.closest('.seg-item');
      if (!b) return;
      state.view = b.getAttribute('data-view');
      syncViewButtons();
      applyView();
    });

    $('#btnDemo').addEventListener('click', play);
    $('#btnTpl').addEventListener('click', function () {
      if (window.PLCEditor) window.PLCEditor.openTemplate(state.id);
    });
    $('#btnExport').addEventListener('click', exportSvg);
    $('#btnExportTop').addEventListener('click', function () {
      if (document.body.getAttribute('data-mode') === 'draw' && window.PLCEditor) {
        window.PLCEditor.exportSvg();
        return;
      }
      exportSvg();
    });
    $('#btnPrint').addEventListener('click', function () { window.print(); });
    $('#zoomIn').addEventListener('click', function () { zoomBy(1); });
    $('#zoomOut').addEventListener('click', function () { zoomBy(-1); });
    $('#btnFit').addEventListener('click', function () {
      ZOOM_I = 4; state.zoom = 1; applyZoom();
    });

    $('#searchInput').addEventListener('input', function (e) {
      state.q = e.target.value;
      renderCatalog();
    });

    document.addEventListener('keydown', function (e) {
      if (document.body.getAttribute('data-mode') === 'draw') return;
      if (e.target && e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') { stop(); applyScene(state.scene + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { stop(); applyScene(state.scene - 1); e.preventDefault(); }
      else if (e.key === ' ' && e.target.tagName !== 'BUTTON') { play(); e.preventDefault(); }
    });
  }

  /* ---------------- 对外 ---------------- */
  window.PLCAtlas = {
    select: select,
    currentId: function () { return state.id; }
  };

  /* ---------------- 启动 ---------------- */
  renderCodes();
  renderProgress();
  bind();
  select('rev-double');
})();
