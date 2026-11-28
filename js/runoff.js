/*
 * Rain -> runoff -> pool rise: the rough estimate behind the drag selection on the Trend
 * Recorder's basin-precipitation strip.
 *
 *   rain volume (ac-ft)   = basin-mean rain (in) × drainage area (sq mi) × 53.33
 *   runoff into the pool  = rain volume × runoff ratio
 *   pool rise (ft)        = elev(stor(pool now) + runoff) − pool now, from the USACE elevation–storage
 *                           rating, i.e. as if releases stay equal to the pre-storm inflow, so every
 *                           acre-foot of storm runoff is stored.
 *
 * Runoff ratio "from past records" (deriveRatio): over the last ~45 days, daily basin rain (Open-Meteo
 * model, js/weather.js) is split into rain events (days ≥ 0.1 in, a single dry day does not end an
 * event); for each event the inflow volume above baseflow (USACE computed inflow, daily means; baseflow
 * = the lowest daily inflow in the 3 days before the event) is summed over the event plus 2 days of lag,
 * stopping where the next event starts. Ratio = Σ runoff ÷ Σ rain volume, clamped to 0.05–0.9. Under
 * 1 in of event rain (or no complete event) the default 0.4 is used and the result says so.
 *
 * This is a rough estimate: model rain (not gauges), constant-baseflow separation, and soil moisture and
 * snow (storage on the ground, melt) change how much rain reaches the pool.
 * Browser: window.HYDRO.runoff. Node: module.exports (pure functions; the loader needs the browser).
 */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? null : root.HYDRO);
  if (node) module.exports = api;
  else root.HYDRO.runoff = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var HOUR = 3600000, DAY = 24 * HOUR;
  var ACFT_PER_IN_SQMI = 53.33;   // 1 inch of water over 1 square mile
  var ACFT_PER_CFS_DAY = 1.9835;  // 1 cfs for 24 h
  var DEFAULT_RATIO = 0.4, MIN_RAIN_IN = 1, CLAMP = [0.05, 0.9], LAG_DAYS = 2, WET_DAY_IN = 0.1, BASE_DAYS = 3;
  var WINDOW_DAYS = 45;

  function rainVolume(inches, areaSqMi) { return inches * areaSqMi * ACFT_PER_IN_SQMI; }

  function medianStep(t) {
    var d = [];
    for (var i = 1; i < t.length; i++) if (t[i] > t[i - 1]) d.push(t[i] - t[i - 1]);
    if (!d.length) return HOUR;
    d.sort(function (a, b) { return a - b; });
    return d[Math.floor(d.length / 2)];
  }

  /*
   * Rain over the span [a, b] from bar series: lines = [{ t[], v[], fc }], each value the total for
   * the step ending at t (hourly or daily). A bar counts when its centre lies in [a, b]; it is forecast
   * when its line is flagged fc or its centre is after `now`.
   * -> { total, fcst, n, nFc, step, from, to } (from/to: first bar start, last bar end; null if none).
   */
  function spanRain(lines, a, b, now) {
    var r = { total: 0, fcst: 0, n: 0, nFc: 0, step: HOUR, from: null, to: null };
    (lines || []).forEach(function (l) {
      if (!l || !l.t || !l.t.length) return;
      var step = medianStep(l.t);
      r.step = step;
      for (var i = 0; i < l.t.length; i++) {
        var c = l.t[i] - step / 2, v = l.v[i];
        if (c < a || c > b || v == null || !isFinite(v)) continue;
        r.total += v; r.n++;
        if (l.fc || (now != null && c > now)) { r.fcst += v; r.nFc++; }
        if (r.from == null || l.t[i] - step < r.from) r.from = l.t[i] - step;
        if (r.to == null || l.t[i] > r.to) r.to = l.t[i];
      }
    });
    return r;
  }

  /*
   * Fixed 24-h (UTC) buckets: { t: [day start], v: [sum | mean], n: [count] }. A value stamped t
   * belongs to the bucket of t − shift (hourly sums stamped at the end of their hour: shift = 1 ms).
   * Buckets with fewer than minCount values are dropped.
   */
  function daily(t, v, mode, minCount, shift) {
    var map = {}, keys = [];
    for (var i = 0; i < t.length; i++) {
      if (v[i] == null || !isFinite(v[i])) continue;
      var k = Math.floor((t[i] - (shift || 0)) / DAY);
      if (!map[k]) { map[k] = { s: 0, n: 0 }; keys.push(k); }
      map[k].s += v[i]; map[k].n++;
    }
    keys.sort(function (x, y) { return x - y; });
    var out = { t: [], v: [], n: [] };
    keys.forEach(function (k) {
      var m = map[k];
      if (m.n < (minCount || 1)) return;
      out.t.push(k * DAY); out.v.push(mode === 'mean' ? m.s / m.n : m.s); out.n.push(m.n);
    });
    return out;
  }

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /*
   * Empirical runoff ratio. rain: daily basin rain { t: [day start], v: [in] }; inflow: daily mean
   * inflow { t: [day start], v: [cfs] }; area: sq mi. opts: { minRain, def, lag, wet }.
   * -> { ratio, raw, clamped, fallback, reason, rainIn, rainAcft, runoffAcft, events, days, from, to }
   */
  function deriveRatio(rain, inflow, area, opts) {
    opts = opts || {};
    var minRain = opts.minRain == null ? MIN_RAIN_IN : opts.minRain, def = opts.def == null ? DEFAULT_RATIO : opts.def;
    var lag = opts.lag == null ? LAG_DAYS : opts.lag, wet = opts.wet == null ? WET_DAY_IN : opts.wet;
    var out = { ratio: def, raw: null, clamped: false, fallback: true, reason: '', rainIn: 0, rainAcft: 0, runoffAcft: 0, events: 0, skipped: 0, days: 0, from: null, to: null };
    if (!rain || !rain.t || !rain.t.length || !inflow || !inflow.t || !inflow.t.length || !(area > 0)) {
      out.reason = 'no rain or inflow record'; return out;
    }
    var q = {};
    inflow.t.forEach(function (t, i) { if (inflow.v[i] != null && isFinite(inflow.v[i])) q[Math.round(t / DAY)] = inflow.v[i]; });
    var qDays = Object.keys(q).map(Number).sort(function (a, b) { return a - b; });
    var qFirst = qDays[0], qLast = qDays[qDays.length - 1];
    var r = {};
    rain.t.forEach(function (t, i) { r[Math.round(t / DAY)] = rain.v[i] || 0; });
    var rDays = Object.keys(r).map(Number).sort(function (a, b) { return a - b; });
    var d0 = Math.max(rDays[0], qFirst), d1 = Math.min(rDays[rDays.length - 1], qLast);
    out.days = d1 >= d0 ? d1 - d0 + 1 : 0;
    out.from = d0 * DAY; out.to = (d1 + 1) * DAY;
    // Events: runs of wet days; one dry day inside a run does not end it.
    var events = [], cur = null;
    for (var d = rDays[0]; d <= rDays[rDays.length - 1]; d++) {
      var isWet = (r[d] || 0) >= wet;
      if (isWet) {
        if (cur && d - cur.e <= 2) cur.e = d;
        else { cur = { s: d, e: d }; events.push(cur); }
      }
    }
    events.forEach(function (ev, k) {
      var next = events[k + 1], wEnd = Math.min(ev.e + lag, next ? next.s - 1 : Infinity);
      // The event and its lag must lie inside the inflow record, with a baseflow day before it.
      if (ev.s <= qFirst || wEnd > qLast) { out.skipped++; return; }
      var base = null;
      for (var b = ev.s - BASE_DAYS; b <= ev.s; b++) if (q[b] != null && (base == null || q[b] < base)) base = q[b];
      if (base == null) { out.skipped++; return; }
      var have = 0, vol = 0;
      for (var x = ev.s; x <= wEnd; x++) if (q[x] != null) { have++; vol += Math.max(0, q[x] - base) * ACFT_PER_CFS_DAY; }
      if (have < 0.8 * (wEnd - ev.s + 1)) { out.skipped++; return; }
      var rin = 0;
      for (x = ev.s; x <= ev.e; x++) rin += r[x] || 0;
      out.events++; out.rainIn += rin; out.runoffAcft += vol;
    });
    out.rainAcft = rainVolume(out.rainIn, area);
    if (out.rainIn < minRain) {
      out.reason = out.events ? 'only ' + out.rainIn.toFixed(1) + ' in of rain in complete events' : 'no complete rain event in the record';
      return out;
    }
    out.raw = out.runoffAcft / out.rainAcft;
    out.ratio = clamp(out.raw, CLAMP[0], CLAMP[1]);
    out.clamped = out.ratio !== out.raw;
    out.fallback = false;
    return out;
  }

  function interp(xs, ys, x) {
    if (x == null || !isFinite(x) || !xs.length || x < xs[0] || x > xs[xs.length - 1]) return null;
    var lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    if (xs[hi] === xs[lo]) return ys[lo];
    return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
  }

  /*
   * Pool rise from storing `addAcft` at pool elevation `elev`, with an elevation–storage rating
   * (xs: elevation ft ascending, ys: storage ac-ft ascending).
   * -> { stor0, stor1, elev1, dElev } or { error }.
   */
  function poolRise(xs, ys, elev, addAcft) {
    if (!xs || !ys || xs.length < 2) return { error: 'no elevation–storage rating' };
    for (var i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1]) return { error: 'rating not monotonic' };
    var s0 = interp(xs, ys, elev);
    if (s0 == null) return { error: 'pool ' + elev + ' ft is outside the rating' };
    var s1 = s0 + addAcft;
    if (s1 > ys[ys.length - 1]) return { error: 'above the top of the rating', stor0: s0, stor1: s1 };
    var e1 = interp(ys, xs, s1);
    return { stor0: s0, stor1: s1, elev1: e1, dElev: e1 - elev };
  }

  // ---- Loader (browser): ratio for one project, cached 6 h -------------------------------------

  var cache = {};
  function loadRatio(e, days) {
    days = days || WINDOW_DAYS;
    var now = Date.now(), c = cache[e.code];
    if (c && (c.then || now - c.at < 6 * HOUR)) return c.then ? c : Promise.resolve(c);
    var area = H.weather.BASINS[e.code] && H.weather.BASINS[e.code].area, start = now - (days + 1) * DAY;
    var rainP = H.weather.loadRange(e.code, start, now).then(function (r) { return r.s ? daily(r.s.t, r.s.p, 'sum', 20, 1) : null; });
    var inP = H.history.cwmsChunks(e.series.inflow, start - BASE_DAYS * DAY, now).then(function (s) { return daily(s.t, s.v, 'mean', 3, 0); });
    var p = Promise.all([rainP, inP]).then(function (res) {
      var out = deriveRatio(res[0], res[1], area);
      out.at = Date.now(); out.window = days;
      cache[e.code] = out;
      return out;
    }, function (err) {
      delete cache[e.code];
      return { ratio: DEFAULT_RATIO, fallback: true, reason: 'record unavailable (' + (err.message || 'failed') + ')', at: Date.now(), window: days, error: true };
    });
    cache[e.code] = p;
    return p;
  }

  return {
    ACFT_PER_IN_SQMI: ACFT_PER_IN_SQMI, ACFT_PER_CFS_DAY: ACFT_PER_CFS_DAY, DEFAULT_RATIO: DEFAULT_RATIO, MIN_RAIN_IN: MIN_RAIN_IN,
    CLAMP: CLAMP, LAG_DAYS: LAG_DAYS, WINDOW_DAYS: WINDOW_DAYS,
    rainVolume: rainVolume, spanRain: spanRain, daily: daily, deriveRatio: deriveRatio, poolRise: poolRise, interp: interp,
    loadRatio: loadRatio, _cache: cache
  };
});
