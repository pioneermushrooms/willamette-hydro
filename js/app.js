/* Willamette Valley Hydro Dispatch — UI. Live data from USGS and USACE; provisional, not official. */
(function () {
  'use strict';

  var H = window.HYDRO;
  if (!H) return;

  var TZ = 'America/Los_Angeles';
  var HOUR = 3600 * 1000;
  var DAY = 24 * HOUR;
  var POLL_MS = H.SETTINGS.pollMinutes * 60 * 1000;
  var FULL_MS = 60 * 60 * 1000;   // full 7-day reload this often; incremental polls in between
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
    wx: null,             // { fetchedAt, basins, error } from js/weather.js (model rain, past + forecast)
    wxSno: null,
    hz: null,             // { fetchedAt, fires, alerts, … } from js/hazards.js
    pw: null,             // { fetchedAt, utilities, bpa } from js/outages.js          // { fetchedAt, stations, error } SNOTEL hourly accumulated precipitation
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
  /*
   * Update an element to new markup in place: unchanged nodes are left alone, changed text and
   * attributes are patched, and only nodes whose type changed are replaced. Periodic refreshes then
   * change just the numbers that moved, without rebuilding boxes, restarting animations or
   * flashing. Works for HTML and SVG (the markup is parsed in a shallow clone of the element).
   */
  function setHTML(el, html) {
    if (!el || el.__html === html) return;
    el.__html = html;
    if (!el.firstChild) { el.innerHTML = html; return; }
    var tmp = el.cloneNode(false);
    tmp.innerHTML = html;
    morphChildren(el, tmp);
  }
  function morphChildren(from, to) {
    var a = Array.prototype.slice.call(from.childNodes), b = Array.prototype.slice.call(to.childNodes);
    for (var i = 0; i < b.length; i++) {
      if (i < a.length) morphNode(a[i], b[i]);
      else from.appendChild(b[i]);
    }
    for (var k = a.length - 1; k >= b.length; k--) from.removeChild(a[k]);
  }
  function morphNode(f, t) {
    if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName) { f.parentNode.replaceChild(t, f); return; }
    if (f.nodeType === 3 || f.nodeType === 8) { if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue; return; }
    if (f.nodeType !== 1) return;
    var i, at;
    for (i = f.attributes.length - 1; i >= 0; i--) { at = f.attributes[i].name; if (!t.hasAttribute(at) && at !== 'open') f.removeAttribute(at); }
    for (i = 0; i < t.attributes.length; i++) { at = t.attributes[i]; if (f.getAttribute(at.name) !== at.value) f.setAttribute(at.name, at.value); }
    morphChildren(f, t);
  }

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

  // A label/value cell. Secondary text (sub, and a "derived"/"model" hint in the label) goes in a
  // dd.sub; in the Overview header it floats as a popover on hover/focus instead of resizing the cell.
  function kv(label, value, unit, cls, sub) {
    var m = /\s*<span class="hint">([^<]*)<\/span>/.exec(label), hint = m ? m[1] : '';
    if (m) label = label.replace(m[0], '');
    var note = (hint ? '<span class="sub-kind">' + hint + '</span>' : '') + (sub || '');
    return '<div' + (note ? ' class="has-pop" tabindex="0"' : '') + '><dt>' + label + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + value +
      (unit ? '<span class="unit">' + unit + '</span>' : '') + '</dd>' + (note ? '<dd class="sub">' + note + '</dd>' : '') + '</div>';
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
      np.textContent = 'next ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }
  }

  // Keep the previous good series when a single series fails on a later poll;
  // its timestamp keeps ageing so it turns STALE honestly.
  // An incremental poll (next.since set) only holds the last few hours: splice it onto prev.
  function merge(prev, next) {
    if (!prev) return next;
    var keepFrom = Date.now() - H.SETTINGS.historyDays * DAY;
    H.projects.forEach(function (p) {
      var a = prev.projects[p.id] || {}, b = next.projects[p.id] || (next.projects[p.id] = {});
      Object.keys(p.series).forEach(function (k) {
        if (!p.series[k]) return;
        if (b[k] == null) { if (a[k]) b[k] = a[k]; }
        else if (next.since && k !== 'rule') b[k] = H.spliceSeries(a[k], b[k], keepFrom);
      });
    });
    H.projects.forEach(function (p) {
      if (!p.gage) return;
      var a = prev.projects[p.id] || {}, b = next.projects[p.id] || (next.projects[p.id] = {});
      if (!next.sources.usgs.ok || b.gage == null) { if (a.gage) b.gage = a.gage; }
      else if (next.since) b.gage = H.spliceSeries(a.gage, b.gage, keepFrom);
    });
    if (!next.sources.usgs.ok) next.stations = prev.stations;
    else if (next.since) H.stations.forEach(function (st) {
      var a = prev.stations[st.id] || {}, b = next.stations[st.id] || (next.stations[st.id] = {});
      Object.keys(a).forEach(function (k) { b[k] = H.spliceSeries(a[k], b[k], keepFrom); });
    });
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
    // Weather loads on its own so a slow forecast service never holds up the agency data.
    if (H.weather) {
      H.weather.load().then(function (r) { if (r && (!r.error || !state.wx || state.wx.error)) state.wx = r; renderWx(); trackEvents(); });
      H.weather.loadSnotel().then(function (r) { if (r && (!r.error || !state.wxSno || state.wxSno.error)) state.wxSno = r; renderWx(); });
    }
    if (H.outages) H.outages.load().then(function (r) { state.pw = r; renderHazards(); renderMapHazards(); trackEvents(); });
    if (H.hazards) H.hazards.load().then(function (r) {
      // Keep the last good half when one source fails on a later poll.
      if (state.hz && r.firesError && !state.hz.firesError) { r.fires = state.hz.fires; r.firesError = null; r.firesStale = true; }
      if (state.hz && r.alertsError && !state.hz.alertsError) { r.alerts = state.hz.alerts; r.alertsError = null; }
      state.hz = r; renderHazards(); trackEvents();
    });
    // Full 7-day load at start and hourly (picks up agency revisions); otherwise only the last
    // 3 hours, spliced onto what is already loaded, so frequent polls stay light.
    var full = !state.snap || !state.fullAt || Date.now() - state.fullAt > FULL_MS;
    var started = Date.now();
    Promise.all([H.loadAll({ bpaUrl: BPA_URL, since: full ? null : started - 3 * HOUR }), nwpsP, tdgP, snowP]).then(function (res) {
      if (full && res[0].sources.cwms.ok) state.fullAt = started;
      if (res[2]) state.tdg = mergeTdg(state.tdg, res[2]);
      if (res[3]) state.snow = res[3].error && state.snow && !state.snow.error ? state.snow : res[3];
      var snap = res[0];
      state.snap = merge(state.snap, snap);
      // Strips drawn from the live series (inflow/outflow) must pick up the new points.
      Object.keys(state.strips).forEach(function (k) { if (/\|flows\|(24h|7d)$/.test(k) && state.strips[k] && !state.strips[k].loading) state.strips[k].at = 0; });
      state.nwps = mergeNwps(state.nwps, res[1]);
      // Share the live snapshot with other views (Teacup) — they must not refetch it.
      H.live = { snap: state.snap, nwps: state.nwps, tdg: state.tdg };
      document.dispatchEvent(new CustomEvent('hydro:data'));
      loadConsLimits();
      state.fetching = false;
      state.nextPollAt = Date.now() + POLL_MS;
      state.pollTimer = setTimeout(poll, POLL_MS);
      renderAll(true);
      trackEvents();
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
    $('#last-fetch').textContent = fmtClock.format(s.fetchedAt).replace(/^24/, '00').slice(0, 5);

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
    setHTML($('#feed-badges'), b.join(''));
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

    setHTML($('#totals'), tiles.map(function (x) {
      var hm = /\s*<span class="hint">([^<]*)<\/span>/.exec(x.label), label = hm ? x.label.replace(hm[0], '') : x.label;
      var note = (hm ? '<span class="sub-kind">' + hm[1] + '</span>' : '') + (x.sub || '');
      return '<div class="tile' + (x.cls ? ' ' + x.cls : '') + (note ? ' has-pop' : '') + '" tabindex="0">' +
        '<div class="tile-label">' + label + '</div>' +
        '<div class="tile-value"><span>' + x.value + '</span>' + (x.unit ? '<span class="unit">' + x.unit + '</span>' : '') + '</div>' +
        (note ? '<div class="tile-sub">' + note + '</div>' : '') + (x.extra || '') +
        (x.bar != null ? '<div class="tile-bar"><span style="width:' + Math.max(0, Math.min(100, x.bar)).toFixed(1) + '%"></span></div>' : '') +
        '</div>';
    }).join(''));
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
    // Hazard markers (fires; later power outages) sit above the rivers and below the nodes.
    s += '<g id="map-hazards"></g><g id="map-nodes"></g>';
    svg.innerHTML = s;
    initMapHazards(svg);

    // Tap selects the nearest node within a generous radius, so small nodes stay easy to hit on phones.
    svg.addEventListener('click', function (ev) {
      if (hzPick(ev, true)) return;   // a tap on a hazard marker shows its details instead
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
    setHTML($('#map-nodes'), s);
    if (focusId) { var n = document.querySelector('.node[data-id="' + focusId + '"]'); if (n) n.focus({ preventScroll: true }); }
  }

  // ---- Hazard markers on the Basin map (js/hazards.js) ----------------------
  /*
   * The schematic is not geographic: H.hazards.toSchematic() places a lat/lon by a least-squares
   * fit through the dams. Each layer is a kind plus a list of { lat, lon, title, lines[], cls, r }:
   *   drawHazardMarkers('fire', items)     flame, red (wildfire) or amber (cls 'prescribed')
   *   drawHazardMarkers('outage', items)   lightning bolt with a slash (power outage; not fed yet)
   * renderMapHazards() draws every layer in state.mapLayers (set state.mapLayers.outage to a list
   * and call it to add outages). Points beyond the schematic are clamped to its edge with a
   * chevron pointing outward. Hover, keyboard focus or a tap shows a tooltip (#map-tip); the
   * markers never take clicks from the nodes.
   */
  var HZ_INSET = 18, HZ_NODE_GAP = 15, HZ_ORDER = ['outage', 'fire'];
  var hzItems = {};          // kind -> items drawn, with their schematic x/y (for hit-testing and the tooltip)
  var hzTip = { key: null, pinned: false };

  function hzGlyph(kind, r) {
    var k = (r / 9).toFixed(3);
    if (kind === 'outage') {
      return '<circle class="hz-glow" r="' + (r * 1.15).toFixed(1) + '"/>' +
        '<path class="hz-glyph" vector-effect="non-scaling-stroke" transform="scale(' + k + ') translate(-11.5 -12)" d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>' +
        ['hz-slash-bg', 'hz-slash'].map(function (c) { return '<line class="' + c + '" x1="' + (-r).toFixed(1) + '" y1="' + (-r).toFixed(1) + '" x2="' + r.toFixed(1) + '" y2="' + r.toFixed(1) + '"/>'; }).join('');
    }
    return '<circle class="hz-glow" r="' + (r * 1.2).toFixed(1) + '"/>' +
      '<path class="hz-glyph" vector-effect="non-scaling-stroke" transform="scale(' + k + ') translate(-12 -13)" d="M12 22c4 0 7-2.7 7-6.6 0-3.2-2-5.4-3.5-7-.3 1.8-1.2 3-2.4 3.6.4-3.4-1.2-6.6-4.1-9 .2 3.4-1.5 5.4-3 7.2C4.6 11.9 5 13.6 5 15.4 5 19.3 8 22 12 22z"/>';
  }

  // Schematic position, clamped inside the viewBox (out = the direction it lies in, degrees, when
  // clamped) and nudged off any node it would sit under.
  function hzPlace(lat, lon) {
    var p = H.hazards && H.hazards.toSchematic(lat, lon);
    if (!p) return null;
    var vb = H.basinMap.viewBox;
    var x = Math.max(vb[0] + HZ_INSET, Math.min(vb[0] + vb[2] - HZ_INSET, p.x)), y = Math.max(vb[1] + HZ_INSET, Math.min(vb[1] + vb[3] - HZ_INSET, p.y));
    var out = x !== p.x || y !== p.y ? Math.atan2(p.y - y, p.x - x) * 180 / Math.PI : null;
    if (out == null) all.forEach(function (e) {
      var dx = x - e.map.x, dy = y - e.map.y, d = Math.hypot(dx, dy);
      if (d >= HZ_NODE_GAP) return;
      if (d < 0.01) { dx = 1; dy = -1; d = Math.SQRT2; }
      x = e.map.x + dx / d * HZ_NODE_GAP; y = e.map.y + dy / d * HZ_NODE_GAP;
    });
    return { x: x, y: y, out: out };
  }

  // items: [{ lat, lon, title, lines: [..], cls, r }] -> SVG markup for one layer.
  function drawHazardMarkers(kind, items) {
    var s = '', drawn = [];
    (items || []).forEach(function (it) {
      var p = hzPlace(it.lat, it.lon);
      if (!p) return;
      var r = Math.max(4, Math.min(11, it.r || 6));
      if (p.out != null) r = Math.min(r, 6.5);
      var key = kind + ':' + drawn.length;
      drawn.push(Object.assign({}, it, { x: p.x, y: p.y, rr: r }));
      s += '<g class="hz-mk hz-' + kind + (it.cls ? ' ' + it.cls : '') + (p.out != null ? ' hz-off' : '') + '" data-hz="' + key + '" tabindex="0" role="img" aria-label="' +
        esc(it.title + '. ' + it.lines.join('. ') + (p.out != null ? '. Beyond the edge of the map.' : '')) + '" transform="translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')">';
      if (p.out != null) s += '<path class="hz-chev" transform="rotate(' + p.out.toFixed(0) + ') translate(' + (r + 7).toFixed(1) + ' 0)" d="M-2.5 -4L2 0L-2.5 4"/>';
      s += hzGlyph(kind, r) + '</g>';
    });
    hzItems[kind] = drawn;
    return s;
  }

  // Fires from js/hazards.js as marker items; sized by acres (log scale, clamped).
  function fireItems(fires) {
    return (fires || []).slice().sort(function (a, b) { return (+b.acres || 0) - (+a.acres || 0); }).map(function (f) {
      var ac = +f.acres || 0, rx = f.type === 'prescribed';
      var l1 = (rx ? 'Prescribed burn' : 'Wildfire') + ' · ' + (f.acres != null ? fmt(ac, 0) + ' ac' : 'size n/a') + (f.contained != null ? ' · ' + fmt(f.contained, 0) + '% contained' : '');
      var l2 = [f.cause ? 'Cause: ' + f.cause : null, f.discovered != null ? 'discovered ' + hzT(f.discovered) : null].filter(Boolean).join(' · ');
      return { lat: f.lat, lon: f.lon, title: f.name, cls: rx ? 'prescribed' : 'wildfire', r: 4.5 + 1.6 * Math.log10(Math.max(1, ac)),
        lines: [l1, l2, fmt(f.near.mi, 0) + ' mi ' + f.near.dir + ' of ' + f.near.name].filter(Boolean) };
    });
  }

  function renderMapHazards() {
    var el = $('#map-hazards');
    if (!el) return;
    var hz = state.hz, ly = state.mapLayers || (state.mapLayers = {});
    if (hz && (!hz.firesError || hz.firesStale)) ly.fire = fireItems(hz.fires);
    // Power outages: one crossed-bolt marker per outage of ≥ 2 customers (or with a cause), plus any reported
    // by a utility with a location; single-customer outages are left off the map to keep it readable.
    var pw = state.pw;
    if (pw) ly.outage = [].concat.apply([], pw.utilities.filter(function (u) { return !u.error; }).map(function (u) {
      return u.incidents.filter(function (x) { return x.lat != null && (x.n >= 2 || x.cause || x.comment); }).map(function (x) {
        return { lat: x.lat, lon: x.lon, r: 5 + 1.5 * Math.log10(Math.max(1, x.n)), title: u.name + ' outage · ' + fmt(x.n) + ' customer' + (x.n > 1 ? 's' : ''),
          lines: [x.area ? 'Area: ' + x.area : null, x.cause ? 'Cause: ' + x.cause : null, x.comment ? x.comment : null, x.start ? 'Since ' + pwT(x.start) : x.startText ? 'Since ' + x.startText : null,
            x.etr ? 'Est. restore ' + pwT(x.etr) : x.etrText ? 'Est. restore ' + x.etrText : null, x.planned ? 'Planned' : null].filter(Boolean) };
      });
    }));
    // Outages under fires; within a layer the biggest first, so small ones stay visible on top.
    setHTML(el, HZ_ORDER.map(function (k) { hzItems[k] = []; return ly[k] && ly[k].length ? drawHazardMarkers(k, ly[k]) : ''; }).join(''));
    if (hzTip.key) showHzTip(hzTip.key, hzTip.pinned);
  }

  function hzByKey(key) { var a = String(key).split(':'), list = hzItems[a[0]]; return list ? list[+a[1]] : null; }

  function showHzTip(key, pinned) {
    var it = hzByKey(key), tip = $('#map-tip'), svg = $('#basin-map');
    if (!it || !tip) { hideHzTip(true); return; }
    hzTip.key = key; hzTip.pinned = !!pinned;
    var html = '<b>' + esc(it.title) + '</b>' + it.lines.map(function (l) { return '<br>' + esc(l); }).join('');
    if (tip.__html !== html) { tip.innerHTML = html; tip.__html = html; }
    tip.hidden = false;
    var ctm = svg.getScreenCTM();
    if (!ctm) return;
    var wrap = svg.parentNode.getBoundingClientRect(), pt = svg.createSVGPoint();
    pt.x = it.x; pt.y = it.y;
    var c = pt.matrixTransform(ctm), cx = c.x - wrap.left, cy = c.y - wrap.top, off = it.rr * ctm.a + 8;
    var tw = tip.offsetWidth, th = tip.offsetHeight, left = cx + off, top = cy - th / 2;
    if (left + tw > wrap.width - 4) left = cx - off - tw;
    if (left < 4) { left = cx - tw / 2; top = cy + off; if (top + th > wrap.height - 4) top = cy - off - th; }   // narrow map: above/below
    tip.style.left = Math.max(4, Math.min(wrap.width - tw - 4, left)) + 'px';
    tip.style.top = Math.max(4, Math.min(wrap.height - th - 4, top)) + 'px';
    svg.querySelectorAll('.hz-mk').forEach(function (g) { g.classList.toggle('hz-active', g.getAttribute('data-hz') === key); });
  }
  function hideHzTip(force) {
    if (hzTip.pinned && !force) return;
    hzTip.key = null; hzTip.pinned = false;
    var tip = $('#map-tip');
    if (tip) tip.hidden = true;
    document.querySelectorAll('#basin-map .hz-active').forEach(function (g) { g.classList.remove('hz-active'); });
  }

  // Hover / tap on a marker (hit-tested by distance: the nodes' larger hit areas lie above the
  // markers, and a node nearer the pointer than the marker keeps the click). True if a marker was hit.
  function hzPick(ev, isClick) {
    var svg = $('#basin-map'), ctm = svg.getScreenCTM();
    if (!ctm) return false;
    var pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    var p = pt.matrixTransform(ctm.inverse()), best = null, bestD = Infinity, slack = isClick ? 6 : 3;
    Object.keys(hzItems).forEach(function (k) {
      hzItems[k].forEach(function (it, i) { var d = Math.hypot(it.x - p.x, it.y - p.y); if (d < Math.max(it.rr + slack, 8) && d < bestD) { bestD = d; best = k + ':' + i; } });
    });
    var nodeD = Infinity;
    all.forEach(function (e) { nodeD = Math.min(nodeD, Math.hypot(e.map.x - p.x, e.map.y - p.y)); });
    var hit = best && bestD < nodeD;
    svg.classList.toggle('hz-hover', !!hit);
    if (!hit) { hideHzTip(isClick); return false; }
    if (isClick) { if (hzTip.pinned && hzTip.key === best) hideHzTip(true); else showHzTip(best, true); }
    else if (!hzTip.pinned || hzTip.key !== best) showHzTip(best, false);
    return true;
  }

  function initMapHazards(svg) {
    if (!$('#map-tip')) {
      var tip = document.createElement('div');
      tip.className = 'tooltip map-tip'; tip.id = 'map-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
      svg.parentNode.appendChild(tip);
    }
    svg.addEventListener('pointermove', function (ev) { if (ev.pointerType !== 'touch') hzPick(ev, false); });
    svg.addEventListener('pointerleave', function () { svg.classList.remove('hz-hover'); hideHzTip(false); });
    svg.addEventListener('focusin', function (ev) { var g = ev.target.closest && ev.target.closest('.hz-mk'); if (g) showHzTip(g.getAttribute('data-hz'), false); });
    svg.addEventListener('focusout', function (ev) { if (ev.target.closest && ev.target.closest('.hz-mk')) hideHzTip(true); });
    svg.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hideHzTip(true); });
    document.addEventListener('pointerdown', function (ev) { if (hzTip.pinned && !svg.contains(ev.target)) hideHzTip(true); });
    // Legend entries for the fire markers (an outage entry belongs with that layer).
    var lg = document.querySelector('#ws-map .map-legend');
    if (lg && !lg.querySelector('.lg-hz')) {
      var ic = function (cls) { return '<svg class="lg-hz-ic hz-fire ' + cls + '" viewBox="-8 -8 16 16" aria-hidden="true">' + hzGlyph('fire', 6) + '</svg>'; };
      lg.insertAdjacentHTML('beforeend', '<li class="lg-hz">' + ic('wildfire') + 'Wildfire</li><li class="lg-hz">' + ic('prescribed') + 'Prescribed burn</li>');
    }
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

  function reservoirReadouts(p, full, extra) {
    var d = projData(p), L = function (k) { return d && H.latest(d[k]); };
    var e = L('elev'), r = d && H.ruleToday(d.rule), st = L('stor'), out = L('out'), inn = L('inflow');
    var S = function (k) { return p.series[k] ? H.srcLink({ cwms: p.series[k].name, unit: p.series[k].unit }) : ''; };
    var h = kvVal('Pool elev' + S('elev'), val(e, 1, 'ft', 'hl', e ? staleTag(e.t).trim() : ''));
    var dev = e && r ? e.v - r.v : null;
    h += kv('vs rule' + S('rule'), !d ? LOADING : dev == null ? NA : signed(dev, 1), dev == null ? '' : 'ft', '', r ? 'Pool minus the USACE rule curve (' + fmt(r.v, 1) + ' ft today)' : '');
    if (p.cons) {
      var pf = st ? H.percentFull(p, st.v) : null;
      h += kv('% full <span class="hint">derived</span>', !d ? LOADING : !pf ? NA : pf.below ? 'Below cons. pool' : fmt(pf.clamped, 1),
        pf && !pf.below ? '%' : '', pf && pf.below ? 'watchtext' : '', pf ? '(storage − bottom) ÷ conservation capacity' : '');
    } else if (p.powerPool) {
      h += kv('% full', 'n/a', '', 'na', 'No conservation pool (run-of-river). Band ' + p.powerPool.elevBottom + '–' + p.powerPool.elevTop + ' ft');
    } else {
      h += kv('% full', p.consFromLevels && p.consTried !== true ? LOADING : NA, '', 'na', 'needs CWMS conservation limits');
    }
    h += kvVal('Outflow' + S('out'), val(out, 0, 'cfs', '', p.cbt ? 'hourly average' : ''));
    h += kvVal('<span title="Computed by USACE from outflow and the change in storage">Inflow</span>' + S('inflow'), val(inn, 0, 'cfs', inn && inn.v < 0 ? 'neg' : '', inn && inn.v < 0 ? 'computed from storage change; negative as reported' : ''));
    if (full) {
      h += kvVal('Storage' + S('stor'), p.noStorage ? { html: 'n/a', unit: '', cls: 'na', sub: 'not published' } : val(st, 0, 'ac-ft'));
      if (p.cons) h += kv('Conservation pool', fmt(p.cons.elevBottom, 1) + '–' + fmt(p.cons.elevTop, 1), 'ft', '', 'CWMS bottom/top of conservation' + (p.consFromLevels ? ' (read at runtime)' : ''));
    }
    return '<dl class="kv">' + h + (extra || '') + '</dl>';
  }

  function stationReadouts(s, full, extra) {
    var d = stData(s), L = function (k) { return d && H.latest(d[k]); };
    var flow = L('flow'), stage = L('stage'), tc = L('tempC');
    var U = function (pc) { return H.srcLink({ usgs: s.site, param: pc }); };
    var h = s.params.indexOf('flow') < 0
      ? kv('Flow' + U('00060'), !d ? LOADING : NA, '', '', 'no discharge series published for this gauge')
      : kvVal('Flow' + U('00060'), val(flow, 0, 'cfs', s.primary === 'flow' ? 'hl' : '', flow && isProvisional(flow.q) ? 'provisional' : ''));
    h += kvVal('Stage' + U('00065'), val(stage, 2, 'ft', s.primary === 'stage' ? 'hl' : '', stage && isProvisional(stage.q) ? 'provisional' : ''));
    var tf = tc ? { v: H.cToF(tc.v) } : null;
    h += kvVal('Water temp' + U('00010'), val(tf, 1, '°F', '', tc ? fmt(tc.v, 1) + ' °C as reported' : ''));
    var prim = d && H.stationPrimary(s, d), w = window24(prim);
    var ch = w && w.v.length > 1 ? w.v[w.v.length - 1] - w.v[0] : null;
    var unit = s.primary === 'flow' ? 'cfs' : 'ft';
    h += kv('24 h change <span class="hint">derived</span>', !d ? LOADING : ch == null ? NA : signed(ch, s.primary === 'flow' ? 0 : 2), ch == null ? '' : unit, '', '');
    if (full) {
      h += kv('USGS site' + U(''), s.site, '', '', esc(s.usgsName));
    }
    return '<dl class="kv">' + h + (extra || '') + '</dl>';
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

  // ---- Workspace: selected project header + "More" ----------------------------

  // Folder tabs across the top of the project panel: one per reservoir (a selected river gauge gets
  // its own tab at the end). Active tab is bright and joins the panel; the others sit behind it.
  function renderTabs() {
    var box = $('#ws-tabs');
    if (!box) return;
    var sel = byId[state.selectedId], list = H.projects.slice();
    if (sel && sel.kind !== 'reservoir') list.push(sel);
    setHTML(box, list.map(function (e) {
      var on = e.id === state.selectedId, st = statusOf(e);
      return '<button type="button" class="ws-tab' + (on ? ' on' : '') + (e.kind !== 'reservoir' ? ' river' : '') + '" role="tab" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-id="' + e.id + '" title="' + esc(e.name + ' · ' + st.label) + '">' +
        '<span class="light ' + st.level + '" aria-hidden="true"></span>' + esc(e.kind === 'reservoir' ? e.name : shortName(e)) + '</button>';
    }).join(''));
    var a = box.querySelector('.ws-tab.on');
    if (a && a.scrollIntoView && box.scrollWidth > box.clientWidth) {
      var l = a.offsetLeft - box.offsetLeft, r = l + a.offsetWidth;
      if (l < box.scrollLeft || r > box.scrollLeft + box.clientWidth) box.scrollLeft = l - 24;
    }
  }

  // Header: name, status and the handful of numbers that matter, above the chart.
  function renderDetails() {
    var e = byId[state.selectedId], st = statusOf(e), h;
    var isRes = e.kind === 'reservoir';
    var sub = isRes ? e.river + ' · ' + e.purpose : e.river + ' · USGS ' + e.site;
    h = '<div class="ws-title"><div><span class="panel-tag mono">' + (isRes ? 'USACE PROJECT ' + e.code : 'USGS RIVER GAUGE') + '</span>' +
      '<h2>' + esc(e.name) + '</h2><p class="ws-sub">' + esc(sub) + '</p></div>' + statusPill(st) + '</div>';
    if (isRes) {
      var w = wxSummary(e), rain = !H.weather || !H.weather.BASINS[e.code] ? '' :
        kv('Rain 24 h <span class="hint">model · basin above the dam</span>', !state.wx ? LOADING : w ? inch(w.past24) : NA, w ? 'in' : '', '', w ? 'Past 24 h, mean of two model points for this basin (not a gauge). Next 24 h: ' + inch(w.next24) + ' in.' : '');
      var gd = projData(e), gl = gd && H.latest(gd.gage), co = gd && H.latest(gd.out);
      var gage = !e.gage ? '' : kv(esc(e.gage.short) + ' gage' + H.srcLink({ usgs: e.gage.site, param: '00060' }), !state.snap ? LOADING : gl ? fmt(gl.v, 0) : NA, gl ? 'cfs' : '', '',
        gl ? 'Measured by USGS ' + e.gage.site + ' (' + esc(e.gage.name) + ') at ' + esc(stamp(gl.t)) + (co ? '; USACE outflow last reported ' + esc(stamp(co.t)) : '') + '. USGS usually posts it sooner than the USACE outflow.' + (e.gage.note ? ' Note: ' + esc(e.gage.note) + '.' : '') : '');
      h += reservoirReadouts(e, false, gage + rain);
      if (w) h += '<p class="ws-wx">' + wxState(w) + '</p>' + (w.wind ? '<p class="ws-wx">' + windText(w, false) + '</p>' : '');
    } else {
      h += stationReadouts(e, false, floodKv(e));
    }
    setHTML($('#ws-head'), h);
    renderTabs();
    renderMore(e);
  }

  // NWS flood category now (and forecast, if different) as one header cell for river gauges.
  function floodKv(s) {
    if (!N) return '';
    var lid = N.LIDS[s.id];
    if (lid === null) return kv('NWS flood', '<span class="na">none published</span>', '', '', '');
    var o = state.nwps && state.nwps[s.id], g = o && o.gauge;
    if (!g) return kv('NWS flood', state.nwps ? NA : LOADING, '', '', '');
    var d = stData(s), us = d && H.latest(d.stage), stage = us ? us.v : g.observed.stage;
    var nowCat = g.observed.category || N.categoryFor(stage, g.thresholds), fcCat = g.nwsForecastCategory || (g.peak && g.peak.category);
    return kv('NWS flood', nowCat && nowCat !== 'none' ? fcatBadge(nowCat, '') : '<span class="na">below action</span>', '', '', fcCat && fcCat !== nowCat ? 'forecast: ' + esc(N.LABEL[fcCat] || fcCat) : '');
  }

  // "More about …": everything else for the selected point, collapsed by default (remembered).
  function renderMore(e) {
    var isRes = e.kind === 'reservoir', h = '';
    $('#ws-more-sum').textContent = 'More about ' + e.name;
    if (isRes) {
      var d = projData(e);
      h += wxBlock(e);
      h += levelsSection(e);
      var tdg = tdgChip(e);
      if (tdg) h += '<section class="ws-sec"><h3>Total dissolved gas below the dam</h3>' + tdg + '</section>';
      var stl = d && H.latest(d.stor), Ss = e.series.stor ? H.srcLink({ cwms: e.series.stor.name, unit: e.series.stor.unit }) : '';
      h += '<section class="ws-sec"><h3>Storage and readings</h3><dl class="kv ws-kv-more">' +
        kvVal('Storage' + Ss, e.noStorage ? { html: 'n/a', unit: '', cls: 'na', sub: 'not published' } : val(stl, 0, 'ac-ft')) +
        (e.cons ? kv('Conservation pool', fmt(e.cons.elevBottom, 1) + '–' + fmt(e.cons.elevTop, 1), 'ft', '', 'CWMS bottom / top of conservation' + (e.consFromLevels ? ' (read at runtime)' : '')) : '') +
        (e.powerPool ? kv('Power pool band', fmt(e.powerPool.elevBottom, 1) + '–' + fmt(e.powerPool.elevTop, 1), 'ft', '', 'run-of-river') : '') + '</dl>' +
        (d ? readingsTable([
          { label: 'Pool elevation', t: (H.latest(d.elev) || {}).t },
          { label: 'Storage', t: e.noStorage ? null : (H.latest(d.stor) || {}).t },
          { label: 'Outflow', t: (H.latest(d.out) || {}).t },
          { label: 'Computed inflow', t: (H.latest(d.inflow) || {}).t },
          { label: 'Rule curve (daily)', t: (H.ruleToday(d.rule) || {}).t, daily: true }
        ]) : '') + sourceLinks(e) + '</section>';
    } else {
      var sd = stData(e);
      h += '<section class="ws-sec"><h3>NWS flood stages and forecast</h3>' + floodBlock(e, true) + '</section>';
      var oq = ODEQ_AT[e.id] && H.levels && H.levels.peekProjectLevels(ODEQ_AT[e.id].code) ? odeqEntry(e.id) : null;
      if (oq && oq.entry) {
        var ov = H.levels.evalSeasonal(oq.entry, Date.now());
        h += '<p class="flood-note">ODEQ 2006 TMDL temperature target for DEX/LOP today: <b>' + (ov == null ? 'none published for today' : fmt(H.cToF(ov), 1) + ' °F (' + fmt(ov, 1) + ' °C)') +
          '</b> <span class="hint">published target at the dam tailwater; Jasper is the nearest gauge, shown for context.</span></p>';
      }
      h += '<section class="ws-sec"><h3>Readings</h3>' + (sd ? readingsTable(e.params.map(function (k) {
        return { label: { flow: 'Discharge (00060)', stage: 'Gage height (00065)', tempC: 'Water temp (00010)' }[k], t: (H.latest(sd[k]) || {}).t };
      })) : '') + '<p class="hint">USGS site ' + esc(e.site) + ' · ' + esc(e.usgsName) + '</p>' + sourceLinks(e) + '</section>';
    }
    var st = statusOf(e);
    if (st.reason) h += '<p class="detail-note ' + st.level + '">' + esc(st.reason) + ' <span class="hint">Status derived by this site.</span></p>';
    setHTML($('#ws-more-body'), h);
  }

  // "Levels and targets" (folded in from the old Teacup page): published elevation target today and its
  // next changes, structural levels with the distance from the pool, and today's 30-yr statistics.
  var STOR_TARGETS = {
    HCR: [{ id: 'Stor.Inst.0.Interim_Operations', label: 'Interim operations (storage)' }, { id: 'Stor.Inst.0.Injunction-Target', label: 'Injunction target (storage)' }]
  };
  var fChg = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
  function levelsSection(e) {
    var LVm = H.levels, T = H.teacupCore, lv = levelsFor(e), now = Date.now();
    var head = '<section class="ws-sec"><h3>Levels and targets <span class="hint">published CWMS location levels</span></h3>';
    if (!LVm || !L) return '';
    if (!lv) return head + '<p class="na loading">Loading levels…</p></section>';
    var d = projData(e), el = d && H.latest(d.elev), h = head;
    var tgt = L.targetFor(e.code, lv), te = tgt && LVm.pick(lv, tgt.id, now), tv = te ? LVm.evalSeasonal(te, now) : null;
    h += '<dl class="ws-facts">';
    if (tgt && te) {
      var ch = T.nextTargetChanges(te, now, 3);
      h += '<div><dt>' + esc(tgt.label) + '</dt><dd>' + (tv == null ? '<span class="na">none today</span>' : '<b class="mono tgt-val">' + fmt(tv, 1) + ' ft</b> today' + (el ? ' · pool ' + signed(el.v - tv, 1) + ' ft' : '')) +
        (ch.length ? ' · next: ' + ch.map(function (c) { return fChg.format(new Date(c.t)) + ' ' + (c.v == null ? 'ends' : fmt(c.v, 1) + ' ft'); }).join(', ') : '') + '</dd></div>';
    } else h += '<div><dt>Published target</dt><dd><span class="na">no injunction or interim elevation target published</span></dd></div>';
    (STOR_TARGETS[e.code] || []).forEach(function (o) {
      var se = LVm.pick(lv, o.id, now); if (!se) return;
      var sv = LVm.evalSeasonal(se, now);
      h += '<div><dt>' + esc(o.label) + '</dt><dd>' + (sv == null ? '<span class="na">none today</span>' : '<span class="mono">' + fmt(sv) + ' ac-ft</span> today') + '</dd></div>';
    });
    var sp = function (k) { var x = LVm.pick(lv, LVm.IDS[k], now); return x ? LVm.evalSeasonal(x, now) : null; };
    if (sp('statsAve') != null) h += '<div><dt>30-yr today</dt><dd class="mono">p05 ' + fmt(sp('statsP05'), 1) + ' · mean ' + fmt(sp('statsAve'), 1) + ' · p95 ' + fmt(sp('statsP95'), 1) + ' ft</dd></div>';
    h += '</dl>';
    var lvls = L.levelValues(lv, now);
    if (lvls.length) h += '<table class="ws-table"><thead><tr><th>Level</th><th>Elev ft</th><th>Pool vs level</th></tr></thead><tbody>' + lvls.map(function (x) {
      return '<tr><th>' + esc(x.label) + '</th><td class="mono">' + fmt(x.v, 1) + '</td><td class="mono">' + (el ? signed(el.v - x.v, 1) + ' ft' : '—') + '</td></tr>';
    }).join('') + '</tbody></table>';
    return h + '<p class="hint">Published targets, not a statement of current operations. <a href="#/docs">Docs ▸</a></p></section>';
  }

  // ---- Project list (left column) ----------------------------------------------

  function cell(v, cls, title) { return '<span class="ws-v mono' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + v + '</span>'; }

  // "Middle Fork Willamette at Jasper" -> "MF Willamette · Jasper" (full name in the tooltip).
  function shortName(e) {
    if (e.kind === 'reservoir') return e.name;
    return e.name.replace(/^Middle Fork /, 'MF ').replace(/^Coast Fork /, 'CF ').replace(/^South Fork /, 'SF ')
      .replace(/ (at|near) /, ' · ').replace(/ below /, ' · blw ');
  }

  // icon: mini teacup (reservoirs) or null for the status light; tip: extra tooltip; tag: badge after the name.
  function listRow(e, cols, icon, tip, tag) {
    var st = statusOf(e), sel = e.id === state.selectedId;
    return '<li class="ws-row ' + (e.kind === 'reservoir' ? 'ws-row-res' : 'ws-row-riv') + (sel ? ' selected' : '') + '" role="option" tabindex="0" aria-selected="' + sel + '" data-id="' + e.id + '" title="' + esc((tip || e.name) + ' · ' + st.label + (st.reason ? ' · ' + st.reason : '')) + '">' +
      (icon ? '<span class="ws-icon">' + icon + '<span class="light ' + st.level + '" aria-hidden="true"></span></span>' : '<span class="ws-icon"><span class="light ' + st.level + '" aria-hidden="true"></span></span>') +
      '<span class="ws-name">' + esc(shortName(e)) + (tag ? ' ' + tag : '') + '</span>' + cols + '</li>';
  }

  // Mini teacup for a list row: water level within the conservation pool (by elevation, like the old
  // Teacup page), coloured by rule-curve status, with the rule curve as a dashed line. Dexter (no
  // conservation pool) gets a tube for its power-pool band.
  function miniCup(p, el, r) {
    var T = H.teacupCore, rd = T.ruleDelta(el ? el.v : null, r ? r.v : null, H.SETTINGS.ruleBelowFt, H.SETTINGS.ruleAboveFt), cls = rd.status || 'none';
    var lim = p.noStorage ? p.powerPool : p.cons, top = 3, bot = 19, f = el && lim ? T.elevFraction(el.v, lim.elevBottom, lim.elevTop) : null;
    var y = function (fr) { return (bot - fr * (bot - top)).toFixed(1); };
    var s = '<svg class="mini-cup" viewBox="0 0 24 22" aria-hidden="true">';
    var shape = p.noStorage ? '<rect x="8" y="' + top + '" width="8" height="' + (bot - top) + '" rx="1.5"/>' : '<path d="M2 ' + top + ' L22 ' + top + ' L18.5 ' + bot + ' L5.5 ' + bot + ' Z"/>';
    var id = 'mc-' + p.code;
    s += '<defs><clipPath id="' + id + '">' + shape + '</clipPath></defs>';
    if (f != null && f > 0) s += '<rect class="cup-water ' + cls + '" clip-path="url(#' + id + ')" x="0" y="' + y(f) + '" width="24" height="' + (bot - y(f) + 1) + '"/>';
    s += shape.replace('<rect ', '<rect class="mini-cup-body" ').replace('<path ', '<path class="mini-cup-body" ');
    if (r && lim) { var rf = T.elevFraction(r.v, lim.elevBottom, lim.elevTop); s += '<line class="mini-cup-rule" x1="0" x2="24" y1="' + y(rf) + '" y2="' + y(rf) + '"/>'; }
    if (el && lim && el.v < lim.elevBottom) s += '<path class="mini-cup-below" d="M9 20 l3 2 l3 -2 z"/>';
    return s + '</svg>';
  }

  // Last 24 h as a tiny line for river rows.
  function miniSpark(s) {
    var w = window24(s);
    if (!w || w.v.length < 2) return '<span class="mini-spark na"></span>';
    var lo = Math.min.apply(null, w.v), hi = Math.max.apply(null, w.v), span = hi - lo || 1, W = 48, Hh = 16;
    var d = w.t.map(function (t, i) { return (i ? 'L' : 'M') + (((t - w.t0) / (w.t1 - w.t0)) * W).toFixed(1) + ' ' + (Hh - 2 - ((w.v[i] - lo) / span) * (Hh - 4)).toFixed(1); }).join('');
    return '<svg class="mini-spark" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  function renderList() {
    var none = '<span class="na">—</span>';
    setHTML($('#res-list'), H.projects.map(function (p) {
      var d = projData(p), el = d && H.latest(d.elev), r = d && H.ruleToday(d.rule), out = d && H.latest(d.out), inn = d && H.latest(d.inflow);
      var dev = el && r ? el.v - r.v : null, st = d && H.latest(d.stor), pf = p.cons && st ? H.percentFull(p, st.v) : null;
      var tip = p.name + (el ? ' · pool ' + fmt(el.v, 1) + ' ft' : '') + (pf ? ' · ' + (pf.below ? 'below conservation pool' : fmt(pf.clamped, 1) + ' % full') : '') + (r ? ' · rule curve ' + fmt(r.v, 1) + ' ft' : '');
      return listRow(p,
        cell(el ? fmt(el.v, 1) : none, 'hl') +
        cell(dev == null ? none : signed(dev, 1), dev == null ? '' : dev < -H.SETTINGS.ruleBelowFt || dev > H.SETTINGS.ruleAboveFt ? 'off' : '', r ? 'Rule curve ' + fmt(r.v, 1) + ' ft today' : '') +
        cell(inn ? fmt(inn.v, 0) : none, inn && inn.v < 0 ? 'neg' : '', 'Inflow (computed by USACE)') +
        cell(out ? fmt(out.v, 0) : none), miniCup(p, el, r), tip);
    }).join(''));
    setHTML($('#riv-list'), H.stations.map(function (s) {
      var d = stData(s), prim = d && H.stationPrimary(s, d), l = prim && H.latest(prim), w = window24(prim);
      var flow = s.primary === 'flow', ch = w && w.v.length > 1 ? w.v[w.v.length - 1] - w.v[0] : null;
      var g = nwpsGauge(s), cat = g && (g.observed.category || (N && N.categoryFor(l && !flow ? l.v : g.observed.stage, g.thresholds)));
      return listRow(s,
        '<span class="ws-v">' + miniSpark(prim) + '</span>' +
        cell(l ? fmt(l.v, flow ? 0 : 2) + '<span class="unit">' + (flow ? 'cfs' : 'ft') + '</span>' : none, 'hl') +
        cell(ch == null ? none : signed(ch, flow ? 0 : 2), '', '24 h change'), null, null, cat && cat !== 'none' ? fcatBadge(cat, '') : '');
    }).join(''));
  }

  function bindCards() {
    ['#res-list', '#riv-list'].forEach(function (sel) {
      var el = $(sel);
      el.addEventListener('click', function (ev) {
        var r = ev.target.closest('.ws-row');
        if (r) select(r.getAttribute('data-id'), true, true);
      });
      el.addEventListener('keydown', function (ev) {
        var r = ev.target.closest('.ws-row');
        if (!r) return;
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(r.getAttribute('data-id'), true, true); }
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          var n = ev.key === 'ArrowDown' ? r.nextElementSibling : r.previousElementSibling;
          if (n) n.focus();
        }
      });
    });
    var tabs = $('#ws-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (ev) { var t = ev.target.closest('.ws-tab'); if (t) select(t.getAttribute('data-id'), true); });
      tabs.addEventListener('keydown', function (ev) {
        var t = ev.target.closest('.ws-tab');
        if (!t || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'Home' && ev.key !== 'End')) return;
        ev.preventDefault();
        var all = Array.prototype.slice.call(tabs.querySelectorAll('.ws-tab')), i = all.indexOf(t);
        var n = ev.key === 'Home' ? all[0] : ev.key === 'End' ? all[all.length - 1] : all[(i + (ev.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
        select(n.getAttribute('data-id'), true);
        var f = tabs.querySelector('.ws-tab[data-id="' + n.getAttribute('data-id') + '"]'); if (f) f.focus();
      });
    }
    var more = $('#ws-more');
    try { more.open = localStorage.getItem('wvhd:more') === '1'; } catch (e) { /* default closed */ }
    more.addEventListener('toggle', function () { try { localStorage.setItem('wvhd:more', more.open ? '1' : '0'); } catch (e) { /* ignore */ } });
  }

  // ---- Basin precipitation (js/weather.js) ---------------------------------------

  var fWx = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric' });
  var fWxDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'numeric', day: 'numeric' });
  var fH23 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' });
  function wxT(t) { return fWx.format(new Date(t)); }
  function inch(v) { return v == null ? '—' : v < 0.005 ? '0' : fmt(v, 2); }

  function wxSummary(p) {
    var W = H.weather, s = state.wx && state.wx.basins[p.code], b = W && W.BASINS[p.code];
    return s && b ? W.summarize(s, Date.now(), b.area) : null;
  }

  // Small line icons for the current condition (stroke = currentColor; coloured by CSS).
  var WX_ICON = (function () {
    var sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
    var moon = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>';
    var cloud = '<path d="M7 17h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 10.2 3.5 3.5 0 0 0 7 17z"/>';
    var cloudHi = '<path d="M7 14h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 7.2 3.5 3.5 0 0 0 7 14z"/>';
    return {
      clear: { d: sun, night: moon },
      partly: { d: '<path d="M8 3v1.5M3.5 8H2M4.2 4.2l1 1M12.8 4.2l-1 1"/><path d="M5.6 10.3A3.5 3.5 0 1 1 11.6 6.6"/>' + '<path d="M9 19h9a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 9 11.2 3 3 0 0 0 9 19z"/>',
        night: '<path d="M11 6.5A4.5 4.5 0 0 1 5 2.6a4.5 4.5 0 1 0 6 3.9z"/><path d="M9 19h9a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 9 11.2 3 3 0 0 0 9 19z"/>' },
      cloudy: { d: cloud },
      fog: { d: cloudHi + '<path d="M4 18h16M6 21h12"/>' },
      drizzle: { d: cloudHi + '<path d="M9 18v1M13 18v1M17 18v1M11 21v1M15 21v1"/>' },
      rain: { d: cloudHi + '<path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>' },
      freezing: { d: cloudHi + '<path d="M8 17l-1 3M16 17l-1 3"/><path d="M12 17.5v4M10.3 18.5l3.4 2M13.7 18.5l-3.4 2"/>' },
      snow: { d: cloudHi + '<path d="M8 17.5v3M6.7 18.2l2.6 1.6M9.3 18.2l-2.6 1.6M16 17.5v3M14.7 18.2l2.6 1.6M17.3 18.2l-2.6 1.6M12 20v2"/>' },
      thunder: { d: cloudHi + '<path d="M12.5 14l-2.5 4h3l-2 4"/>' }
    };
  })();
  function wxIcon(c) {
    if (!c || !WX_ICON[c.key]) return '';
    var ic = WX_ICON[c.key], d = c.night && ic.night ? ic.night : ic.d;
    return '<svg class="wx-ic wx-ic-' + c.key + (c.night ? ' night' : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
  }

  // One-line state with an icon for the current condition: what it is doing now, since when, and the forecast.
  function wxState(w) {
    var ev = w.event, c = H.weather.condition ? H.weather.condition(w) : null;
    var fc = function (t) { return '<span class="wx-fc">' + t + '</span>'; };
    if (ev && !ev.end) {
      var since = ev.openStart ? ' for 3 days+' : ' since ' + wxT(ev.start), ends = fc(w.ends ? 'forecast to ease ~' + wxT(w.ends) : 'still going at the end of the forecast');
      var wetNow = c ? c.wet : w.raining;
      if (wetNow) {
        var WORD = { rain: 'Raining', drizzle: 'Drizzle', snow: 'Snowing', freezing: 'Freezing rain', thunder: 'Thunderstorms' };
        return '<span class="wx-now">' + wxIcon(c || { key: 'rain' }) + '<b class="wx-wet">' + (WORD[c && c.key] || 'Raining') + since + '</b>' + ends + '</span>';
      }
      // A break between showers: show what it is doing now, and that the event is still on.
      return '<span class="wx-now">' + wxIcon(c) + '<span class="wx-cond">' + esc(c ? c.label : '') + '</span><b class="wx-wet">Rain on and off' + since + '</b>' + ends + '</span>';
    }
    return '<span class="wx-now">' + wxIcon(c) + (c ? '<span class="wx-cond">' + esc(c.label) + '</span>' : '') + '<b class="wx-dry">' + (ev ? 'Dry since ' + wxT(ev.end) : 'Dry for 3 days+') + '</b>' +
      fc(w.nextStart ? 'next rain ~' + wxT(w.nextStart) : 'no rain in the 3-day forecast') + '</span>';
  }

  // Wind line: arrow (pointing where the wind blows to), direction, speed, gusts and the forecast peak.
  var WIND_LABEL = { calm: '', breezy: 'breezy', advisory: 'advisory-level', warning: 'warning-level' };
  function windArrow(dir) {
    if (dir == null) return '';
    return '<svg class="wind-arrow" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(' + Math.round(dir) + ' 12 12)"><path d="M12 3v16M7 14l5 6 5-6"/></g></svg>';
  }
  function windText(w, full) {
    var x = w && w.wind;
    if (!x) return '';
    var gust = function (o) { return '<b class="mono">' + fmt(o.gust, 0) + ' mph</b>'; };
    var h = '<span class="wx-now wind-now wind-' + x.level + '">' +
      '<svg class="wx-ic wx-ic-wind" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/></svg>' +
      '<span class="wx-cond">Wind</span>' + windArrow(x.dir) +
      '<b class="wind-v">' + esc(x.from) + ' ' + fmt(x.speed, 0) + ' mph' + (x.gust != null ? ', gusts ' + fmt(x.gust, 0) : '') + '</b>' +
      (WIND_LABEL[x.level] ? '<span class="wind-tag wind-' + x.level + '">' + WIND_LABEL[x.level] + '</span>' : '');
    if (x.next24) h += '<span class="wx-fc">next 24 h: gusts to ' + gust(x.next24) + ' ~' + wxT(x.next24.t) + (WIND_LABEL[x.next24.level] && x.next24.level !== x.level ? ' <span class="wind-tag wind-' + x.next24.level + '">' + WIND_LABEL[x.next24.level] + '</span>' : '') + '</span>';
    if (full && x.past24) h += '<span class="wx-fc">past 24 h peak ' + gust(x.past24) + ' ' + wxT(x.past24.t) + '</span>';
    if (full && x.next72) h += '<span class="wx-fc">3-day peak ' + gust(x.next72) + ' ~' + wxT(x.next72.t) + '</span>';
    return h + '</span>';
  }

  function wxLine(p) {
    if (!H.weather || !H.weather.BASINS[p.code]) return '';
    if (!state.wx) return '<p class="wx-line"><span class="wx-h">BASIN RAIN</span> <span class="na loading">loading…</span></p>';
    var w = wxSummary(p);
    if (!w) return '<p class="wx-line"><span class="wx-h">BASIN RAIN</span> <span class="na">unavailable' + (state.wx.error ? ' (' + esc(state.wx.error) + ')' : '') + '</span></p>';
    return '<p class="wx-line"><span class="wx-h">BASIN RAIN <span class="hint">model</span></span> past 24 h <b class="mono">' + inch(w.past24) + ' in</b> · next 24 h <b class="mono">' + inch(w.next24) + ' in</b><br>' + wxState(w) + '</p>';
  }

  // Hourly bars, past 72 h (solid) and forecast 72 h (faded), with a NOW line.
  function wxChart(s, now) {
    var t0 = now - 72 * HOUR, t1 = now + 72 * HOUR, W = window.innerWidth < 600 ? 380 : 600, Hh = 130, ml = 34, mr = 6, mt = 8, mb = 20, pw = W - ml - mr, ph = Hh - mt - mb;
    var idx = []; s.t.forEach(function (t, i) { if (t > t0 && t <= t1 + HOUR) idx.push(i); });
    if (!idx.length) return '';
    var hi = Math.max(0.1, Math.max.apply(null, idx.map(function (i) { return s.p[i]; })));
    var nt = niceTicks(0, hi, 3), top = Math.max(hi, nt.ticks[nt.ticks.length - 1]);
    var x = function (t) { return ml + ((t - t0) / (t1 - t0)) * pw; }, y = function (v) { return mt + (1 - v / top) * ph; };
    var bw = Math.max(1, pw / 144 - 1), g = '<g class="axis">';
    nt.ticks.forEach(function (v) { if (v > top + 1e-9) return; g += '<line x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text x="' + (ml - 5) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, nt.step < 0.1 ? 2 : 1) + '</text>'; });
    // Pacific midnights as day labels.
    for (var d = Math.ceil(t0 / HOUR) * HOUR; d <= t1; d += HOUR) {
      if (fH23.format(new Date(d)) !== '00' || x(d) > W - 60) continue;
      g += '<line class="wx-day" x1="' + x(d).toFixed(1) + '" x2="' + x(d).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"/><text x="' + (x(d) + 3).toFixed(1) + '" y="' + (Hh - 6) + '">' + esc(W < 600 ? fWxDay.format(new Date(d + 12 * HOUR)).split(',')[0] : fWxDay.format(new Date(d + 12 * HOUR))) + '</text>';
    }
    g += '</g><g>';
    idx.forEach(function (i) {
      var v = s.p[i]; if (v < 0.005) return;
      var xe = x(s.t[i]), yy = y(v), fc = s.t[i] > now;
      g += '<rect class="wx-bar' + (fc ? ' fc' : '') + '" x="' + (xe - bw - 0.5).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (mt + ph - yy).toFixed(1) + '"><title>' +
        esc(wxT(s.t[i] - HOUR) + '–' + fHM(s.t[i]) + ': ' + fmt(v, 2) + ' in' + (fc ? ' (forecast)' : ' (model)')) + '</title></rect>';
    });
    g += '</g><line class="wx-now" x1="' + x(now).toFixed(1) + '" x2="' + x(now).toFixed(1) + '" y1="' + (mt - 4) + '" y2="' + (mt + ph) + '"/><text class="wx-now-lab" x="' + (x(now) + 3).toFixed(1) + '" y="' + (mt + 4) + '">NOW</text>';
    return '<svg class="wx-svg" viewBox="0 0 ' + W + ' ' + Hh + '" width="100%" role="img" aria-label="Hourly basin precipitation, past 72 hours and 72-hour forecast">' + g + '</svg>' +
      '<div class="rt-legend"><span><i class="wx-k"></i>Past hours (model)</span><span><i class="wx-k fc"></i>Forecast</span><span class="hint">in per hour · hover a bar for its value</span></div>';
  }
  var fWxH = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric' });
  function fHM(t) { return fWxH.format(new Date(t)); }

  // Basin precipitation section of "More": totals as one aligned table, then timing, chart, gauges.
  function wxBlock(p) {
    var W = H.weather, b = W && W.BASINS[p.code];
    if (!b) return '';
    var head = '<h3>Basin rain and wind <span class="hint">≈ ' + fmt(b.area) + ' sq mi above the dam · model</span></h3>';
    if (!state.wx) return '<section class="ws-sec wx-box">' + head + '<p class="na loading">Loading weather…</p></section>';
    var s = state.wx.basins[p.code], w = wxSummary(p);
    if (!w) return '<section class="ws-sec wx-box">' + head + '<p class="na">Weather model unavailable' + (state.wx.error ? ' (' + esc(state.wx.error) + ')' : '') + '.</p></section>';
    var td = function (v) { return '<td class="mono">' + inch(v) + '</td>'; };
    var h = '<section class="ws-sec wx-box">' + head +
      '<table class="ws-table wx-table"><thead><tr><th></th><th>6 h</th><th>24 h</th><th>72 h</th><th>Rain on basin, 24 h</th></tr></thead><tbody>' +
      '<tr><th>Past</th>' + td(w.past6) + td(w.past24) + td(w.past72) + '<td class="mono">' + fmt(w.vol24) + ' ac-ft · ' + fmt(w.vol24cfs) + ' cfs-day</td></tr>' +
      '<tr><th>Forecast</th>' + td(w.next6) + td(w.next24) + td(w.next72) + '<td class="mono">' + fmt(w.volNext24) + ' ac-ft · ' + fmt(w.volNext24cfs) + ' cfs-day</td></tr>' +
      '</tbody></table><p class="wx-unit hint">inches, basin mean</p>' +
      '<dl class="ws-facts">' +
      '<div><dt>Now</dt><dd>' + wxState(w) + '</dd></div>' +
      (w.event ? '<div><dt>' + (w.event.end ? 'Last event' : 'This event') + '</dt><dd><span class="mono">' + inch(w.event.total) + ' in</span> ' + (w.event.openStart ? 'over 3+ days' : 'from ' + wxT(w.event.start)) + (w.event.end ? ' to ' + wxT(w.event.end) : ' so far') + '</dd></div>' : '') +
      (w.wind ? '<div><dt>Wind</dt><dd>' + windText(w, true) + '</dd></div>' : '') +
      (w.fzNow != null ? '<div><dt>Freezing level</dt><dd><span class="mono">' + fmt(Math.round(w.fzNow / 100) * 100) + ' ft</span>' + (w.tempNow != null ? ' · ' + fmt(w.tempNow, 0) + ' °F basin mean' : '') + ' · rain below, snow above</dd></div>' : '') +
      '</dl>' + wxChart(s, Date.now());
    var sts = W.stationsFor(p.code);
    if (sts.length) {
      var sn = state.wxSno;
      h += '<h4 class="ws-h4">Measured · NRCS SNOTEL (high-elevation gauges, same basin)</h4>' + (!sn ? '<p class="na loading">loading…</p>' :
        '<table class="ws-table"><thead><tr><th>Station</th><th>Elev ft</th><th>6 h in</th><th>24 h in</th></tr></thead><tbody>' + sts.map(function (st) {
          var a = sn.stations[st.triplet], d6 = W.accumDiff(a, Date.now(), 6), d24 = W.accumDiff(a, Date.now(), 24);
          return '<tr><th>' + esc(st.name) + ' <a class="src-link" href="https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=' + st.triplet.split(':')[0] + '" target="_blank" rel="noopener" title="NRCS SNOTEL ' + esc(st.name) + '">↗</a></th>' +
            '<td class="mono">' + fmt(st.elevFt) + '</td><td class="mono">' + (d6 ? fmt(d6.v, 1) : '—') + '</td><td class="mono">' + (d24 ? fmt(d24.v, 1) : '—') + '</td></tr>';
        }).join('') + '</tbody></table>');
    } else h += '<p class="hint">No SNOTEL gauge in this basin on this site; model only.</p>';
    h += '<p class="hint wx-src">Open-Meteo weather model, mean of ' + b.pts.length + ' points (past hours are model analysis, not rain gauges; forecast to ' + wxT(w.horizon) + '). ' +
      'Rain on the basin is not runoff: soil, snow and travel time decide how much reaches the pool and when. Basin points and area are approximate. ' +
      '<a href="' + esc(W.pageUrl(p.code)) + '" target="_blank" rel="noopener">Open-Meteo ↗</a> · <a href="' + esc(W.nwsUrl(p.code)) + '" target="_blank" rel="noopener">NWS forecast for the basin ↗</a></p></section>';
    return h;
  }

  function renderWx() {
    renderList();
    if (state.selectedId && byId[state.selectedId] && byId[state.selectedId].kind === 'reservoir') renderDetails();
  }

  // ---- Area status cards: wildfire, NWS alerts, power (js/hazards.js) ---------------

  var HZ_ICON = {
    fire: '<path d="M12 22c4 0 7-2.7 7-6.6 0-3.2-2-5.4-3.5-7-.3 1.8-1.2 3-2.4 3.6.4-3.4-1.2-6.6-4.1-9 .2 3.4-1.5 5.4-3 7.2C4.6 11.9 5 13.6 5 15.4 5 19.3 8 22 12 22z"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    boltOff: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/><path d="M3 3l18 18"/>'
  };
  function hzIcon(k) { return '<svg class="sc-ic" viewBox="0 0 24 24" aria-hidden="true">' + HZ_ICON[k] + '</svg>'; }
  var fHz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function hzT(t) { return t == null ? '—' : fHz.format(new Date(t)); }

  function card(key, level, icon, title, status, body) {
    return '<details class="sc sc-' + level + '" data-card="' + key + '"><summary>' + hzIcon(icon) +
      '<span class="sc-t">' + title + '</span><span class="sc-s">' + status + '</span><span class="sc-chev" aria-hidden="true"></span></summary>' +
      '<div class="sc-body">' + body + '</div></details>';
  }

  function fireRow(f) {
    return '<tr><th>' + esc(f.name) + (f.type === 'prescribed' ? ' <span class="sc-tag">prescribed</span>' : '') + '</th>' +
      '<td class="mono">' + (f.acres != null ? fmt(f.acres, 0) + ' ac' : '—') + '</td>' +
      '<td class="mono">' + (f.contained != null ? fmt(f.contained, 0) + '%' : '—') + '</td>' +
      '<td>' + fmt(f.near.mi, 0) + ' mi ' + esc(f.near.dir) + ' of ' + esc(f.near.name) + '</td>' +
      '<td>' + esc(f.cause || '—') + '</td><td class="mono">' + hzT(f.discovered) + '</td></tr>';
  }

  // Power card: live utility outages (EWEB, Lane Electric, EPUD, Blachly-Lane) + BPA transmission (js/outages.js).
  var fPw = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function pwT(t) { return t == null ? '—' : fPw.format(new Date(t)); }
  function powerCard() {
    var O = H.outages, pw = state.pw;
    if (!O) return '';
    if (!pw) return card('power', 'pending', 'bolt', 'Power', '<span class="na loading">checking…</span>', '');
    var ok = pw.utilities.filter(function (u) { return !u.error; }), bad = pw.utilities.filter(function (u) { return u.error; });
    var bpa = pw.bpa ? pw.bpa.items.filter(function (b) { return b.stillOut || (Date.now() - Date.parse(b.out)) < 48 * 3600e3; }) : [];
    var st = O.status(ok, bpa), w = st.worst;
    var where = function (x) { return x.area || (x.comment && x.comment.length < 40 ? x.comment : '') || ''; };
    var line = !ok.length ? '<span class="na">outage data unavailable</span>'
      : st.level === 'ok' ? 'No outages detected' + (st.out ? ' <span class="hint">· ' + fmt(st.out) + ' customer' + (st.out > 1 ? 's' : '') + ' in small outages</span>' : '')
        : '<b>' + fmt(st.out) + ' customers out</b>' + (w ? ' · largest ' + esc(w.utility) + ' ' + fmt(w.n) + (where(w) ? ' ' + esc(where(w)) : '') + (w.cause ? ' · ' + esc(w.cause) : '') : '');
    if (st.bpaTrip) line += ' · <b class="sc-alert-txt">BPA line tripped</b>';
    var body = '<div class="table-scroll"><table class="ws-table sc-table"><thead><tr><th>Utility</th><th>Customers out</th><th>Outages</th><th>Areas affected</th><th>Updated</th></tr></thead><tbody>' +
      pw.utilities.map(function (u) {
        return '<tr><th><a href="' + esc(u.map) + '" target="_blank" rel="noopener">' + esc(u.name) + ' ↗</a></th>' + (u.error ? '<td colspan="4" class="na">unavailable (' + esc(u.error) + ')</td>'
          : '<td class="mono">' + fmt(u.out) + (u.served ? ' <span class="hint">of ' + fmt(u.served) + '</span>' : '') + '</td><td class="mono">' + u.incidents.length + '</td>' +
            '<td>' + (u.regions.length ? u.regions.map(function (r) { return esc(r.name) + ' (' + r.out + ')'; }).join(', ') : u.incidents.filter(function (x) { return x.area; }).map(function (x) { return esc(x.area); }).join(', ') || '—') + '</td>' +
            '<td class="mono">' + pwT(u.updated) + '</td>') + '</tr>';
      }).join('') + '</tbody></table></div>';
    var big = st.incidents.filter(function (x) { return x.n >= 2 || x.cause || x.comment; }).slice(0, 12);
    if (big.length) body += '<h4 class="ws-h4">Outages</h4><div class="table-scroll"><table class="ws-table sc-table"><thead><tr><th>Utility</th><th>Customers</th><th>Area</th><th>Since</th><th>Cause / notes</th><th>Est. restore</th></tr></thead><tbody>' +
      big.map(function (x) {
        return '<tr><th>' + esc(x.utility) + (x.planned ? ' <span class="sc-tag">planned</span>' : '') + '</th><td class="mono">' + fmt(x.n) + '</td><td>' + esc(x.area || '—') + '</td>' +
          '<td class="mono">' + (x.start ? pwT(x.start) : esc(x.startText || '—')) + '</td><td>' + esc([x.cause, x.comment, x.status].filter(Boolean).join(' · ') || '—') + '</td>' +
          '<td class="mono">' + (x.etr ? pwT(x.etr) : esc(x.etrText || '—')) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    body += '<h4 class="ws-h4">BPA transmission near the projects (Eugene district and Willamette lines)</h4>' + (!pw.bpa ? '<p class="sc-none">BPA report not copied yet (' + esc(pw.bpaError || '') + ').</p>'
      : !bpa.length ? '<p class="sc-none">No local BPA line, feeder or transformer outages in the last 48 h or still out. Report copied ' + pwT(Date.parse(pw.bpa.fetchedAt)) + '.</p>'
        : '<div class="table-scroll"><table class="ws-table sc-table"><thead><tr><th>Line / equipment</th><th>kV</th><th>Type</th><th>Cause</th><th>Out</th><th>Back</th></tr></thead><tbody>' + bpa.map(function (b) {
          return '<tr><th>' + esc(b.name) + '</th><td class="mono">' + (b.kv || '—') + '</td><td>' + esc(/auto/i.test(b.type) ? 'Unplanned (auto)' : /plan/i.test(b.type) ? 'Planned' : b.type) + '</td><td>' + esc(b.cause || '—') + '</td>' +
            '<td class="mono">' + pwT(Date.parse(b.out)) + '</td><td class="mono">' + (b.stillOut ? '<b>still out</b>' : pwT(Date.parse(b.in))) + '</td></tr>';
        }).join('') + '</tbody></table></div><p class="hint">BPA Daily Interruptions Report, copied ' + pwT(Date.parse(pw.bpa.fetchedAt)) + ' (BPA updates it daily).</p>');
    body += '<p class="hint">Live from each utility’s public outage map, checked ' + pwT(pw.fetchedAt) + ' (every 2–5 min). Card turns amber when one outage affects ≥ ' + O.LEVEL.incidentWatch + ' customers or ≥ ' + O.LEVEL.totalWatch +
      ' are out, red at ≥ ' + O.LEVEL.incidentAlert + ' in one outage, ≥ ' + O.LEVEL.totalAlert + ' total, or an unplanned BPA line trip still out. ' +
      'Not covered: ' + O.UNAVAILABLE.map(function (u) { return '<a href="' + esc(u.map) + '" target="_blank" rel="noopener">' + esc(u.name) + ' ↗</a> (' + esc(u.why) + ')'; }).join(', ') +
      (bad.length ? '. Unavailable right now: ' + esc(bad.map(function (u) { return u.name; }).join(', ')) : '') + '.</p>';
    return card('power', ok.length ? st.level : 'unknown', st.level === 'ok' ? 'bolt' : 'boltOff', 'Power', line, body);
  }

  function renderHazards() {
    var box = $('#status-cards');
    if (!box || !H.hazards) return;
    var hz = state.hz, h = '';
    // Wildfire
    if (!hz) h += card('fire', 'pending', 'fire', 'Wildfire', '<span class="na loading">checking…</span>', '');
    else {
      var fs = H.hazards.fireStatus(hz.fires, hz.alerts), wf = fs.fires;
      var status = hz.firesError ? '<span class="na">fire data unavailable</span>'
        : !wf.length ? 'No active wildfires within ' + H.hazards.NEAR_MI + ' mi' + (fs.rx.length ? ' · ' + fs.rx.length + ' prescribed burn' + (fs.rx.length > 1 ? 's' : '') : '')
          : '<b>' + wf.length + ' active wildfire' + (wf.length > 1 ? 's' : '') + '</b> · nearest ' + esc(wf[0].name) + ', ' + fmt(wf[0].near.mi, 0) + ' mi ' + esc(wf[0].near.dir) + ' of ' + esc(wf[0].near.name);
      if (fs.fireAlerts.length) status += ' · <b class="sc-alert-txt">' + esc(fs.fireAlerts.map(function (a) { return a.event; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ')) + '</b>';
      var level = hz.firesError ? 'unknown' : fs.level, body = '';
      if (fs.fireAlerts.length) body += '<ul class="sc-alerts">' + fs.fireAlerts.map(function (a) { return '<li><b>' + esc(a.event) + '</b> until ' + hzT(a.ends) + '<br><span class="hint">' + esc(a.area) + '</span></li>'; }).join('') + '</ul>';
      var all = wf.concat(fs.rx);
      body += all.length ? '<div class="table-scroll"><table class="ws-table sc-table"><thead><tr><th>Fire</th><th>Size</th><th>Contained</th><th>Where</th><th>Cause</th><th>Discovered</th></tr></thead><tbody>' + all.map(fireRow).join('') + '</tbody></table></div>'
        : '<p class="sc-none">No active fire incidents reported within ' + H.hazards.NEAR_MI + ' miles of any project.</p>';
      if (all.length) body += '<p class="hint sc-map-note">Fires are marked on the Basin map below (hover for details).</p>';
      body += '<p class="hint">NIFC WFIGS current incidents' + (hz.firesStale ? ' (last good update; latest request failed)' : '') + ' and NWS alerts, checked ' + hzT(hz.fetchedAt) + '. Incidents can lag the first reports by hours. ' +
        '<a href="https://app.watchduty.org/" target="_blank" rel="noopener">Watch Duty map ↗</a> · <a href="https://inciweb.wildfire.gov/state/oregon" target="_blank" rel="noopener">InciWeb Oregon ↗</a> · ' +
        '<a href="' + esc(H.hazards.fireUrl()) + '" target="_blank" rel="noopener">raw WFIGS data ↗</a></p>';
      h += card('fire', level, 'fire', 'Wildfire', status, body);
    }
    // NWS alerts (non-fire; fire alerts are on the wildfire card)
    if (!hz) h += card('alerts', 'pending', 'bell', 'NWS alerts', '<span class="na loading">checking…</span>', '');
    else {
      var al = (hz.alerts || []).filter(function (a) { return !a.fire; });
      var ev = al.map(function (a) { return a.event; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      var lvl = hz.alertsError ? 'unknown' : !al.length ? 'ok' : al.some(function (a) { return /warning/i.test(a.event); }) ? 'alert' : 'watch';
      h += card('alerts', lvl, 'bell', 'NWS alerts', hz.alertsError ? '<span class="na">alerts unavailable</span>' : al.length ? '<b>' + esc(ev.join(', ')) + '</b>' : 'No active warnings or advisories for the basin',
        (al.length ? '<ul class="sc-alerts">' + al.map(function (a) {
          return '<li><b>' + esc(a.event) + '</b> · ' + esc(a.severity || '') + ' · until ' + hzT(a.ends) + '<br>' + esc(a.headline) + '<br><span class="hint">' + esc(a.area) + '</span></li>';
        }).join('') + '</ul>' : '<p class="sc-none">No active NWS alerts name Lane, Linn or the Willamette/Cascade zones.</p>') +
        '<p class="hint">National Weather Service active alerts for Oregon, filtered to the basin’s counties and zones, checked ' + hzT(hz.fetchedAt) + '. <a href="https://www.weather.gov/pqr/" target="_blank" rel="noopener">NWS Portland ↗</a></p>');
    }
    h += powerCard();
    setHTML(box, h);
    var open = box.querySelector('.sc[open]');
    if (open) placeCard(open);
    renderMapHazards();
  }

  // An open card's body floats over the page below (CSS .sc-body), right under its card and as wide
  // as the row of cards; nothing below moves. One open at a time; outside click or Escape closes it.
  function placeCard(d) {
    var box = $('#status-cards');
    if (box && d) box.style.setProperty('--sc-top', Math.round(d.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 6) + 'px');
  }
  function openCard(key) {
    var box = $('#status-cards'), d = box && box.querySelector('.sc[data-card="' + key + '"]');
    if (!d) return;
    box.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    d.open = true;
  }
  function initStatusCards() {
    var box = $('#status-cards');
    if (!box) return;
    box.addEventListener('toggle', function (ev) {
      var d = ev.target;
      if (!d.classList || !d.classList.contains('sc') || !d.open) return;
      box.querySelectorAll('.sc[open]').forEach(function (o) { if (o !== d) o.open = false; });
      placeCard(d);
      // A card low on the screen (phones): bring its overlay into view.
      var body = d.querySelector('.sc-body');
      if (body && body.getBoundingClientRect().bottom > window.innerHeight) {
        window.scrollBy({ top: Math.min(body.getBoundingClientRect().bottom - window.innerHeight + 12, d.getBoundingClientRect().top - 72), behavior: REDUCED ? 'auto' : 'smooth' });
      }
    }, true);
    document.addEventListener('click', function (ev) {
      var o = box.querySelector('.sc[open]');
      if (o && !o.contains(ev.target)) o.open = false;
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var o = box.querySelector('.sc[open]');
      if (!o) return;
      o.open = false;
      var sm = o.querySelector('summary');
      if (sm) sm.focus();
    });
    window.addEventListener('resize', function () { var o = box.querySelector('.sc[open]'); if (o) placeCard(o); });
  }

  // ---- Live event feed (js/events.js detect, js/notify.js toasts + bell panel) ---------------

  var evPrev = null;
  // Called after each data source lands: compares with the previous snapshot. The first snapshot
  // (and the first load of each source) only seeds; events.js skips sources missing in either.
  function trackEvents() {
    if (!H.events || !H.notify) return;
    var next = { at: Date.now(), wx: state.wx, hz: state.hz, pw: state.pw, nwps: state.nwps, snap: state.snap };
    var ev = evPrev ? H.events.detect(evPrev, next, next.at) : [];
    evPrev = next;
    if (ev.length) H.notify.push(ev);
  }
  // Toast / feed click: select the project or gauge, or open the matching status card.
  function openEvent(e) {
    var away = H.router && H.router.current() !== 'overview';
    if (away) H.router.go('overview');
    setTimeout(function () {
      if (e.entityId && byId[e.entityId]) {
        select(e.entityId, true);
        var ws = $('#workspace');
        if (ws) ws.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
      } else if (e.kind === 'power') openCard('power');
      else if (e.kind === 'fire' || e.fire) openCard('fire');
      else if (e.kind === 'alert') openCard('alerts');
    }, away ? 80 : 0);
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
    setHTML(box, '<table class="snow-table"><thead><tr><th>Station</th><th>SWE</th><th>Depth</th><th>SWE 7 d</th><th>Last report</th></tr></thead><tbody>' +
      H.snotel.STATIONS.map(function (st) {
        var o = sn.stations[st.triplet];
        var swe = o && o.swe.v.length ? o.swe.v[o.swe.v.length - 1] : null, dep = o && o.depth.v.length ? o.depth.v[o.depth.v.length - 1] : null;
        return '<tr><td><b>' + esc(st.name) + '</b><span class="snow-meta">' + fmt(st.elevFt) + ' ft · ' + esc(st.basin) + '</span></td>' +
          '<td class="mono">' + (swe == null ? NA : fmt(swe, 1) + ' in') + '</td><td class="mono">' + (dep == null ? NA : fmt(dep, 0) + ' in') + '</td>' +
          '<td>' + (o ? snowSpark(o) : '') + '</td><td class="mono">' + (o && o.last ? fSnowDay.format(new Date(o.last + 'T12:00:00Z')) : NA) + '</td></tr>';
      }).join('') + '</tbody></table>');
  }

  // ---- Selection -----------------------------------------------------------

  // One selection drives the list, the map, the header, the chart and "More".
  // fromList: on narrow screens (chart below the list) bring the chart into view.
  function select(id, withChart, fromList) {
    if (!byId[id]) return;
    state.selectedId = id;
    document.querySelectorAll('.node, .ws-row').forEach(function (n) {
      var on = n.getAttribute('data-id') === id;
      n.classList.toggle('selected', on);
      if (n.classList.contains('node')) n.setAttribute('aria-pressed', on ? 'true' : 'false');
      else n.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderDetails();
    setChart(id);
    if (fromList && window.matchMedia && window.matchMedia('(max-width: 960px)').matches) {
      var t = $('#trends'); if (t) t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    }
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
  // Reservoirs: the time axis continues this far past "now" (hours) as a hatched forecast zone, where the
  // strips show the model's rain forecast and the NWRFC inflow forecast (the pool itself has none).
  var FC_ZONE_H = { '24h': 72, '7d': 72, '30d': 168 };
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
        .then(function () { if (state.chartId === e.id) { renderChart(false); renderDetails(); } });
    }
    return null;
  }

  // Long-range history for the charted point (cached in js/history.js); re-renders when it lands.
  function histFor(e) {
    if (!isLong(state.range) || !H.history) return null;
    var key = e.id + ':' + state.range, hv = state.hist[key];
    // Fresh enough, or already refreshing in the background: draw what we have.
    if (hv && !hv.loading && (hv.refreshing || Date.now() - hv.at < 30 * 60 * 1000)) return hv;
    if (!hv || !hv.loading) {
      var prevH = hv && !hv.loading ? hv : null, first = !prevH;
      if (prevH) prevH.refreshing = true; else state.hist[key] = { loading: true };
      var d = e.kind === 'reservoir' ? projData(e) : null;
      // Calendar YEAR: reservoirs read the year's lake record (plus live readings); rivers use the 1-yr history.
      var pr = state.range !== 'year' ? H.history.load(e, state.range, d && d.elev)
        : e.kind === 'reservoir' ? H.history.loadYear(e, curYear()).then(function (r) { if (r.pool && d && d.elev) r.pool = H.history.appendLive(r.pool, d.elev); return r; })
          : H.history.load(e, '1y', null);
      pr.then(function (r) {
        // A failed background refresh keeps the history already on screen.
        if (prevH && (!r || r.error)) { prevH.refreshing = false; prevH.at = Date.now(); return; }
        r.at = Date.now();
        state.hist[key] = r;
        if (state.chartId === e.id && e.id + ':' + state.range === key) renderChart(first);
      });
    }
    return state.hist[key];
  }

  // Long-range history is cached; add the live readings that arrived since it loaded (hourly),
  // so 30 D … YEAR views keep moving with every poll.
  function withLive(h, live) {
    if (!h || !h.t || !h.t.length || !live || !H.history) return h;
    var r = H.history.appendLive(h, live);
    if (r.t.length === h.t.length) return h;
    r.liveFrom = h.liveFrom || r.liveFrom;
    return r;
  }

  function chartModel() {
    var e = byId[state.chartId], res = e.kind === 'reservoir';
    var long = isLong(state.range), hist = long ? histFor(e) : null, hLoading = !!(hist && hist.loading);
    var now = Date.now(), end = now, start = now - RANGE_H[state.range] * HOUR;
    if (state.range === 'year') { start = H.history.pacificMidnight(curYear(), 1, 1); end = H.history.pacificMidnight(curYear() + 1, 1, 1); }
    var fz = res && FC_ZONE_H[state.range] ? { from: now, to: now + FC_ZONE_H[state.range] * HOUR, h: FC_ZONE_H[state.range] } : null;
    if (fz) end = fz.to;
    var s, ref = null, unit, dec, title, src, param = null, g = null;
    if (res) {
      var d = projData(e);
      s = long ? withLive(hist && hist.pool, d && d.elev) : d && d.elev; ref = long ? hist && hist.rule : d && d.rule; unit = 'ft'; dec = 2;
      title = e.name + ' · pool elevation (ft)';
      src = long
        ? (hist && hist.src ? hist.src + (hist.pool && hist.pool.liveFrom ? stamp(hist.pool.liveFrom) + ' (hourly)' : '') : 'loading history…') +
          '; dashed: ' + e.series.rule.name + ' (USACE rule curve, daily, linearly joined).' + (hist && hist.note ? ' ' + hist.note : '')
        : 'USACE CWMS (NWDP) ' + e.series.elev.name + '; dashed: ' + e.series.rule.name + ' (USACE rule curve, daily, linearly joined).';
      if (fz) src += ' Hatched: the next ' + (fz.h % 24 ? fz.h + ' h' : fz.h / 24 + ' days') + ' (forecast zone). The pool has no published forecast; the strips below show the model rain forecast and, where NWRFC publishes one, its inflow forecast.';
    } else {
      var sd = stData(e);
      param = state.riverParam === 'temp' ? 'temp' : e.params.indexOf('flow') >= 0 && state.riverParam === 'flow' ? 'flow' : 'stage';
      if (param === 'temp') {
        // USGS reports °C; the site displays °F (°C kept in tooltips/details).
        var tsrc = long ? (state.range === '30d' ? withLive(hist && hist.tempC, sd && sd.tempC) : hist && hist.tempC) : sd && sd.tempC;
        var tc = tsrc && tsrc.t.length ? tsrc : null;
        s = tc ? { t: tc.t, v: tc.v.map(H.cToF), q: tc.q } : null;
        unit = '°F'; dec = 1;
        title = e.name + ' · water temperature (°F)';
        src = 'USGS NWIS site ' + e.site + ', parameter 00010 water temperature (reported in °C, shown in °F)' + (long && hist && hist.src ? ', ' + hist.src : '') + '. Values flagged P are provisional.';
      } else {
        var psrc = long ? (state.range === '30d' ? withLive(hist && hist[param], sd && sd[param]) : hist && hist[param]) : sd && sd[param];
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
      var tg = L && L.targetFor(e.code, lv);
      if (tg && layerOn('target')) {
        var te = LVm.pick(lv, tg.id, now);
        if (te) target = { label: tg.label, pts: LVm.seasonalSeries(te, start - DAY, end + DAY) };
      }
      levels = L.levelValues(lv, now).filter(function (l) { return layerOn('lvl:' + l.key); });
    }
    return { e: e, res: res, start: start, end: end, now: now, t: t, v: v, q: q, rt: rt, rv: rv, unit: unit, dec: dec, title: title, src: src,
      lv: lv, stats: stats, target: target, levels: levels,
      tt: tt, tv: tv, tLabel: tLabel, tNote: tNote,
      param: param, fc: fc, issued: issued, bands: bands, fcNote: fcNote, peak: g && g.peak, long: long,
      fullStart: fullStart, fullEnd: fullEnd, zoomed: zoomed, fz: fz,
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
    $('#trend-tag').textContent = RANGE_TAG[state.range] + (M.fz ? ' + ' + (M.fz.h % 24 ? M.fz.h + ' H' : M.fz.h / 24 + ' D') + ' AHEAD' : '') + (M.long ? ' · HISTORY + LIVE' : ' · LIVE SERIES') +
      (state.snap && state.snap.fetchedAt ? ' · checked ' + fmtClock.format(state.snap.fetchedAt).replace(/^24/, '00').slice(0, 5) : '');
    setHTML($('#chart-src'), 'Source: ' + H.linkSources(M.src));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H2);
    svg.setAttribute('height', H2);
    state.geom = null;

    if (M.t.length < 2) {
      setHTML(svg, '');
      msg.hidden = false;
      msg.textContent = M.loading ? (M.long ? 'Loading ' + RANGE_TAG[state.range].toLowerCase() + ' of history…' : 'Loading live data…')
        : M.histError ? 'History unavailable (' + M.histError + ').' : 'No data returned for this series in the selected window.';
      $('#chart-legend').innerHTML = '';
      setHTML($('#chart-stats'), '');
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
      '<clipPath id="plot-clip"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath>' + fzHatch('fc-hatch') + '</defs>';

    s += '<g class="grid axis">';
    nt.ticks.forEach(function (v, k) {
      if (v < yMin || v > yMax) return;
      var yy = y(v).toFixed(1);
      s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<text x="' + (ml - 8) + '" y="' + (+yy + 3.5) + '" text-anchor="end">' + labels[k] + '</text>';
    });
    // x ticks on Pacific-time boundaries (Pacific offsets are whole hours, so UTC hour starts align)
    // Tick style follows the visible span, so zooming in switches months -> days -> hours.
    var xl = [], xtext = function (xx, lab) { xl.push({ x: +xx, lab: lab }); return '<text x="' + xx + '" y="' + (H2 - 9) + '" text-anchor="middle">' + lab + '</text>'; };
    var spanH = (M.end - M.start) / HOUR, tickMode = spanH <= 48 ? 'hours' : spanH <= 240 ? 'days' : spanH <= 75 * 24 ? 'weeks' : 'months';
    if (tickMode === 'weeks' || tickMode === 'months') {
      // Weeks: faint daily lines, Mondays labelled. Months: month starts labelled (year on January).
      var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (tickMode === 'weeks') {
        H.history.dayTicks(M.start, M.end, false).forEach(function (o) {
          var xx = x(o.t).toFixed(1), p2 = parts(o.t + HOUR);
          s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:' + (o.dow === 1 ? '.6' : '.18') + '"/>';
          if (o.dow === 1) s += xtext(xx, pw < 420 ? p2.month + '/' + p2.day : 'Mon ' + p2.month + '/' + p2.day);
        });
      } else {
        var mt2 = H.history.monthTicks(M.start, M.end), skip = spanH > 200 * 24 && pw < 420 ? 2 : 1;
        mt2.forEach(function (o, i) {
          var xx = x(o.t).toFixed(1);
          s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:.55"/>';
          if (i % skip === 0) s += xtext(xx, MN[o.m - 1] + (o.m === 1 ? " '" + String(o.y).slice(2) : ''));
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
        s += xtext(xx, lab);
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
      if (M.fz) s += fzZone(xn, ml, pw, mt, ph, 'fc-hatch', true);
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
    if (M.end > M.now + HOUR && x(M.now) >= ml) {
      var xnow = x(M.now).toFixed(1);
      s += '<line class="now-line" x1="' + xnow + '" x2="' + xnow + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
      s += '<text class="now-label" x="' + (+xnow + 4) + '" y="' + (mt + ph - 6) + '">' + (M.fc.t.length > 1 ? 'NOW · NWS FORECAST →' : M.fz ? 'NOW' : 'TODAY') + '</text>';
    }
    s += '<circle class="now" cx="' + x(M.t[n - 1]).toFixed(1) + '" cy="' + y(M.v[n - 1]).toFixed(1) + '" r="4.5"/>';
    s += '<g id="cross" style="display:none"><line class="cross" id="cross-line" y1="' + mt + '" y2="' + (mt + ph) + '"/><circle class="cross-dot" id="cross-dot" r="5"/>' +
      curTSVG('cross-t', H2 - 9) + '</g>';
    s += '<rect x="' + ml + '" y="0" width="' + pw + '" height="' + H2 + '" fill="transparent"/>';
    if (animate) { svg.innerHTML = s; svg.__html = s; } else setHTML(svg, s);
    if (animate && !REDUCED) {
      var line = $('#chart-line');
      line.style.setProperty('--len', Math.ceil(line.getTotalLength()));
    }
    state.geom = { M: M, x: x, y: y, ml: ml, pw: pw, W: W, H: H2, mt: mt, ph: ph, xl: xl };
    renderTrendZoom(M);
    renderLayerBar(M);
    renderStrips();

    $('#chart-legend').innerHTML = '<span><i></i>' + (M.res ? (M.long && /^USGS/.test(M.src) ? 'Pool elevation (USGS daily + USACE live)' : 'Pool elevation (USACE)') : M.param === 'flow' ? 'Discharge (USGS)' : M.param === 'temp' ? 'Water temperature (USGS)' : 'Gage height (USGS)') + '</span>' +
      (M.tt.length ? '<span><i class="tgt"></i>' + esc(M.tLabel) + '</span>' : '') + (M.tNote ? '<span class="na">' + esc(M.tNote) + '</span>' : '') +
      (M.rt.length > 1 ? '<span><i class="ref"></i>USACE rule curve</span>' : M.res ? '<span class="na">Rule curve: no data</span>' : '') +
      (M.fc.t.length > 1 ? '<span><i class="fc"></i>NWS/NWRFC forecast (via NOAA NWPS), issued ' + stamp(M.issued) + '</span>' : '') +
      (M.fz && M.end > M.now ? '<span><i class="lg-fz"></i>Forecast zone (no pool forecast; rain and inflow forecasts below)</span>' : '') +
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
    setHTML($('#chart-stats'), stats);
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

  // Synced crosshair: hovering the main chart or any strip puts the cursor (and a time label on
  // the x-axis) at the same moment in all of them. The time snaps to the main series' nearest
  // reading when there is one close by, so every cursor sits on the same instant.
  function onPointer(ev) {
    var g = state.geom;
    if (!g) return;
    var rect = $('#chart').getBoundingClientRect(), px = (ev.clientX - rect.left) * (g.W / rect.width);
    if (px < g.ml || px > g.ml + g.pw) { hideCross(); return; }
    crossAt(g.M.start + ((px - g.ml) / g.pw) * (g.M.end - g.M.start));
  }

  // Cursor time label, e.g. "Fri 27 03:00" (short: "Fri 03:00" on spans up to 3 days; months: "Fri 11/27").
  function curLabel(t, short) {
    var g = state.geom, span = g ? g.M.end - g.M.start : 7 * DAY, p = parts(t);
    var hm = String(p.h).padStart(2, '0') + ':' + String(p.m).padStart(2, '0');
    if (span > 75 * DAY) return p.weekday + ' ' + p.month + '/' + p.day;
    return p.weekday + (short && span <= 3 * DAY ? '' : ' ' + p.day) + ' ' + hm;
  }
  // A time label on an x-axis (boxed, so it reads over the tick labels); placed by placeCurT().
  function curTSVG(id, baseline) {
    return '<g class="cur-t"' + (id ? ' id="' + id + '"' : '') + ' style="display:none"><rect class="cur-t-bg" y="' + (baseline - 11) + '" height="15" rx="2"/>' +
      '<text class="cur-t-txt" y="' + baseline + '" text-anchor="middle"></text></g>';
  }
  function placeCurT(el, x, t) {
    var g = state.geom;
    if (!el || !g) return;
    if (t == null) { el.style.display = 'none'; return; }
    var lab = curLabel(t), w = lab.length * 6.4 + 10, cx = Math.max(g.ml + w / 2 - 6, Math.min(g.ml + g.pw - w / 2 + 6, x));
    var tx = el.querySelector('text'), bg = el.querySelector('rect');
    if (tx.textContent !== lab) tx.textContent = lab;
    tx.setAttribute('x', cx.toFixed(1));
    bg.setAttribute('x', (cx - w / 2).toFixed(1)); bg.setAttribute('width', w.toFixed(1));
    el.style.display = '';
  }

  function crossAt(t) {
    var g = state.geom;
    if (!g) return;
    var rect = $('#chart').getBoundingClientRect(), scale = g.W / rect.width;
    var tip = $('#tooltip'), extra = '', cx, cy = null, tc = t, html;
    var lastObs = g.M.t[g.M.t.length - 1], fi = -1;
    if (g.M.fc.t.length > 1 && t > lastObs) {
      fi = lastIndexBefore(t, g.M.fc.t);
      if (fi < g.M.fc.t.length - 1 && Math.abs(g.M.fc.t[fi + 1] - t) < Math.abs(g.M.fc.t[fi] - t)) fi++;
    }
    if (fi > 0) {
      tc = g.M.fc.t[fi]; cy = g.y(g.M.fc.v[fi]);
      html = stamp(tc) + '<br><b>' + fmt(g.M.fc.v[fi], g.M.dec) + ' ' + g.M.unit + '</b><br>NWS forecast';
    } else {
      var i = lastIndexBefore(t, g.M.t);
      if (i < 0) i = 0;
      if (i < g.M.t.length - 1 && Math.abs(g.M.t[i + 1] - t) < Math.abs(g.M.t[i] - t)) i++;
      var span = g.M.end - g.M.start;
      if (g.M.fz && t > g.M.now && Math.abs(g.M.t[i] - t) > Math.max(3 * HOUR, span / 60)) {
        // Forecast zone: no pool forecast; the rule curve where it is published (rain/inflow on the strips).
        var rf = g.M.rt.length ? H.interpolate({ t: g.M.rt, v: g.M.rv }, t) : null;
        html = stamp(t) + '<br><span class="fz-tag">FORECAST ZONE</span> +' + fmt((t - g.M.now) / HOUR, 0) + ' h' +
          (rf != null ? '<br>rule curve ' + fmt(rf, 1) + ' ft' : '') + '<br><span class="na">no pool forecast</span>';
      } else if (Math.abs(g.M.t[i] - t) > Math.max(3 * HOUR, span / 60)) {
        // No reading near the cursor (e.g. in the future part of the window): cursor only.
        html = stamp(t) + '<br><span class="na">no reading</span>';
      } else {
        tc = g.M.t[i]; cy = g.y(g.M.v[i]);
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
        html = stamp(g.M.t[i]) + '<br><b>' + fmt(g.M.v[i], g.M.dec) + ' ' + g.M.unit + '</b>' + extra;
      }
    }
    cx = g.x(tc);
    syncStrips(tc);
    $('#cross').style.display = '';
    $('#cross-line').setAttribute('x1', cx); $('#cross-line').setAttribute('x2', cx);
    var dot = $('#cross-dot');
    if (cy == null) dot.style.display = 'none';
    else { dot.style.display = ''; dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); }
    placeCurT($('#cross-t'), cx, tc);
    tip.hidden = false;
    if (tip.__html !== html) { tip.innerHTML = html; tip.__html = html; }
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
    renderChart(true);
  }

  // Smallest zoom window: 2 h on 24 H, 6 h on 7 D, 1 day on 30 D, 7 days on 6 MO / 1 YR.
  function trendMinZoom() { return ({ '24h': 2, '7d': 6, '30d': 24, '6m': 168, '1y': 168, year: 72, years: 72 })[state.range] / RANGE_H[state.range]; }
  function setTrendZoom(z) { state.tzoom = H.zoom.clamp(z, trendMinZoom()); hideCross(); renderChart(false); }
  function renderTrendZoom(M) {
    var el = $('#trend-zoom');
    if (!el || !H.zoom) return;
    setHTML(el, H.zoom.bar(state.tzoom, 'tzoom', state.tzoom[0] > 0 || state.tzoom[1] < 1 ? esc(stamp(M.start) + ' – ' + stamp(M.end)) : ''));
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

  // Forecast zone right of "now" (reservoirs): a hatch pattern (one per SVG) and the zone itself.
  function fzHatch(id) {
    return '<pattern id="' + id + '" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="fz-hl" x1="0" y1="0" x2="0" y2="7"/></pattern>';
  }
  function fzZone(xn, ml, pw, mt, ph, id, label) {
    var x0 = Math.max(ml, xn), w = ml + pw - x0;
    if (w <= 0) return '';
    return '<rect class="fz-zone" x="' + x0.toFixed(1) + '" y="' + mt + '" width="' + w.toFixed(1) + '" height="' + ph + '" fill="url(#' + id + ')"/>' +
      (label && w > 80 ? '<text class="fz-label" x="' + (x0 + 5).toFixed(1) + '" y="' + (mt + 11) + '">FORECAST →</text>' : '');
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
    // off = reason the layer has no data here: shown greyed out and struck through, not clickable.
    var chip = function (it, label, off) {
      return '<button type="button" class="chip small tl-chip' + (off ? ' tl-na' : '') + '" data-layer="' + esc(it.key) + '" aria-pressed="' + (!off && L.isOn(it)) + '"' +
        (off ? ' disabled title="' + esc(off) + '" aria-label="' + esc(label + ': ' + off) + '"' : '') + '>' + esc(label) + '</button>';
    };
    if (e.kind === 'reservoir') {
      var lv = levelsFor(e), have = lv ? L.levelValues(lv).map(function (l) { return l.key; }) : null;
      // Every layer is listed; ones this dam does not publish are greyed out (known once its levels load).
      var items = L.CHART_TOGGLES.filter(function (it) { return state.range !== 'years' || (it.key !== 'rule' && it.key !== 'target'); });
      var offWhy = function (it) {
        if (!lv) return null;
        if (it.key === 'target') return (L.targetFor(e.code, lv) && H.levels.pick(lv, L.targetFor(e.code, lv).id, Date.now())) ? null : 'No injunction or interim-operations elevation target is published in CWMS for ' + e.name + '.';
        if (it.key === 'stats') return H.levels.pick(lv, H.levels.IDS.statsAve, Date.now()) ? null : 'No 30-yr statistics are published in CWMS for ' + e.name + '.';
        if (it.level) return have.indexOf(it.level) >= 0 ? null : it.label + ' is not published in CWMS for ' + e.name + '.';
        return null;
      };
      h += '<div class="tl-group" role="group" aria-label="Layers on the chart"><span class="tl-h">On chart</span>' +
        items.map(function (it) { return chip(it, it.label, offWhy(it)); }).join('') + (have ? '' : '<span class="na loading tl-note">loading level lines…</span>') + '</div>';
    }
    if (state.range !== 'years') {
      var defs = L.stripsFor(e, M ? M.param : null);
      h += '<div class="tl-group" role="group" aria-label="Charts below"><span class="tl-h">Below chart</span>' +
        defs.map(function (d) { return chip(stripItem(e, d), d.label, M ? stripOff(stripData(e, d, M)) : L.unavailable(e, d.key)); }).join('') + '</div>';
    }
    setHTML(el, h);
  }

  // Strips: each enabled quantity as its own small chart on the main chart's time axis.
  // Strip data for the current point and range (cached; fetched once, re-rendered when it lands).
  // Fetched for every offered strip, on or off, so unavailable ones can be greyed out before a click.
  function stripData(e, def, M) {
    var ck = e.id + '|' + def.key + '|' + state.range, sd = state.strips[ck];
    if (L.unavailable(e, def.key)) return { empty: true, lines: [], static: L.unavailable(e, def.key) };
    if (!sd || (!sd.loading && !sd.refreshing && Date.now() - sd.at > 10 * 60 * 1000)) {
      // Refresh in the background: keep the current lines on screen until the new ones land.
      state.strips[ck] = sd = sd && !sd.error ? Object.assign({}, sd, { refreshing: true }) : { loading: true };
      L.load(e, def.key, M.fullStart, Math.min(M.fullEnd, Date.now()), e.kind === 'reservoir' ? projData(e) : null, M.fz ? M.fz.to : null).then(function (r) {
        r.at = Date.now(); state.strips[ck] = r;
        if (state.geom && state.geom.M.e === e) { renderLayerBar(state.geom.M); renderStrips(); }
      });
    }
    return sd;
  }
  // Reason a strip is unavailable now (known in advance, or fetched and empty), or null.
  function stripOff(sd) { return sd && !sd.loading && sd.empty ? sd.static || (sd.error ? 'Unavailable: ' + sd.error : 'Not reported for this window' + (sd.src ? ' (' + sd.src + ')' : '') + '.') : null; }

  function renderStrips() {
    var box = $('#trend-strips'), g = state.geom;
    if (!box || !L) return;
    if (state.range === 'years' || !g) { box.innerHTML = ''; return; }
    var M = g.M, e = M.e;
    var defs = L.stripsFor(e, M.param).filter(function (d) { return L.isOn(stripItem(e, d)) && !stripOff(stripData(e, d, M)); });
    state.stripView = [];
    setHTML(box, defs.map(function (def) { return stripHTML(def, stripData(e, def, M), g); }).join(''));
  }

  function stripHTML(def, sd, g) {
    var M = g.M, unit = esc(def.unit);
    if (def.key === 'flows' && M.long && sd.lines && M.e.kind === 'reservoir') {
      var dl = projData(M.e) || {};
      sd = Object.assign({}, sd, { lines: sd.lines.map(function (l) { if (l.fc) return l; var lv = l.cls === 'st-out' ? dl.out : dl.inflow, r = withLive(l, lv); return r === l ? l : Object.assign({}, l, { t: r.t, v: r.v }); }) });
    }
    // Each line's newest reading, so a series that reports later (hourly vs 15-min) is visible as such.
    var lastOf = function (l) { return !l.fc && l.t.length ? ' <span class="st-last mono" title="Newest reading of this series">' + esc(fmtClock.format(l.t[l.t.length - 1]).replace(/^24/, '00').slice(0, 5)) + '</span>' : ''; };
    // Forecast lines name their issue time and link to the forecaster's page.
    var keyLabel = function (l) {
      var lab = esc(l.issued ? l.label.replace(/\)$/, ', issued ' + stamp(l.issued) + ')') : l.label);
      return l.page ? '<a class="st-klink" href="' + esc(l.page) + '" target="_blank" rel="noopener">' + lab + ' ↗</a>' : lab;
    };
    var keys = sd.lines && sd.lines.length ? sd.lines.map(function (l) { return '<span class="st-key">' + (sd.lines.length > 1 ? '<i class="' + l.cls + '"></i>' + keyLabel(l) : '<span class="st-lab-1">latest</span>') + lastOf(l) + '</span>'; }).join('') : '';
    var note = sd.note ? '<span class="na st-note">' + esc(sd.note) + '</span>' : '';
    var hint = def.key === 'precip' && M.e.kind === 'reservoir' && H.runoff ? '<span class="st-hint">drag across the bars: rain total, volume, pool rise</span>' : '';
    var head = '<div class="st-head"><b>' + esc(def.label) + '</b> <span class="st-unit">' + unit + '</span>' + keys + note + hint + '<span class="st-read mono"></span></div>';
    var wrap = function (inner, src, extra) { return '<div class="strip" data-strip="' + def.key + '">' + head + inner + (src ? '<p class="st-src">' + H.linkSources(src) + '</p>' : '') + (extra || '') + '</div>'; };
    if (sd.loading) return wrap('<p class="na loading st-msg">loading…</p>');
    if (sd.empty) return wrap('<p class="na st-msg">' + (sd.error ? 'unavailable (' + esc(sd.error) + ')' : 'not reported for this window') + '</p>', sd.src);
    var vals = [];
    sd.lines.forEach(function (l) { l.t.forEach(function (t, i) { if (t >= M.start && t <= M.end) vals.push(l.v[i]); }); });
    if (!vals.length) return wrap('<p class="na st-msg">no readings in this window</p>', sd.src);
    if (def.ref) vals.push(def.ref);
    var bars = sd.lines.some(function (l) { return l.bars; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (bars) { lo = 0; hi = Math.max(hi, 0.02); }   // rain bars stand on zero
    var pad = (hi - lo || Math.abs(hi) * 0.05 || 1) * 0.12;
    var nt = niceTicks(bars ? 0 : lo - pad, hi + pad, 3), yMin = bars ? 0 : Math.min(nt.ticks[0], lo - pad), yMax = Math.max(nt.ticks[nt.ticks.length - 1], hi + pad);
    var Hs = 104, mt = 6, mb = 24, ph = Hs - mt - mb, W = g.W, ml = g.ml, pw = g.pw;
    var x = function (t) { return ml + ((t - M.start) / (M.end - M.start)) * pw; }, y = function (v) { return mt + (1 - (v - yMin) / (yMax - yMin)) * ph; };
    var dec = nt.step < 1 ? (nt.step < 0.1 ? 2 : 1) : 0;
    var svg = '<svg class="st-svg" viewBox="0 0 ' + W + ' ' + Hs + '" width="100%" height="' + Hs + '" aria-hidden="true"><defs><clipPath id="st-clip-' + def.key + '"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath>' +
      (M.fz ? fzHatch('st-hatch-' + def.key) : '') + '</defs><g class="axis">';
    // The strip shares the main chart's left margin; labels too wide for it go just inside the plot.
    var inside = nt.ticks.some(function (v) { return 6.6 * fmt(v, dec).length + 12 > ml; });
    nt.ticks.forEach(function (v) {
      if (v < yMin || v > yMax) return;
      svg += '<line x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>' + (inside
        ? (y(v) - mt < 11 ? '' : '<text class="st-yin" x="' + (ml + 4) + '" y="' + (y(v) - 3).toFixed(1) + '">' + fmt(v, dec) + '</text>')   // above its line; none at the very top
        : '<text x="' + (ml - 8) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, dec) + '</text>');
    });
    (g.xl || []).forEach(function (o) {
      if (o.x < ml || o.x > ml + pw) return;
      svg += '<line class="st-xg" x1="' + o.x + '" x2="' + o.x + '" y1="' + mt + '" y2="' + (mt + ph) + '"/><line class="st-xt" x1="' + o.x + '" x2="' + o.x + '" y1="' + (mt + ph) + '" y2="' + (mt + ph + 3) + '"/>' +
        '<text class="st-xl" x="' + o.x + '" y="' + (Hs - 7) + '" text-anchor="middle">' + o.lab + '</text>';
    });
    svg += '<line class="st-xaxis" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + (mt + ph) + '" y2="' + (mt + ph) + '"/>';
    svg += '</g><g clip-path="url(#st-clip-' + def.key + ')">';
    var xn = x(M.now), fzOn = M.fz && M.end > M.now;
    if (fzOn) svg += fzZone(xn, ml, pw, mt, ph, 'st-hatch-' + def.key, false);
    if (def.ref) svg += '<line class="st-ref" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + y(def.ref).toFixed(1) + '" y2="' + y(def.ref).toFixed(1) + '"/><text class="st-ref-lab" x="' + (ml + pw - 4) + '" y="' + (y(def.ref) - mt < 12 ? y(def.ref) + 11 : y(def.ref) - 3).toFixed(1) + '" text-anchor="end">' + esc(def.refLabel) + '</text>';
    sd.lines.forEach(function (l) {
      var i0 = Math.max(0, lastIndexBefore(M.start, l.t)), i1 = Math.min(l.t.length - 1, lastIndexBefore(M.end, l.t) + 1), d = '';
      if (l.bars) {
        // One bar per value, spanning the hour (or day) it totals: (t − step, t].
        var bstep = l.t.length > 1 ? l.t[1] - l.t[0] : HOUR, y0 = y(0);
        for (var b = i0; b <= i1; b++) {
          if (!(l.v[b] > 0)) continue;
          var xa = x(l.t[b] - bstep), xb = x(l.t[b]), bw = Math.max(0.8, xb - xa - (xb - xa > 3 ? 1 : 0));
          d += 'M' + xa.toFixed(1) + ' ' + y0.toFixed(1) + 'V' + Math.min(y0 - 0.8, y(l.v[b])).toFixed(1) + 'h' + bw.toFixed(1) + 'V' + y0.toFixed(1) + 'Z';
        }
        svg += '<path class="st-bars ' + l.cls + '" d="' + d + '"/>';
        return;
      }
      var step = Math.max(1, Math.ceil((i1 - i0 + 1) / 700));
      for (var i = i0; i <= i1; i += step) d += (d ? 'L' : 'M') + x(l.t[i]).toFixed(1) + ' ' + y(l.v[i]).toFixed(1);
      svg += '<path class="st-line ' + l.cls + '" d="' + d + '"/>';
    });
    var extra = '';
    if (def.key === 'precip' && M.e.kind === 'reservoir') {
      // Drag selection (rain total → volume → runoff → pool rise); kept across refreshes until cleared.
      var ps = prSel && prSel.id === M.e.id ? prSel : null, sa = ps ? Math.max(ml, x(ps.a)) : 0, sb = ps ? Math.min(ml + pw, x(ps.b)) : 0;
      svg += '<rect class="pr-sel" y="' + mt + '" height="' + ph + '" x="' + sa.toFixed(1) + '" width="' + Math.max(0, sb - sa).toFixed(1) + '"' + (ps && sb > sa ? '' : ' style="display:none"') + '/>';
      if (ps) extra = prSummaryHTML(M.e, sd, M, W, x);
    }
    svg += '</g>';
    if (fzOn && xn >= ml && xn <= ml + pw) svg += '<line class="st-now" x1="' + xn.toFixed(1) + '" x2="' + xn.toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
    svg += '<line class="st-cursor" y1="' + mt + '" y2="' + (mt + ph) + '" style="display:none"/>' + curTSVG(null, Hs - 7) + '</svg>';
    state.stripView.push({ def: def, sd: sd });
    return wrap(svg, sd.src, extra);
  }

  // Cursor + "value at cursor" readout on every strip (t = null hides them). In the forecast zone
  // only the forecast lines are read out (and before "now" only the observed ones).
  function syncStrips(t) {
    var g = state.geom, box = $('#trend-strips');
    if (!box || !g || !state.stripView) return;
    var x = g.ml + ((t - g.M.start) / (g.M.end - g.M.start)) * g.pw;
    box.querySelectorAll('.strip').forEach(function (el) {
      var view = state.stripView.filter(function (v) { return v.def.key === el.getAttribute('data-strip'); })[0], cur = el.querySelector('.st-cursor'), rd = el.querySelector('.st-read');
      if (!view || !cur || !rd) return;
      placeCurT(el.querySelector('.cur-t'), x, t);
      if (t == null) { cur.style.display = 'none'; rd.textContent = ''; return; }
      cur.setAttribute('x1', x.toFixed(1)); cur.setAttribute('x2', x.toFixed(1)); cur.style.display = '';
      var tol = Math.max(2 * HOUR, (g.M.end - g.M.start) / 150), ahead = !!g.M.fz && t > g.M.now;
      var lines = view.sd.lines.filter(function (l) { return ahead ? l.fc : !l.fc; });
      var vals = !lines.length ? [ahead ? 'no forecast' : '—'] : lines.map(function (l) {
        var v = null;
        if (l.fc && !l.bars) v = H.interpolate(l, t);   // forecast lines (~6-hourly) read linearly between their points
        else {
          var i = lastIndexBefore(t, l.t);
          if (i < 0) i = 0;
          if (i < l.t.length - 1 && Math.abs(l.t[i + 1] - t) < Math.abs(l.t[i] - t)) i++;
          if (Math.abs(l.t[i] - t) <= Math.max(tol, 36 * HOUR * (l.t.length > 1 && l.t[1] - l.t[0] >= 20 * HOUR ? 1 : 0))) v = l.v[i];
        }
        return (view.sd.lines.length > 1 ? l.label + ' ' : '') + (v != null ? fmt(v, view.def.dec) + ' ' + view.def.unit : '—');
      });
      // "Fri 03:00 · Outflow 900 cfs · Computed inflow 640 cfs"
      var html = '<span class="st-rt">' + esc(curLabel(t, true)) + '</span>' + (ahead ? ' <span class="fz-tag">FORECAST</span>' : '') + ' · ' + esc(vals.join(' · '));
      rd.innerHTML = html;
      var sv = el.querySelector('.st-svg');   // float the readout at the top of the plot, below the (wrapping) header
      if (sv) rd.style.top = Math.round(sv.getBoundingClientRect().top - el.getBoundingClientRect().top + 2) + 'px';
    });
  }

  // ---- Basin rain selection: drag across the precipitation strip ---------------------------------
  // Shows the basin-mean rain in the span, its volume on the basin, the estimated runoff into the pool
  // (empirical runoff ratio, js/runoff.js) and the pool rise that would cause at today's pool.

  var prSel = null;                 // { id, a, b } (ms); survives the 3-minute refresh until cleared
  var prRatio = {}, prRating = {};  // per project code

  function prRatioFor(e) {
    var c = prRatio[e.code];
    if (!c || (!c.loading && Date.now() - c.at > 6 * HOUR)) {
      prRatio[e.code] = c = c && !c.loading ? c : { loading: true };
      H.runoff.loadRatio(e).then(function (r) { prRatio[e.code] = r; renderStrips(); });
    }
    return c;
  }

  function prRatingFor(e) {
    if (e.code === 'DEX') return { none: 'Dexter publishes no elevation–storage rating' };
    if (!H.ratings) return { none: 'ratings not loaded' };
    var c = prRating[e.code];
    if (c) return c;
    prRating[e.code] = c = { loading: true };
    var def = H.ratings.cwmsDefs('storage', e.code)[0];
    H.ratings.load(def).then(function (en) {
      var d = en.data;
      if (d.kind !== '1d') throw new Error('unexpected rating shape');
      prRating[e.code] = { xs: d.xs, ys: d.ys, id: def.id };
    }).catch(function (err) { prRating[e.code] = { error: err.message || 'failed', at: Date.now() }; }).then(renderStrips);
    return c;
  }

  function prSummaryHTML(e, sd, M, W, x) {
    var Rn = H.runoff, b = H.weather && H.weather.BASINS[e.code];
    if (!Rn || !b) return '';
    var r = Rn.spanRain(sd.lines, prSel.a, prSel.b, M.now), vol = Rn.rainVolume(r.total, b.area);
    var rr = prRatioFor(e), rt = prRatingFor(e), ratio = rr.loading ? null : rr.ratio, run = ratio == null ? null : vol * ratio;
    var hrs = Math.round((r.n * r.step) / HOUR), fcH = Math.round((r.nFc * r.step) / HOUR);
    var from = r.from != null ? r.from : prSel.a, to = r.to != null ? r.to : prSel.b;
    var dd = function (label, v, cls) { return '<div' + (cls ? ' class="' + cls + '"' : '') + '><dt>' + label + '</dt><dd>' + v + '</dd></div>'; };
    var rise;
    var el = H.latest((projData(e) || {}).elev);
    if (rt.none) rise = '<span class="na">n/a (' + esc(rt.none) + ')</span>';
    else if (rt.loading) rise = '<span class="na loading">loading rating…</span>';
    else if (rt.error) rise = '<span class="na">rating unavailable (' + esc(rt.error) + ')</span>';
    else if (!el) rise = '<span class="na">no current pool reading</span>';
    else if (run == null) rise = '<span class="na loading">…</span>';
    else {
      var pr = Rn.poolRise(rt.xs, rt.ys, el.v, run);
      rise = pr.error ? '<span class="na">' + esc(pr.error) + '</span>'
        : '≈ ' + signed(pr.dElev, Math.abs(pr.dElev) < 0.1 ? 2 : 1) + ' ft <span class="pr-sub">(' + fmt(el.v, 1) + ' → ' + fmt(pr.elev1, 1) + ' ft)</span>';
    }
    var ratioTxt = rr.loading ? '<span class="na loading">runoff ratio: deriving from the last ' + Rn.WINDOW_DAYS + ' days of rain and inflow…</span>'
      : rr.fallback ? 'runoff ratio ' + fmt(rr.ratio, 2) + ' (default: ' + esc(rr.reason || 'no usable record') + '; deriving one needs ≥ ' + Rn.MIN_RAIN_IN + ' in of event rain)'
        : 'runoff ratio ≈ ' + fmt(rr.ratio, 2) + ' (derived from last ' + rr.window + ' days: ' + fmt(rr.rainIn, 1) + ' in rain, ' + fmt(rr.runoffAcft, 0) + ' ac-ft runoff' +
          (rr.clamped ? '; raw ' + fmt(rr.raw, 2) + ', clamped to ' + Rn.CLAMP.join('–') : '') + ')';
    // Float beside the selection (left of it when it sits in the right half); full width on phones.
    var xa = x(prSel.a) / W * 100, xb = x(prSel.b) / W * 100, pos;
    if (W < 560) pos = 'left:6px;right:6px';
    else if ((xa + xb) / 2 > 50) pos = 'right:clamp(6px,' + (100 - xa).toFixed(1) + '%,calc(100% - 386px))';
    else pos = 'left:clamp(6px,' + xb.toFixed(1) + '%,calc(100% - 386px))';
    return '<div class="pr-sum' + (W < 560 ? ' pr-full' : '') + '" role="status" style="' + pos + '"><div class="pr-h"><b>Selected rain</b> <span class="mono pr-span">' + esc(curLabel(from, false)) + ' – ' + esc(curLabel(to, false)) + ' · ' + hrs + ' h' +
      (fcH ? ' (' + fcH + ' h forecast)' : '') + '</span><button type="button" class="btn pr-x" data-prsel="clear" title="Clear the selection (Esc)">Clear</button></div>' +
      '<dl class="pr-dl mono">' +
      dd('Basin-mean rain', fmt(r.total, 2) + ' in' + (r.nFc ? ' <span class="pr-fc">incl. ' + fmt(r.fcst, 2) + ' in forecast</span>' : '')) +
      dd('Rain on the basin', fmt(vol, 0) + ' ac-ft <span class="pr-sub">(' + fmt(b.area, 0) + ' sq mi × 53.33)</span>') +
      dd('Runoff into pool', run == null ? '<span class="na loading">…</span>' : '≈ ' + fmt(run, 0) + ' ac-ft') +
      dd('Pool rise', rise) + '</dl>' +
      '<p class="pr-note">' + ratioTxt + '. Pool rise: at the current pool, if outflow stays equal to the pre-event inflow (all storm runoff stored; USACE elevation–storage rating). ' +
      '<b>Rough estimate</b>: model rain, not gauges; soil moisture and snow change how much runs off. <a href="#/sources">How this is estimated ▸</a></p></div>';
  }

  function initPrecipSelect() {
    var box = $('#trend-strips'), drag = null;
    if (!box || !H.runoff) return;
    var tAt = function (sv, clientX) {
      var g = state.geom, r = sv.getBoundingClientRect();
      if (!g) return null;
      var px = Math.max(g.ml, Math.min(g.ml + g.pw, (clientX - r.left) * (g.W / r.width)));
      return g.M.start + ((px - g.ml) / g.pw) * (g.M.end - g.M.start);
    };
    var show = function (sv, a, b) {
      var g = state.geom, rc = sv.querySelector('.pr-sel');
      if (!g || !rc) return;
      var xa = g.ml + ((Math.min(a, b) - g.M.start) / (g.M.end - g.M.start)) * g.pw, xb = g.ml + ((Math.max(a, b) - g.M.start) / (g.M.end - g.M.start)) * g.pw;
      rc.setAttribute('x', xa.toFixed(1)); rc.setAttribute('width', Math.max(0, xb - xa).toFixed(1)); rc.style.display = '';
    };
    box.addEventListener('pointerdown', function (ev) {
      var sv = ev.target.closest && ev.target.closest('.strip[data-strip="precip"] svg.st-svg'), g = state.geom;
      if (!sv || !g || g.M.e.kind !== 'reservoir' || (ev.button != null && ev.button > 0)) return;
      var r = sv.getBoundingClientRect(), px = (ev.clientX - r.left) * (g.W / r.width);
      if (px < g.ml || px > g.ml + g.pw) return;
      drag = { sv: sv, id: ev.pointerId, x0: ev.clientX, t0: tAt(sv, ev.clientX), moved: false };
    });
    box.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(ev.clientX - drag.x0) > 6) {
        drag.moved = true;
        try { drag.sv.setPointerCapture(drag.id); } catch (e) { /* ignore */ }
      }
      if (drag.moved) show(drag.sv, drag.t0, tAt(drag.sv, ev.clientX));
    });
    box.addEventListener('pointerup', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag, t1 = tAt(d.sv, ev.clientX), g = state.geom;
      drag = null;
      if (!d.moved || !g) return;
      // Whole hours: a bar counts when its centre is inside the span.
      prSel = { id: g.M.e.id, a: Math.floor(Math.min(d.t0, t1) / HOUR) * HOUR, b: Math.ceil(Math.max(d.t0, t1) / HOUR) * HOUR };
      renderStrips();
    });
    box.addEventListener('pointercancel', function () { if (drag) { drag = null; renderStrips(); } });
    box.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('[data-prsel="clear"]')) { prSel = null; renderStrips(); }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && prSel) { prSel = null; renderStrips(); }
    });
  }

  // Lets other pages open a point in the Trend Recorder.
  H.trend = {
    open: function (id, range) {
      if (!byId[id]) return;
      if (range) setRange(range);
      location.hash = '#/overview';
      setTimeout(function () { select(id, true); var t = $('#trends'); if (t) t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' }); }, 60);
    }
  };

  function initTrends() {
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
    // Hovering a strip moves the cursor on the main chart and every other strip too.
    var onStrip = function (ev) { var t = stripT(ev); if (t == null) hideCross(); else crossAt(t); };
    $('#trend-strips').addEventListener('pointermove', onStrip);
    $('#trend-strips').addEventListener('pointerdown', onStrip);
    $('#trend-strips').addEventListener('pointerleave', hideCross);
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
    initPrecipSelect();

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
    renderHazards();
    renderMapNodes();
    renderList();
    renderDetails();
    renderSnow();
    if (dataChanged) renderChart(false);   // background refresh: no draw-in animation
  }

  $('#refresh').addEventListener('click', poll);
  // Back on screen (tab shown, window focused, phone woken): refresh if the data is over 2 minutes old.
  // Hidden tabs have their timers throttled by the browser, so this is what keeps a returning view fresh.
  function wake() {
    if (document.hidden || state.fetching) return;
    if (!state.snap || Date.now() - (state.snap.fetchedAt || 0) > 2 * 60 * 1000 || (state.nextPollAt && Date.now() >= state.nextPollAt)) poll();
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);

  tickClock();
  setInterval(tickClock, 1000);
  setInterval(function () { if (state.snap && !state.fetching) renderAll(false); }, 60000);
  renderMapBase();
  bindCards();
  initStatusCards();
  if (H.notify) H.notify.init({ open: openEvent });
  initTrends();
  renderAll(true);
  poll();
})();
