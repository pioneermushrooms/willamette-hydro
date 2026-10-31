/* Willamette Valley Hydro Dispatch — UI. Live data from USGS and USACE; provisional, not official. */
(function () {
  'use strict';

  var H = window.HYDRO;
  if (!H) return;

  var TZ = 'America/Los_Angeles';
  var HOUR = 3600 * 1000;
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
    range: '7d',
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

  function poll() {
    if (state.fetching) return;
    state.fetching = true;
    clearTimeout(state.pollTimer);
    renderFeed();
    tickClock();
    H.loadAll({ bpaUrl: BPA_URL }).then(function (snap) {
      state.snap = merge(state.snap, snap);
      state.fetching = false;
      state.nextPollAt = Date.now() + POLL_MS;
      state.pollTimer = setTimeout(poll, POLL_MS);
      renderAll(true);
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
    } else {
      h += kv('% full', 'n/a', '', 'na', 'No conservation pool (run-of-river). Band ' + p.powerPool.elevBottom + '–' + p.powerPool.elevTop + ' ft');
    }
    h += kvVal('Outflow', val(out, 0, 'cfs', '', p.cbt ? 'hourly average' : ''));
    h += kvVal('Computed inflow', val(inn, 0, 'cfs', inn && inn.v < 0 ? 'neg' : '', inn ? (inn.v < 0 ? 'computed from storage change; negative as reported' : 'computed by USACE') : ''));
    if (full) {
      h += kvVal('Storage', p.noStorage ? { html: 'n/a', unit: '', cls: 'na', sub: 'not published' } : val(st, 0, 'ac-ft'));
      if (p.cons) h += kv('Conservation pool', fmt(p.cons.elevBottom, 1) + '–' + fmt(p.cons.elevTop, 1), 'ft', '', 'CWMS bottom/top of conservation');
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
      return '<p class="src">Source: <a href="' + e.sourceUrl + '" rel="noopener">USGS ' + e.site + ' ↗</a></p>';
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
        '<div class="detail-gauge">' + reservoirGauge(p, 'card-' + p.id) + reservoirReadouts(p, false) + '</div>' +
        (d ? readingLine(e && e.t, 'Last pool reading') : '') + sourceLinks(p));
    }).join('');
    $('#river-cards').innerHTML = H.stations.map(function (s) {
      var d = stData(s), prim = d && H.stationPrimary(s, d), w = window24(prim);
      return cardShell(s, s.river + ' · USGS ' + s.site, stationReadouts(s, false) +
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

  function chartModel() {
    var e = byId[state.chartId], res = e.kind === 'reservoir';
    var end = Date.now(), start = end - (state.range === '24h' ? 24 : 168) * HOUR;
    var s, ref = null, unit, dec, title, src;
    if (res) {
      var d = projData(e);
      s = d && d.elev; ref = d && d.rule; unit = 'ft'; dec = 2;
      title = e.name + ' · pool elevation (ft)';
      src = 'USACE CWMS (NWDP) ' + e.series.elev.name + '; dashed: ' + e.series.rule.name + ' (USACE rule curve, daily, linearly joined).';
    } else {
      var sd = stData(e);
      s = sd && H.stationPrimary(e, sd);
      unit = e.primary === 'flow' ? 'cfs' : 'ft'; dec = e.primary === 'flow' ? 0 : 2;
      title = e.name + (e.primary === 'flow' ? ' · discharge (cfs)' : ' · gage height (ft)');
      src = 'USGS NWIS site ' + e.site + ', parameter ' + (e.primary === 'flow' ? '00060 discharge' : '00065 gage height') + '. Values flagged P are provisional.' +
        (e.params.indexOf('flow') < 0 ? ' This gauge has no discharge series, so stage is charted.' : '');
    }
    var t = [], v = [], q = [];
    if (s && s.t.length) {
      var i0 = lastIndexBefore(start, s.t) + 1;
      var n = s.t.length - i0, step = Math.max(1, Math.ceil(n / 900));
      for (var i = i0; i < s.t.length; i += step) { t.push(s.t[i]); v.push(s.v[i]); q.push(s.q ? s.q[i] : null); }
      if (t[t.length - 1] !== s.t[s.t.length - 1] && s.t.length > i0) { t.push(s.t[s.t.length - 1]); v.push(s.v[s.v.length - 1]); q.push(s.q ? s.q[s.q.length - 1] : null); }
    }
    var rt = [], rv = [];
    if (ref && ref.t.length) {
      var a = H.interpolate(ref, start); if (a != null) { rt.push(start); rv.push(a); }
      for (var k = 0; k < ref.t.length; k++) if (ref.t[k] > start && ref.t[k] < end) { rt.push(ref.t[k]); rv.push(ref.v[k]); }
      var b = H.interpolate(ref, end); if (b != null) { rt.push(end); rv.push(b); }
    }
    return { e: e, res: res, start: start, end: end, t: t, v: v, q: q, rt: rt, rv: rv, unit: unit, dec: dec, title: title, src: src, loading: !state.snap };
  }

  function renderChart(animate) {
    var M = chartModel();
    var wrap = $('#chart-wrap'), svg = $('#chart'), msg = $('#chart-msg');
    var W = Math.max(260, Math.floor(wrap.clientWidth)), H2 = W < 520 ? 230 : 300;
    $('#chart-title').textContent = M.title;
    $('#trend-tag').textContent = (state.range === '24h' ? 'LAST 24 H' : 'LAST 7 D') + ' · LIVE SERIES';
    $('#chart-src').textContent = 'Source: ' + M.src;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H2);
    svg.setAttribute('height', H2);
    state.geom = null;

    if (M.t.length < 2) {
      svg.innerHTML = '';
      msg.hidden = false;
      msg.textContent = M.loading ? 'Loading live data…' : 'No data returned for this series in the selected window.';
      $('#chart-legend').innerHTML = '';
      $('#chart-stats').innerHTML = '';
      $('#chart-table').innerHTML = '';
      return;
    }
    msg.hidden = true;

    var vals = M.v.concat(M.rv);
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
    var xt = [];
    for (var tt = Math.ceil(M.start / HOUR) * HOUR; tt <= M.end; tt += HOUR) {
      var p = parts(tt);
      if (state.range === '24h' ? p.h % 6 === 0 : p.h === 0) xt.push({ t: tt, p: p });
    }
    var narrow = pw / Math.max(1, xt.length) < 52;
    xt.forEach(function (o) {
      var xx = x(o.t).toFixed(1), lab;
      if (state.range === '24h') lab = o.p.h === 0 ? o.p.weekday + ' ' + o.p.day : String(o.p.h).padStart(2, '0') + ':00';
      else lab = narrow ? o.p.day : o.p.weekday + ' ' + o.p.day;
      s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:.55"/>';
      s += '<text x="' + xx + '" y="' + (H2 - 9) + '" text-anchor="middle">' + lab + '</text>';
    });
    s += '</g>';

    var d = '';
    for (var i = 0; i < M.t.length; i++) d += (i ? 'L' : 'M') + x(M.t[i]).toFixed(1) + ' ' + y(M.v[i]).toFixed(1);
    var n = M.t.length;
    s += '<g clip-path="url(#plot-clip)">';
    s += '<path class="area" d="' + d + 'L' + x(M.t[n - 1]).toFixed(1) + ' ' + (mt + ph) + 'L' + x(M.t[0]).toFixed(1) + ' ' + (mt + ph) + 'Z"/>';
    if (M.rt.length > 1) {
      var rd = '';
      for (var j = 0; j < M.rt.length; j++) rd += (j ? 'L' : 'M') + x(M.rt[j]).toFixed(1) + ' ' + y(M.rv[j]).toFixed(1);
      s += '<path class="ref-line" d="' + rd + '"/>';
      var ry = y(M.rv[M.rv.length - 1]), above = ry - mt > 18;
      s += '<text class="ref-label" x="' + (W - mr - 6) + '" y="' + (above ? ry - 6 : ry + 14).toFixed(1) + '" text-anchor="end">RULE CURVE ' + fmt(M.rv[M.rv.length - 1], 1) + ' ft</text>';
    }
    s += '<path class="series' + (animate && !REDUCED ? ' draw' : '') + '" id="chart-line" d="' + d + '"/>';
    s += '</g>';
    s += '<circle class="now" cx="' + x(M.t[n - 1]).toFixed(1) + '" cy="' + y(M.v[n - 1]).toFixed(1) + '" r="4.5"/>';
    s += '<g id="cross" style="display:none"><line class="cross" id="cross-line" y1="' + mt + '" y2="' + (mt + ph) + '"/><circle class="cross-dot" id="cross-dot" r="5"/></g>';
    s += '<rect x="' + ml + '" y="0" width="' + pw + '" height="' + H2 + '" fill="transparent"/>';
    svg.innerHTML = s;
    if (animate && !REDUCED) {
      var line = $('#chart-line');
      line.style.setProperty('--len', Math.ceil(line.getTotalLength()));
    }
    state.geom = { M: M, x: x, y: y, ml: ml, pw: pw, W: W };

    $('#chart-legend').innerHTML = '<span><i></i>' + (M.res ? 'Pool elevation (USACE)' : M.e.primary === 'flow' ? 'Discharge (USGS)' : 'Gage height (USGS)') + '</span>' +
      (M.rt.length > 1 ? '<span><i class="ref"></i>USACE rule curve</span>' : M.res ? '<span class="na">Rule curve: no data</span>' : '');

    var lo2 = Math.min.apply(null, M.v), hi2 = Math.max.apply(null, M.v), ch = M.v[n - 1] - M.v[0];
    var stats = '<div><dt>Latest</dt><dd>' + fmt(M.v[n - 1], M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Min</dt><dd>' + fmt(lo2, M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Max</dt><dd>' + fmt(hi2, M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Change in window</dt><dd>' + signed(ch, M.dec) + ' ' + M.unit + '</dd></div>';
    if (M.res && M.rt.length) {
      var rNow = H.interpolate({ t: M.rt, v: M.rv }, M.t[n - 1]);
      if (rNow != null) stats += '<div><dt>vs rule curve</dt><dd>' + signed(M.v[n - 1] - rNow, 1) + ' ft</dd></div>';
    }
    stats += '<div><dt>Latest reading</dt><dd>' + stamp(M.t[n - 1]) + '</dd></div>';
    $('#chart-stats').innerHTML = stats;
    renderTable(M);
  }

  function renderTable(M) {
    var step = (state.range === '24h' ? 1 : 6) * HOUR, rows = [], seen = {};
    for (var target = M.t[M.t.length - 1]; target >= M.start; target -= step) {
      var i = lastIndexBefore(target, M.t);
      if (i < 0 || seen[i]) continue;
      seen[i] = true;
      var r = M.res && M.rt.length ? H.interpolate({ t: M.rt, v: M.rv }, M.t[i]) : null;
      rows.push('<tr><td>' + stamp(M.t[i]) + '</td><td>' + fmt(M.v[i], M.dec) + '</td>' +
        (M.res ? '<td>' + (r == null ? '—' : fmt(r, 1)) + '</td>' : '<td>' + esc(qualText(M.q[i]) || '—') + '</td>') + '</tr>');
    }
    $('#chart-table').innerHTML = '<table><caption class="skip">' + esc(M.title) + '</caption><thead><tr><th>Time (PT)</th><th>' +
      (M.res ? 'Pool elev (ft)' : M.e.primary === 'flow' ? 'Flow (cfs)' : 'Stage (ft)') + '</th><th>' + (M.res ? 'Rule curve (ft)' : 'Qualifier') + '</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table>';
  }

  function onPointer(ev) {
    var g = state.geom;
    if (!g) return;
    var rect = $('#chart').getBoundingClientRect(), scale = g.W / rect.width;
    var px = (ev.clientX - rect.left) * scale;
    if (px < g.ml || px > g.ml + g.pw) { hideCross(); return; }
    var t = g.M.start + ((px - g.ml) / g.pw) * (g.M.end - g.M.start);
    var i = lastIndexBefore(t, g.M.t);
    if (i < 0) i = 0;
    if (i < g.M.t.length - 1 && Math.abs(g.M.t[i + 1] - t) < Math.abs(g.M.t[i] - t)) i++;
    var cx = g.x(g.M.t[i]), cy = g.y(g.M.v[i]);
    $('#cross').style.display = '';
    $('#cross-line').setAttribute('x1', cx); $('#cross-line').setAttribute('x2', cx);
    $('#cross-dot').setAttribute('cx', cx); $('#cross-dot').setAttribute('cy', cy);
    var tip = $('#tooltip'), extra = '';
    if (g.M.res && g.M.rt.length) {
      var r = H.interpolate({ t: g.M.rt, v: g.M.rv }, g.M.t[i]);
      if (r != null) extra = '<br>rule curve ' + fmt(r, 1) + ' ft';
    } else if (g.M.q[i]) extra = '<br>' + esc(qualText(g.M.q[i]));
    tip.hidden = false;
    tip.innerHTML = stamp(g.M.t[i]) + '<br><b>' + fmt(g.M.v[i], g.M.dec) + ' ' + g.M.unit + '</b>' + extra;
    var left = cx / scale + 14, tw = tip.offsetWidth;
    if (left + tw > rect.width - 4) left = cx / scale - tw - 14;
    tip.style.left = Math.max(4, left) + 'px';
  }

  function hideCross() {
    var c = $('#cross');
    if (c) c.style.display = 'none';
    $('#tooltip').hidden = true;
  }

  function setChart(id) {
    state.chartId = id;
    $('#trend-select').value = id;
    renderChart(true);
  }

  function initTrends() {
    var sel = $('#trend-select');
    sel.innerHTML =
      '<optgroup label="Reservoirs · pool elevation">' + H.projects.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</optgroup>' +
      '<optgroup label="Rivers · discharge (stage at Eugene)">' + H.stations.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</optgroup>';
    sel.value = state.chartId;
    sel.addEventListener('change', function () { select(sel.value, true); });

    document.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.range = b.getAttribute('data-range');
        document.querySelectorAll('.seg button').forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
        renderChart(true);
      });
    });

    var svg = $('#chart');
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
