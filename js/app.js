/* Willamette Valley Hydro Dispatch — UI. Live data from USGS and USACE; provisional, not official. */
(function () {
  'use strict';

  var H = window.HYDRO;
  if (!H) return;

  var TZ = 'America/Los_Angeles';
  var HOUR = 3600 * 1000;
  var DAY = 24 * HOUR;
  var POLL_MS = H.SETTINGS.pollMinutes * 60 * 1000;
  var BPA_URL = 'data/bpa.json';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ICON = { normal: '●', watch: '▲', low: '✕', pending: '○' };
  var NA = '<span class="na">no data</span>';
  var LOADING = '<span class="na loading">loading…</span>';

  var all = H.projects.concat(H.stations);
  var byId = {};
  all.forEach(function (e) { byId[e.id] = e; });

  var state = {
    snap: null,
    fetching: false,
    nextPollAt: null,
    pollTimer: 0,
    selectedId: 'lookout-point',
    chartId: 'lookout-point',
    range: '7d',          // '24h' | '7d' live series; '30d' | '6m' | '1y' long history (js/history.js)
    tzoom: [0, 1],        // Trend Recorder zoom window as fractions of the selected range (js/zoom.js)
    lv: {},               // project code -> { loading } | { data: CWMS levels } (level lines, 30-yr bands, target)
    strips: {},           // '<id>|<strip>|<range>' -> js/layers.js load result, or { loading: true }
    hist: {},             // '<id>:<range>' -> history result (or { loading: true })
    riverParam: 'flow',   // trend chart for river gauges: 'flow' | 'stage' (flood bands + NWS stage forecast)
    nwps: null,           // { <stationId>: { lid, gauge, error } } from js/nwps.js
    tdg: null,            // { DEX|CGR: { series, error } } from js/tdg.js
    snow: null,           // { fetchedAt, stations, error } from js/snotel.js
    angles: {},
    geom: null
  };

  // ---- Helpers -------------------------------------------------------------

  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(n, d) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }

  function signed(n, d) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n), d); }

  var fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  var fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZoneName: 'short' });
  var fmtStamp = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  var fmtShort = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  var fmtParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  function parts(t) {
    var o = {};
    fmtParts.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    o.h = parseInt(o.hour, 10) % 24;
    o.m = parseInt(o.minute, 10);
    return o;
  }

  function dateLine(t) {
    var o = {};
    fmtDate.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    return o.weekday + ' ' + o.month + ' ' + o.day + ' ' + o.year + ' · ' + (o.timeZoneName || 'PT');
  }

  // "Oct 30, 4:45 PM PDT"
  function stamp(t) { return t == null ? '—' : fmtStamp.format(new Date(t)); }

  function ago(t) {
    if (t == null) return '';
    var min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.floor(min / 60);
    if (h < 48) return h + ' h ' + (min % 60) + ' min ago';
    return Math.floor(h / 24) + ' d ago';
  }

  function staleTag(t) {
    var f = H.freshness(t);
    if (f === 'stale') return ' <span class="tag watch">STALE</span>';
    if (f === 'very-stale') return ' <span class="tag low">STALE &gt;12H</span>';
    return '';
  }

  function readingLine(t, label) {
    if (t == null) return '<p class="reading mono">' + (label || 'Last reading') + ': ' + NA + '</p>';
    return '<p class="reading mono">' + (label || 'Last reading') + ': <time datetime="' + new Date(t).toISOString() + '">' + stamp(t) +
      '</time> · ' + ago(t) + staleTag(t) + '</p>';
  }

  function statusPill(st) {
    return '<span class="status ' + st.level + '"' + (st.reason ? ' title="' + esc(st.reason) + '"' : '') + '><span class="icon" aria-hidden="true">' +
      ICON[st.level] + '</span>' + esc(st.label) + '</span>';
  }

  function kv(label, value, unit, cls, sub) {
    return '<div><dt>' + label + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + value +
      (unit ? '<span class="unit">' + unit + '</span>' : '') + '</dd>' + (sub ? '<dd class="sub">' + sub + '</dd>' : '') + '</div>';
  }

  // Value cell: "loading…" before the first fetch, "no data" when the series is absent.
  function val(point, d, unit, cls, sub) {
    if (!state.snap) return { html: LOADING, unit: '', cls: '', sub: '' };
    if (!point) return { html: NA, unit: '', cls: '', sub: sub || '' };
    return { html: fmt(point.v, d), unit: unit, cls: cls || '', sub: sub || '' };
  }

  function kvVal(label, v) { return kv(label, v.html, v.unit, v.cls, v.sub); }

  function isProvisional(q) { return q && /(^|,)P(,|$)/.test(q); }

  function qualText(q) {
    if (!q) return '';
    if (isProvisional(q)) return 'provisional';
    if (/(^|,)A(,|$)/.test(q)) return 'approved';
    return q;
  }

  function projData(p) { return state.snap ? state.snap.projects[p.id] || {} : null; }
  function stData(s) { return state.snap ? state.snap.stations[s.id] || {} : null; }

  function statusOf(e) {
    return e.kind === 'reservoir' ? H.reservoirStatus(e, projData(e)) : H.stationStatus(e, stData(e));
  }

  function lastIndexBefore(t, arr) {
    var lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  // ---- Clock + polling -----------------------------------------------------

  function tickClock() {
    var now = Date.now();
    $('#clock').textContent = fmtClock.format(now).replace(/^24/, '00');
    $('#clock-date').textContent = dateLine(now);
    var np = $('#next-poll');
    if (state.fetching) np.textContent = 'fetching…';
    else if (state.nextPollAt) {
      var left = Math.max(0, Math.round((state.nextPollAt - now) / 1000));
      np.textContent = 'next poll ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }
  }

  // Keep the previous good series when a single series fails on a later poll;
  // its timestamp keeps ageing so it turns STALE honestly.
  function merge(prev, next) {
    if (!prev) return next;
    H.projects.forEach(function (p) {
      var a = prev.projects[p.id] || {}, b = next.projects[p.id] || (next.projects[p.id] = {});
      Object.keys(p.series).forEach(function (k) { if (p.series[k] && b[k] == null && a[k]) b[k] = a[k]; });
    });
    if (!next.sources.usgs.ok) next.stations = prev.stations;
    if (!next.sources.bpa.ok && prev.bpa) next.bpa = prev.bpa;
    return next;
  }

  // Keep the last good NWS gauge when a later request fails (its forecast keeps its issued time).
  function mergeNwps(prev, next) {
    if (!next) return prev || {};
    if (prev) Object.keys(next).forEach(function (id) {
      if (!next[id].gauge && prev[id] && prev[id].gauge) { next[id].gauge = prev[id].gauge; next[id].stale = true; }
    });
    return next;
  }

  // Keep the last good TDG series when a later request fails (it then ages into STALE).
  function mergeTdg(prev, next) {
    if (prev) Object.keys(next).forEach(function (k) { if (!next[k].series && prev[k] && prev[k].series) next[k] = prev[k]; });
    return next;
  }

  function poll() {
    if (state.fetching) return;
    state.fetching = true;
    clearTimeout(state.pollTimer);
    renderFeed();
    tickClock();
    var nwpsP = H.nwps ? H.nwps.loadAll().catch(function () { return null; }) : Promise.resolve(null);
    var tdgP = H.tdg ? H.tdg.loadAll().catch(function () { return null; }) : Promise.resolve(null);
    var snowP = H.snotel ? H.snotel.load().catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([H.loadAll({ bpaUrl: BPA_URL }), nwpsP, tdgP, snowP]).then(function (res) {
      if (res[2]) state.tdg = mergeTdg(state.tdg, res[2]);
      if (res[3]) state.snow = res[3].error && state.snow && !state.snow.error ? state.snow : res[3];
      var snap = res[0];
      state.snap = merge(state.snap, snap);
      state.nwps = mergeNwps(state.nwps, res[1]);
      // Share the live snapshot with other views (Teacup) — they must not refetch it.
      H.live = { snap: state.snap, nwps: state.nwps, tdg: state.tdg };
      document.dispatchEvent(new CustomEvent('hydro:data'));
      loadConsLimits();
      state.fetching = false;
      state.nextPollAt = Date.now() + POLL_MS;
      state.pollTimer = setTimeout(poll, POLL_MS);
      renderAll(true);
    });
  }

  // Fall Creek / Blue River: conservation limits from CWMS location levels (once per page load).
  function loadConsLimits() {
    if (!H.levels || !H.teacupCore) return;
    H.projects.forEach(function (p) {
      if (!p.consFromLevels || p.consTried) return;
      p.consTried = 'loading';
      H.levels.fetchProjectLevels(p.code).then(function (lv) {
        var c = H.teacupCore.consLimits(lv, null, Date.now());
        if (c.elevBottom != null && c.elevTop != null && c.elevTop > c.elevBottom) p.cons = c;
      }, function () {}).then(function () { p.consTried = true; renderAll(false); });
    });
  }

  // ---- Feed status ---------------------------------------------------------

  function renderFeed() {
    var s = state.snap, dot = $('#live-dot'), label = $('#live-label'), btn = $('#refresh');
    btn.disabled = state.fetching;
    btn.textContent = state.fetching ? 'Fetching…' : '↻ Refresh';
    if (!s) {
      dot.className = 'live-dot pending';
      label.textContent = state.fetching ? 'CONNECTING' : 'OFFLINE';
      return;
    }
    var src = s.sources, cw = src.cwms, cwTotal = cw.ok + cw.failed + cw.empty;
    var bpaAge = s.bpa ? H.freshness(s.bpa.latest.epochMs) : 'none';
    var okCount = (src.usgs.ok ? 1 : 0) + (cw.ok > 0 ? 1 : 0);
    var full = src.usgs.ok && cw.ok === cwTotal;
    dot.className = 'live-dot ' + (full ? 'normal' : okCount ? 'watch' : 'low');
    label.textContent = state.fetching ? 'UPDATING' : full ? 'LIVE' : okCount ? 'PARTIAL' : 'OFFLINE';
    $('#last-fetch').textContent = fmtClock.format(s.fetchedAt).replace(/^24/, '00').slice(0, 5) + ' PT';

    var b = [];
    b.push(src.usgs.ok
      ? '<span class="badge ok" title="USGS NWIS Instantaneous Values">USGS NWIS ✓ ' + src.usgs.series + ' series</span>'
      : '<span class="badge err" title="' + esc(src.usgs.error || '') + '">USGS NWIS ✕ ' + esc(src.usgs.error || 'failed') + '</span>');
    b.push('<span class="badge ' + (cw.ok === cwTotal ? 'ok' : cw.ok ? 'warn' : 'err') + '" title="' + esc(cw.errors.join('\n')) + '">USACE CWMS ' +
      (cw.ok === cwTotal ? '✓ ' : '') + cw.ok + '/' + cwTotal + ' series</span>');
    if (src.bpa.ok && bpaAge === 'fresh') b.push('<span class="badge ok">BPA file ✓ ' + ago(s.bpa.latest.epochMs) + '</span>');
    else if (s.bpa) b.push('<span class="badge warn">BPA file stale · ' + ago(s.bpa.latest.epochMs) + '</span>');
    else b.push('<span class="badge err" title="' + esc(src.bpa.error || '') + '">BPA file ✕ ' + esc(src.bpa.error || 'missing') + '</span>');
    if (state.nwps) {
      var lids = Object.keys(state.nwps).filter(function (id) { return state.nwps[id].lid; });
      var okN = lids.filter(function (id) { return state.nwps[id].gauge; }).length;
      b.push('<span class="badge ' + (okN === lids.length ? 'ok' : okN ? 'warn' : 'err') + '" title="NOAA NWPS flood categories + NWS/NWRFC forecasts">NOAA NWPS ' +
        (okN === lids.length ? '✓ ' : '') + okN + '/' + lids.length + ' gauges</span>');
    }
    if (state.tdg) {
      var tk = Object.keys(state.tdg), tok = tk.filter(function (k) { return state.tdg[k].series && state.tdg[k].series.t.length; }).length;
      b.push('<span class="badge ' + (tok === tk.length ? 'ok' : tok ? 'warn' : 'err') + '" title="CWMS TDG % saturation, Dexter + Cougar tailwater">CWMS TDG ' + (tok === tk.length ? '✓ ' : '') + tok + '/' + tk.length + '</span>');
    }
    if (state.snow) {
      var sn = H.snotel.STATIONS.length, sok = H.snotel.STATIONS.filter(function (x) { return state.snow.stations[x.triplet]; }).length;
      b.push('<span class="badge ' + (sok === sn ? 'ok' : sok ? 'warn' : 'err') + '" title="NRCS SNOTEL daily snowpack">SNOTEL ' + (sok === sn ? '✓ ' : '') + sok + '/' + sn + '</span>');
    }
    b.push('<span class="badge plain">Fetched ' + stamp(s.fetchedAt) + '</span>');
    $('#feed-badges').innerHTML = b.join('');
  }

  // ---- Totals --------------------------------------------------------------

  function sparkSVG(t, v, opts) {
    opts = opts || {};
    var w = 200, h = opts.h || 44, pad = 3;
    if (!t || t.length < 2) return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"></svg>';
    var t0 = opts.t0 != null ? opts.t0 : t[0], t1 = opts.t1 != null ? opts.t1 : t[t.length - 1];
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), span = hi - lo || Math.abs(hi) * 0.01 || 1;
    lo -= span * 0.15; hi += span * 0.15;
    var x = function (tt) { return ((tt - t0) / (t1 - t0 || 1)) * w; };
    var y = function (vv) { return pad + (1 - (vv - lo) / (hi - lo)) * (h - 2 * pad); };
    var d = '';
    for (var i = 0; i < t.length; i++) d += (i ? 'L' : 'M') + x(t[i]).toFixed(1) + ' ' + y(v[i]).toFixed(1);
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="area" d="' + d + 'L' + x(t[t.length - 1]).toFixed(1) + ' ' + h + 'L' + x(t[0]).toFixed(1) + ' ' + h + 'Z"/>' +
      '<path class="line" d="' + d + '"/></svg>';
  }

  // Last 24 h of a series (relative to now).
  function window24(s) {
    if (!s || !s.t.length) return null;
    var start = Date.now() - 24 * HOUR, i = lastIndexBefore(start, s.t) + 1;
    return { t: s.t.slice(i), v: s.v.slice(i), t0: start, t1: Date.now() };
  }

  function renderTotals() {
    var s = state.snap, tiles = [];

    // BPA-wide hydro (aggregate; not Willamette-specific)
    var bpa = s && s.bpa, bl = bpa && bpa.latest, bf = bl ? H.freshness(bl.epochMs) : 'none';
    var bpaSpark = '';
    if (bpa && bpa.series && bpa.series.length > 1) {
      var bt = bpa.series.map(function (r) { return Date.parse(r[0]); }), bv = bpa.series.map(function (r) { return r[1]; });
      bpaSpark = sparkSVG(bt, bv, { h: 30 });
    }
    tiles.push({
      cls: 'wide',
      label: 'BPA-wide hydro <span class="hint">all hydro in BPA’s balancing authority (Columbia basin, federal + other), NOT Willamette-specific</span>',
      value: !s ? LOADING : bl && bf !== 'very-stale' && bf !== 'none' ? fmt(bl.hydroMW) : NA,
      unit: bl && bf !== 'very-stale' ? 'MW' : '',
      sub: bl ? stamp(bl.epochMs) + ' · ' + ago(bl.epochMs) + (bf !== 'fresh' ? ' <span class="tag watch">STALE</span>' : '') +
        ' · <a href="' + esc(bpa.source) + '" rel="noopener">BPA</a>' : (s ? 'data/bpa.json unavailable' : ''),
      extra: bf === 'fresh' ? bpaSpark + '<div class="spark-cap"><span>−48 H</span><span>NOW</span></div>' : ''
    });

    var rel = s ? H.totalRelease(s) : null;
    tiles.push({
      label: 'Total reservoir release <span class="hint">derived</span>',
      value: !s ? LOADING : rel.cfs != null ? fmt(rel.cfs) : NA, unit: rel && rel.cfs != null ? 'cfs' : '',
      sub: rel ? 'sum of latest outflows · ' + rel.reporting + ' of ' + rel.total + ' reporting' : ''
    });

    var bs = s ? H.basinStorage(s) : null;
    tiles.push({
      label: 'Basin conservation storage <span class="hint">derived (USACE definition)</span>',
      value: !s ? LOADING : bs.pct != null ? fmt(bs.pct, 1) : NA, unit: bs && bs.pct != null ? '%' : '',
      sub: bs ? bs.reporting + ' of ' + bs.total + ' projects with storage' : '',
      bar: bs && bs.pct != null ? bs.pct : null
    });

    var c = { normal: 0, watch: 0, low: 0 }, rep = 0, stale = 0, none = 0;
    all.forEach(function (e) {
      if (!s) return;
      var t = e.kind === 'reservoir' ? (H.latest(projData(e).elev) || {}).t : newestStation(e);
      var f = H.freshness(t);
      if (f === 'fresh') rep++; else if (f === 'none') none++; else stale++;
    });
    tiles.push({
      label: 'Sites reporting',
      value: !s ? LOADING : String(rep), unit: s ? '/ ' + all.length : '',
      sub: s ? '<span class="light watch" aria-hidden="true"></span> ' + stale + ' stale &nbsp;<span class="light low" aria-hidden="true"></span> ' + none + ' no data' : ''
    });

    $('#totals').innerHTML = tiles.map(function (x) {
      return '<div class="tile' + (x.cls ? ' ' + x.cls : '') + '">' +
        '<div class="tile-label">' + x.label + '</div>' +
        '<div class="tile-value"><span>' + x.value + '</span>' + (x.unit ? '<span class="unit">' + x.unit + '</span>' : '') + '</div>' +
        '<div class="tile-sub">' + (x.sub || '') + '</div>' + (x.extra || '') +
        (x.bar != null ? '<div class="tile-bar"><span style="width:' + Math.max(0, Math.min(100, x.bar)).toFixed(1) + '%"></span></div>' : '') +
        '</div>';
    }).join('');
  }

  function newestStation(st) {
    var d = stData(st), n = null;
    st.params.forEach(function (k) { var l = H.latest(d[k]); if (l && (n == null || l.t > n)) n = l.t; });
    return n;
  }

  // ---- Gauge ---------------------------------------------------------------

  function polar(cx, cy, r, deg) {
    var a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }

  function arc(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }

  function fracToDeg(f) { return -120 + 240 * Math.max(0, Math.min(1, f)); }

  /*
   * Elevation gauge. The arc spans the conservation pool (or Dexter's power-pool band)
   * in feet; the needle is the live pool elevation, the amber tick the USACE rule curve.
   */
  function gaugeSVG(key, o) {
    var cx = 60, cy = 56, R = 42, span = o.max - o.min;
    var frac = o.value == null ? null : (o.value - o.min) / span;
    var s = '<svg class="gauge" viewBox="0 0 120 112" role="img" aria-label="' + esc(o.aria) + '">';
    s += '<circle class="face" cx="' + cx + '" cy="' + cy + '" r="54"/>';
    s += '<path class="track" d="' + arc(cx, cy, R, -120, 120) + '"/>';
    if (frac != null && frac > 0.002) s += '<path class="fill" d="' + arc(cx, cy, R, -120, fracToDeg(frac)) + '"/>';
    for (var i = 0; i <= 10; i++) {
      var a = fracToDeg(i / 10), major = i % 5 === 0;
      var p0 = polar(cx, cy, major ? 30 : 33, a), p1 = polar(cx, cy, 37, a);
      s += '<line class="tick' + (major ? ' major' : '') + '" x1="' + p0[0].toFixed(2) + '" y1="' + p0[1].toFixed(2) + '" x2="' + p1[0].toFixed(2) + '" y2="' + p1[1].toFixed(2) + '"/>';
    }
    if (o.marker != null) {
      var ra = fracToDeg((o.marker - o.min) / span), q0 = polar(cx, cy, 36, ra), q1 = polar(cx, cy, 52, ra);
      s += '<line class="rule" x1="' + q0[0].toFixed(2) + '" y1="' + q0[1].toFixed(2) + '" x2="' + q1[0].toFixed(2) + '" y2="' + q1[1].toFixed(2) + '"><title>USACE rule curve ' + fmt(o.marker, 1) + ' ft</title></line>';
    }
    var l0 = polar(cx, cy, 30, -120), l1 = polar(cx, cy, 30, 120);
    s += '<text class="scale" x="' + (l0[0] - 6).toFixed(1) + '" y="' + (l0[1] + 10).toFixed(1) + '">' + fmt(o.min) + '</text>';
    s += '<text class="scale" x="' + (l1[0] + 6).toFixed(1) + '" y="' + (l1[1] + 10).toFixed(1) + '" text-anchor="end">' + fmt(o.max) + '</text>';
    if (frac != null) {
      var deg = fracToDeg(frac), from = state.angles[key] != null ? state.angles[key] : -120;
      s += '<line class="needle" x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="' + (cy - 38) + '" data-deg="' + deg.toFixed(1) +
        '" data-key="' + key + '" style="transform-origin:' + cx + 'px ' + cy + 'px;transform:rotate(' + from + 'deg)"/>';
    }
    s += '<circle class="hub" cx="' + cx + '" cy="' + cy + '" r="4"/>';
    s += '<text class="val' + (o.small ? ' small' : '') + '" x="' + cx + '" y="' + (cy + 40) + '">' + esc(o.center) + '</text>';
    s += '<text class="cap" x="' + cx + '" y="' + (cy + 50) + '">' + esc(o.caption) + '</text>';
    return s + '</svg>';
  }

  function sweepNeedles(root) {
    var needles = (root || document).querySelectorAll('.needle[data-deg]');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        needles.forEach(function (n) {
          n.style.transform = 'rotate(' + n.getAttribute('data-deg') + 'deg)';
          state.angles[n.getAttribute('data-key')] = +n.getAttribute('data-deg');
        });
      });
    });
  }

  function reservoirGauge(p, key) {
    var d = projData(p), e = d && H.latest(d.elev), r = d && H.ruleToday(d.rule);
    if (!p.cons && !p.powerPool) {
      // Conservation limits not loaded yet (or not published): scale on recent pool and rule values.
      var vals = [];
      if (d && d.elev) vals = vals.concat(d.elev.v);
      if (r) vals.push(r.v);
      var lo = vals.length ? Math.floor(Math.min.apply(null, vals) - 5) : 0, hi = vals.length ? Math.ceil(Math.max.apply(null, vals) + 5) : 1;
      return gaugeSVG(key, {
        min: lo, max: hi, value: e ? e.v : null, marker: r ? r.v : null,
        center: !d ? '…' : e ? fmt(e.v, 1) + ' ft' : '—', small: true, caption: p.consFromLevels && p.consTried !== true ? 'LIMITS LOADING' : '7-DAY RANGE',
        aria: p.name + ' pool elevation ' + (e ? fmt(e.v, 1) + ' ft' : 'no data')
      });
    }
    if (!p.cons) {
      var b = p.powerPool;
      return gaugeSVG(key, {
        min: b.elevBottom, max: b.elevTop, value: e ? e.v : null, marker: r ? r.v : null,
        center: !d ? '…' : e ? fmt(e.v, 1) + ' ft' : '—', small: true, caption: 'POWER POOL BAND',
        aria: p.name + ' pool elevation ' + (e ? fmt(e.v, 1) + ' ft' : 'no data') + ' within the ' + b.elevBottom + ' to ' + b.elevTop + ' ft power pool band'
      });
    }
    var st = d && H.latest(d.stor), pf = st ? H.percentFull(p, st.v) : null;
    return gaugeSVG(key, {
      min: p.cons.elevBottom, max: p.cons.elevTop, value: e ? e.v : null, marker: r ? r.v : null,
      center: !d ? '…' : !pf ? '—' : pf.below ? 'BELOW' : fmt(pf.clamped, 1) + '%',
      small: pf && pf.below, caption: !d ? 'LOADING' : !pf ? 'NO STORAGE' : pf.below ? 'CONS. POOL' : '% FULL · DERIVED',
      aria: p.name + ': ' + (pf ? (pf.below ? 'below conservation pool' : fmt(pf.clamped, 1) + ' percent full (derived)') : 'no storage data') +
        '; pool elevation ' + (e ? fmt(e.v, 1) + ' ft' : 'no data')
    });
  }

  // ---- Basin map -----------------------------------------------------------

  function smoothPath(pts) {
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += 'C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ' ' +
        (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ' ' + p2[0] + ' ' + p2[1];
    }
    return d;
  }

  function renderMapBase() {
    var m = H.basinMap, svg = $('#basin-map'), s = '';
    svg.setAttribute('viewBox', m.viewBox.join(' '));
    m.rivers.forEach(function (rv) {
      var d = smoothPath(rv.points);
      s += '<path class="river-bed" d="' + d + '" stroke-width="' + (rv.main ? 7 : 4.5) + '"/>';
      s += '<path class="river-flow" d="' + d + '" stroke-width="' + (rv.main ? 2.4 : 1.6) + '" style="animation-duration:' + (rv.main ? 1.8 : 2.4) + 's"/>';
      s += '<text class="river-label" transform="translate(' + rv.labelAt[0] + ' ' + rv.labelAt[1] + ') rotate(' + rv.labelRotate + ')">' + esc(rv.label) + '</text>';
    });
    m.places.forEach(function (p) {
      s += '<text class="place-label" x="' + p.x + '" y="' + p.y + '" text-anchor="' + p.anchor + '">' + esc(p.label) + '</text>';
    });
    s += '<g id="map-nodes"></g>';
    svg.innerHTML = s;

    // Tap selects the nearest node within a generous radius, so small nodes stay easy to hit on phones.
    svg.addEventListener('click', function (ev) {
      var g = ev.target.closest('.node'), best = g ? g.getAttribute('data-id') : null;
      var ctm = svg.getScreenCTM();
      if (ctm) {
        var pt = svg.createSVGPoint();
        pt.x = ev.clientX; pt.y = ev.clientY;
        var p = pt.matrixTransform(ctm.inverse()), bestD = 30;
        all.forEach(function (e) {
          var dd = Math.hypot(e.map.x - p.x, e.map.y - p.y);
          if (dd < bestD) { bestD = dd; best = e.id; }
        });
      }
      if (best) select(best, true);
    });
    svg.addEventListener('keydown', function (ev) {
      var g = ev.target.closest && ev.target.closest('.node');
      if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(g.getAttribute('data-id'), true); }
    });
  }

  function renderMapNodes() {
    var s = '', focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.node');
    var focusId = focused ? focused.getAttribute('data-id') : null;
    all.forEach(function (e) {
      var dam = e.kind === 'reservoir', st = statusOf(e), sel = e.id === state.selectedId;
      var label = (dam ? 'Dam: ' : 'USGS gauge: ') + e.name + ', ' + st.label.toLowerCase();
      s += '<g class="node ' + (dam ? 'dam' : 'station') + (sel ? ' selected' : '') + '" data-id="' + e.id + '" tabindex="0" role="button" aria-pressed="' + sel +
        '" aria-label="' + esc(label) + '" transform="translate(' + e.map.x + ' ' + e.map.y + ')">';
      s += '<circle class="hit" r="22"/>';
      s += '<circle class="halo ' + st.level + '" r="7"/>';
      s += dam ? '<rect class="body" x="-7.5" y="-7.5" width="15" height="15" rx="2"/>' : '<circle class="body" r="7"/>';
      s += '<circle class="core ' + st.level + '" r="' + (dam ? 3.8 : 3.4) + '"/>';
      s += '<circle class="ring" r="13"/>';
      s += '<text class="node-label" x="' + e.map.lx + '" y="' + e.map.ly + '" text-anchor="' + e.map.anchor + '">' + esc(e.short || e.name.toUpperCase()) + '</text>';
      s += '</g>';
    });
    $('#map-nodes').innerHTML = s;
    if (focusId) { var n = document.querySelector('.node[data-id="' + focusId + '"]'); if (n) n.focus(); }
  }

  // ---- NWS flood categories + forecast (NOAA NWPS) --------------------------

  var N = H.nwps;
  var fmtDayUTC = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

  function nwpsGauge(s) { var o = state.nwps && state.nwps[s.id]; return o ? o.gauge : null; }

  function fcatBadge(cat, prefix) {
    return '<span class="fcat fcat-' + cat + '">' + prefix + esc((N.LABEL[cat] || cat).toUpperCase()) + '</span>';
  }

  function thresholdsLine(th) {
    return N.CATS.filter(function (c) { return th[c].stage != null; }).map(function (c) {
      return '<span class="fth fth-' + c + '">' + N.LABEL[c] + ' ' + fmt(th[c].stage, 1) + '</span>';
    }).join(' ') + ' <span class="hint">ft (NWS flood stages)</span>';
  }

  // Horizontal ruler: flood-category bands (live NWS thresholds), current stage, 7-day forecast peak.
  function floodRuler(th, stage, peak) {
    var w = 200, top = 0;
    N.CATS.forEach(function (c) { if (th[c].stage != null) top = Math.max(top, th[c].stage); });
    top = Math.max(top, stage || 0, (peak && peak.stage) || 0) * 1.1;
    var x = function (v) { return Math.max(0, Math.min(w, (v / top) * w)); };
    var s = '<svg class="flood-ruler" viewBox="0 0 ' + w + ' 26" preserveAspectRatio="none" aria-hidden="true">';
    s += '<rect class="fr-track" x="0" y="9" width="' + w + '" height="8"/>';
    var defined = N.CATS.filter(function (c) { return th[c].stage != null; });
    defined.forEach(function (c, i) {
      var a = x(th[c].stage), b = i < defined.length - 1 ? x(th[defined[i + 1]].stage) : w;
      s += '<rect class="fr-' + c + '" x="' + a.toFixed(1) + '" y="9" width="' + Math.max(0, b - a).toFixed(1) + '" height="8"/>';
    });
    if (peak) s += '<line class="fr-peak" x1="' + x(peak.stage).toFixed(1) + '" x2="' + x(peak.stage).toFixed(1) + '" y1="3" y2="23"/>';
    if (stage != null) s += '<path class="fr-now" d="M' + x(stage).toFixed(1) + ' 8 l-4 -6 h8 z M' + x(stage).toFixed(1) + ' 8 v10"/>';
    return s + '</svg>';
  }

  // Flood block for a river card (full=false) or the details panel (full=true).
  function floodBlock(s, full) {
    if (!N) return '';
    var lid = N.LIDS[s.id];
    if (lid === null) return '<div class="flood"><p class="flood-note">No NWS flood stages published for this gauge.</p></div>';
    if (!state.nwps) return '<div class="flood"><p class="flood-note">' + LOADING + '</p></div>';
    var o = state.nwps[s.id], g = o && o.gauge;
    if (!g) return '<div class="flood"><p class="flood-note warntext">NWS data unavailable' + (o && o.error ? ' (' + esc(o.error) + ')' : '') + '.</p></div>';
    var th = g.thresholds, d = stData(s), us = d && H.latest(d.stage);
    var stage = us ? us.v : g.observed.stage;
    var nowCat = g.observed.category || N.categoryFor(stage, th);
    var peak = g.peak, fcCat = g.nwsForecastCategory || (peak && peak.category);
    var h = '<div class="flood"><div class="flood-badges">';
    h += nowCat ? fcatBadge(nowCat, 'NWS NOW: ') : '<span class="fcat">NWS: NO CATEGORY</span>';
    if (fcCat && fcCat !== nowCat) h += fcatBadge(fcCat, 'FORECAST: ');
    if (o.stale) h += '<span class="tag watch">CACHED</span>';
    h += '</div>';
    if (th) h += floodRuler(th, stage, peak) + '<p class="flood-note mono">' + thresholdsLine(th) + '</p>';
    else h += '<p class="flood-note">No NWS flood stages published for this gauge.</p>';
    h += peak
      ? '<p class="flood-note">Forecast peak (7 d): <b>' + fmt(peak.stage, 2) + ' ft</b>' + (peak.flow != null ? ' · ' + fmt(peak.flow) + ' cfs' : '') + ' · ' + stamp(peak.t) + '</p>'
      : '<p class="flood-note">No current NWS forecast.</p>';
    if (full) {
      if (g.forecast) h += '<p class="flood-note hint">NWS/NWRFC forecast (via NOAA NWPS), issued ' + stamp(g.forecast.issued) + '.</p>';
      if (g.observed.stage != null) h += '<p class="flood-note hint">NWPS observed: ' + fmt(g.observed.stage, 2) + ' ft' +
        (g.observed.flow != null ? ' · ' + fmt(g.observed.flow) + ' cfs' : '') + (g.observed.t ? ' · ' + stamp(g.observed.t) : '') + '</p>';
      if (g.crests.length) h += '<p class="flood-note">Historic crests (NWS): ' + g.crests.map(function (c) {
        return '<b>' + fmt(c.stage, 1) + ' ft</b> ' + fmtDayUTC.format(new Date(c.t));
      }).join(' · ') + '</p>';
    }
    return h + '</div>';
  }

  // ---- TDG (Dexter / Cougar tailwater) --------------------------------------

  function tdgChip(p) {
    if (!H.tdg || !H.tdg.SERIES[p.code]) return '';
    return H.tdg.chipHTML(p.code, state.tdg ? state.tdg[p.code] : null, stamp);
  }

  // ---- ODEQ 2006 TMDL temperature target (published level) -------------------
  // Drawn only where a USGS temperature gauge sits directly below the project.
  var ODEQ_AT = {
    'middle-fork-jasper': { code: 'DEX', label: 'ODEQ 2006 TMDL target for DEX/LOP (published; applies at the dam tailwater, nearest gauge shown for context)' }
  };
  var odeqLoading = {};

  function odeqEntry(stationId) {
    var cfg = ODEQ_AT[stationId], LV = H.levels;
    if (!cfg || !LV) return null;
    var lv = LV.peekProjectLevels(cfg.code);
    if (!lv) {
      if (!odeqLoading[cfg.code]) {
        odeqLoading[cfg.code] = true;
        LV.fetchProjectLevels(cfg.code).then(function () { renderChart(false); renderDetails(); }, function () { odeqLoading[cfg.code] = 'failed'; renderChart(false); });
      }
      return { cfg: cfg, entry: null, loading: odeqLoading[cfg.code] === true };
    }
    return { cfg: cfg, entry: LV.pick(lv, LV.IDS.odeqTemp, Date.now()) };
  }

  // ---- Readouts ------------------------------------------------------------

  function reservoirReadouts(p, full) {
    var d = projData(p), L = function (k) { return d && H.latest(d[k]); };
    var e = L('elev'), r = d && H.ruleToday(d.rule), st = L('stor'), out = L('out'), inn = L('inflow');
    var h = kvVal('Pool elev', val(e, 1, 'ft', 'hl', e ? staleTag(e.t).trim() : ''));
    var dev = e && r ? e.v - r.v : null;
    h += kv('vs rule curve', !d ? LOADING : dev == null ? NA : signed(dev, 1), dev == null ? '' : 'ft', '', r ? 'USACE rule ' + fmt(r.v, 1) + ' ft today' : '');
    if (p.cons) {
      var pf = st ? H.percentFull(p, st.v) : null;
      h += kv('% full <span class="hint">derived</span>', !d ? LOADING : !pf ? NA : pf.below ? 'Below cons. pool' : fmt(pf.clamped, 1),
        pf && !pf.below ? '%' : '', pf && pf.below ? 'watchtext' : '', pf ? '(storage − bottom) ÷ conservation capacity' : '');
    } else if (p.powerPool) {
      h += kv('% full', 'n/a', '', 'na', 'No conservation pool (run-of-river). Band ' + p.powerPool.elevBottom + '–' + p.powerPool.elevTop + ' ft');
    } else {
      h += kv('% full', p.consFromLevels && p.consTried !== true ? LOADING : NA, '', 'na', 'needs CWMS conservation limits');
    }
    h += kvVal('Outflow', val(out, 0, 'cfs', '', p.cbt ? 'hourly average' : ''));
    h += kvVal('Computed inflow', val(inn, 0, 'cfs', inn && inn.v < 0 ? 'neg' : '', inn ? (inn.v < 0 ? 'computed from storage change; negative as reported' : 'computed by USACE') : ''));
    if (full) {
      h += kvVal('Storage', p.noStorage ? { html: 'n/a', unit: '', cls: 'na', sub: 'not published' } : val(st, 0, 'ac-ft'));
      if (p.cons) h += kv('Conservation pool', fmt(p.cons.elevBottom, 1) + '–' + fmt(p.cons.elevTop, 1), 'ft', '', 'CWMS bottom/top of conservation' + (p.consFromLevels ? ' (read at runtime)' : ''));
    }
    return '<dl class="kv">' + h + '</dl>';
  }

  function stationReadouts(s, full) {
    var d = stData(s), L = function (k) { return d && H.latest(d[k]); };
    var flow = L('flow'), stage = L('stage'), tc = L('tempC');
    var h = s.params.indexOf('flow') < 0
      ? kv('Flow', !d ? LOADING : NA, '', '', 'no discharge series published for this gauge')
      : kvVal('Flow', val(flow, 0, 'cfs', s.primary === 'flow' ? 'hl' : '', flow && isProvisional(flow.q) ? 'provisional' : ''));
    h += kvVal('Stage', val(stage, 2, 'ft', s.primary === 'stage' ? 'hl' : '', stage && isProvisional(stage.q) ? 'provisional' : ''));
    var tf = tc ? { v: H.cToF(tc.v) } : null;
    h += kvVal('Water temp', val(tf, 1, '°F', '', tc ? fmt(tc.v, 1) + ' °C as reported' : ''));
    var prim = d && H.stationPrimary(s, d), w = window24(prim);
    var ch = w && w.v.length > 1 ? w.v[w.v.length - 1] - w.v[0] : null;
    var unit = s.primary === 'flow' ? 'cfs' : 'ft';
    h += kv('24 h change <span class="hint">derived</span>', !d ? LOADING : ch == null ? NA : signed(ch, s.primary === 'flow' ? 0 : 2), ch == null ? '' : unit, '', s.primary === 'stage' ? 'stage' : 'flow');
    if (full) {
      h += kv('USGS site', s.site, '', '', esc(s.usgsName));
    }
    return '<dl class="kv">' + h + '</dl>';
  }

  // Per-series reading table for the details panel.
  function readingsTable(rows) {
    return '<table class="readings mono"><thead><tr><th>Series</th><th>Last reading (PT)</th><th>Age</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var age = r.t == null ? '' : r.daily ? 'daily value for today' : ago(r.t) + staleTag(r.t);
        return '<tr><td>' + r.label + '</td><td>' + (r.t == null ? NA : stamp(r.t)) + '</td><td>' + age + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function sourceLinks(e) {
    if (e.kind === 'river') {
      var lid = N && N.LIDS[e.id];
      return '<p class="src">Source: <a href="' + e.sourceUrl + '" rel="noopener">USGS ' + e.site + ' ↗</a>' +
        (lid ? ' · <a href="' + N.gaugeUrl(lid) + '" rel="noopener">NWS ' + lid + ' ↗</a>' : '') + '</p>';
    }
    return '<p class="src">Source: <a href="' + e.sourceUrl + '" rel="noopener">USACE Access to Water ↗</a> · <a href="' + esc(e.apiUrl) +
      '" rel="noopener" title="Raw CWMS Data API, last 24 h (browsers receive XML)">CWMS elevation series ↗</a></p>';
  }

  // ---- Detail panel --------------------------------------------------------

  function renderDetails() {
    var e = byId[state.selectedId], st = statusOf(e), h;
    var isRes = e.kind === 'reservoir';
    var sub = isRes ? e.river + ' · ' + e.purpose : e.river + ' · USGS ' + e.site;
    h = '<div class="detail-head"><div><span class="panel-tag mono">' + (isRes ? 'USACE PROJECT ' + e.code : 'USGS RIVER GAUGE') + '</span>' +
      '<h2>' + esc(e.name) + '</h2><p>' + esc(sub) + '</p></div>' + statusPill(st) + '</div>';
    if (isRes) {
      var d = projData(e);
      h += '<div class="detail-gauge">' + reservoirGauge(e, 'detail') + reservoirReadouts(e, true) + '</div>';
      h += tdgChip(e);
      var w = d && window24(d.elev);
      if (w && w.t.length > 1) h += '<div>' + sparkSVG(w.t, w.v, { t0: w.t0, t1: w.t1 }) + '<div class="spark-cap"><span>−24 H</span><span>POOL ELEV · ft</span><span>NOW</span></div></div>';
      if (d) {
        h += readingsTable([
          { label: 'Pool elevation', t: (H.latest(d.elev) || {}).t },
          { label: 'Storage', t: e.noStorage ? null : (H.latest(d.stor) || {}).t },
          { label: 'Outflow', t: (H.latest(d.out) || {}).t },
          { label: 'Computed inflow', t: (H.latest(d.inflow) || {}).t },
          { label: 'Rule curve (daily)', t: (H.ruleToday(d.rule) || {}).t, daily: true }
        ]);
      }
    } else {
      var sd = stData(e);
      h += stationReadouts(e, true);
      h += floodBlock(e, true);
      var oq = ODEQ_AT[e.id] && H.levels && H.levels.peekProjectLevels(ODEQ_AT[e.id].code) ? odeqEntry(e.id) : null;
      if (oq && oq.entry) {
        var ov = H.levels.evalSeasonal(oq.entry, Date.now());
        h += '<p class="flood-note">ODEQ 2006 TMDL temperature target for DEX/LOP today: <b>' + (ov == null ? 'none published for today' : fmt(H.cToF(ov), 1) + ' °F (' + fmt(ov, 1) + ' °C)') +
          '</b> <span class="hint">published target at the dam tailwater; Jasper is the nearest gauge, shown for context.</span></p>';
      }
      var pw = sd && window24(H.stationPrimary(e, sd));
      if (pw && pw.t.length > 1) h += '<div>' + sparkSVG(pw.t, pw.v, { t0: pw.t0, t1: pw.t1 }) + '<div class="spark-cap"><span>−24 H</span><span>' + (e.primary === 'flow' ? 'FLOW · cfs' : 'STAGE · ft') + '</span><span>NOW</span></div></div>';
      if (sd) {
        h += readingsTable(e.params.map(function (k) {
          return { label: { flow: 'Discharge (00060)', stage: 'Gage height (00065)', tempC: 'Water temp (00010)' }[k], t: (H.latest(sd[k]) || {}).t };
        }));
      }
    }
    if (st.reason) h += '<p class="detail-note ' + st.level + '">' + esc(st.reason) + ' <span class="hint">Status derived by this site.</span></p>';
    h += sourceLinks(e);
    h += '<div><a class="btn" href="#trends" id="open-trend">Open trend ▸</a></div>';
    var panel = $('#details');
    panel.innerHTML = h;
    sweepNeedles(panel);
    $('#open-trend').addEventListener('click', function () { setChart(e.id); });
  }

  // ---- Cards ---------------------------------------------------------------

  function cardShell(e, sub, body) {
    var st = statusOf(e);
    return '<article class="card' + (e.id === state.selectedId ? ' selected' : '') + '" data-id="' + e.id + '">' +
      '<div class="card-head"><div><h3><button type="button" class="card-select" aria-label="Show details for ' + esc(e.name) + '">' + esc(e.name) + '</button></h3><p>' + esc(sub) + '</p></div>' +
      statusPill(st) + '</div>' + body + '</article>';
  }

  function renderCards() {
    $('#reservoir-cards').innerHTML = H.projects.map(function (p) {
      var d = projData(p), e = d && H.latest(d.elev);
      return cardShell(p, p.river + (p.hydro ? ' · hydropower' : ' · flood control'),
        '<div class="detail-gauge">' + reservoirGauge(p, 'card-' + p.id) + reservoirReadouts(p, false) + '</div>' + tdgChip(p) +
        (d ? readingLine(e && e.t, 'Last pool reading') : '') + sourceLinks(p));
    }).join('');
    $('#river-cards').innerHTML = H.stations.map(function (s) {
      var d = stData(s), prim = d && H.stationPrimary(s, d), w = window24(prim);
      return cardShell(s, s.river + ' · USGS ' + s.site, stationReadouts(s, false) + floodBlock(s, false) +
        (w && w.t.length > 1 ? '<div>' + sparkSVG(w.t, w.v, { t0: w.t0, t1: w.t1 }) + '<div class="spark-cap"><span>−24 H</span><span>' + (s.primary === 'flow' ? 'FLOW' : 'STAGE') + '</span><span>NOW</span></div></div>' : '') +
        (d ? readingLine(newestStation(s)) : '') + sourceLinks(s));
    }).join('');
    sweepNeedles($('#reservoir-cards'));
  }

  function bindCards() {
    ['#reservoir-cards', '#river-cards'].forEach(function (sel) {
      $(sel).addEventListener('click', function (ev) {
        if (ev.target.closest('a')) return;
        var c = ev.target.closest('.card');
        if (c) select(c.getAttribute('data-id'), true);
      });
    });
  }

  // ---- Snowpack (NRCS SNOTEL) --------------------------------------------------

  var fSnowDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

  function snowSpark(o) {
    if (!o || o.swe.v.length < 2) return '';
    var v = o.swe.v.slice(-7), w = 120, h = 28, hi = Math.max(1, Math.max.apply(null, v));
    var d = v.map(function (x, i) { return (i ? 'L' : 'M') + ((i / (v.length - 1)) * w).toFixed(1) + ' ' + (h - 2 - (x / hi) * (h - 4)).toFixed(1); }).join('');
    return '<svg class="snow-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="' + w + '" y1="' + (h - 2) + '" y2="' + (h - 2) + '" class="snow-base"/><path d="' + d + '"/></svg>';
  }

  function renderSnow() {
    var box = $('#snow-grid');
    if (!box || !H.snotel) return;
    var sn = state.snow;
    if (!sn) { box.innerHTML = '<p class="na loading">Loading SNOTEL…</p>'; return; }
    if (sn.error && !Object.keys(sn.stations).length) { box.innerHTML = '<p class="warntext">SNOTEL data unavailable (' + esc(sn.error) + ').</p>'; return; }
    box.innerHTML = '<table class="snow-table"><thead><tr><th>Station</th><th>SWE</th><th>Depth</th><th>SWE 7 d</th><th>Last report</th></tr></thead><tbody>' +
      H.snotel.STATIONS.map(function (st) {
        var o = sn.stations[st.triplet];
        var swe = o && o.swe.v.length ? o.swe.v[o.swe.v.length - 1] : null, dep = o && o.depth.v.length ? o.depth.v[o.depth.v.length - 1] : null;
        return '<tr><td><b>' + esc(st.name) + '</b><span class="snow-meta">' + fmt(st.elevFt) + ' ft · ' + esc(st.basin) + '</span></td>' +
          '<td class="mono">' + (swe == null ? NA : fmt(swe, 1) + ' in') + '</td><td class="mono">' + (dep == null ? NA : fmt(dep, 0) + ' in') + '</td>' +
          '<td>' + (o ? snowSpark(o) : '') + '</td><td class="mono">' + (o && o.last ? fSnowDay.format(new Date(o.last + 'T12:00:00Z')) : NA) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ---- Selection -----------------------------------------------------------

  function select(id, withChart) {
    if (!byId[id]) return;
    state.selectedId = id;
    document.querySelectorAll('.node, .card').forEach(function (n) {
      var on = n.getAttribute('data-id') === id;
      n.classList.toggle('selected', on);
      if (n.classList.contains('node')) n.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderDetails();
    if (withChart) setChart(id);
  }

  // ---- Trend chart ---------------------------------------------------------

  function niceTicks(lo, hi, count) {
    var span = hi - lo || 1;
    var raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var t = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) t.push(+v.toFixed(10));
    return { ticks: t, step: step };
  }

  var RANGE_H = { '24h': 24, '7d': 168, '30d': 30 * 24, '6m': 182 * 24, '1y': 365 * 24, year: 365 * 24, years: 365 * 24 };
  var RANGE_TAG = { '24h': 'LAST 24 H', '7d': 'LAST 7 D', '30d': 'LAST 30 D', '6m': 'LAST 6 MO', '1y': 'LAST 1 YR', year: 'CALENDAR YEAR', years: 'PAST YEARS' };
  function isLong(r) { return r === '30d' || r === '6m' || r === '1y' || r === 'year'; }
  var fYearNum = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' });
  function curYear() { return +fYearNum.format(new Date()); }

  // ---- Chart layers (js/layers.js): level lines, 30-yr bands, target, strips ------------

  var L = H.layers;
  function chartItem(key) { return L ? L.CHART_TOGGLES.filter(function (x) { return x.key === key; })[0] : null; }
  function layerOn(key) { var it = chartItem(key); return !!(it && L.isOn(it)); }
  function stripItem(e, def) { return { key: 'strip:' + (e.kind === 'reservoir' ? 'res' : 'riv') + ':' + def.key, on: def.on }; }

  // CWMS location levels for a project (cached by js/cwms-levels.js); re-renders when they land.
  function levelsFor(e) {
    if (e.kind !== 'reservoir' || !H.levels) return null;
    var c = state.lv[e.code];
    if (c && !c.loading) return c.data;
    if (!c) {
      state.lv[e.code] = { loading: true };
      H.levels.fetchProjectLevels(e.code).then(function (lv) { state.lv[e.code] = { data: lv }; }, function () { state.lv[e.code] = { data: null }; })
        .then(function () { if (state.chartId === e.id) renderChart(false); });
    }
    return null;
  }

  // Long-range history for the charted point (cached in js/history.js); re-renders when it lands.
  function histFor(e) {
    if (!isLong(state.range) || !H.history) return null;
    var key = e.id + ':' + state.range, hv = state.hist[key];
    if (hv && !hv.loading) return hv;
    if (!hv) {
      state.hist[key] = { loading: true };
      var d = e.kind === 'reservoir' ? projData(e) : null;
      // Calendar YEAR: reservoirs read the year's lake record (plus live readings); rivers use the 1-yr history.
      var pr = state.range !== 'year' ? H.history.load(e, state.range, d && d.elev)
        : e.kind === 'reservoir' ? H.history.loadYear(e, curYear()).then(function (r) { if (r.pool && d && d.elev) r.pool = H.history.appendLive(r.pool, d.elev); return r; })
          : H.history.load(e, '1y', null);
      pr.then(function (r) {
        state.hist[key] = r;
        if (state.chartId === e.id && e.id + ':' + state.range === key) renderChart(true);
        setTimeout(function () { if (state.hist[key] === r) delete state.hist[key]; }, 30 * 60 * 1000);
      });
    }
    return state.hist[key];
  }

  function chartModel() {
    var e = byId[state.chartId], res = e.kind === 'reservoir';
    var long = isLong(state.range), hist = long ? histFor(e) : null, hLoading = !!(hist && hist.loading);
    var now = Date.now(), end = now, start = now - RANGE_H[state.range] * HOUR;
    if (state.range === 'year') { start = H.history.pacificMidnight(curYear(), 1, 1); end = H.history.pacificMidnight(curYear() + 1, 1, 1); }
    var s, ref = null, unit, dec, title, src, param = null, g = null;
    if (res) {
      var d = projData(e);
      s = long ? hist && hist.pool : d && d.elev; ref = long ? hist && hist.rule : d && d.rule; unit = 'ft'; dec = 2;
      title = e.name + ' · pool elevation (ft)';
      src = long
        ? (hist && hist.src ? hist.src + (hist.pool && hist.pool.liveFrom ? stamp(hist.pool.liveFrom) + ' (hourly)' : '') : 'loading history…') +
          '; dashed: ' + e.series.rule.name + ' (USACE rule curve, daily, linearly joined).' + (hist && hist.note ? ' ' + hist.note : '')
        : 'USACE CWMS (NWDP) ' + e.series.elev.name + '; dashed: ' + e.series.rule.name + ' (USACE rule curve, daily, linearly joined).';
    } else {
      var sd = stData(e);
      param = state.riverParam === 'temp' ? 'temp' : e.params.indexOf('flow') >= 0 && state.riverParam === 'flow' ? 'flow' : 'stage';
      if (param === 'temp') {
        // USGS reports °C; the site displays °F (°C kept in tooltips/details).
        var tsrc = long ? hist && hist.tempC : sd && sd.tempC;
        var tc = tsrc && tsrc.t.length ? tsrc : null;
        s = tc ? { t: tc.t, v: tc.v.map(H.cToF), q: tc.q } : null;
        unit = '°F'; dec = 1;
        title = e.name + ' · water temperature (°F)';
        src = 'USGS NWIS site ' + e.site + ', parameter 00010 water temperature (reported in °C, shown in °F)' + (long && hist && hist.src ? ', ' + hist.src : '') + '. Values flagged P are provisional.';
      } else {
        var psrc = long ? hist && hist[param] : sd && sd[param];
        s = psrc && psrc.t.length ? psrc : null;
        unit = param === 'flow' ? 'cfs' : 'ft'; dec = param === 'flow' ? 0 : 2;
        title = e.name + (param === 'flow' ? ' · discharge (cfs)' : ' · gage height (ft)');
        src = 'USGS NWIS site ' + e.site + ', parameter ' + (param === 'flow' ? '00060 discharge' : '00065 gage height') + (long && hist && hist.src ? ', ' + hist.src : '') + '. Values flagged P are provisional.' +
          (e.params.indexOf('flow') < 0 ? ' This gauge has no discharge series, so stage is charted.' : '');
        g = nwpsGauge(e);
      }
    }
    var gBands = g;
    if (long) g = null; // NWS forecast extension only on the 24 H / 7 D views
    // NWS forecast as a dashed extension to the right of "now" (river gauges only).
    var fc = { t: [], v: [] }, issued = null, bands = [], fcNote = '';
    if (g && g.forecast && s && s.t.length) {
      var fv = param === 'flow' ? g.forecast.flow : g.forecast.stage, lastT = s.t[s.t.length - 1];
      var fcEnd = now + (state.range === '24h' ? 24 : 168) * HOUR; // mirror the history window
      fc.t.push(lastT); fc.v.push(s.v[s.v.length - 1]);
      for (var f = 0; f < g.forecast.t.length; f++) {
        if (g.forecast.t[f] <= lastT || fv[f] == null) continue;
        fc.t.push(g.forecast.t[f]); fc.v.push(fv[f]);
        if (g.forecast.t[f] > fcEnd) break;
      }
      if (fc.t.length > 1) {
        issued = g.forecast.issued;
        end = Math.max(now, Math.min(fc.t[fc.t.length - 1], fcEnd));
        src += ' Dashed: NWS/NWRFC forecast (via NOAA NWPS), issued ' + stamp(issued) + '.';
      } else {
        fc = { t: [], v: [] };
        if (param === 'flow') fcNote = 'NWS forecast has no flow values for this gauge; switch to Stage.';
      }
    } else if (!long && !res && param !== 'temp' && N && N.LIDS[e.id] && state.nwps && !g) {
      fcNote = 'NWS data unavailable.';
    }
    // Zoom: narrow [start, end] to the visible window; everything below samples only inside it.
    var fullStart = start, fullEnd = end, zoomed = state.tzoom[0] > 0 || state.tzoom[1] < 1;
    if (zoomed) {
      start = fullStart + state.tzoom[0] * (fullEnd - fullStart);
      end = fullStart + state.tzoom[1] * (fullEnd - fullStart);
      if (fc.t.length) {
        var keep = { t: [], v: [] };
        fc.t.forEach(function (ft, k) { if (ft >= start && ft <= end || (fc.t[k + 1] >= start && ft < start) || (fc.t[k - 1] <= end && ft > end)) { keep.t.push(ft); keep.v.push(fc.v[k]); } });
        fc = keep.t.length > 1 ? keep : { t: [], v: [] };
      }
    }
    if (param === 'stage' && gBands && gBands.thresholds) {
      var defined = N.CATS.filter(function (c) { return gBands.thresholds[c].stage != null; });
      defined.forEach(function (c, i) {
        bands.push({ cat: c, lo: gBands.thresholds[c].stage, hi: i < defined.length - 1 ? gBands.thresholds[defined[i + 1]].stage : null });
      });
      if (bands.length) src += ' Bands: NWS flood categories (live from NOAA NWPS).';
    }
    var t = [], v = [], q = [];
    if (s && s.t.length) {
      // Points inside [start, end] (plus one either side when zoomed, so lines reach the edges), thinned to ~900.
      var i0 = lastIndexBefore(start, s.t) + (zoomed ? 0 : 1), i1 = s.t.length - 1;
      if (i0 < 0) i0 = 0;
      if (zoomed) { var ie = lastIndexBefore(end, s.t); i1 = Math.min(s.t.length - 1, ie + 1); }
      var n = i1 - i0 + 1, step = Math.max(1, Math.ceil(n / 900));
      for (var i = i0; i <= i1; i += step) { t.push(s.t[i]); v.push(s.v[i]); q.push(s.q ? s.q[i] : null); }
      if (n > 0 && t[t.length - 1] !== s.t[i1]) { t.push(s.t[i1]); v.push(s.v[i1]); q.push(s.q ? s.q[i1] : null); }
    }
    var rt = [], rv = [];
    if (res && !layerOn('rule')) ref = null;
    if (ref && ref.t.length) {
      var a = H.interpolate(ref, start); if (a != null) { rt.push(start); rv.push(a); }
      for (var k = 0; k < ref.t.length; k++) if (ref.t[k] > start && ref.t[k] < end) { rt.push(ref.t[k]); rv.push(ref.v[k]); }
      var b = H.interpolate(ref, end); if (b != null) { rt.push(end); rv.push(b); }
    }
    // ODEQ 2006 TMDL temperature target (published seasonal level, °C -> °F), Jasper only.
    var tt = [], tv = [], tLabel = '', tNote = '';
    if (param === 'temp') {
      var oq = odeqEntry(e.id);
      if (!oq) tNote = 'No ODEQ temperature target drawn: published targets apply at the dams, and no project sits directly above this gauge (e.g. Cottage Grove is far upstream of Goshen).';
      else if (oq.loading) tNote = 'Loading ODEQ target…';
      else if (!oq.entry) tNote = 'ODEQ target level unavailable.';
      else {
        H.levels.seasonalSeries(oq.entry, start, end).forEach(function (p) { tt.push(p[0]); tv.push(p[1] == null ? null : H.cToF(p[1])); });
        tLabel = oq.cfg.label;
        src += ' Dashed: ' + oq.cfg.code + '.Temp-Water.Inst.0.ODEQ-2006TMDL-Target (CWMS level, monthly steps).';
      }
    }
    // Reservoir layers: 30-yr statistics bands, published target, level lines (CWMS location levels).
    var lv = res ? levelsFor(e) : null, LVm = H.levels, stats = null, target = null, levels = [];
    if (lv && LVm) {
      if (layerOn('stats')) {
        stats = {};
        ['statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95'].forEach(function (k) { stats[k] = LVm.seasonalSeries(LVm.pick(lv, LVm.IDS[k], now), start - DAY, end + DAY).filter(function (p) { return p[1] != null; }); });
        if (!stats.statsAve.length) stats = null;
      }
      var tg = L && L.TARGETS[e.code];
      if (tg && layerOn('target')) {
        var te = LVm.pick(lv, LVm.IDS[tg.idKey], now);
        if (te) target = { label: tg.label, pts: LVm.seasonalSeries(te, start - DAY, end + DAY) };
      }
      levels = L.levelValues(lv, now).filter(function (l) { return layerOn('lvl:' + l.key); });
    }
    return { e: e, res: res, start: start, end: end, now: now, t: t, v: v, q: q, rt: rt, rv: rv, unit: unit, dec: dec, title: title, src: src,
      lv: lv, stats: stats, target: target, levels: levels,
      tt: tt, tv: tv, tLabel: tLabel, tNote: tNote,
      param: param, fc: fc, issued: issued, bands: bands, fcNote: fcNote, peak: g && g.peak, long: long,
      fullStart: fullStart, fullEnd: fullEnd, zoomed: zoomed,
      loading: long ? hLoading : !state.snap, histError: long && hist && !hist.loading ? hist.error : null };
  }

  function renderChart(animate) {
    var yrBtn = document.querySelector('[data-range="years"]'), isRes = byId[state.chartId].kind === 'reservoir';
    if (yrBtn) { yrBtn.disabled = !isRes; yrBtn.title = isRes ? 'Compare up to six past calendar years' : 'PAST YEARS is for reservoirs'; }
    if (state.range === 'years' && !isRes) setRange('1y');
    setYearsMode(state.range === 'years');
    if (state.range === 'years') { renderYearsView(); return; }
    var M = chartModel();
    var wrap = $('#chart-wrap'), svg = $('#chart'), msg = $('#chart-msg');
    var W = Math.max(260, Math.floor(wrap.clientWidth)), H2 = W < 520 ? 230 : 300;
    var ps = $('#param-seg');
    ps.hidden = M.res;
    if (!M.res) {
      var noFlow = M.e.params.indexOf('flow') < 0;
      ps.querySelector('[data-param="flow"]').disabled = noFlow;
      ps.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-param') === M.param ? 'true' : 'false'); });
      ps.querySelector('[data-param="temp"]').disabled = M.e.params.indexOf('tempC') < 0;
    }
    $('#chart-title').textContent = M.title;
    $('#trend-tag').textContent = RANGE_TAG[state.range] + (M.long ? ' · HISTORY + LIVE' : ' · LIVE SERIES');
    $('#chart-src').textContent = 'Source: ' + M.src;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H2);
    svg.setAttribute('height', H2);
    state.geom = null;

    if (M.t.length < 2) {
      svg.innerHTML = '';
      msg.hidden = false;
      msg.textContent = M.loading ? (M.long ? 'Loading ' + RANGE_TAG[state.range].toLowerCase() + ' of history…' : 'Loading live data…')
        : M.histError ? 'History unavailable (' + M.histError + ').' : 'No data returned for this series in the selected window.';
      $('#chart-legend').innerHTML = '';
      $('#chart-stats').innerHTML = '';
      $('#chart-table').innerHTML = '';
      return;
    }
    msg.hidden = true;

    var inView = function (arr, ts) { return M.zoomed ? arr.filter(function (v, k) { return ts[k] >= M.start && ts[k] <= M.end; }) : arr; };
    var vals = inView(M.v, M.t).concat(M.rv, M.fc.v, M.tv.filter(function (v) { return v != null; }));
    if (!vals.length) vals = M.v.slice();
    var inWin = function (p) { return p[0] >= M.start && p[0] <= M.end && p[1] != null; };
    // 30-yr bands do not stretch the axis (their extremes can follow one unusual year); they are clipped.
    if (M.target) M.target.pts.forEach(function (p) { if (inWin(p)) vals.push(p[1]); });
    M.levels.forEach(function (l) { vals.push(l.v); });
    if (M.bands.length) vals.push(M.bands[0].lo); // always show at least the first flood band
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.08;
    var nt = niceTicks(lo - pad, hi + pad, W < 520 ? 4 : 5);
    var yMin = Math.min(nt.ticks[0], lo - pad), yMax = Math.max(nt.ticks[nt.ticks.length - 1], hi + pad);
    var tickDec = nt.step < 1 ? (nt.step < 0.1 ? 2 : 1) : 0;
    var labels = nt.ticks.map(function (v) { return fmt(v, tickDec); });
    var ml = 12 + 6.6 * Math.max.apply(null, labels.map(function (l) { return l.length; }));
    var mr = 14, mt = 14, mb = 28, pw = W - ml - mr, ph = H2 - mt - mb;
    var x = function (t) { return ml + ((t - M.start) / (M.end - M.start)) * pw; };
    var y = function (v) { return mt + (1 - (v - yMin) / (yMax - yMin)) * ph; };

    var s = '<defs><linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#39d0e0" stop-opacity="0.22"/><stop offset="1" stop-color="#39d0e0" stop-opacity="0"/></linearGradient>' +
      '<clipPath id="plot-clip"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>';

    s += '<g class="grid axis">';
    nt.ticks.forEach(function (v, k) {
      if (v < yMin || v > yMax) return;
      var yy = y(v).toFixed(1);
      s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<text x="' + (ml - 8) + '" y="' + (+yy + 3.5) + '" text-anchor="end">' + labels[k] + '</text>';
    });
    // x ticks on Pacific-time boundaries (Pacific offsets are whole hours, so UTC hour starts align)
    // Tick style follows the visible span, so zooming in switches months -> days -> hours.
    var spanH = (M.end - M.start) / HOUR, tickMode = spanH <= 48 ? 'hours' : spanH <= 240 ? 'days' : spanH <= 75 * 24 ? 'weeks' : 'months';
    if (tickMode === 'weeks' || tickMode === 'months') {
      // Weeks: faint daily lines, Mondays labelled. Months: month starts labelled (year on January).
      var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (tickMode === 'weeks') {
        H.history.dayTicks(M.start, M.end, false).forEach(function (o) {
          var xx = x(o.t).toFixed(1), p2 = parts(o.t + HOUR);
          s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:' + (o.dow === 1 ? '.6' : '.18') + '"/>';
          if (o.dow === 1) s += '<text x="' + xx + '" y="' + (H2 - 9) + '" text-anchor="middle">' + (pw < 420 ? p2.month + '/' + p2.day : 'Mon ' + p2.month + '/' + p2.day) + '</text>';
        });
      } else {
        var mt2 = H.history.monthTicks(M.start, M.end), skip = spanH > 200 * 24 && pw < 420 ? 2 : 1;
        mt2.forEach(function (o, i) {
          var xx = x(o.t).toFixed(1);
          s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:.55"/>';
          if (i % skip === 0) s += '<text x="' + xx + '" y="' + (H2 - 9) + '" text-anchor="middle">' + MN[o.m - 1] + (o.m === 1 ? " '" + String(o.y).slice(2) : '') + '</text>';
        });
      }
    } else {
      var xt = [], hstep = spanH <= 8 ? 1 : spanH <= 16 ? 2 : spanH <= 30 ? 3 : 6;
      for (var tt = Math.ceil(M.start / HOUR) * HOUR; tt <= M.end; tt += HOUR) {
        var p = parts(tt);
        if (tickMode === 'hours' ? p.h % hstep === 0 : p.h === 0) xt.push({ t: tt, p: p });
      }
      var narrow = pw / Math.max(1, xt.length) < 52;
      var every = Math.max(1, Math.ceil(30 / (pw / Math.max(1, xt.length))));
      xt = xt.filter(function (o, i) { return i % every === 0; });
      xt.forEach(function (o) {
        var xx = x(o.t).toFixed(1), lab;
        if (tickMode === 'hours') lab = o.p.h === 0 ? o.p.weekday + ' ' + o.p.day : String(o.p.h).padStart(2, '0') + ':00';
        else lab = narrow ? o.p.day : o.p.weekday + ' ' + o.p.day;
        s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:.55"/>';
        s += '<text x="' + xx + '" y="' + (H2 - 9) + '" text-anchor="middle">' + lab + '</text>';
      });
    }
    s += '</g>';

    var d = '';
    for (var i = 0; i < M.t.length; i++) d += (i ? 'L' : 'M') + x(M.t[i]).toFixed(1) + ' ' + y(M.v[i]).toFixed(1);
    var n = M.t.length;
    s += '<g clip-path="url(#plot-clip)">';
    M.bands.forEach(function (b) {
      var y1 = y(b.hi == null ? yMax : Math.min(b.hi, yMax)), y0 = y(b.lo);
      if (b.lo > yMax) return;
      s += '<rect class="fband fband-' + b.cat + '" x="' + ml + '" y="' + y1.toFixed(1) + '" width="' + pw + '" height="' + Math.max(0, y0 - y1).toFixed(1) + '"/>';
      s += '<line class="fline fline-' + b.cat + '" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '"/>';
      s += '<text class="fband-label" x="' + (ml + 6) + '" y="' + (y0 - 4).toFixed(1) + '">' + N.LABEL[b.cat].toUpperCase() + ' ' + fmt(b.lo, 1) + ' ft</text>';
    });
    if (M.end > M.now + HOUR) {
      var xn = x(M.now);
      s += '<rect class="future" x="' + xn.toFixed(1) + '" y="' + mt + '" width="' + (ml + pw - xn).toFixed(1) + '" height="' + ph + '"/>';
    }
    s += '<path class="area" d="' + d + 'L' + x(M.t[n - 1]).toFixed(1) + ' ' + (mt + ph) + 'L' + x(M.t[0]).toFixed(1) + ' ' + (mt + ph) + 'Z"/>';
    if (M.rt.length > 1) {
      var rd = '';
      for (var j = 0; j < M.rt.length; j++) rd += (j ? 'L' : 'M') + x(M.rt[j]).toFixed(1) + ' ' + y(M.rv[j]).toFixed(1);
      s += '<path class="ref-line" d="' + rd + '"/>';
      var ry = y(M.rv[M.rv.length - 1]), above = ry - mt > 18;
      s += '<text class="ref-label" x="' + (W - mr - 6) + '" y="' + (above ? ry - 6 : ry + 14).toFixed(1) + '" text-anchor="end">RULE CURVE ' + fmt(M.rv[M.rv.length - 1], 1) + ' ft</text>';
    }
    if (M.tt.length) {
      var td = '', pen = false;
      for (var ti = 0; ti < M.tt.length; ti++) {
        if (M.tv[ti] == null) { pen = false; continue; }
        td += (pen ? 'L' : 'M') + x(M.tt[ti]).toFixed(1) + ' ' + y(M.tv[ti]).toFixed(1); pen = true;
      }
      s += '<path class="tgt-line" d="' + td + '"/>';
      var lastT = null;
      for (var tj = M.tv.length - 1; tj >= 0; tj--) if (M.tv[tj] != null) { lastT = M.tv[tj]; break; }
      if (lastT != null) {
        var tyy = y(lastT), tAbove = tyy - mt > 18;
        s += '<text class="tgt-label" x="' + (W - mr - 6) + '" y="' + (tAbove ? tyy - 6 : tyy + 14).toFixed(1) + '" text-anchor="end">ODEQ TARGET ' + fmt(lastT, 1) + ' °F</text>';
      }
    }
    s += layerSVG(M, x, y, ml, pw, mt, ph);
    s += '<path class="series' + (animate && !REDUCED ? ' draw' : '') + '" id="chart-line" d="' + d + '"/>';
    if (M.fc.t.length > 1) {
      var fd = '';
      for (var fi = 0; fi < M.fc.t.length; fi++) fd += (fi ? 'L' : 'M') + x(M.fc.t[fi]).toFixed(1) + ' ' + y(M.fc.v[fi]).toFixed(1);
      s += '<path class="fc-line" d="' + fd + '"/>';
    }
    s += '</g>';
    if (M.end > M.now + HOUR) {
      var xnow = x(M.now).toFixed(1);
      s += '<line class="now-line" x1="' + xnow + '" x2="' + xnow + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
      s += '<text class="now-label" x="' + (+xnow + 4) + '" y="' + (mt + ph - 6) + '">' + (M.fc.t.length > 1 ? 'NOW · NWS FORECAST →' : 'TODAY') + '</text>';
    }
    s += '<circle class="now" cx="' + x(M.t[n - 1]).toFixed(1) + '" cy="' + y(M.v[n - 1]).toFixed(1) + '" r="4.5"/>';
    s += '<g id="cross" style="display:none"><line class="cross" id="cross-line" y1="' + mt + '" y2="' + (mt + ph) + '"/><circle class="cross-dot" id="cross-dot" r="5"/></g>';
    s += '<rect x="' + ml + '" y="0" width="' + pw + '" height="' + H2 + '" fill="transparent"/>';
    svg.innerHTML = s;
    if (animate && !REDUCED) {
      var line = $('#chart-line');
      line.style.setProperty('--len', Math.ceil(line.getTotalLength()));
    }
    state.geom = { M: M, x: x, y: y, ml: ml, pw: pw, W: W, mt: mt, ph: ph };
    renderTrendZoom(M);
    renderLayerBar(M);
    renderStrips();

    $('#chart-legend').innerHTML = '<span><i></i>' + (M.res ? (M.long && /^USGS/.test(M.src) ? 'Pool elevation (USGS daily + USACE live)' : 'Pool elevation (USACE)') : M.param === 'flow' ? 'Discharge (USGS)' : M.param === 'temp' ? 'Water temperature (USGS)' : 'Gage height (USGS)') + '</span>' +
      (M.tt.length ? '<span><i class="tgt"></i>' + esc(M.tLabel) + '</span>' : '') + (M.tNote ? '<span class="na">' + esc(M.tNote) + '</span>' : '') +
      (M.rt.length > 1 ? '<span><i class="ref"></i>USACE rule curve</span>' : M.res ? '<span class="na">Rule curve: no data</span>' : '') +
      (M.fc.t.length > 1 ? '<span><i class="fc"></i>NWS/NWRFC forecast (via NOAA NWPS), issued ' + stamp(M.issued) + '</span>' : '') +
      (M.bands.length ? '<span><i class="fb"></i>NWS flood categories</span>' : '') +
      (M.fcNote ? '<span class="na">' + esc(M.fcNote) + '</span>' : '') +
      (M.stats ? '<span><i class="lg-p95"></i>30-yr p05–p95</span><span><i class="lg-p75"></i>p25–p75</span><span><i class="lg-mean"></i>30-yr mean</span>' : '') +
      (M.target ? '<span><i class="lg-target"></i>' + esc(M.target.label) + ' (published)</span>' : '') +
      (M.levels.length ? '<span><i class="lg-lvl"></i>Level lines (CWMS)</span>' : '');

    var lo2 = Math.min.apply(null, M.v), hi2 = Math.max.apply(null, M.v), ch = M.v[n - 1] - M.v[0];
    var stats = '<div><dt>Latest</dt><dd>' + fmt(M.v[n - 1], M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Min</dt><dd>' + fmt(lo2, M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Max</dt><dd>' + fmt(hi2, M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Change in window</dt><dd>' + signed(ch, M.dec) + ' ' + M.unit + '</dd></div>';
    if (M.res && M.rt.length) {
      var rNow = H.interpolate({ t: M.rt, v: M.rv }, M.t[n - 1]);
      if (rNow != null) stats += '<div><dt>vs rule curve</dt><dd>' + signed(M.v[n - 1] - rNow, 1) + ' ft</dd></div>';
    }
    if (M.tt.length) {
      var tNow = null;
      for (var tk = 0; tk < M.tt.length; tk++) if (M.tt[tk] <= M.t[n - 1] && M.tv[tk] != null) tNow = M.tv[tk];
      if (tNow != null) stats += '<div><dt>vs ODEQ target</dt><dd>' + signed(M.v[n - 1] - tNow, 1) + ' °F</dd></div>';
    }
    if (M.fc.t.length > 1) {
      var pk = 1;
      for (var pi = 1; pi < M.fc.v.length; pi++) if (M.fc.v[pi] > M.fc.v[pk]) pk = pi;
      stats += '<div><dt>Forecast peak (shown)</dt><dd>' + fmt(M.fc.v[pk], M.dec) + ' ' + M.unit + ' · ' + stamp(M.fc.t[pk]) + '</dd></div>';
    }
    stats += '<div><dt>Latest reading</dt><dd>' + stamp(M.t[n - 1]) + '</dd></div>';
    $('#chart-stats').innerHTML = stats;
    renderTable(M);
  }

  function renderTable(M) {
    var step = ({ '24h': 1, '7d': 6, '30d': 24, '6m': 7 * 24, '1y': 7 * 24, year: 7 * 24 })[state.range] * HOUR, rows = [], seen = {};
    for (var target = M.t[M.t.length - 1]; target >= M.start; target -= step) {
      var i = lastIndexBefore(target, M.t);
      if (i < 0 || seen[i]) continue;
      seen[i] = true;
      var r = M.res && M.rt.length ? H.interpolate({ t: M.rt, v: M.rv }, M.t[i]) : null;
      rows.push('<tr><td>' + stamp(M.t[i]) + '</td><td>' + fmt(M.v[i], M.dec) + '</td>' +
        (M.res ? '<td>' + (r == null ? '—' : fmt(r, 1)) + '</td>' : '<td>' + esc(qualText(M.q[i]) || '—') + '</td>') + '</tr>');
    }
    $('#chart-table').innerHTML = '<table><caption class="skip">' + esc(M.title) + '</caption><thead><tr><th>Time (PT)</th><th>' +
      (M.res ? 'Pool elev (ft)' : M.param === 'flow' ? 'Flow (cfs)' : M.param === 'temp' ? 'Temp (°F)' : 'Stage (ft)') + '</th><th>' + (M.res ? 'Rule curve (ft)' : 'Qualifier') + '</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table>';
  }

  function onPointer(ev) {
    var g = state.geom;
    if (!g) return;
    var rect = $('#chart').getBoundingClientRect(), scale = g.W / rect.width;
    var px = (ev.clientX - rect.left) * scale;
    if (px < g.ml || px > g.ml + g.pw) { hideCross(); return; }
    var t = g.M.start + ((px - g.ml) / g.pw) * (g.M.end - g.M.start);
    var tip = $('#tooltip'), extra = '';
    var lastObs = g.M.t[g.M.t.length - 1];
    if (g.M.fc.t.length > 1 && t > lastObs) {
      var fi = lastIndexBefore(t, g.M.fc.t);
      if (fi < g.M.fc.t.length - 1 && Math.abs(g.M.fc.t[fi + 1] - t) < Math.abs(g.M.fc.t[fi] - t)) fi++;
      if (fi > 0) {
        var fx = g.x(g.M.fc.t[fi]), fy = g.y(g.M.fc.v[fi]);
        $('#cross').style.display = '';
        $('#cross-line').setAttribute('x1', fx); $('#cross-line').setAttribute('x2', fx);
        $('#cross-dot').setAttribute('cx', fx); $('#cross-dot').setAttribute('cy', fy);
        tip.hidden = false;
        tip.innerHTML = stamp(g.M.fc.t[fi]) + '<br><b>' + fmt(g.M.fc.v[fi], g.M.dec) + ' ' + g.M.unit + '</b><br>NWS forecast';
        var fl = fx / scale + 14;
        if (fl + tip.offsetWidth > rect.width - 4) fl = fx / scale - tip.offsetWidth - 14;
        tip.style.left = Math.max(4, fl) + 'px';
        return;
      }
    }
    var i = lastIndexBefore(t, g.M.t);
    if (i < 0) i = 0;
    if (i < g.M.t.length - 1 && Math.abs(g.M.t[i + 1] - t) < Math.abs(g.M.t[i] - t)) i++;
    var cx = g.x(g.M.t[i]), cy = g.y(g.M.v[i]);
    syncStrips(t);
    $('#cross').style.display = '';
    $('#cross-line').setAttribute('x1', cx); $('#cross-line').setAttribute('x2', cx);
    $('#cross-dot').setAttribute('cx', cx); $('#cross-dot').setAttribute('cy', cy);
    if (g.M.res && g.M.rt.length) {
      var r = H.interpolate({ t: g.M.rt, v: g.M.rv }, g.M.t[i]);
      if (r != null) extra = '<br>rule curve ' + fmt(r, 1) + ' ft';
    } else if (g.M.q[i]) extra = '<br>' + esc(qualText(g.M.q[i]));
    if (g.M.param === 'temp') {
      extra = '<br>' + fmt((g.M.v[i] - 32) * 5 / 9, 1) + ' °C' + extra;
      if (g.M.tt.length) {
        var tvv = null;
        for (var q2 = 0; q2 < g.M.tt.length; q2++) if (g.M.tt[q2] <= g.M.t[i]) tvv = g.M.tv[q2];
        if (tvv != null) extra += '<br>ODEQ target ' + fmt(tvv, 1) + ' °F';
      }
    }
    tip.hidden = false;
    tip.innerHTML = stamp(g.M.t[i]) + '<br><b>' + fmt(g.M.v[i], g.M.dec) + ' ' + g.M.unit + '</b>' + extra;
    var left = cx / scale + 14, tw = tip.offsetWidth;
    if (left + tw > rect.width - 4) left = cx / scale - tw - 14;
    tip.style.left = Math.max(4, left) + 'px';
  }

  function hideCross() {
    var c = $('#cross');
    if (c) c.style.display = 'none';
    syncStrips(null);
    $('#tooltip').hidden = true;
  }

  function setChart(id) {
    if (state.chartId !== id) state.tzoom = [0, 1];
    state.chartId = id;
    $('#trend-select').value = id;
    renderChart(true);
  }

  // Smallest zoom window: 2 h on 24 H, 6 h on 7 D, 1 day on 30 D, 7 days on 6 MO / 1 YR.
  function trendMinZoom() { return ({ '24h': 2, '7d': 6, '30d': 24, '6m': 168, '1y': 168, year: 72, years: 72 })[state.range] / RANGE_H[state.range]; }
  function setTrendZoom(z) { state.tzoom = H.zoom.clamp(z, trendMinZoom()); hideCross(); renderChart(false); }
  function renderTrendZoom(M) {
    var el = $('#trend-zoom');
    if (!el || !H.zoom) return;
    el.innerHTML = H.zoom.bar(state.tzoom, 'tzoom', state.tzoom[0] > 0 || state.tzoom[1] < 1 ? esc(stamp(M.start) + ' – ' + stamp(M.end)) : '');
  }

  function setRange(r) {
    state.range = r;
    state.tzoom = [0, 1];
    document.querySelectorAll('[data-range]').forEach(function (o) { o.setAttribute('aria-pressed', o.getAttribute('data-range') === r ? 'true' : 'false'); });
  }

  // PAST YEARS replaces the time chart, its strips, stats and table with js/pastyears.js.
  function setYearsMode(on) {
    ['#chart-wrap', '#trend-strips', '#chart-legend', '#chart-stats', '#trend-zoom', '#chart-src'].forEach(function (sel) { var el = $(sel); if (el) el.hidden = on; });
    var tv = $('#trends .table-view');
    if (tv) tv.hidden = on;
    $('#years-box').hidden = !on;
  }

  function renderYearsView() {
    var e = byId[state.chartId], box = $('#years-box');
    if (!H.pastYears || !box) return;
    $('#param-seg').hidden = true;
    $('#chart-title').textContent = e.name + ' · pool elevation by calendar year (ft)';
    $('#trend-tag').textContent = 'PAST YEARS · HISTORY';
    var lv = levelsFor(e);
    renderLayerBar(null);
    var levels = lv && L ? L.levelValues(lv).filter(function (l) { return layerOn('lvl:' + l.key); }) : [];
    H.pastYears.render(box, { p: e, code: e.code, lv: lv, levels: levels, stats: layerOn('stats') }, function () { if (state.range === 'years') renderYearsView(); });
  }

  // 30-yr bands, published target and level lines on the main chart (inside its clip group).
  function layerSVG(M, x, y, ml, pw, mt, ph) {
    var out = '';
    var path = function (pts) {
      var d = '', pen = false;
      pts.forEach(function (p) { if (p[1] == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); pen = true; });
      return d;
    };
    var band = function (a, b) {
      if (!a.length || !b.length) return '';
      return 'M' + a.map(function (p) { return x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join('L') + 'L' +
        b.slice().reverse().map(function (p) { return x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join('L') + 'Z';
    };
    if (M.stats) {
      out += '<path class="an-p95" d="' + band(M.stats.statsP95, M.stats.statsP05) + '"/><path class="an-p75" d="' + band(M.stats.statsP75, M.stats.statsP25) + '"/>' +
        '<path class="an-mean" d="' + path(M.stats.statsAve) + '"/>';
    }
    if (M.target && M.target.pts.length) out += '<path class="an-target" d="' + path(M.target.pts) + '"/>';
    if (M.levels.length) {
      var items = M.levels.map(function (l) { return { y: y(l.v), l: l }; });
      M.levels.forEach(function (l) { out += '<line class="lvl-line lvl-' + l.key + '" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y(l.v).toFixed(1) + '" y2="' + y(l.v).toFixed(1) + '"/>'; });
      H.teacupCore.spreadLabels(items, 12, mt + 10, mt + ph - 2).forEach(function (it) {
        out += '<text class="lvl-lab" x="' + (ml + 6) + '" y="' + (it.ly - 3).toFixed(1) + '">' + esc(it.l.label) + ' ' + fmt(it.l.v, 1) + '</text>';
      });
    }
    return out;
  }

  // Toggle chips: "On chart" (reservoirs) and "Below chart" (strips).
  function renderLayerBar(M) {
    var el = $('#trend-layers');
    if (!el || !L) return;
    var e = M ? M.e : byId[state.chartId], h = '';
    var chip = function (it, label, dis) {
      return '<button type="button" class="chip small tl-chip" data-layer="' + esc(it.key) + '" aria-pressed="' + L.isOn(it) + '"' + (dis ? ' disabled' : '') + '>' + esc(label) + '</button>';
    };
    if (e.kind === 'reservoir') {
      var lv = levelsFor(e), have = lv ? L.levelValues(lv).map(function (l) { return l.key; }) : null;
      var items = L.CHART_TOGGLES.filter(function (it) {
        if (it.key === 'target') return !!L.TARGETS[e.code] && state.range !== 'years';
        if (it.key === 'rule') return state.range !== 'years';
        return !it.level || (have && have.indexOf(it.level) >= 0);
      });
      h += '<div class="tl-group" role="group" aria-label="Layers on the chart"><span class="tl-h">On chart</span>' +
        items.map(function (it) { return chip(it, it.label); }).join('') + (have ? '' : '<span class="na loading tl-note">loading level lines…</span>') + '</div>';
    }
    if (state.range !== 'years') {
      var defs = L.stripsFor(e, M ? M.param : null);
      h += '<div class="tl-group" role="group" aria-label="Charts below"><span class="tl-h">Below chart</span>' +
        defs.map(function (d) { return chip(stripItem(e, d), d.label); }).join('') + '</div>';
    }
    el.innerHTML = h;
  }

  // Strips: each enabled quantity as its own small chart on the main chart's time axis.
  function renderStrips() {
    var box = $('#trend-strips'), g = state.geom;
    if (!box || !L) return;
    if (state.range === 'years' || !g) { box.innerHTML = ''; return; }
    var M = g.M, e = M.e, defs = L.stripsFor(e, M.param).filter(function (d) { return L.isOn(stripItem(e, d)); });
    state.stripView = [];
    if (!defs.length) { box.innerHTML = ''; return; }
    var live = e.kind === 'reservoir' ? projData(e) : null;
    box.innerHTML = defs.map(function (def) {
      var ck = e.id + '|' + def.key + '|' + state.range, sd = state.strips[ck];
      if (!sd || (!sd.loading && Date.now() - sd.at > 10 * 60 * 1000)) {
        state.strips[ck] = sd = { loading: true };
        L.load(e, def.key, M.fullStart, Math.min(M.fullEnd, Date.now()), live).then(function (r) {
          r.at = Date.now(); state.strips[ck] = r;
          if (state.geom && state.geom.M.e === e) renderStrips();
        });
      }
      return stripHTML(def, sd, g);
    }).join('');
  }

  function stripHTML(def, sd, g) {
    var M = g.M, unit = esc(def.unit);
    var keys = sd.lines && sd.lines.length > 1 ? sd.lines.map(function (l) { return '<span class="st-key"><i class="' + l.cls + '"></i>' + esc(l.label) + '</span>'; }).join('') : '';
    var head = '<div class="st-head"><b>' + esc(def.label) + '</b> <span class="st-unit">' + unit + '</span>' + keys + '<span class="st-read mono"></span></div>';
    var wrap = function (inner, src) { return '<div class="strip" data-strip="' + def.key + '">' + head + inner + (src ? '<p class="st-src">' + esc(src) + '</p>' : '') + '</div>'; };
    if (sd.loading) return wrap('<p class="na loading st-msg">loading…</p>');
    if (sd.empty) return wrap('<p class="na st-msg">' + (sd.error ? 'unavailable (' + esc(sd.error) + ')' : 'not reported for this window') + '</p>', sd.src);
    var vals = [];
    sd.lines.forEach(function (l) { l.t.forEach(function (t, i) { if (t >= M.start && t <= M.end) vals.push(l.v[i]); }); });
    if (!vals.length) return wrap('<p class="na st-msg">no readings in this window</p>', sd.src);
    if (def.ref) vals.push(def.ref);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo || Math.abs(hi) * 0.05 || 1) * 0.12;
    var nt = niceTicks(lo - pad, hi + pad, 3), yMin = Math.min(nt.ticks[0], lo - pad), yMax = Math.max(nt.ticks[nt.ticks.length - 1], hi + pad);
    var Hs = 84, mt = 6, mb = 6, ph = Hs - mt - mb, W = g.W, ml = g.ml, pw = g.pw;
    var x = function (t) { return ml + ((t - M.start) / (M.end - M.start)) * pw; }, y = function (v) { return mt + (1 - (v - yMin) / (yMax - yMin)) * ph; };
    var dec = nt.step < 1 ? (nt.step < 0.1 ? 2 : 1) : 0;
    var svg = '<svg class="st-svg" viewBox="0 0 ' + W + ' ' + Hs + '" width="100%" height="' + Hs + '" aria-hidden="true"><defs><clipPath id="st-clip-' + def.key + '"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs><g class="axis">';
    nt.ticks.forEach(function (v) { if (v < yMin || v > yMax) return; svg += '<line x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text x="' + (ml - 8) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, dec) + '</text>'; });
    svg += '</g><g clip-path="url(#st-clip-' + def.key + ')">';
    if (def.ref) svg += '<line class="st-ref" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y(def.ref).toFixed(1) + '" y2="' + y(def.ref).toFixed(1) + '"/><text class="st-ref-lab" x="' + (ml + pw - 4) + '" y="' + (y(def.ref) - mt < 12 ? y(def.ref) + 11 : y(def.ref) - 3).toFixed(1) + '" text-anchor="end">' + esc(def.refLabel) + '</text>';
    sd.lines.forEach(function (l) {
      var i0 = Math.max(0, lastIndexBefore(M.start, l.t)), i1 = Math.min(l.t.length - 1, lastIndexBefore(M.end, l.t) + 1), step = Math.max(1, Math.ceil((i1 - i0 + 1) / 700)), d = '';
      for (var i = i0; i <= i1; i += step) d += (d ? 'L' : 'M') + x(l.t[i]).toFixed(1) + ' ' + y(l.v[i]).toFixed(1);
      svg += '<path class="st-line ' + l.cls + '" d="' + d + '"/>';
    });
    svg += '</g><line class="st-cursor" y1="' + mt + '" y2="' + (mt + ph) + '" style="display:none"/></svg>';
    state.stripView.push({ def: def, sd: sd });
    return wrap(svg, sd.src);
  }

  // Cursor + "value at cursor" readout on every strip (t = null hides them).
  function syncStrips(t) {
    var g = state.geom, box = $('#trend-strips');
    if (!box || !g || !state.stripView) return;
    var x = g.ml + ((t - g.M.start) / (g.M.end - g.M.start)) * g.pw;
    box.querySelectorAll('.strip').forEach(function (el) {
      var view = state.stripView.filter(function (v) { return v.def.key === el.getAttribute('data-strip'); })[0], cur = el.querySelector('.st-cursor'), rd = el.querySelector('.st-read');
      if (!view || !cur || !rd) return;
      if (t == null) { cur.style.display = 'none'; rd.textContent = ''; return; }
      cur.setAttribute('x1', x.toFixed(1)); cur.setAttribute('x2', x.toFixed(1)); cur.style.display = '';
      var tol = Math.max(2 * HOUR, (g.M.end - g.M.start) / 150);
      rd.textContent = view.sd.lines.map(function (l) {
        var i = lastIndexBefore(t, l.t);
        if (i < 0) i = 0;
        if (i < l.t.length - 1 && Math.abs(l.t[i + 1] - t) < Math.abs(l.t[i] - t)) i++;
        var ok = Math.abs(l.t[i] - t) <= Math.max(tol, 36 * HOUR * (l.t.length > 1 && l.t[1] - l.t[0] >= 20 * HOUR ? 1 : 0));
        return (view.sd.lines.length > 1 ? l.label + ' ' : '') + (ok ? fmt(l.v[i], view.def.dec) + ' ' + view.def.unit : '—');
      }).join(' · ');
    });
  }

  // Lets other pages (Teacup) open a point in the Trend Recorder.
  H.trend = {
    open: function (id, range) {
      if (!byId[id]) return;
      if (state.chartId !== id) state.tzoom = [0, 1];
      state.chartId = id;
      $('#trend-select').value = id;
      if (range) setRange(range);
      location.hash = '#/overview';
      setTimeout(function () { renderChart(true); var t = $('#trends'); if (t) t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' }); }, 60);
    }
  };

  function initTrends() {
    var sel = $('#trend-select');
    sel.innerHTML =
      '<optgroup label="Reservoirs · pool elevation">' + H.projects.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</optgroup>' +
      '<optgroup label="Rivers · discharge or stage + NWS forecast">' + H.stations.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</optgroup>';
    sel.value = state.chartId;
    sel.addEventListener('change', function () { select(sel.value, true); });

    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        setRange(b.getAttribute('data-range'));
        renderChart(true);
      });
    });
    document.querySelectorAll('[data-param]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        state.riverParam = b.getAttribute('data-param');
        state.tzoom = [0, 1];
        renderChart(true);
      });
    });

    $('#trend-layers').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-layer]');
      if (!b || b.disabled || !L) return;
      L.setOn(b.getAttribute('data-layer'), b.getAttribute('aria-pressed') !== 'true');
      renderChart(false);
    });
    var stripT = function (ev) {
      var sv = ev.target.closest && ev.target.closest('svg.st-svg'), g = state.geom;
      if (!sv || !g) return null;
      var r = sv.getBoundingClientRect(), px = (ev.clientX - r.left) * (g.W / r.width);
      return px < g.ml || px > g.ml + g.pw ? null : g.M.start + ((px - g.ml) / g.pw) * (g.M.end - g.M.start);
    };
    $('#trend-strips').addEventListener('pointermove', function (ev) { syncStrips(stripT(ev)); });
    $('#trend-strips').addEventListener('pointerdown', function (ev) { syncStrips(stripT(ev)); });
    $('#trend-strips').addEventListener('pointerleave', function () { syncStrips(null); });
    var svg = $('#chart');
    if (H.zoom) {
      // Drag across the chart to zoom into that span; double-click to zoom out; toolbar above the chart.
      H.zoom.attach(svg, function () { return state.geom; }, function (fa, fb) {
        var z = state.tzoom, w = z[1] - z[0];
        setTrendZoom([z[0] + fa * w, z[0] + fb * w]);
      }, function (fc) {
        var z = state.tzoom;
        setTrendZoom(H.zoom.apply(z, 'out', trendMinZoom(), z[0] + fc * (z[1] - z[0])));
      });
      $('#trend-zoom').addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-tzoom]');
        if (b && !b.disabled) setTrendZoom(H.zoom.apply(state.tzoom, b.getAttribute('data-tzoom'), trendMinZoom()));
      });
    }
    svg.addEventListener('pointermove', onPointer);
    svg.addEventListener('pointerdown', onPointer);
    svg.addEventListener('pointerleave', hideCross);

    var lastW = $('#chart-wrap').clientWidth, pending = 0;
    var onResize = function () {
      var w = $('#chart-wrap').clientWidth;
      if (w === lastW) return;
      lastW = w;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(function () { hideCross(); renderChart(false); });
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe($('#chart-wrap'));
    else window.addEventListener('resize', onResize);
  }

  // ---- Boot ----------------------------------------------------------------

  // dataChanged: new fetch arrived (re-draw chart). Otherwise a periodic refresh of ages/status.
  function renderAll(dataChanged) {
    renderFeed();
    renderTotals();
    renderMapNodes();
    renderCards();
    renderDetails();
    renderSnow();
    if (dataChanged) renderChart(true);
  }

  $('#refresh').addEventListener('click', poll);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.nextPollAt && Date.now() >= state.nextPollAt) poll();
  });

  tickClock();
  setInterval(tickClock, 1000);
  setInterval(function () { if (state.snap && !state.fetching) renderAll(false); }, 60000);
  renderMapBase();
  bindCards();
  initTrends();
  renderAll(true);
  poll();
})();
