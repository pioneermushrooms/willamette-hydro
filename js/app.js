/* Willamette Valley Hydro Dispatch — UI. Illustrative data only, not live. */
(function () {
  'use strict';

  var D = window.HYDRO_DATA;
  if (!D) return;

  var SVGNS = 'http://www.w3.org/2000/svg';
  var TZ = 'America/Los_Angeles';
  var STEP_MS = D.meta.stepMinutes * 60 * 1000;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var STATUS = {
    normal: { label: 'NORMAL', icon: '●' },
    watch: { label: 'WATCH', icon: '▲' },
    low: { label: 'LOW', icon: '▼' }
  };

  var all = D.reservoirs.concat(D.rivers);
  var byId = {};
  all.forEach(function (e) { byId[e.id] = e; });

  var state = {
    selectedId: 'lookout-point',
    chartId: 'lookout-point',
    range: '7d',
    lastUpdated: floorTo(Date.now(), STEP_MS),
    geom: null
  };

  // ---- Helpers -------------------------------------------------------------

  function $(sel) { return document.querySelector(sel); }

  function floorTo(t, step) { return Math.floor(t / step) * step; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(n, d) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }

  function signed(n, d) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n), d); }

  function statusPill(s) {
    return '<span class="status ' + s + '"><span class="icon" aria-hidden="true">' + STATUS[s].icon +
      '</span>' + STATUS[s].label + '</span>';
  }

  function kv(label, value, unit, cls) {
    return '<div><dt>' + esc(label) + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + value +
      (unit ? '<span class="unit">' + unit + '</span>' : '') + '</dd></div>';
  }

  function shortName(e) {
    if (e.kind === 'river') return e.name.split(' at ')[1].toUpperCase();
    return e.name.toUpperCase();
  }

  var fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  var fmtHM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZoneName: 'short' });
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

  function stamp(t) {
    var p = parts(t);
    return p.weekday + ' ' + p.month + '/' + p.day + ' ' + (p.h < 10 ? '0' : '') + p.h + ':' + p.minute;
  }

  // ---- Clock ---------------------------------------------------------------

  function tickClock() {
    var now = Date.now();
    $('#clock').textContent = fmtClock.format(now).replace(/^24/, '00');
    $('#clock-date').textContent = dateLine(now);
    var lu = floorTo(now, STEP_MS);
    if (lu !== state.lastUpdated) {
      state.lastUpdated = lu;
      renderChart(false);
    }
    $('#last-updated').textContent = fmtHM.format(state.lastUpdated).replace(/^24/, '00') + ' PT';
    var left = Math.max(0, Math.round((state.lastUpdated + STEP_MS - now) / 1000));
    var mm = Math.floor(left / 60), ss = left % 60;
    $('#next-refresh').textContent = 'next cycle ' + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  // ---- Totals --------------------------------------------------------------

  function renderTotals() {
    var t = D.totals();
    var generating = D.reservoirs.filter(function (r) { return r.hydro && r.generationMW > 0; }).length;
    var watch = t.alarms - t.lowAlarms;
    var tiles = [
      { label: 'Total generation', value: t.generationMW, d: 1, unit: 'MW', sub: 'of ' + fmt(t.capacityMW) + ' MW installed', bar: (t.generationMW / t.capacityMW) * 100 },
      { label: 'Units online', value: t.unitsOnline, d: 0, unit: '/ ' + t.units, sub: generating + ' of 5 plants generating' },
      { label: 'Active alarms', value: t.alarms, d: 0, unit: '', cls: 'alert',
        sub: '<span class="light low" aria-hidden="true"></span> ' + t.lowAlarms + ' low &nbsp;<span class="light watch" aria-hidden="true"></span> ' + watch + ' watch' },
      { label: 'Basin storage', value: t.basinStoragePercent, d: 1, unit: '%', sub: 'conservation pool, weighted', bar: t.basinStoragePercent },
      { label: 'Total release', value: t.totalReleaseCfs, d: 0, unit: 'cfs', sub: D.reservoirs.length + ' reservoirs' }
    ];
    $('#totals').innerHTML = tiles.map(function (x) {
      return '<div class="tile' + (x.cls ? ' ' + x.cls : '') + '">' +
        '<div class="tile-label">' + x.label + '</div>' +
        '<div class="tile-value"><span data-count="' + x.value + '" data-d="' + x.d + '">' + fmt(x.value, x.d) + '</span>' +
        (x.unit ? '<span class="unit">' + x.unit + '</span>' : '') + '</div>' +
        '<div class="tile-sub">' + x.sub + '</div>' +
        (x.bar != null ? '<div class="tile-bar"><span style="width:0" data-w="' + x.bar.toFixed(1) + '"></span></div>' : '') +
        '</div>';
    }).join('');
    countUp();
  }

  function countUp() {
    var els = document.querySelectorAll('[data-count]');
    var bars = document.querySelectorAll('.tile-bar > span');
    requestAnimationFrame(function () {
      bars.forEach(function (b) { b.style.width = b.getAttribute('data-w') + '%'; });
    });
    if (REDUCED) return;
    var start = performance.now(), dur = 1100;
    function step(now) {
      var k = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      els.forEach(function (el) {
        el.textContent = fmt(parseFloat(el.getAttribute('data-count')) * e, +el.getAttribute('data-d'));
      });
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---- Gauge ---------------------------------------------------------------

  function polar(cx, cy, r, deg) {
    var a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }

  function arc(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    var large = a1 - a0 > 180 ? 1 : 0;
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }

  function pctToDeg(p) { return -120 + (240 * Math.max(0, Math.min(100, p))) / 100; }

  function gaugeSVG(r) {
    var cx = 60, cy = 56, R = 42;
    var s = '<svg class="gauge" viewBox="0 0 120 112" role="img" aria-label="' + esc(r.name) + ' conservation pool ' + r.percentFull + ' percent full">';
    s += '<circle class="face" cx="' + cx + '" cy="' + cy + '" r="54"/>';
    s += '<path class="zone-low" d="' + arc(cx, cy, 50, -120, pctToDeg(10)) + '" style="stroke-width:3"/>';
    s += '<path class="track" d="' + arc(cx, cy, R, -120, 120) + '"/>';
    if (r.percentFull > 0.2) s += '<path class="fill" d="' + arc(cx, cy, R, -120, pctToDeg(r.percentFull)) + '"/>';
    for (var i = 0; i <= 10; i++) {
      var a = pctToDeg(i * 10), major = i % 5 === 0;
      var p0 = polar(cx, cy, major ? 30 : 33, a), p1 = polar(cx, cy, 37, a);
      s += '<line class="tick' + (major ? ' major' : '') + '" x1="' + p0[0].toFixed(2) + '" y1="' + p0[1].toFixed(2) + '" x2="' + p1[0].toFixed(2) + '" y2="' + p1[1].toFixed(2) + '"/>';
    }
    var ra = pctToDeg(r.ruleCurvePercent), q0 = polar(cx, cy, 36, ra), q1 = polar(cx, cy, 52, ra);
    s += '<line class="rule" x1="' + q0[0].toFixed(2) + '" y1="' + q0[1].toFixed(2) + '" x2="' + q1[0].toFixed(2) + '" y2="' + q1[1].toFixed(2) + '"><title>Rule curve ' + r.ruleCurvePercent + '%</title></line>';
    var l0 = polar(cx, cy, 30, -120), l1 = polar(cx, cy, 30, 120);
    s += '<text class="scale" x="' + (l0[0] - 4).toFixed(1) + '" y="' + (l0[1] + 10).toFixed(1) + '">0</text>';
    s += '<text class="scale" x="' + (l1[0] - 6).toFixed(1) + '" y="' + (l1[1] + 10).toFixed(1) + '">100</text>';
    s += '<line class="needle" x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="' + (cy - 38) + '" data-deg="' + pctToDeg(r.percentFull).toFixed(1) +
      '" style="transform-origin:' + cx + 'px ' + cy + 'px;transform:rotate(-120deg)"/>';
    s += '<circle class="hub" cx="' + cx + '" cy="' + cy + '" r="4"/>';
    s += '<text class="val" x="' + cx + '" y="' + (cy + 40) + '">' + fmt(r.percentFull, 1) + '%</text>';
    s += '<text class="cap" x="' + cx + '" y="' + (cy + 50) + '">CONS. POOL</text>';
    return s + '</svg>';
  }

  function sweepNeedles(root) {
    var needles = (root || document).querySelectorAll('.needle[data-deg]');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        needles.forEach(function (n) { n.style.transform = 'rotate(' + n.getAttribute('data-deg') + 'deg)'; });
      });
    });
  }

  // ---- Sparkline -----------------------------------------------------------

  function sparkSVG(values, ref) {
    var w = 200, h = 44, pad = 3;
    var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    var span = hi - lo || 1;
    lo -= span * 0.15; hi += span * 0.15;
    var x = function (i) { return (i / (values.length - 1)) * w; };
    var y = function (v) { return pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad); };
    var d = values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join('');
    var s = '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">';
    s += '<path class="area" d="' + d + 'L' + w + ' ' + h + 'L0 ' + h + 'Z"/>';
    if (ref != null && ref >= lo && ref <= hi) s += '<line class="min" x1="0" x2="' + w + '" y1="' + y(ref).toFixed(1) + '" y2="' + y(ref).toFixed(1) + '"/>';
    s += '<path class="line" d="' + d + '"/>';
    return s + '</svg>';
  }

  function last(arr, n) { return arr.slice(arr.length - n); }

  // ---- Basin map -----------------------------------------------------------

  function smoothPath(pts) {
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0] + ' ' + p2[1];
    }
    return d;
  }

  function renderMap() {
    var m = D.basinMap, svg = $('#basin-map');
    svg.setAttribute('viewBox', m.viewBox.join(' '));
    var s = '';
    m.rivers.forEach(function (rv) {
      var d = smoothPath(rv.points);
      var q = byId[rv.flowRef] ? byId[rv.flowRef].flowCfs : 1500;
      var dur = (2.2 * Math.pow(3000 / q, 0.3)).toFixed(2);
      s += '<path class="river-bed" d="' + d + '" stroke-width="' + (rv.main ? 7 : 4.5) + '"/>';
      s += '<path class="river-flow" d="' + d + '" stroke-width="' + (rv.main ? 2.4 : 1.6) + '" style="animation-duration:' + dur + 's"/>';
      s += '<text class="river-label" transform="translate(' + rv.labelAt[0] + ' ' + rv.labelAt[1] + ') rotate(' + rv.labelRotate + ')">' + esc(rv.label) + '</text>';
    });
    m.places.forEach(function (p) {
      s += '<text class="place-label" x="' + p.x + '" y="' + p.y + '" text-anchor="' + p.anchor + '">' + esc(p.label) + '</text>';
    });
    all.forEach(function (e) {
      var dam = e.kind === 'reservoir';
      var label = (dam ? 'Dam: ' : 'Station: ') + e.name + ', status ' + STATUS[e.status].label.toLowerCase();
      s += '<g class="node ' + (dam ? 'dam' : 'station') + '" data-id="' + e.id + '" tabindex="0" role="button" aria-label="' + esc(label) + '" transform="translate(' + e.map.x + ' ' + e.map.y + ')">';
      s += '<circle class="hit" r="22"/>';
      s += '<circle class="halo ' + e.status + '" r="7"/>';
      s += dam ? '<rect class="body" x="-7.5" y="-7.5" width="15" height="15" rx="2"/>' : '<circle class="body" r="7"/>';
      s += '<circle class="core ' + e.status + '" r="' + (dam ? 3.8 : 3.4) + '"/>';
      s += '<circle class="ring" r="13"/>';
      s += '<text class="node-label" x="' + e.map.lx + '" y="' + e.map.ly + '" text-anchor="' + e.map.anchor + '">' + esc(shortName(e)) + '</text>';
      s += '</g>';
    });
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
          var d = Math.hypot(e.map.x - p.x, e.map.y - p.y);
          if (d < bestD) { bestD = d; best = e.id; }
        });
      }
      if (best) select(best, { chart: true });
    });
    svg.addEventListener('keydown', function (ev) {
      var g = ev.target.closest && ev.target.closest('.node');
      if (g && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        select(g.getAttribute('data-id'), { chart: true });
      }
    });
  }

  // ---- Detail panel --------------------------------------------------------

  function reservoirReadouts(r, full) {
    var dev = r.elevationFt - r.ruleCurveFt;
    var h = kv('Pool elev', fmt(r.elevationFt, 1), 'ft', 'hl');
    h += kv('vs rule curve', signed(dev, 1), 'ft');
    if (full) {
      h += kv('Rule curve', fmt(r.ruleCurveFt, 1), 'ft');
      h += kv('Full / min pool', fmt(r.fullPoolFt, 1) + ' / ' + fmt(r.minPoolFt, 1), 'ft');
    }
    h += kv('Inflow', fmt(r.inflowCfs), 'cfs');
    h += kv('Outflow', fmt(r.outflowCfs), 'cfs');
    if (full) h += kv('Net storage', signed(r.inflowCfs - r.outflowCfs), 'cfs');
    if (r.hydro) {
      h += kv('Generation', fmt(r.generationMW, 1), 'MW', 'hl');
      if (full) h += kv('Units online', r.unitsOnline + ' / ' + r.units, '· ' + r.capacityMW + ' MW cap');
    } else {
      h += kv('Generation', 'Flood control — no generation', '', 'na');
    }
    return '<dl class="kv">' + h + '</dl>';
  }

  function riverReadouts(s, full) {
    var f = s.series.flowCfs, day = f[f.length - 1] - f[f.length - 97];
    var h = kv('Flow', fmt(s.flowCfs), 'cfs', 'hl');
    h += kv('Stage', fmt(s.stageFt, 2), 'ft');
    h += kv('Water temp', fmt(s.tempF, 1), '°F');
    h += kv('24 h change', signed(day), 'cfs');
    if (full) {
      h += kv('Min flow target', fmt(s.minTargetCfs), 'cfs');
      h += kv('Flood stage', fmt(s.floodStageFt, 0), 'ft');
    }
    return '<dl class="kv">' + h + '</dl>';
  }

  function renderDetails() {
    var e = byId[state.selectedId], h;
    var sub = e.kind === 'reservoir' ? e.river + ' · ' + e.purpose : e.river + ' · river station';
    h = '<div class="detail-head"><div><span class="panel-tag mono">' + (e.kind === 'reservoir' ? 'DAM / RESERVOIR' : 'RIVER STATION') + '</span>' +
      '<h2>' + esc(e.name) + '</h2><p>' + esc(sub) + '</p></div>' + statusPill(e.status) + '</div>';
    if (e.kind === 'reservoir') {
      h += '<div class="detail-gauge">' + gaugeSVG(e) + reservoirReadouts(e, true) + '</div>';
      h += '<div>' + sparkSVG(last(e.series.elevationFt, 97), e.ruleCurveFt) +
        '<div class="spark-cap"><span>−24 H</span><span>POOL ELEV · ft · dashed = rule curve</span><span>NOW</span></div></div>';
    } else {
      h += riverReadouts(e, true);
      h += '<div>' + sparkSVG(last(e.series.flowCfs, 97), e.minTargetCfs) +
        '<div class="spark-cap"><span>−24 H</span><span>FLOW · cfs · dashed = min target</span><span>NOW</span></div></div>';
    }
    h += '<p class="detail-note ' + e.status + '">' + esc(e.note) + '</p>';
    h += '<div><a class="btn" href="#trends" id="open-trend">Open trend ▸</a></div>';
    var panel = $('#details');
    panel.innerHTML = h;
    sweepNeedles(panel);
    $('#open-trend').addEventListener('click', function () { setChart(e.id); });
  }

  // ---- Cards ---------------------------------------------------------------

  function cardShell(e, sub, body) {
    return '<div class="card" role="button" tabindex="0" data-id="' + e.id + '" aria-label="' + esc(e.name + ', status ' + STATUS[e.status].label.toLowerCase()) + '">' +
      '<div class="card-head"><div><h3>' + esc(e.name) + '</h3><p>' + esc(sub) + '</p></div>' + statusPill(e.status) + '</div>' + body + '</div>';
  }

  function renderCards() {
    $('#reservoir-cards').innerHTML = D.reservoirs.map(function (r) {
      return cardShell(r, r.river, '<div class="detail-gauge">' + gaugeSVG(r) + reservoirReadouts(r, false) + '</div>');
    }).join('');
    $('#river-cards').innerHTML = D.rivers.map(function (s) {
      return cardShell(s, s.river, riverReadouts(s, false) + '<div>' + sparkSVG(last(s.series.flowCfs, 97), s.minTargetCfs) +
        '<div class="spark-cap"><span>−24 H</span><span>FLOW</span><span>NOW</span></div></div>');
    }).join('');
    sweepNeedles($('#reservoir-cards'));

    ['#reservoir-cards', '#river-cards'].forEach(function (sel) {
      var root = $(sel);
      root.addEventListener('click', function (ev) {
        var c = ev.target.closest('.card');
        if (c) select(c.getAttribute('data-id'), { chart: true });
      });
      root.addEventListener('keydown', function (ev) {
        var c = ev.target.closest('.card');
        if (c && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          select(c.getAttribute('data-id'), { chart: true });
        }
      });
    });
  }

  // ---- Selection -----------------------------------------------------------

  function select(id, opts) {
    if (!byId[id]) return;
    state.selectedId = id;
    document.querySelectorAll('.node, .card').forEach(function (n) {
      var on = n.getAttribute('data-id') === id;
      n.classList.toggle('selected', on);
      if (n.classList.contains('node')) n.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderDetails();
    if (opts && opts.chart) setChart(id);
  }

  // ---- Trend chart ---------------------------------------------------------

  function niceTicks(lo, hi, count) {
    var span = hi - lo || 1;
    var raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var t = [], v = Math.ceil(lo / step) * step;
    for (; v <= hi + step * 1e-6; v += step) t.push(+v.toFixed(10));
    return { ticks: t, step: step };
  }

  function chartModel() {
    var e = byId[state.chartId], res = e.kind === 'reservoir';
    var full = res ? e.series.elevationFt : e.series.flowCfs, N = full.length;
    var idx = [], i;
    if (state.range === '24h') for (i = N - 97; i < N; i++) idx.push(i);
    else for (i = 0; i < N; i += 4) idx.push(i);
    return {
      e: e, res: res,
      values: idx.map(function (k) { return full[k]; }),
      stage: res ? null : idx.map(function (k) { return e.series.stageFt[k]; }),
      times: idx.map(function (k) { return state.lastUpdated - (N - 1 - k) * STEP_MS; }),
      ref: res ? e.ruleCurveFt : e.minTargetCfs,
      refLabel: res ? 'Rule curve' : 'Min flow target',
      unit: res ? 'ft' : 'cfs',
      dec: res ? 2 : 0,
      title: e.name + (res ? ' · pool elevation (ft)' : ' · flow (cfs)')
    };
  }

  function renderChart(animate) {
    var M = chartModel();
    var wrap = $('#chart-wrap'), svg = $('#chart');
    var W = Math.max(260, Math.floor(wrap.clientWidth)), H = W < 520 ? 230 : 300;
    var vals = M.values.concat([M.ref]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo || 1) * 0.08;
    var nt = niceTicks(lo - pad, hi + pad, W < 520 ? 4 : 5);
    var yMin = Math.min(nt.ticks[0], lo - pad), yMax = Math.max(nt.ticks[nt.ticks.length - 1], hi + pad);
    var tickDec = nt.step < 1 ? (nt.step < 0.1 ? 2 : 1) : 0;
    var labels = nt.ticks.map(function (v) { return fmt(v, tickDec); });
    var ml = 12 + 6.6 * Math.max.apply(null, labels.map(function (l) { return l.length; }));
    var mr = 14, mt = 14, mb = 28;
    var pw = W - ml - mr, ph = H - mt - mb, n = M.values.length;
    var x = function (i) { return ml + (i / (n - 1)) * pw; };
    var y = function (v) { return mt + (1 - (v - yMin) / (yMax - yMin)) * ph; };

    var s = '<defs><linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#39d0e0" stop-opacity="0.22"/><stop offset="1" stop-color="#39d0e0" stop-opacity="0"/></linearGradient></defs>';

    s += '<g class="grid axis">';
    nt.ticks.forEach(function (v, k) {
      if (v < yMin || v > yMax) return;
      var yy = y(v).toFixed(1);
      s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<text x="' + (ml - 8) + '" y="' + (+yy + 3.5) + '" text-anchor="end">' + labels[k] + '</text>';
    });
    // x ticks at Pacific-time boundaries
    var xt = [];
    M.times.forEach(function (t, i) {
      var p = parts(t);
      // 24 h samples are 15-min (exact :00 exists); 7 d samples are hourly at an arbitrary minute.
      if (state.range === '24h' ? p.m === 0 && p.h % 6 === 0 : p.h === 0) xt.push({ i: i, p: p });
    });
    var narrow = pw / Math.max(1, xt.length) < 52;
    xt.forEach(function (o) {
      var xx = x(o.i).toFixed(1), lab;
      if (state.range === '24h') lab = o.p.h === 0 ? o.p.weekday + ' ' + o.p.day : (o.p.h < 10 ? '0' : '') + o.p.h + ':00';
      else lab = narrow ? o.p.day : o.p.weekday + ' ' + o.p.day;
      s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:.55"/>';
      s += '<text x="' + xx + '" y="' + (H - 9) + '" text-anchor="middle">' + lab + '</text>';
    });
    s += '</g>';

    var d = M.values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join('');
    s += '<path class="area" d="' + d + 'L' + x(n - 1).toFixed(1) + ' ' + (mt + ph) + 'L' + ml + ' ' + (mt + ph) + 'Z"/>';
    var ry = y(M.ref).toFixed(1);
    s += '<line class="ref" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + ry + '" y2="' + ry + '"/>';
    var refAbove = +ry - mt > 18;
    s += '<text class="ref-label" x="' + (ml + 6) + '" y="' + (refAbove ? +ry - 5 : +ry + 13) + '">' +
      M.refLabel.toUpperCase() + ' ' + fmt(M.ref, M.res ? 1 : 0) + ' ' + M.unit + '</text>';
    s += '<path class="series' + (animate && !REDUCED ? ' draw' : '') + '" id="chart-line" d="' + d + '"/>';
    s += '<circle class="now" cx="' + x(n - 1).toFixed(1) + '" cy="' + y(M.values[n - 1]).toFixed(1) + '" r="4.5"/>';
    s += '<g id="cross" style="display:none"><line class="cross" id="cross-line" y1="' + mt + '" y2="' + (mt + ph) + '"/><circle class="cross-dot" id="cross-dot" r="5"/></g>';
    s += '<rect id="chart-hit" x="' + ml + '" y="0" width="' + pw + '" height="' + H + '" fill="transparent"/>';

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('height', H);
    svg.innerHTML = s;
    if (animate && !REDUCED) {
      var line = $('#chart-line');
      line.style.setProperty('--len', Math.ceil(line.getTotalLength()));
    }
    state.geom = { M: M, x: x, y: y, ml: ml, pw: pw, n: n, W: W };

    $('#chart-title').textContent = M.title;
    $('#trend-tag').textContent = state.range === '24h' ? '15-MIN SAMPLES · 24 H' : 'HOURLY SAMPLES · 7 D';
    $('#chart-legend').innerHTML = '<span><i></i>' + (M.res ? 'Pool elevation' : 'Flow') + '</span><span><i class="ref"></i>' + M.refLabel + '</span>';

    var v = M.values, lo2 = Math.min.apply(null, v), hi2 = Math.max.apply(null, v), ch = v[n - 1] - v[0];
    var days = state.range === '24h' ? 1 : 7;
    $('#chart-stats').innerHTML =
      '<div><dt>Current</dt><dd>' + fmt(v[n - 1], M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Min</dt><dd>' + fmt(lo2, M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Max</dt><dd>' + fmt(hi2, M.dec) + ' ' + M.unit + '</dd></div>' +
      '<div><dt>Change ' + state.range.toUpperCase() + '</dt><dd>' + signed(ch, M.dec) + ' ' + M.unit + '</dd></div>' +
      (M.res ? '<div><dt>Rate</dt><dd>' + signed(ch / days, 2) + ' ft/day</dd></div>' : '');

    renderTable(M);
  }

  function renderTable(M) {
    var every = state.range === '24h' ? 4 : 24; // hourly for 24 h, 6-hourly for 7 d (series is hourly)
    var rows = [];
    for (var i = M.values.length - 1; i >= 0; i -= every) {
      rows.push('<tr><td>' + stamp(M.times[i]) + '</td><td>' + fmt(M.values[i], M.dec) + '</td>' +
        (M.stage ? '<td>' + fmt(M.stage[i], 2) + '</td>' : '') + '</tr>');
    }
    $('#chart-table').innerHTML = '<table><caption class="skip">' + esc(M.title) + '</caption><thead><tr><th>Time (PT)</th><th>' +
      (M.res ? 'Pool elev (ft)' : 'Flow (cfs)') + '</th>' + (M.stage ? '<th>Stage (ft)</th>' : '') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function onPointer(ev) {
    var g = state.geom;
    if (!g) return;
    var svg = $('#chart'), rect = svg.getBoundingClientRect();
    var scale = g.W / rect.width;
    var px = (ev.clientX - rect.left) * scale;
    var i = Math.round(((px - g.ml) / g.pw) * (g.n - 1));
    if (i < 0 || i > g.n - 1) { hideCross(); return; }
    var cx = g.x(i), cy = g.y(g.M.values[i]);
    $('#cross').style.display = '';
    var cl = $('#cross-line');
    cl.setAttribute('x1', cx); cl.setAttribute('x2', cx);
    var cd = $('#cross-dot');
    cd.setAttribute('cx', cx); cd.setAttribute('cy', cy);
    var tip = $('#tooltip');
    tip.hidden = false;
    tip.innerHTML = stamp(g.M.times[i]) + ' PT<br><b>' + fmt(g.M.values[i], g.M.dec) + ' ' + g.M.unit + '</b>' +
      (g.M.stage ? ' · ' + fmt(g.M.stage[i], 2) + ' ft' : '');
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
      '<optgroup label="Reservoirs · pool elevation">' + D.reservoirs.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + '</option>'; }).join('') + '</optgroup>' +
      '<optgroup label="Rivers · flow">' + D.rivers.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</optgroup>';
    sel.value = state.chartId;
    sel.addEventListener('change', function () { select(sel.value, { chart: true }); });

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

    var lastW = 0, pending = 0;
    var onResize = function () {
      var w = $('#chart-wrap').clientWidth;
      if (w === lastW) return;
      lastW = w;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(function () { hideCross(); renderChart(false); });
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe($('#chart-wrap'));
    else window.addEventListener('resize', onResize);
    lastW = $('#chart-wrap').clientWidth;
    renderChart(true);
  }

  // ---- Boot ----------------------------------------------------------------

  $('#seed').textContent = D.meta.seed;
  tickClock();
  setInterval(tickClock, 1000);
  renderTotals();
  renderMap();
  renderCards();
  initTrends();
  select(state.selectedId);
})();
