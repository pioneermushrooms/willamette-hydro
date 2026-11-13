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
    levels: {}, levelErr: {}, loading: {},
    ruleYear: {}, ruleYearErr: {},
    range: 'year',        // 'year' (calendar year) | '30d' | '6m' | '1y' (window ending now) | 'years' (past years overlaid)
    years: null,          // selected calendar years for 'years' (default: this year and the two before)
    yearData: {},         // '<code>:<year>' -> js/history.js loadYear result, or { loading: true }
    zoom: null,           // 'years' chart window as year fractions [from, to]; null = full year
    hist: {},             // '<code>:<range>' -> js/history.js result, or { loading: true }
    ro: null
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

  function loadRuleYear(code) {
    if (st.ruleYear[code] || st.ruleYearErr[code] === 'loading') return;
    var p = byCode[code], y = +fYear.format(new Date());
    st.ruleYearErr[code] = 'loading';
    // Daily USACE rule curve for the whole calendar year (CWMS publishes it ahead).
    H.fetchCwms(p.series.rule, Date.UTC(y, 0, 1, 0), Date.UTC(y + 1, 0, 1, 12)).then(function (s) {
      st.ruleYear[code] = s;
      delete st.ruleYearErr[code];
    }, function (err) {
      st.ruleYearErr[code] = err.message || 'failed';
    }).then(function () { if (code === st.sel) renderAnnual(); });
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

  // ---- Annual chart --------------------------------------------------------------

  var RANGE_BTNS = [['year', 'YEAR'], ['30d', '30 D'], ['6m', '6 MO'], ['1y', '1 YR'], ['years', 'PAST YEARS']];
  var RANGE_DAYS = { '30d': 30, '6m': 182, '1y': 365 };
  var MNAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Pool + rule-curve history for a rolling window (js/history.js, cached there for 30 min).
  function histFor(m) {
    var key = m.code + ':' + st.range, hv = st.hist[key];
    if (hv) return hv;
    st.hist[key] = { loading: true };
    H.history.load(m.p, st.range, m.d && m.d.elev).then(function (r) {
      st.hist[key] = r;
      setTimeout(function () { if (st.hist[key] === r) delete st.hist[key]; }, 30 * 60 * 1000);
      if (m.code === st.sel) renderAnnual();
    });
    return st.hist[key];
  }

  // Seasonal level as daily points over [t0, t1] (spans calendar years).
  function windowSeries(entry, t0, t1) {
    if (!entry) return [];
    var y0 = +fYear.format(new Date(t0)), y1 = +fYear.format(new Date(t1)), pts = [];
    for (var y = y0; y <= y1; y++) pts = pts.concat(T.annualSeries(entry, y));
    return pts.filter(function (p) { return p[0] >= t0 && p[0] <= t1; });
  }

  function renderAnnual() {
    var box = st.el && st.el.querySelector('#tc-annual');
    if (!box) return;
    var m = model(st.sel), lv = m.lv;
    if (!lv) { box.innerHTML = ''; return; }
    if (st.range === 'years') { renderYears(box, m); return; }
    var W = Math.max(280, Math.floor(box.clientWidth || 600)), Ht = W < 520 ? 220 : 260;
    var year = +fYear.format(new Date()), now = Date.now(), cal = st.range === 'year';
    var t0 = cal ? Date.UTC(year, 0, 1, 8) : now - RANGE_DAYS[st.range] * 24 * 3600 * 1000;
    var t1 = cal ? Date.UTC(year + 1, 0, 1, 8) : now;
    var hist = cal ? null : histFor(m), hLoading = !!(hist && hist.loading);
    var ser = {};
    ['statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95'].forEach(function (k) {
      var en = LV.pick(lv, LV.IDS[k], now);
      ser[k] = cal ? T.annualSeries(en, year) : windowSeries(en, t0, t1);
    });
    var hasStats = ser.statsAve.some(function (p) { return p[1] != null; });
    var tgt = ELEV_TARGET[m.code], tEntry = tgt ? LV.pick(lv, tgt.id, now) : null;
    var tSer = tEntry ? (cal ? T.annualSeries(tEntry, year) : windowSeries(tEntry, t0, t1)) : [];
    var ry = cal ? st.ruleYear[m.code] : hist && !hLoading ? hist.rule : null;
    var pool = cal ? (m.d && m.d.elev && m.d.elev.t.length ? m.d.elev : null) : hist && !hLoading && hist.pool && hist.pool.t.length ? hist.pool : null;
    if (ry && !cal) {
      var rt = [], rv = [];
      ry.t.forEach(function (t, i) { if (t >= t0 - 86400000 && t <= t1 + 86400000) { rt.push(t); rv.push(ry.v[i]); } });
      ry = { t: rt, v: rv };
    }

    var vals = [];
    ['statsP05', 'statsP95'].forEach(function (k) { ser[k].forEach(function (p) { if (p[1] != null) vals.push(p[1]); }); });
    tSer.forEach(function (p) { if (p[1] != null) vals.push(p[1]); });
    if (ry) ry.v.forEach(function (v) { vals.push(v); });
    if (pool) { vals.push(Math.min.apply(null, pool.v)); vals.push(Math.max.apply(null, pool.v)); }
    var seg = '<div class="seg tc-range" role="group" aria-label="Chart range">' + RANGE_BTNS.map(function (b) {
      return '<button type="button" data-tcrange="' + b[0] + '" aria-pressed="' + (st.range === b[0]) + '">' + b[1] + '</button>';
    }).join('') + '</div>';
    var title = cal ? year + ' at a glance' : { '30d': 'Last 30 days', '6m': 'Last 6 months', '1y': 'Last 12 months' }[st.range];
    var head = '<div class="tc-an-head"><h4 class="tc-h4">' + title + ' <span class="hint">30-yr stats thru 2023 are DERIVED from published CWMS levels</span></h4>' + seg + '</div>';
    if (!vals.length) { box.innerHTML = head + '<p class="na">' + (hLoading ? 'Loading history…' : 'No series published for this project in this window.') + '</p>'; return; }
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.06 || 1;
    lo -= pad; hi += pad;
    var ml = 44, mr = 10, mt = 10, mb = 24, pw = W - ml - mr, ph = Ht - mt - mb;
    var x = function (t) { return ml + ((t - t0) / (t1 - t0)) * pw; };
    var y = function (v) { return mt + (1 - (v - lo) / (hi - lo)) * ph; };
    var path = function (pts) {
      var d = '', pen = false;
      pts.forEach(function (p) {
        if (p[1] == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); pen = true;
      });
      return d;
    };
    var band = function (a, b) {
      var top = a.filter(function (p) { return p[1] != null; }), bot = b.filter(function (p) { return p[1] != null; }).reverse();
      if (!top.length || !bot.length) return '';
      return 'M' + top.map(function (p) { return x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join('L') + 'L' +
        bot.map(function (p) { return x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join('L') + 'Z';
    };
    var s = '<svg class="annual" viewBox="0 0 ' + W + ' ' + Ht + '" width="100%" height="' + Ht + '" role="img" aria-label="' + esc(m.p.name + ' ' + title + ' elevation chart') + '">';
    s += '<defs><clipPath id="an-clip"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>';
    // grid
    var step = (hi - lo) > 120 ? 50 : (hi - lo) > 60 ? 20 : (hi - lo) > 25 ? 10 : (hi - lo) > 10 ? 5 : (hi - lo) > 4 ? 2 : (hi - lo) > 2 ? 1 : 0.5;
    for (var v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      s += '<line class="an-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>' +
        '<text class="an-lab" x="' + (ml - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, step < 1 ? 1 : 0) + '</text>';
    }
    if (cal) {
      var months = W < 520 ? 'JFMAMJJASOND' : null;
      for (var mo = 0; mo < 12; mo++) {
        var tm = Date.UTC(year, mo, 1, 8), xm = x(tm).toFixed(1);
        s += '<line class="an-grid" x1="' + xm + '" x2="' + xm + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
        s += '<text class="an-lab" x="' + (x(tm) + (x(Date.UTC(year, mo + 1, 1, 8)) - x(tm)) / 2).toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="middle">' + (months ? months[mo] : MNAMES[mo]) + '</text>';
      }
    } else if (st.range === '30d') {
      H.history.dayTicks(t0, t1, false).forEach(function (o) {
        var xd = x(o.t).toFixed(1), d = new Date(o.t + 12 * 3600 * 1000);
        s += '<line class="an-grid" x1="' + xd + '" x2="' + xd + '" y1="' + mt + '" y2="' + (mt + ph) + '"' + (o.dow === 1 ? '' : ' style="opacity:.35"') + '/>';
        if (o.dow === 1) s += '<text class="an-lab" x="' + xd + '" y="' + (Ht - 7) + '" text-anchor="middle">' + fDay.format(d) + '</text>';
      });
    } else {
      var ticks = H.history.monthTicks(t0, t1), skip = st.range === '1y' && W < 420 ? 2 : 1;
      ticks.forEach(function (o, i) {
        var xm2 = x(o.t).toFixed(1);
        s += '<line class="an-grid" x1="' + xm2 + '" x2="' + xm2 + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
        if (i % skip === 0) s += '<text class="an-lab" x="' + xm2 + '" y="' + (Ht - 7) + '" text-anchor="middle">' + MNAMES[o.m - 1] + (o.m === 1 ? " '" + String(o.y).slice(2) : '') + '</text>';
      });
    }
    s += '<g clip-path="url(#an-clip)">';
    if (hasStats) {
      s += '<path class="an-p95" d="' + band(ser.statsP95, ser.statsP05) + '"/>';
      s += '<path class="an-p75" d="' + band(ser.statsP75, ser.statsP25) + '"/>';
      s += '<path class="an-mean" d="' + path(ser.statsAve) + '"/>';
    }
    if (ry && ry.t.length) s += '<path class="an-rule" d="' + path(ry.t.map(function (t, i) { return [t, ry.v[i]]; })) + '"/>';
    if (tSer.length) s += '<path class="an-target" d="' + path(tSer) + '"/>';
    if (pool) s += '<path class="an-pool" d="' + path(pool.t.map(function (t, i) { return [t, pool.v[i]]; })) + '"/>';
    s += '</g>';
    if (cal) {
      var xn = x(now).toFixed(1);
      s += '<line class="an-today" x1="' + xn + '" x2="' + xn + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
      s += '<text class="an-todaylab" x="' + (+xn + (x(now) > W - 70 ? -4 : 4)) + '" y="' + (mt + 10) + '" text-anchor="' + (x(now) > W - 70 ? 'end' : 'start') + '">TODAY</text>';
    }
    s += '</svg>';
    var leg = [];
    if (hasStats) leg.push('<span><i class="lg-p95"></i>p05–p95</span><span><i class="lg-p75"></i>p25–p75</span><span><i class="lg-mean"></i>30-yr mean</span>');
    var ruleLoading = cal ? st.ruleYearErr[m.code] === 'loading' : hLoading;
    leg.push(ry && ry.t.length ? '<span><i class="lg-rule"></i>Rule curve' + (cal ? ' ' + year : '') + ' (CWMS daily)</span>' : ruleLoading ? '<span class="na loading">loading rule curve…</span>' : '<span class="na">rule curve unavailable</span>');
    if (tSer.length) leg.push('<span><i class="lg-target"></i>' + esc(tgt.label) + ' (published)</span>');
    if (pool) leg.push('<span><i class="lg-pool"></i>' + (cal ? 'Pool, last 7 days (LIVE)' : 'Pool elevation (history + LIVE)') + '</span>');
    else if (hLoading) leg.push('<span class="na loading">loading pool history…</span>');
    else if (!cal) leg.push('<span class="na">pool history unavailable' + (hist && hist.error ? ' (' + esc(hist.error) + ')' : '') + '</span>');
    var foot = cal
      ? 'Pick 30 D, 6 MO or 1 YR for pool history against the rule curve. The calendar-year view shows the last 7 days of live pool data.'
      : 'Pool: ' + esc(hist && hist.src ? hist.src + (hist.pool && hist.pool.liveFrom ? stamp(hist.pool.liveFrom) + ' (hourly)' : '') : '…') + '. ' +
        'Rule curve: CWMS ' + esc(m.p.series.rule.name) + '. ' + (hist && hist.note ? esc(hist.note) + ' ' : '') + 'Provisional data.';
    box.innerHTML = head + s + '<div class="an-legend">' + leg.join('') + '</div><p class="hint">' + foot + '</p>';
  }

  // ---- Past years overlaid on one Jan–Dec axis -------------------------------------

  var MAX_YEARS = 6;          // six validated colours; each year keeps the colour (year mod 6)
  var YEARS_BACK = 20;        // year chips offered: this year and the 19 before
  var fShort = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

  function thisYear() { return +fYear.format(new Date()); }
  function selectedYears() {
    if (!st.years) { var y = thisYear(); st.years = [y, y - 1, y - 2]; }
    return st.years.slice().sort(function (a, b) { return b - a; });
  }
  function toggleYear(y) {
    var cur = selectedYears(), i = cur.indexOf(y);
    if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); }
    else if (cur.length < MAX_YEARS) cur.push(y);
    st.years = cur;
    renderAnnual();
  }
  function yearSlot(y) { return ((y % MAX_YEARS) + MAX_YEARS) % MAX_YEARS; }

  function yearFor(code, y) {
    var key = code + ':' + y, v = st.yearData[key];
    if (v) return v;
    st.yearData[key] = { loading: true };
    H.history.loadYear(byCode[code], y).then(function (r) {
      st.yearData[key] = r;
      if (code === st.sel && st.range === 'years') renderAnnual();
    });
    return st.yearData[key];
  }

  // Value of series s at year-fraction f of year y (nearest reading within 2 days), or null.
  function valueAtFrac(s, y, f) {
    if (!s || !s.t || !s.t.length) return null;
    var a = H.history.pacificMidnight(y, 1, 1), b = H.history.pacificMidnight(y + 1, 1, 1), t = a + f * (b - a);
    var lo = 0, hi = s.t.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s.t[mid] <= t) lo = mid; else hi = mid; }
    var k = Math.abs(s.t[lo] - t) <= Math.abs(s.t[hi] - t) ? lo : hi;
    return Math.abs(s.t[k] - t) <= 2 * 24 * 3600 * 1000 ? s.v[k] : null;
  }

  // Zoom presets (Pacific calendar months of the reference year; month 13 = next Jan 1).
  var ZOOM_PRESETS = [['all', 'Full year', 1, 13], ['fall', 'Fall drawdown · Oct–Dec', 10, 13], ['refill', 'Refill · Jan–May', 1, 6], ['summer', 'Summer · Jun–Sep', 6, 10]];
  function monthFrac(cy, mo) { return mo >= 13 ? 1 : H.history.yearFrac(H.history.pacificMidnight(cy, mo, 1), cy); }
  function zoomWindow() { if (!st.zoom) st.zoom = [0, 1]; return st.zoom; }
  function setZoom(z) { st.zoom = T.clampZoom(z[0], z[1]); renderAnnual(); }
  function zoomAction(a) {
    var z = zoomWindow(), cy = thisYear();
    var pre = ZOOM_PRESETS.filter(function (p) { return p[0] === a; })[0];
    if (pre) return setZoom([monthFrac(cy, pre[2]), monthFrac(cy, pre[3])]);
    if (a === 'in') return setZoom(T.zoomBy(z, 0.5));
    if (a === 'out') return setZoom(T.zoomBy(z, 2));
    if (a === 'left') return setZoom(T.panBy(z, -1));
    if (a === 'right') return setZoom(T.panBy(z, 1));
  }
  // "Oct 1 – Dec 31" for a window of the reference year.
  function windowLabel(z, cy) {
    var a = H.history.pacificMidnight(cy, 1, 1), b = H.history.pacificMidnight(cy + 1, 1, 1);
    var d = function (f) { var t = a + f * (b - a); return fShort.format(new Date(t + H.history.pacificOffset(t))); };
    return z[0] <= 0 && z[1] >= 1 ? 'Jan 1 – Dec 31' : d(z[0]) + ' – ' + d(Math.max(z[0], z[1] - 1e-6));
  }

  function renderYears(box, m) {
    var years = selectedYears(), cy = thisYear(), now = Date.now(), z = zoomWindow(), z0 = z[0], z1 = z[1];
    var spanDays = (z1 - z0) * 365, zoomed = z0 > 0 || z1 < 1;
    var W = Math.max(280, Math.floor(box.clientWidth || 600)), Ht = W < 520 ? 260 : 320;
    var seg = '<div class="seg tc-range" role="group" aria-label="Chart range">' + RANGE_BTNS.map(function (b) {
      return '<button type="button" data-tcrange="' + b[0] + '" aria-pressed="' + (st.range === b[0]) + '">' + b[1] + '</button>';
    }).join('') + '</div>';
    var chips = '';
    for (var y = cy; y > cy - YEARS_BACK; y--) {
      var on = years.indexOf(y) >= 0, full = !on && years.length >= MAX_YEARS;
      chips += '<button type="button" class="chip small yr-chip" data-tcyear="' + y + '" aria-pressed="' + on + '"' +
        (full ? ' disabled title="Up to ' + MAX_YEARS + ' years at once; deselect one first"' : '') + '>' +
        (on ? '<i class="yr-sw yr-c' + yearSlot(y) + '" aria-hidden="true"></i>' : '') + y + '</button>';
    }
    var head = '<div class="tc-an-head"><h4 class="tc-h4">Past years, ' + esc(m.p.name) + ' <span class="hint">pool elevation by calendar year</span></h4>' + seg + '</div>' +
      '<div class="tc-chips yr-chips" role="group" aria-label="Years to compare (up to ' + MAX_YEARS + ')">' + chips + '</div>';
    var zbtn = function (a, label, title, dis) { return '<button type="button" class="btn yr-zb" data-tczoom="' + a + '" title="' + title + '" aria-label="' + title + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>'; };
    var zoomBar = '<div class="yr-zoom" role="group" aria-label="Zoom the chart">' +
      zbtn('out', '−', 'Zoom out', !zoomed) + zbtn('in', '+', 'Zoom in', z1 - z0 <= T.MIN_SPAN + 1e-9) + zbtn('left', '◀', 'Earlier', z0 <= 0) + zbtn('right', '▶', 'Later', z1 >= 1) +
      '<span class="yr-presets">' + ZOOM_PRESETS.map(function (p) {
        var pz = [monthFrac(cy, p[2]), monthFrac(cy, p[3])], cur = Math.abs(pz[0] - z0) < 1e-6 && Math.abs(pz[1] - z1) < 1e-6;
        return '<button type="button" class="chip small" data-tczoom="' + p[0] + '" aria-pressed="' + cur + '">' + p[1] + '</button>';
      }).join('') + '</span>' +
      '<span class="yr-window mono">' + windowLabel(z, cy) + '</span></div>';

    var data = years.map(function (y) { return { y: y, r: yearFor(m.code, y) }; });
    var loading = data.filter(function (d) { return d.r.loading; }).map(function (d) { return d.y; });
    var shown = data.filter(function (d) { return !d.r.loading && d.r.pool && d.r.pool.t.length; });
    if (!shown.length) {
      box.innerHTML = head + '<p class="na' + (loading.length ? ' loading' : '') + '">' + (loading.length ? 'Loading ' + loading.join(', ') + '…' : 'No pool history returned for the selected years.') + '</p>' + yearErrors(data);
      return;
    }

    var frac = H.history.yearFrac, margin = 3 / 365;
    var inWin = function (f) { return f >= z0 - margin && f <= z1 + margin; };
    // Reference context: the 30-yr statistics bands for this calendar year (DERIVED, published CWMS levels).
    var lv = m.lv, ser = {};
    ['statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95'].forEach(function (k) {
      ser[k] = T.annualSeries(LV.pick(lv, LV.IDS[k], now), cy).filter(function (p) { return p[1] != null; }).map(function (p) { return [frac(p[0], cy), p[1]]; });
    });
    var hasStats = ser.statsAve.length > 0;

    // Elevation axis fits only what is inside the zoom window.
    var vals = [];
    shown.forEach(function (d) {
      d.r.pool.t.forEach(function (t, i) { var f = frac(t, d.y); if (f >= z0 && f <= z1) vals.push(d.r.pool.v[i]); });
      if (d.r.rule) d.r.rule.t.forEach(function (t, i) { var f = frac(t, d.y); if (f >= z0 && f < 1 && f <= z1) vals.push(d.r.rule.v[i]); });
    });
    var poolVals = vals.length;
    if (hasStats) ['statsP05', 'statsP95'].forEach(function (k) { ser[k].forEach(function (p) { if (p[0] >= z0 && p[0] <= z1) vals.push(p[1]); }); });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.08 || 0.5;
    lo -= pad; hi += pad;
    var ml = 54, mr = W < 520 ? 40 : 52, mt = 10, mb = 24, pw = W - ml - mr, ph = Ht - mt - mb;
    var x = function (f) { return ml + ((f - z0) / (z1 - z0)) * pw; }, yv = function (v) { return mt + (1 - (v - lo) / (hi - lo)) * ph; };
    // Pool readings at 24:00 Dec 31 sit at f = 1 and belong to that year; a rule-curve value stamped
    // at the next Jan 1 midnight does not, so rule curves stop before f = 1.
    var path = function (s, yr, isRule) {
      var d = '', pen = false, prev = null;
      s.t.forEach(function (t, i) {
        var f = frac(t, yr);
        if (f < 0 || f > 1 || (isRule && f >= 1) || !inWin(f)) { pen = false; return; }
        if (prev != null && t - prev > 3 * 24 * 3600 * 1000) pen = false;   // gap in record
        d += (pen ? 'L' : 'M') + x(f).toFixed(1) + ' ' + yv(s.v[i]).toFixed(1); pen = true; prev = t;
      });
      return d;
    };
    var band = function (a, b) {
      var top = a.filter(function (p) { return inWin(p[0]); }), bot = b.filter(function (p) { return inWin(p[0]); }).reverse();
      if (!top.length || !bot.length) return '';
      return 'M' + top.map(function (p) { return x(p[0]).toFixed(1) + ' ' + yv(p[1]).toFixed(1); }).join('L') + 'L' + bot.map(function (p) { return x(p[0]).toFixed(1) + ' ' + yv(p[1]).toFixed(1); }).join('L') + 'Z';
    };

    var s = '<svg class="annual yr-svg" viewBox="0 0 ' + W + ' ' + Ht + '" width="100%" height="' + Ht + '" role="img" aria-label="' + esc(m.p.name + ' pool elevation for ' + years.join(', ') + ', ' + windowLabel(z, cy)) + '">';
    s += '<defs><clipPath id="yr-clip"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>';
    var step = T.niceStep(hi - lo), dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      s += '<line class="an-grid" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + yv(v).toFixed(1) + '" y2="' + yv(v).toFixed(1) + '"/>' +
        '<text class="an-lab" x="' + (ml - 6) + '" y="' + (yv(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, dec) + '</text>';
    }
    if (spanDays > 120) {
      // Month columns; each month name zooms to that month.
      for (var mo = 1; mo <= 12; mo++) {
        var f0 = monthFrac(cy, mo), f1 = monthFrac(cy, mo + 1);
        if (f1 <= z0 || f0 >= z1) continue;
        if (f0 >= z0) s += '<line class="an-grid" x1="' + x(f0).toFixed(1) + '" x2="' + x(f0).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
        var cx = x((Math.max(f0, z0) + Math.min(f1, z1)) / 2);
        s += '<text class="an-lab yr-mlab" data-tcmonth="' + mo + '" x="' + cx.toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="middle"><title>Zoom to ' + MNAMES[mo - 1] + '</title>' + (W < 520 && spanDays > 250 ? 'JFMAMJJASOND'[mo - 1] : MNAMES[mo - 1]) + '</text>';
      }
    } else {
      var dstep = T.dayTickStep(spanDays, pw, W < 520 ? 52 : 46);
      for (var k = 0; k < 367; k++) {
        var tk = H.history.pacificMidnight(cy, 1, 1 + k), fk = frac(tk, cy);
        if (fk > z1) break;
        if (fk < z0) continue;
        var dt = new Date(Date.UTC(cy, 0, 1 + k, 12)), dom = dt.getUTCDate(), first = dom === 1;
        if (!first && (dstep >= 7 ? (dom - 1) % dstep !== 0 || dom > 29 : (dom - 1) % dstep !== 0)) continue;
        s += '<line class="an-grid" x1="' + x(fk).toFixed(1) + '" x2="' + x(fk).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"' + (first ? '' : ' style="opacity:.45"') + '/>' +
          '<text class="an-lab' + (first ? ' yr-mlab' : '') + '"' + (first ? ' data-tcmonth="' + (dt.getUTCMonth() + 1) + '"' : '') + ' x="' + x(fk).toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="middle">' + fShort.format(dt) + '</text>';
      }
    }
    s += '<g clip-path="url(#yr-clip)">';
    if (hasStats) s += '<path class="an-p95" d="' + band(ser.statsP95, ser.statsP05) + '"/><path class="an-p75" d="' + band(ser.statsP75, ser.statsP25) + '"/>';
    shown.forEach(function (d) { if (d.r.rule && d.r.rule.t.length) s += '<path class="yr-rule yr-c' + yearSlot(d.y) + '" d="' + path(d.r.rule, d.y, true) + '"/>'; });
    shown.forEach(function (d) { s += '<path class="yr-pool yr-c' + yearSlot(d.y) + '" d="' + path(d.r.pool, d.y) + '"/>'; });
    if (spanDays <= 60) {
      // Zoomed in: mark each reading so individual daily values are visible.
      shown.forEach(function (d) {
        var dots = '';
        d.r.pool.t.forEach(function (t, i) { var f = frac(t, d.y); if (f >= z0 && f <= z1) dots += '<circle cx="' + x(f).toFixed(1) + '" cy="' + yv(d.r.pool.v[i]).toFixed(1) + '" r="3"/>'; });
        s += '<g class="yr-dots yr-c' + yearSlot(d.y) + '">' + dots + '</g>';
      });
    }
    s += '</g>';
    // Direct labels at each line's last reading inside the window, spread so they never overlap.
    var items = [];
    shown.forEach(function (d) {
      for (var n = d.r.pool.t.length - 1; n >= 0; n--) {
        var f = frac(d.r.pool.t[n], d.y);
        if (f <= z1 && f >= z0) { items.push({ y: yv(d.r.pool.v[n]), xe: x(Math.min(1, f)), yr: d.y }); break; }
      }
    });
    T.spreadLabels(items, 12, mt + 6, mt + ph - 2).forEach(function (it) {
      var lx = Math.min(it.xe + 4, ml + pw + 4);
      s += '<line class="yr-lead yr-c' + yearSlot(it.yr) + '" x1="' + it.xe.toFixed(1) + '" x2="' + (lx + 2).toFixed(1) + '" y1="' + it.y.toFixed(1) + '" y2="' + it.ly.toFixed(1) + '"/>' +
        '<text class="yr-lab" x="' + (lx + 4).toFixed(1) + '" y="' + (it.ly + 3.5).toFixed(1) + '">' + it.yr + '</text>';
    });
    if (!poolVals) s += '<text class="an-lab" x="' + (ml + pw / 2) + '" y="' + (mt + ph / 2) + '" text-anchor="middle">No readings in this window for the selected years</text>';
    s += '<g class="yr-cross" style="display:none"><line class="yr-cross-line" y1="' + mt + '" y2="' + (mt + ph) + '"/></g>';
    s += '<rect class="yr-sel" x="0" y="' + mt + '" width="0" height="' + ph + '" style="display:none"/>';
    s += '<rect class="yr-hit" x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '" fill="transparent"/>';
    s += '</svg>';

    var leg = shown.map(function (d) { return '<span><i class="yr-key yr-c' + yearSlot(d.y) + '"></i>' + d.y + '</span>'; });
    leg.push('<span><i class="yr-key-rule"></i>dashed: that year’s rule curve</span>');
    if (hasStats) leg.push('<span><i class="lg-p95"></i>30-yr p05–p95</span><span><i class="lg-p75"></i>p25–p75</span>');
    if (loading.length) leg.push('<span class="na loading">loading ' + loading.join(', ') + '…</span>');

    var rows = data.map(function (d) {
      if (d.r.loading) return '<tr><td>' + d.y + '</td><td colspan="4" class="na">loading…</td></tr>';
      var sm = H.history.yearSummary(d.r.pool, d.y);
      if (!sm) return '<tr><td>' + d.y + '</td><td colspan="4" class="na">' + esc(d.r.error || 'no pool data') + '</td></tr>';
      var day = function (t) { return fShort.format(new Date(t - 12 * 3600 * 1000 + (H.history.pacificOffset(t)))); };
      return '<tr><td><i class="yr-key yr-c' + yearSlot(d.y) + '"></i> ' + d.y + (d.y === cy ? ' (to date)' : '') + '</td><td>' + fmt(sm.min, 2) + ' · ' + day(sm.minT) + '</td><td>' + fmt(sm.max, 2) + ' · ' + day(sm.maxT) + '</td>' +
        '<td>' + (sm.fallMean == null ? '—' : fmt(sm.fallMean, 2)) + '</td><td class="yr-src">' + esc(d.r.src || '') + '</td></tr>';
    }).join('');
    var table = '<details class="table-view"><summary>Year summary table</summary><div class="table-scroll"><table><thead><tr><th>Year</th><th>Lowest pool (ft) · date</th><th>Highest pool (ft) · date</th><th>Mean Nov 15–Dec 15 (ft)</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';

    box.innerHTML = head + zoomBar + '<div class="yr-wrap">' + s + '<div class="tooltip mono yr-tip" hidden></div></div>' +
      '<p class="hint yr-howto">Drag across the chart to zoom in · tap a month name to zoom to that month · double-click to zoom out.</p>' +
      '<div class="an-legend">' + leg.join('') + '</div>' + table +
      '<p class="hint">Each year is drawn on the same calendar axis. Pool: USGS daily lake elevation (24:00) at the project’s lake gage where one exists, otherwise USACE CWMS as 6-hour means. Rule curve: CWMS ' + esc(m.p.series.rule.name) + ' for that year, where published. Bands: 30-yr statistics thru 2023 (DERIVED from published CWMS levels). Provisional data. Hover or tap the chart for values.</p>' + yearErrors(data);
    bindYearChart(box, shown, { ml: ml, pw: pw, W: W, cy: cy, z0: z0, z1: z1 });
  }

  function yearErrors(data) {
    var notes = data.filter(function (d) { return !d.r.loading && (d.r.note || d.r.ruleError || d.r.error); }).map(function (d) {
      return d.y + ': ' + [d.r.error, d.r.note, d.r.ruleError ? 'rule curve unavailable (' + d.r.ruleError + ')' : null].filter(Boolean).join(' ');
    });
    return notes.length ? '<p class="hint yr-notes">' + esc(notes.join(' · ')) + '</p>' : '';
  }

  // Hover/tap readout, drag-to-zoom (horizontal drags; vertical swipes still scroll the page), double-click to zoom out.
  function bindYearChart(box, shown, g) {
    var svg = box.querySelector('.yr-svg'), tip = box.querySelector('.yr-tip'), cross = box.querySelector('.yr-cross'), line = box.querySelector('.yr-cross-line'), sel = box.querySelector('.yr-sel');
    if (!svg) return;
    var a = H.history.pacificMidnight(g.cy, 1, 1), b = H.history.pacificMidnight(g.cy + 1, 1, 1);
    var pxOf = function (ev) { var r = svg.getBoundingClientRect(); return (ev.clientX - r.left) * (g.W / r.width); };
    var fOf = function (px) { return g.z0 + ((px - g.ml) / g.pw) * (g.z1 - g.z0); };
    var drag = null;
    var hide = function () { cross.style.display = 'none'; tip.hidden = true; };
    var show = function (ev) {
      var px = pxOf(ev), f = fOf(px);
      if (px < g.ml || px > g.ml + g.pw) { hide(); return; }
      line.setAttribute('x1', px.toFixed(1)); line.setAttribute('x2', px.toFixed(1)); cross.style.display = '';
      var refT = a + f * (b - a);
      var lines = shown.map(function (d) {
        var v = valueAtFrac(d.r.pool, d.y, f), rv = valueAtFrac(d.r.rule, d.y, f);
        return '<span><i class="yr-key yr-c' + yearSlot(d.y) + '"></i>' + d.y + ': <b>' + (v == null ? '—' : fmt(v, 2) + ' ft') + '</b>' + (rv == null ? '' : ' · rule ' + fmt(rv, 2)) + '</span>';
      });
      tip.innerHTML = '<b>' + fShort.format(new Date(refT + H.history.pacificOffset(refT))) + '</b><br>' + lines.join('<br>');
      tip.hidden = false;
      var bx = box.querySelector('.yr-wrap').getBoundingClientRect(), left = ev.clientX - bx.left + 12;
      if (left + tip.offsetWidth > bx.width) left = ev.clientX - bx.left - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px'; tip.style.top = '8px';
    };
    svg.addEventListener('pointerdown', function (ev) {
      var px = pxOf(ev);
      if (px < g.ml || px > g.ml + g.pw) return;
      drag = { x0: px, id: ev.pointerId, moved: false };
      show(ev);
    });
    svg.addEventListener('pointermove', function (ev) {
      show(ev);
      if (!drag || ev.pointerId !== drag.id) return;
      var px = Math.max(g.ml, Math.min(g.ml + g.pw, pxOf(ev)));
      if (!drag.moved && Math.abs(px - drag.x0) > 8) { drag.moved = true; try { svg.setPointerCapture(drag.id); } catch (e) { /* ignore */ } }
      if (drag.moved) { sel.setAttribute('x', Math.min(px, drag.x0).toFixed(1)); sel.setAttribute('width', Math.abs(px - drag.x0).toFixed(1)); sel.style.display = ''; }
    });
    var end = function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag; drag = null; sel.style.display = 'none';
      if (!d.moved) return;
      var px = Math.max(g.ml, Math.min(g.ml + g.pw, pxOf(ev)));
      setZoom([fOf(Math.min(px, d.x0)), fOf(Math.max(px, d.x0))]);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', function () { drag = null; sel.style.display = 'none'; hide(); });
    svg.addEventListener('pointerleave', function () { if (!drag) hide(); });
    svg.addEventListener('dblclick', function (ev) { ev.preventDefault(); setZoom(T.zoomBy([g.z0, g.z1], 2.5, fOf(pxOf(ev)))); });
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
      '</div><div class="tc-info">' + info + '</div></div><div id="tc-annual" class="tc-annual"></div>';
    renderAnnual();
    loadRuleYear(m.code);
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
        var rb = ev.target.closest('[data-tcrange]');
        if (rb) { st.range = rb.getAttribute('data-tcrange'); renderAnnual(); return; }
        var zb = ev.target.closest('[data-tczoom]');
        if (zb && !zb.disabled) { zoomAction(zb.getAttribute('data-tczoom')); return; }
        var mb = ev.target.closest('[data-tcmonth]');
        if (mb) { var mo = +mb.getAttribute('data-tcmonth'), cyy = thisYear(); setZoom([monthFrac(cyy, mo), monthFrac(cyy, mo + 1)]); return; }
        var yb = ev.target.closest('[data-tcyear]');
        if (yb && !yb.disabled) { toggleYear(+yb.getAttribute('data-tcyear')); return; }
        var rt = ev.target.closest('[data-retry]');
        if (rt) loadLevels(rt.getAttribute('data-retry'), true);
      });
      document.addEventListener('hydro:data', function () { renderCups(); if (st.levels[st.sel]) renderDetail(); });
      var lastW = 0;
      if (root.ResizeObserver) {
        st.ro = new ResizeObserver(function () {
          var b = el.querySelector('#tc-annual');
          var w = b ? b.clientWidth : 0;
          if (w && Math.abs(w - lastW) > 4) { lastW = w; renderAnnual(); }
        });
        st.ro.observe(el);
      }
      renderCups();
      renderDetail();
      loadAllLevels();
    }
  };
})(typeof self !== 'undefined' ? self : this);
