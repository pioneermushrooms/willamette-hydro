/*
 * Pure helpers for the Teacup view (no DOM, no network) — tested offline by check.js.
 *
 * Browser: window.HYDRO.teacupCore. Node: module.exports.
 */
(function (root, factory) {
  var LV = typeof module === 'object' && module.exports ? require('./cwms-levels.js') : root.HYDRO.levels;
  var api = factory(LV);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.teacupCore = api;
})(typeof self !== 'undefined' ? self : this, function (LV) {
  'use strict';

  var DAY = 24 * 3600 * 1000;

  // DERIVED: USACE "teacup" percent of conservation pool from storage.
  // Returns { pct (unclamped), clamped (0..100), below, above } or null.
  function percentFull(stor, bottom, top) {
    if (stor == null || bottom == null || top == null || !(top > bottom)) return null;
    var pct = ((stor - bottom) / (top - bottom)) * 100;
    return { pct: pct, clamped: Math.max(0, Math.min(100, pct)), below: stor < bottom, above: stor > top };
  }

  // Position of an elevation within [bottom, top] as 0..1 (clamped), or null.
  function elevFraction(elev, bottom, top) {
    if (elev == null || bottom == null || top == null || !(top > bottom)) return null;
    return Math.max(0, Math.min(1, (elev - bottom) / (top - bottom)));
  }

  /*
   * DERIVED: pool minus rule curve and a status relative to it, using the same
   * site thresholds as the Overview (below if more than `belowFt` under, above if
   * more than `aboveFt` over). status: 'below' | 'near' | 'above' | null.
   */
  function ruleDelta(elev, rule, belowFt, aboveFt) {
    if (elev == null || rule == null) return { delta: null, status: null };
    var d = elev - rule;
    return { delta: d, status: d < -belowFt ? 'below' : d > aboveFt ? 'above' : 'near' };
  }

  /*
   * Next `n` changes of a seasonal level after `now`, walking its knots forward across
   * cycles: [{ t, v }] where v is the value reached at t (ft) or null when the target
   * stops applying (a gap starts). Knots that just hold the previous value, and repeated
   * gap knots, are skipped. Constant levels have no changes ([]).
   */
  function nextTargetChanges(entry, now, n) {
    var out = [];
    if (!entry || !entry.s || !entry.s.p.length) return out;
    var s = entry.s, t0 = +now, limit = n || 3;
    var cur = LV.evalSeasonal(entry, t0);
    var prev = cur;
    var d = new Date(s.o);
    // start at the cycle that contains now
    var startYearMonths = (new Date(t0).getUTCFullYear() - d.getUTCFullYear()) * 12 + (new Date(t0).getUTCMonth() - d.getUTCMonth());
    var k0 = Math.floor(startYearMonths / s.m) - 1;
    for (var k = k0; k < k0 + 6 && out.length < limit; k++) {
      var cs = addMonthsUTC(s.o, k * s.m);
      for (var i = 0; i < s.p.length && out.length < limit; i++) {
        var t = addMonthsUTC(cs, s.p[i][0]) + s.p[i][1] * 60000, v = s.p[i][2];
        if (t <= t0) continue;
        var same = (v == null && prev == null) || (v != null && prev != null && Math.abs(v - prev) < 1e-6);
        prev = v;
        if (same) continue;
        out.push({ t: t, v: v });
      }
    }
    return out;
  }

  function addMonthsUTC(ms, k) {
    var x = new Date(ms);
    x.setUTCMonth(x.getUTCMonth() + k);
    return x.getTime();
  }

  /*
   * Vertical ruler scale (ft -> px, y grows downward). Focus range [lo, hi] is linear over
   * most of the height; if `floor` (e.g. streambed) lies far below `lo`, the span
   * [floor, lo] is compressed into the bottom `breakFrac` of the plot and `broken` is true
   * (draw a scale-break mark at y(lo)). Returns { y, lo, hi, floor, broken, ticks }.
   */
  function rulerScale(opts) {
    var hi = opts.hi, lo = opts.lo, floor = opts.floor != null ? opts.floor : lo;
    var top = opts.top || 0, bottom = opts.bottom, breakFrac = opts.breakFrac == null ? 0.12 : opts.breakFrac;
    var broken = floor < lo - 0.25 * (hi - lo);
    if (!broken) lo = Math.min(lo, floor);
    var h = bottom - top, yLo = broken ? bottom - h * breakFrac : bottom;
    function y(v) {
      if (v >= lo || !broken) return top + ((hi - v) / (hi - lo)) * (yLo - top);
      return yLo + ((lo - v) / (lo - floor)) * (bottom - yLo);
    }
    // ticks within the focus range
    var span = hi - lo, raw = span / Math.max(3, Math.round(h / 55)), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag, step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag, ticks = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
    return { y: y, lo: lo, hi: hi, floor: floor, broken: broken, ticks: ticks, step: step };
  }

  /*
   * Spreads label y positions so neighbours are at least `gap` px apart while staying as
   * close as possible to their targets, inside [minY, maxY]. Input [{y, ...}] -> same
   * objects with .ly set (sorted by y).
   */
  function spreadLabels(items, gap, minY, maxY) {
    var a = items.slice().sort(function (p, q) { return p.y - q.y; });
    a.forEach(function (it) { it.ly = Math.max(minY, Math.min(maxY, it.y)); });
    for (var pass = 0; pass < 50; pass++) {
      var moved = false;
      for (var i = 1; i < a.length; i++) {
        var need = a[i - 1].ly + gap - a[i].ly;
        if (need > 0.01) { a[i - 1].ly -= need / 2; a[i].ly += need / 2; moved = true; }
      }
      for (var j = 0; j < a.length; j++) a[j].ly = Math.max(minY + j * 0, Math.min(maxY, a[j].ly));
      if (a.length && a[0].ly < minY) a[0].ly = minY;
      for (var k = 1; k < a.length; k++) if (a[k].ly < a[k - 1].ly + gap) a[k].ly = a[k - 1].ly + gap;
      for (var m = a.length - 2; m >= 0; m--) if (a[m].ly > a[m + 1].ly - gap) a[m].ly = a[m + 1].ly - gap;
      if (!moved) break;
    }
    return a;
  }

  // Daily evaluation of a level entry over one calendar year (noon PST each day).
  // Returns [[t, v|null], ...] with 365/366 points.
  function annualSeries(entry, year) {
    var out = [];
    if (!entry) return out;
    var t = Date.UTC(year, 0, 1, 20), end = Date.UTC(year + 1, 0, 1, 20);
    for (; t < end; t += DAY) out.push([t, LV.evalSeasonal(entry, t)]);
    return out;
  }

  // Conservation limits: CWMS levels first (PUBLISHED), project constants as fallback.
  function consLimits(levels, project, now) {
    var I = LV.IDS, v = function (id) { return levels ? LV.constantAt(levels, id, now) : null; };
    var eb = v(I.bottomCons), et = v(I.topCons);
    var sb = v('Stor.Inst.0.Bottom of Conservation'), st = v('Stor.Inst.0.Top of Conservation');
    var c = project && project.cons;
    return {
      elevBottom: eb != null ? eb : c ? c.elevBottom : null,
      elevTop: et != null ? et : c ? c.elevTop : null,
      storBottom: sb != null ? sb : c ? c.storBottom : null,
      storTop: st != null ? st : c ? c.storTop : null,
      fromLevels: eb != null && et != null
    };
  }

  // ---- Zoom on a year axis (fractions of a year, 0..1) --------------------------------

  var MIN_SPAN = 3 / 365;   // zoom stops at about three days

  // Clamp a [a, b] window into [0, 1] with at least MIN_SPAN width, keeping its centre where possible.
  function clampZoom(a, b) {
    if (b < a) { var t = a; a = b; b = t; }
    var w = Math.min(1, Math.max(MIN_SPAN, b - a)), c = (a + b) / 2;
    a = c - w / 2; b = c + w / 2;
    if (a < 0) { b -= a; a = 0; }
    if (b > 1) { a -= b - 1; b = 1; }
    return [Math.max(0, a), Math.min(1, b)];
  }
  // Zoom by factor k (< 1 in, > 1 out) about centre c (default: the window centre).
  function zoomBy(z, k, c) { var m = c == null ? (z[0] + z[1]) / 2 : c, w = (z[1] - z[0]) * k; return clampZoom(m - w / 2, m + w / 2); }
  // Pan by `dir` half-windows (−1 left, +1 right).
  function panBy(z, dir) { var w = z[1] - z[0], d = dir * w / 2; return clampZoom(z[0] + d, z[1] + d); }
  // Day-tick spacing (days) so labels sit at least minPx apart.
  function dayTickStep(spanDays, widthPx, minPx) {
    var steps = [1, 2, 5, 7, 14, 30];
    for (var i = 0; i < steps.length; i++) if (widthPx * steps[i] / spanDays >= (minPx || 44)) return steps[i];
    return 30;
  }
  // Grid step for an elevation span (~4–7 lines), down to 0.05 ft when zoomed in.
  function niceStep(span) {
    var steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= 7) return steps[i];
    return 100;
  }

  /*
   * How a pool record sits against the 30-yr statistics: pts = [[f, elev]] (year fraction 0..1),
   * band arrays [[f, v]] sorted by f. Returns { n, inside, below, above, medianVsMean } where
   * inside/below/above are shares of readings (0..1) relative to p05–p95, and medianVsMean is the
   * median of (reading − 30-yr mean) in ft. Readings without a band value that day are skipped.
   */
  function bandCheck(pts, p05, p95, ave) {
    var at = function (arr, f) {
      if (!arr.length) return null;
      var lo = 0, hi = arr.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (arr[mid][0] <= f) lo = mid; else hi = mid; }
      var k = Math.abs(arr[lo][0] - f) <= Math.abs(arr[hi][0] - f) ? lo : hi;
      return Math.abs(arr[k][0] - f) <= 1.5 / 365 ? arr[k][1] : null;
    };
    var n = 0, inside = 0, below = 0, above = 0, diffs = [];
    pts.forEach(function (p) {
      var a = at(p05, p[0]), b = at(p95, p[0]), m = at(ave, p[0]);
      if (a == null || b == null) return;
      n++;
      if (p[1] < Math.min(a, b)) below++; else if (p[1] > Math.max(a, b)) above++; else inside++;
      if (m != null) diffs.push(p[1] - m);
    });
    diffs.sort(function (x, y) { return x - y; });
    return { n: n, inside: n ? inside / n : null, below: n ? below / n : null, above: n ? above / n : null,
      medianVsMean: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null };
  }

  return {
    percentFull: percentFull,
    elevFraction: elevFraction,
    ruleDelta: ruleDelta,
    nextTargetChanges: nextTargetChanges,
    rulerScale: rulerScale,
    spreadLabels: spreadLabels,
    annualSeries: annualSeries,
    consLimits: consLimits,
    bandCheck: bandCheck,
    MIN_SPAN: MIN_SPAN, clampZoom: clampZoom, zoomBy: zoomBy, panBy: panBy, dayTickStep: dayTickStep, niceStep: niceStep
  };
});
