/*
 * Teacup view (#/teacup): basin teacup overview of all 8 lakes + per-lake elevation ruler,
 * 30-year statistics band, annual chart and published interim-ops / injunction targets.
 *
 * Data:
 *   LIVE       pool elevation, storage, rule curve today — shared by js/app.js via HYDRO.live
 *              (not refetched here).
 *   PUBLISHED  CWMS location levels (structural elevations, 30-yr stats, targets) via
 *              HYDRO.levels (lazy, cached 24 h); full-year rule curve (CWMS daily series).
 *   DERIVED    % full, delta vs rule curve, status colours — computed here.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO, LV = H.levels, T = H.teacupCore;
  H.views = H.views || {};

  var TZ = 'America/Los_Angeles';
  var DAY = 24 * 3600 * 1000;
  var ORDER = ['LOP', 'HCR', 'DEX', 'FAL', 'GPR', 'CGR', 'BLU', 'FRN', 'COT', 'DOR'];
  var INJUNCTION_URL = 'https://www.nwp.usace.army.mil/Locations/Willamette-Valley/Injunction/';
  var byCode = {};
  H.projects.forEach(function (p) { byCode[p.code] = p; });

  // Elevation targets drawn on the ruler/chart, per project. HCR publishes its seasonal
  // elevation measure as "Interim Risk Reduction Measure"; its interim-operations and
  // injunction targets are storage-only (listed as storage, not converted).
  var ELEV_TARGET = {
    LOP: { id: LV.IDS.injunctionTarget, label: 'Injunction target' },
    GPR: { id: LV.IDS.injunctionTarget, label: 'Injunction target' },
    CGR: { id: LV.IDS.injunctionTarget, label: 'Injunction target' },
    HCR: { id: LV.IDS.interimRisk, label: 'Interim Risk Reduction Measure' }
  };
  var STOR_TARGETS = {
    HCR: [{ id: 'Stor.Inst.0.Interim_Operations', label: 'Interim operations (storage)' },
      { id: 'Stor.Inst.0.Injunction-Target', label: 'Injunction target (storage)' }]
  };
  var RULER_LEVELS = [
    ['topDam', 'Top of dam'], ['topMaxFlood', 'Top of max flood'], ['topFlood', 'Top of flood'],
    ['topCons', 'Top of conservation'], ['spillwayCrest', 'Spillway crest'],
    ['bottomCons', 'Bottom of conservation'], ['streambed', 'Streambed']
  ];
  var POWER_LEVELS = [['topPower', 'Top of power pool'], ['bottomPower', 'Bottom of power pool']];
  var STATS = ['statsMin', 'statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95', 'statsMax'];

  var st = {
    el: null, sel: 'LOP',
    levels: {}, levelErr: {}, loading: {}
  };

  // ---- Formatting ------------------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmt(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function signed(n, d) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n), d); }
  var fStamp = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  var fDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
  var fDayY = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
  var fYear = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' });
  function stamp(t) { return fStamp.format(new Date(t)); }
  // "Nov 1" this year, "Mar 17, 2027" otherwise
  function changeDay(t) { return fYear.format(new Date(t)) === fYear.format(new Date()) ? fDay.format(new Date(t)) : fDayY.format(new Date(t)); }
  function na(txt) { return '<span class="na">' + (txt || 'no data') + '</span>'; }

  // ---- Data access ------------------------------------------------------------

  function liveOf(p) { var s = H.live && H.live.snap; return s ? s.projects[p.id] || {} : null; }

  function model(code) {
    var p = byCode[code], d = liveOf(p), lv = st.levels[code] || null, now = Date.now();
    var e = d && H.latest(d.elev), s = d && H.latest(d.stor), r = d && H.ruleToday(d.rule, now);
    var cons = p.cons || lv ? T.consLimits(lv, p, now) : null;
    var pf = cons && s ? T.percentFull(s.v, cons.storBottom, cons.storTop) : null;
    var pfFromElev = false;
    if (!pf && e && cons && cons.elevBottom != null && !p.noStorage) {
      // storage missing: elevation-based fraction, labelled as such
      var f = T.elevFraction(e.v, cons.elevBottom, cons.elevTop);
      pf = { pct: f * 100, clamped: f * 100, below: e.v < cons.elevBottom, above: e.v > cons.elevTop };
      pfFromElev = true;
    }
    var rd = T.ruleDelta(e ? e.v : null, r ? r.v : null, H.SETTINGS.ruleBelowFt, H.SETTINGS.ruleAboveFt);
    return { p: p, code: code, d: d, lv: lv, e: e, s: s, r: r, cons: cons, pf: pf, pfFromElev: pfFromElev, rd: rd, now: now };
  }

  // ---- Lazy loading -----------------------------------------------------------

  function loadLevels(code, force) {
    if (st.loading[code]) return st.loading[code];
    if (st.levels[code] && !force) return Promise.resolve(st.levels[code]);
    delete st.levelErr[code];
    var pr = LV.fetchProjectLevels(code, { force: !!force }).then(function (lv) {
      st.levels[code] = lv;
      return lv;
    }, function (err) {
      st.levelErr[code] = err.message || 'failed';
      return null;
    }).then(function (x) {
      delete st.loading[code];
      renderCups();
      if (code === st.sel) renderDetail();
      return x;
    });
    st.loading[code] = pr;
    if (code === st.sel) renderDetail();
    return pr;
  }

  // Selected lake first, the rest in the background, at most 3 requests at a time.
  function loadAllLevels() {
    var queue = [st.sel].concat(ORDER.filter(function (c) { return c !== st.sel; }));
    var next = function () {
      var c = queue.shift();
      if (!c) return Promise.resolve();
      return loadLevels(c).then(next);
    };
    for (var i = 0; i < 3; i++) next();
  }

  // ---- Cups --------------------------------------------------------------------

  var STATUS_TXT = { below: 'Below rule curve', near: 'Near rule curve', above: 'Above rule curve' };
  var STATUS_ICON = { below: '▼', near: '●', above: '▲' };

  function cupSVG(m) {
    var bottom = 88, top = 14, cls = m.rd.status || 'none';
    var s = '<svg class="cup-svg" viewBox="0 0 120 100" aria-hidden="true">';
    if (m.p.noStorage) {
      // Dexter: forebay elevation within its power-pool band — no conservation pool, no percent.
      var band = m.p.powerPool, fe = m.e ? T.elevFraction(m.e.v, band.elevBottom, band.elevTop) : null;
      s += '<rect class="cup-tube" x="44" y="' + top + '" width="32" height="' + (bottom - top) + '" rx="4"/>';
      if (fe != null) s += '<rect class="cup-water ' + cls + '" x="46" y="' + (bottom - fe * (bottom - top)).toFixed(1) + '" width="28" height="' + (fe * (bottom - top) - 2).toFixed(1) + '" rx="2"/>';
      if (m.r) {
        var rf = T.elevFraction(m.r.v, band.elevBottom, band.elevTop), ry = bottom - rf * (bottom - top);
        s += '<line class="cup-rule" x1="36" x2="84" y1="' + ry.toFixed(1) + '" y2="' + ry.toFixed(1) + '"/>';
      }
      s += '<text class="cup-scale" x="88" y="' + (top + 4) + '">' + band.elevTop + '</text><text class="cup-scale" x="88" y="' + bottom + '">' + band.elevBottom + '</text>';
      return s + '</svg>';
    }
    var clip = 'cupclip-' + m.code;
    var vessel = 'M10 ' + top + ' L110 ' + top + ' L94 ' + (bottom - 6) + ' Q92 ' + bottom + ' 84 ' + bottom + ' L36 ' + bottom + ' Q28 ' + bottom + ' 26 ' + (bottom - 6) + ' Z';
    s += '<defs><clipPath id="' + clip + '"><path d="' + vessel + '"/></clipPath></defs>';
    s += '<path class="cup-body" d="' + vessel + '"/>';
    var c = m.cons, f = m.e && c ? T.elevFraction(m.e.v, c.elevBottom, c.elevTop) : null;
    if (f != null && f > 0) {
      var wy = bottom - f * (bottom - top);
      s += '<rect class="cup-water ' + cls + '" clip-path="url(#' + clip + ')" x="0" y="' + wy.toFixed(1) + '" width="120" height="' + (bottom - wy + 2).toFixed(1) + '"/>';
      s += '<line class="cup-surface ' + cls + '" clip-path="url(#' + clip + ')" x1="0" x2="120" y1="' + wy.toFixed(1) + '" y2="' + wy.toFixed(1) + '"/>';
    }
    if (m.r && c) {
      var rfr = T.elevFraction(m.r.v, c.elevBottom, c.elevTop), ryy = bottom - rfr * (bottom - top);
      s += '<line class="cup-rule" x1="4" x2="116" y1="' + ryy.toFixed(1) + '" y2="' + ryy.toFixed(1) + '"/>';
    }
    if (m.pf && m.pf.below) s += '<path class="cup-below" d="M52 ' + (bottom + 3) + ' l8 7 l8 -7 z"/>';
    s += '<line class="cup-saucer" x1="18" x2="102" y1="' + (bottom + 10) + '" y2="' + (bottom + 10) + '"/>';
    return s + '</svg>';
  }

  function cupHTML(code) {
    var m = model(code), p = m.p, cls = m.rd.status || 'none';
    var pctTxt = p.noStorage ? '<span class="cup-pct na">n/a</span>'
      : !m.d ? '<span class="cup-pct na loading">…</span>'
        : !m.pf ? '<span class="cup-pct na">no data</span>'
          : m.pf.below ? '<span class="cup-pct below-txt">Below cons. pool</span>'
            : '<span class="cup-pct">' + fmt(m.pf.clamped, 1) + '<small>%</small></span>';
    var aria = p.name + ': pool ' + (m.e ? fmt(m.e.v, 1) + ' ft' : 'no data') + (m.rd.delta != null ? ', ' + signed(m.rd.delta, 1) + ' ft vs rule curve' : '') +
      (p.noStorage ? ', no conservation pool' : m.pf ? (m.pf.below ? ', below conservation pool' : ', ' + fmt(m.pf.clamped, 1) + ' percent full') : '');
    return '<button type="button" class="cup st-' + cls + (code === st.sel ? ' selected' : '') + '" data-code="' + code + '" aria-label="' + esc(aria) + '">' +
      '<span class="cup-name">' + esc(p.name) + '</span>' + cupSVG(m) + pctTxt +
      '<span class="cup-sub">' + (p.noStorage ? 'no conservation pool · forebay gauge' : (m.pfFromElev ? '% by elevation (no storage)' : '% full · DERIVED')) + '</span>' +
      '<span class="cup-row"><b>' + (m.e ? fmt(m.e.v, 1) : '—') + '</b> ft <span class="lbl">LIVE</span></span>' +
      '<span class="cup-row ' + cls + '-txt">' + (m.rd.delta != null ? STATUS_ICON[cls] + ' ' + signed(m.rd.delta, 1) + ' ft' : '— ft') + ' <span class="lbl">vs rule</span></span>' +
      '</button>';
  }

  function renderCups() {
    if (!st.el) return;
    var g = st.el.querySelector('#tc-grid');
    if (g) g.innerHTML = ORDER.map(cupHTML).join('');
  }

  // ---- Ruler --------------------------------------------------------------------

  function rulerSVG(m) {
    var lv = m.lv, now = m.now, W = 384, Ht = 560, top = 18, bottom = Ht - 20;
    var marks = [], missing = [];
    RULER_LEVELS.concat(m.p.noStorage ? POWER_LEVELS : []).forEach(function (k) {
      var v = LV.constantAt(lv, LV.IDS[k[0]], now);
      if (v == null) { if (RULER_LEVELS.indexOf(k) >= 0) missing.push(k[1].toLowerCase()); return; }
      marks.push({ key: k[0], label: k[1], v: v });
    });
    var stats = {};
    STATS.forEach(function (k) { stats[k] = LV.valueAt(lv, LV.IDS[k], now); });
    var hasStats = STATS.every(function (k) { return stats[k] != null; });
    var tgt = ELEV_TARGET[m.code], tEntry = tgt ? LV.pick(lv, tgt.id, now) : null, tVal = tEntry ? LV.evalSeasonal(tEntry, now) : null;

    var all = marks.map(function (x) { return x.v; });
    var floorMark = marks.filter(function (x) { return x.key === 'streambed'; })[0];
    var focusVals = marks.filter(function (x) { return x.key !== 'streambed'; }).map(function (x) { return x.v; });
    [m.e && m.e.v, m.r && m.r.v, tVal, hasStats ? stats.statsMin : null, hasStats ? stats.statsMax : null].forEach(function (v) { if (v != null) focusVals.push(v); });
    var hi = Math.max.apply(null, focusVals.concat(all)), lo = Math.min.apply(null, focusVals);
    var pad = (hi - lo) * 0.04 || 2;
    var sc = T.rulerScale({ hi: hi + pad, lo: lo - pad, floor: floorMark ? floorMark.v - pad / 2 : lo - pad, top: top, bottom: bottom });
    var y = sc.y, X0 = 50, XW = 108, XS0 = 114, XS1 = 134, XL = 168;

    var s = '<svg class="ruler" viewBox="0 0 ' + W + ' ' + Ht + '" role="img" aria-label="' + esc(m.p.name + ' elevation ruler') + '">';
    s += '<defs><linearGradient id="rl-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#39d0e0" stop-opacity="0.55"/><stop offset="1" stop-color="#1b6a73" stop-opacity="0.25"/></linearGradient>' +
      '<pattern id="rl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#e070ff" stroke-width="2"/></pattern></defs>';
    // ticks
    sc.ticks.forEach(function (v) {
      var yy = y(v).toFixed(1);
      s += '<line class="rl-tick" x1="' + (X0 - 6) + '" x2="' + X0 + '" y1="' + yy + '" y2="' + yy + '"/><text class="rl-ticklab" x="' + (X0 - 9) + '" y="' + (+yy + 3.5) + '" text-anchor="end">' + fmt(v) + '</text>';
    });
    s += '<line class="rl-axis" x1="' + X0 + '" x2="' + X0 + '" y1="' + top + '" y2="' + bottom + '"/>';
    if (sc.broken) {
      var yb = y(sc.lo);
      s += '<path class="rl-break" d="M' + (X0 - 8) + ' ' + (yb - 3) + ' l16 -5 M' + (X0 - 8) + ' ' + (yb + 3) + ' l16 -5"/>';
      s += '<text class="rl-ticklab" x="' + (X0 - 9) + '" y="' + (yb + 14) + '" text-anchor="end">≈</text>';
    }
    // water column (vessel)
    s += '<rect class="rl-col" x="' + X0 + '" y="' + top + '" width="' + (XW - X0) + '" height="' + (bottom - top) + '"/>';
    if (m.e) s += '<rect x="' + X0 + '" y="' + y(m.e.v).toFixed(1) + '" width="' + (XW - X0) + '" height="' + (bottom - y(m.e.v)).toFixed(1) + '" fill="url(#rl-water)"/>';
    // conservation pool bracket
    var bc = LV.constantAt(lv, LV.IDS.bottomCons, now), tc = LV.constantAt(lv, LV.IDS.topCons, now);
    if (bc != null && tc != null) s += '<rect class="rl-cons" x="' + (XW - 4) + '" y="' + y(tc).toFixed(1) + '" width="4" height="' + (y(bc) - y(tc)).toFixed(1) + '"><title>Conservation pool</title></rect>';
    // 30-yr stats band
    if (hasStats) {
      s += '<rect class="rl-col" x="' + XS0 + '" y="' + top + '" width="' + (XS1 - XS0) + '" height="' + (bottom - top) + '"/>';
      s += '<rect class="rl-p95" x="' + XS0 + '" y="' + y(stats.statsP95).toFixed(1) + '" width="' + (XS1 - XS0) + '" height="' + Math.max(1, y(stats.statsP05) - y(stats.statsP95)).toFixed(1) + '"/>';
      s += '<rect class="rl-p75" x="' + XS0 + '" y="' + y(stats.statsP75).toFixed(1) + '" width="' + (XS1 - XS0) + '" height="' + Math.max(1, y(stats.statsP25) - y(stats.statsP75)).toFixed(1) + '"/>';
      s += '<line class="rl-mean" x1="' + (XS0 - 3) + '" x2="' + (XS1 + 3) + '" y1="' + y(stats.statsAve).toFixed(1) + '" y2="' + y(stats.statsAve).toFixed(1) + '"/>';
      ['statsMin', 'statsMax'].forEach(function (k) {
        s += '<line class="rl-mm" x1="' + (XS0 + 4) + '" x2="' + (XS1 - 4) + '" y1="' + y(stats[k]).toFixed(1) + '" y2="' + y(stats[k]).toFixed(1) + '"/>';
      });
      s += '<text class="rl-collab" x="' + ((XS0 + XS1) / 2) + '" y="' + (top - 6) + '" text-anchor="middle">30-YR</text>';
    }
    s += '<text class="rl-collab" x="' + ((X0 + XW) / 2) + '" y="' + (top - 6) + '" text-anchor="middle">POOL</text>';

    // labelled markers
    // cls styles the marker line, lab styles the text (kept separate so line strokes never hit text)
    var items = marks.map(function (x) { return { y: y(x.v), cls: 'rl-struct' + (x.key === 'spillwayCrest' ? ' dashed' : ''), lab: 'rl-struct-lab', text: x.label + ' ' + fmt(x.v, 1), v: x.v }; });
    if (m.r) items.push({ y: y(m.r.v), cls: 'rl-rule', lab: 'rl-rule-lab', text: 'Rule curve (CWMS daily) ' + fmt(m.r.v, 1), v: m.r.v });
    if (tVal != null) items.push({ y: y(tVal), cls: 'rl-target', lab: 'rl-target-lab', text: 'Published target ' + fmt(tVal, 1), v: tVal });
    if (m.e) items.push({ y: y(m.e.v), cls: 'rl-pool', lab: 'rl-pool-lab', text: 'POOL ' + fmt(m.e.v, 1) + ' ft · LIVE', v: m.e.v });
    var spread = T.spreadLabels(items, 14, top + 4, bottom - 2);
    spread.forEach(function (it) {
      var yy = it.y.toFixed(1), ly = it.ly.toFixed(1);
      if (it.cls === 'rl-target') s += '<rect x="' + X0 + '" y="' + (it.y - 3).toFixed(1) + '" width="' + (XS1 - X0) + '" height="6" fill="url(#rl-hatch)" opacity="0.9"/>';
      s += '<line class="' + it.cls + '" x1="' + X0 + '" x2="' + (XS1 + 8) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<path class="rl-leader" d="M' + (XS1 + 8) + ' ' + yy + ' L' + (XL - 6) + ' ' + ly + ' L' + (XL - 2) + ' ' + ly + '"/>';
      s += '<text class="rl-lab ' + it.lab + '" x="' + XL + '" y="' + (+ly + 3.5) + '">' + esc(it.text) + '</text>';
    });
    if (m.e) s += '<path class="rl-pointer" d="M' + (X0 - 1) + ' ' + y(m.e.v).toFixed(1) + ' l-9 -6 v12 z"/>';
    s += '</svg>';
    return { svg: s, missing: missing, stats: hasStats ? stats : null, tEntry: tEntry, tVal: tVal };
  }

  // ---- Detail ---------------------------------------------------------------------

  function targetBlock(m, R) {
    var tgt = ELEV_TARGET[m.code], storT = STOR_TARGETS[m.code], h = '';
    if (!tgt && !storT) {
      return '<div class="tc-target"><h4 class="tc-h4">Interim operations / injunction target</h4>' +
        '<p class="na">No injunction or interim-operations elevation target is published in CWMS for this project.</p></div>';
    }
    h += '<div class="tc-target"><h4 class="tc-h4">Interim operations / injunction target</h4>';
    h += '<p class="tc-mandatory">Published target — not a statement of current operations.</p>';
    if (tgt) {
      var e = R.tEntry;
      if (!e) h += '<p class="na">' + esc(tgt.label) + ': not published.</p>';
      else {
        h += '<p><b>' + esc(tgt.label) + '</b> today: ' + (R.tVal == null ? '<span class="na">no target published for today</span>' : '<b class="tgt-val">' + fmt(R.tVal, 1) + ' ft</b>') +
          ' <span class="hint">(CWMS level ' + esc(m.code + '.' + tgt.id) + ', version ' + fDayY.format(new Date(e.date)) + ')</span></p>';
        var ch = T.nextTargetChanges(e, m.now, 3);
        h += '<p>Next changes: ' + (ch.length ? ch.map(function (c) { return '<b>' + changeDay(c.t) + ':</b> ' + (c.v == null ? 'target ends' : fmt(c.v, 1) + ' ft'); }).join(' · ') : '<span class="na">none ahead</span>') + '</p>';
      }
    }
    (storT || []).forEach(function (o) {
      var se = LV.pick(m.lv, o.id, m.now);
      if (!se) return;
      var sv = LV.evalSeasonal(se, m.now), ch2 = T.nextTargetChanges(se, m.now, 3);
      h += '<p><b>' + esc(o.label) + '</b> today: ' + (sv == null ? '<span class="na">no target published for today</span>' : fmt(sv) + ' ac-ft') +
        ' · next: ' + (ch2.length ? ch2.map(function (c) { return changeDay(c.t) + ': ' + (c.v == null ? 'ends' : fmt(c.v) + ' ac-ft'); }).join(' · ') : '—') + '</p>';
    });
    if (storT) h += '<p class="hint">Storage-based targets are shown in acre-feet; they are not converted to elevation here.</p>';
    h += '<p class="tc-links"><a href="#/docs">Docs ▸</a> · <a href="' + INJUNCTION_URL + '" rel="noopener">USACE Willamette injunction page ↗</a></p>';
    return h + '</div>';
  }

  function renderDetail() {
    if (!st.el) return;
    var box = st.el.querySelector('#tc-detail');
    var chips = ORDER.map(function (c) {
      return '<button type="button" class="chip" data-code="' + c + '" aria-pressed="' + (c === st.sel) + '">' + esc(byCode[c].name) + '</button>';
    }).join('');
    var m = model(st.sel), head = '<div class="tc-chips" role="group" aria-label="Select lake">' + chips + '</div>';
    head += '<div class="detail-head"><div><span class="panel-tag mono">USACE PROJECT ' + m.code + ' · ELEVATION RULER</span><h2>' + esc(m.p.name) + '</h2><p>' + esc(m.p.river + ' · ' + m.p.purpose) + '</p></div></div>';

    if (!m.lv) {
      var err = st.levelErr[m.code];
      box.innerHTML = head + (err
        ? '<div class="tc-skel"><p class="warntext">Levels unavailable (' + esc(err) + ').</p><button type="button" class="btn" data-retry="' + m.code + '">↻ Retry</button></div>'
        : '<div class="tc-skel"><p class="na loading">Loading levels…</p><div class="skel-bar"></div><div class="skel-bar short"></div></div>');
      return;
    }
    var R = rulerSVG(m);
    var info = '<dl class="kv tc-kv">';
    info += '<div><dt>Pool elevation <span class="lbl">LIVE</span></dt><dd class="hl">' + (m.e ? fmt(m.e.v, 1) + '<span class="unit">ft</span>' : na()) + '</dd>' +
      (m.e ? '<dd class="sub">' + stamp(m.e.t) + '</dd>' : '') + '</div>';
    info += '<div><dt>Rule curve today <span class="lbl">LIVE</span></dt><dd>' + (m.r ? fmt(m.r.v, 1) + '<span class="unit">ft</span>' : na()) + '</dd><dd class="sub">CWMS daily rule curve</dd></div>';
    info += '<div><dt>vs rule curve <span class="lbl">DERIVED</span></dt><dd class="' + (m.rd.status || '') + '-txt">' + (m.rd.delta != null ? signed(m.rd.delta, 1) + '<span class="unit">ft</span>' : na()) + '</dd>' +
      (m.rd.status ? '<dd class="sub">' + STATUS_TXT[m.rd.status] + '</dd>' : '') + '</div>';
    info += '<div><dt>% full <span class="lbl">DERIVED</span></dt><dd>' + (m.p.noStorage ? 'n/a' : !m.pf ? na() : m.pf.below ? '<span class="below-txt">Below cons. pool</span>' : fmt(m.pf.clamped, 1) + '<span class="unit">%</span>') + '</dd>' +
      '<dd class="sub">' + (m.p.noStorage ? 'no conservation pool' : m.pfFromElev ? 'by elevation (storage missing)' : '(storage − bottom) ÷ (top − bottom)') + '</dd></div>';
    info += '</dl>';
    if (H.tdg && H.tdg.SERIES[m.code]) info += H.tdg.chipHTML(m.code, H.live && H.live.tdg ? H.live.tdg[m.code] : null, stamp);
    if (R.stats) {
      info += '<p class="tc-stats mono">Today, 30-yr history thru 2023 <span class="lbl">DERIVED from published CWMS stats</span><br>' +
        'p05 ' + fmt(R.stats.statsP05, 1) + ' · p25 ' + fmt(R.stats.statsP25, 1) + ' · mean ' + fmt(R.stats.statsAve, 1) + ' · p75 ' + fmt(R.stats.statsP75, 1) + ' · p95 ' + fmt(R.stats.statsP95, 1) +
        ' ft<br>min ' + fmt(R.stats.statsMin, 1) + ' · max ' + fmt(R.stats.statsMax, 1) + ' ft</p>';
    } else info += '<p class="na">No 30-year statistics levels are published for this project.</p>';
    info += targetBlock(m, R);
    if (R.missing.length) info += '<p class="hint">Not published for this project: ' + esc(R.missing.join(', ')) + '.</p>';
    if (m.p.noStorage) info += '<p class="hint">Dexter is a re-regulating dam with no conservation pool; the ruler shows its power-pool band.</p>';
    info += '<p class="hint">Structural levels and stats: CWMS location levels (PUBLISHED), fetched ' + stamp(m.lv.fetchedAt) + ', cached 24 h. Scale is linear above the ≈ break; the span down to the streambed is compressed.</p>';
    box.innerHTML = head + '<div class="tc-detail-grid"><div class="tc-ruler">' + R.svg +
      '<div class="rl-legend"><span><i class="lg-pool"></i>Pool (LIVE)</span><span><i class="lg-rule"></i>Rule curve</span><span><i class="lg-target"></i>Published target</span><span><i class="lg-p75"></i>30-yr p25–p75</span><span><i class="lg-p95"></i>p05–p95</span></div>' +
      '</div><div class="tc-info">' + info + '</div></div>' +
      '<p class="tc-open"><button type="button" class="btn" data-open-trend="' + m.p.id + '">Open ' + esc(m.p.name) + ' in the Trend Recorder ›</button>' +
      ' <span class="hint">pool vs rule curve, 30-yr bands and targets for any range (24 H to 1 YR, calendar year, past years), with level lines, flows, temperature, turbidity and TDG</span></p>';
  }

  // ---- Shell ------------------------------------------------------------------------

  function select(code, scroll) {
    if (!byCode[code]) return;
    st.sel = code;
    renderCups();
    renderDetail();
    loadLevels(code);
    if (scroll) {
      var d = st.el.querySelector('#tc-detail');
      if (d && d.scrollIntoView) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  H.views.teacup = {
    title: 'Teacup',
    render: function (el) {
      st.el = el;
      el.querySelector('.view-body').innerHTML =
        '<section class="panel tc-overview">' +
        '<div class="panel-head"><h2>Basin Teacup</h2><span class="panel-tag mono">LIVE POOL · DERIVED % · PUBLISHED LEVELS</span></div>' +
        '<ul class="tc-legend">' +
        '<li><span class="sw below"></span>▼ Below rule curve (&gt;' + H.SETTINGS.ruleBelowFt + ' ft under)</li>' +
        '<li><span class="sw near"></span>● Near rule curve</li>' +
        '<li><span class="sw above"></span>▲ Above rule curve (&gt;' + H.SETTINGS.ruleAboveFt + ' ft over)</li>' +
        '<li><span class="sw none"></span>No data</li>' +
        '<li><span class="sw-rule"></span>Rule curve today</li></ul>' +
        '<p class="hint tc-legend-note">Cup height spans the conservation pool (bottom → top elevation); the water line is the live pool elevation and the dashed line the USACE rule curve. ' +
        'The % is DERIVED from live storage: (storage − bottom of conservation) ÷ (top − bottom). Colours use this site’s thresholds, not an agency determination.</p>' +
        '<div class="tc-grid" id="tc-grid"></div></section>' +
        '<section class="panel tc-detail" id="tc-detail"></section>';
      el.addEventListener('click', function (ev) {
        var cup = ev.target.closest('.cup');
        if (cup) { select(cup.getAttribute('data-code'), true); return; }
        var chip = ev.target.closest('.chip[data-code]');
        if (chip) { select(chip.getAttribute('data-code'), false); return; }
        var ot = ev.target.closest('[data-open-trend]');
        if (ot && H.trend) { H.trend.open(ot.getAttribute('data-open-trend'), '1y'); return; }
        var rt = ev.target.closest('[data-retry]');
        if (rt) loadLevels(rt.getAttribute('data-retry'), true);
      });
      document.addEventListener('hydro:data', function () { renderCups(); if (st.levels[st.sel]) renderDetail(); });
      renderCups();
      renderDetail();
      loadAllLevels();
    }
  };
})(typeof self !== 'undefined' ? self : this);
