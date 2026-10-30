/*
 * Willamette Valley Hydro Dispatch — ILLUSTRATIVE DATA ONLY.
 *
 * Every number in this file is invented for demonstration. Values are chosen to
 * be plausible for the South Willamette Valley in the late-October drawdown
 * season, but they are NOT measurements and NOT live. Trend series are produced
 * by a seeded pseudo-random generator, so output is identical on every load.
 *
 * Works in the browser (window.HYDRO_DATA) and in Node (module.exports).
 */
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = data;
  } else {
    root.HYDRO_DATA = data;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SEED = 20261030;
  var STEP_MINUTES = 15;
  var DAYS = 7;
  var POINTS = (DAYS * 24 * 60) / STEP_MINUTES + 1; // 673 samples, oldest first

  // ---- Seeded PRNG ---------------------------------------------------------

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rngFor(key) {
    return mulberry32((SEED ^ hashString(key)) >>> 0);
  }

  function gauss(rng) {
    var u = Math.max(rng(), 1e-9);
    var v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function round(n, d) {
    var p = Math.pow(10, d);
    return Math.round(n * p) / p;
  }

  // Smoothed random walk, re-zeroed so the final sample is exactly 0.
  function walk(rng, sigma, damping) {
    var w = new Array(POINTS);
    var v = 0;
    for (var i = 0; i < POINTS; i++) {
      v = v * damping + gauss(rng) * sigma;
      w[i] = v;
    }
    var end = w[POINTS - 1];
    for (var j = 0; j < POINTS; j++) w[j] -= end;
    return w;
  }

  // ---- Reservoirs ----------------------------------------------------------
  // fullPoolFt: top of conservation pool. minPoolFt: bottom of conservation
  // pool used for the % full gauge. ruleCurveFt: illustrative late-October
  // operating target. ftPerDay: drawdown rate (positive = falling pool).

  var reservoirs = [
    {
      id: 'lookout-point', name: 'Lookout Point', river: 'Middle Fork Willamette',
      purpose: 'Flood control · Hydropower', hydro: true,
      fullPoolFt: 926.0, minPoolFt: 825.0, ruleCurveFt: 860.0, elevationFt: 862.4,
      inflowCfs: 1350, outflowCfs: 2350,
      capacityMW: 120, generationMW: 31.4, units: 3, unitsOnline: 2,
      note: 'Fall drawdown toward winter flood-control pool on schedule.',
      trend: { ftPerDay: 0.9, noise: 0.012, diurnalFt: 0.04 },
      map: { x: 325, y: 430, lx: 12, ly: -6, anchor: 'start' }
    },
    {
      id: 'hills-creek', name: 'Hills Creek', river: 'Middle Fork Willamette',
      purpose: 'Flood control · Hydropower', hydro: true,
      fullPoolFt: 1541.0, minPoolFt: 1448.0, ruleCurveFt: 1470.0, elevationFt: 1475.3,
      inflowCfs: 460, outflowCfs: 900,
      capacityMW: 30, generationMW: 9.8, units: 2, unitsOnline: 1,
      note: 'Pool 5 ft above target; release increase scheduled.',
      trend: { ftPerDay: 0.55, noise: 0.01, diurnalFt: 0.03 },
      map: { x: 355, y: 455, lx: 12, ly: 4, anchor: 'start' }
    },
    {
      id: 'dexter', name: 'Dexter', river: 'Middle Fork Willamette',
      purpose: 'Re-regulating · Hydropower', hydro: true,
      fullPoolFt: 695.0, minPoolFt: 680.0, ruleCurveFt: 691.0, elevationFt: 690.8,
      inflowCfs: 2350, outflowCfs: 2400,
      capacityMW: 15, generationMW: 7.6, units: 1, unitsOnline: 1,
      note: 'Re-regulating pool smoothing Lookout Point peaking releases.',
      trend: { ftPerDay: 0, noise: 0.02, diurnalFt: 0.9 },
      map: { x: 295, y: 405, lx: 10, ly: -8, anchor: 'start' }
    },
    {
      id: 'green-peter', name: 'Green Peter', river: 'Middle Santiam',
      purpose: 'Flood control · Hydropower', hydro: true,
      fullPoolFt: 1010.0, minPoolFt: 922.0, ruleCurveFt: 940.0, elevationFt: 928.2,
      inflowCfs: 410, outflowCfs: 1250,
      capacityMW: 80, generationMW: 14.2, units: 2, unitsOnline: 1,
      note: 'Deep drawdown: pool 11.8 ft below target. Low-head operation.',
      trend: { ftPerDay: 1.15, noise: 0.015, diurnalFt: 0.05 },
      map: { x: 330, y: 82, lx: 0, ly: -14, anchor: 'middle' }
    },
    {
      id: 'cougar', name: 'Cougar', river: 'South Fork McKenzie',
      purpose: 'Flood control · Hydropower', hydro: true,
      fullPoolFt: 1699.0, minPoolFt: 1532.0, ruleCurveFt: 1565.0, elevationFt: 1560.1,
      inflowCfs: 360, outflowCfs: 720,
      capacityMW: 25, generationMW: 0, units: 2, unitsOnline: 0,
      note: 'Units offline; passing flow through regulating outlet.',
      trend: { ftPerDay: 0.8, noise: 0.012, diurnalFt: 0.02 },
      map: { x: 345, y: 262, lx: -12, ly: 4, anchor: 'end' }
    },
    {
      id: 'fern-ridge', name: 'Fern Ridge', river: 'Long Tom',
      purpose: 'Flood control · Irrigation', hydro: false,
      fullPoolFt: 373.5, minPoolFt: 353.5, ruleCurveFt: 357.0, elevationFt: 356.2,
      inflowCfs: 65, outflowCfs: 210,
      note: 'Approaching winter pool.',
      trend: { ftPerDay: 0.14, noise: 0.006, diurnalFt: 0.01 },
      map: { x: 110, y: 255, lx: -12, ly: 4, anchor: 'end' }
    },
    {
      id: 'cottage-grove', name: 'Cottage Grove', river: 'Coast Fork Willamette',
      purpose: 'Flood control', hydro: false,
      fullPoolFt: 790.0, minPoolFt: 750.0, ruleCurveFt: 766.0, elevationFt: 765.4,
      inflowCfs: 40, outflowCfs: 125,
      note: 'Drawdown on schedule.',
      trend: { ftPerDay: 0.24, noise: 0.006, diurnalFt: 0.01 },
      map: { x: 185, y: 465, lx: -12, ly: 4, anchor: 'end' }
    },
    {
      id: 'dorena', name: 'Dorena', river: 'Row River',
      purpose: 'Flood control', hydro: false,
      fullPoolFt: 832.0, minPoolFt: 770.0, ruleCurveFt: 785.0, elevationFt: 786.1,
      inflowCfs: 95, outflowCfs: 280,
      note: 'Drawdown on schedule.',
      trend: { ftPerDay: 0.3, noise: 0.008, diurnalFt: 0.01 },
      map: { x: 245, y: 455, lx: 10, ly: 18, anchor: 'start' }
    }
  ];

  // ---- River stations ------------------------------------------------------

  var rivers = [
    {
      id: 'willamette-eugene', name: 'Willamette at Eugene', river: 'Willamette',
      flowCfs: 3720, stageFt: 4.6, tempF: 53.1, minTargetCfs: 2000, floodStageFt: 18,
      note: 'Flow supported by Middle Fork drawdown releases.',
      trend: { diurnal: 0.03, noise: 0.006, storm: 0.38 },
      map: { x: 205, y: 305, lx: -12, ly: 4, anchor: 'end' }
    },
    {
      id: 'willamette-harrisburg', name: 'Willamette at Harrisburg', river: 'Willamette',
      flowCfs: 7640, stageFt: 4.2, tempF: 53.8, minTargetCfs: 4500, floodStageFt: 14,
      note: 'Below McKenzie confluence.',
      trend: { diurnal: 0.02, noise: 0.005, storm: 0.4 },
      map: { x: 195, y: 180, lx: -12, ly: 4, anchor: 'end' }
    },
    {
      id: 'mckenzie-vida', name: 'McKenzie at Vida', river: 'McKenzie',
      flowCfs: 2760, stageFt: 3.8, tempF: 49.6, minTargetCfs: 1500, floodStageFt: 14,
      note: 'Spring-fed baseflow; cold and stable.',
      trend: { diurnal: 0.015, noise: 0.004, storm: 0.3 },
      map: { x: 290, y: 225, lx: 0, ly: -14, anchor: 'middle' }
    },
    {
      id: 'mckenzie-coburg', name: 'McKenzie at Coburg', river: 'McKenzie',
      flowCfs: 3560, stageFt: 4.4, tempF: 51.2, minTargetCfs: 1800, floodStageFt: 16,
      note: 'Lower McKenzie above Willamette confluence.',
      trend: { diurnal: 0.02, noise: 0.005, storm: 0.34 },
      map: { x: 235, y: 248, lx: 0, ly: -14, anchor: 'middle' }
    },
    {
      id: 'middle-fork-jasper', name: 'Middle Fork Willamette at Jasper', river: 'Middle Fork Willamette',
      flowCfs: 3010, stageFt: 4.1, tempF: 52.4, minTargetCfs: 1200, floodStageFt: 12,
      note: 'Regulated by Dexter releases.',
      trend: { diurnal: 0.06, noise: 0.004, storm: 0.2 },
      map: { x: 245, y: 360, lx: 8, ly: -9, anchor: 'start' }
    },
    {
      id: 'coast-fork-goshen', name: 'Coast Fork Willamette at Goshen', river: 'Coast Fork Willamette',
      flowCfs: 520, stageFt: 2.3, tempF: 54.0, minTargetCfs: 500, floodStageFt: 18,
      note: 'Flow within 5% of minimum target.',
      trend: { diurnal: 0.03, noise: 0.008, storm: 0.6 },
      map: { x: 208, y: 400, lx: 12, ly: 4, anchor: 'start' }
    }
  ];

  // ---- Schematic map geometry (viewBox 0 0 440 500, north up, not to scale) -

  var basinMap = {
    viewBox: [0, 0, 440, 500],
    // Each river is listed upstream -> downstream so the flow animation runs downstream.
    rivers: [
      { id: 'willamette', label: 'WILLAMETTE', main: true, flowRef: 'willamette-harrisburg',
        points: [[220, 335], [205, 305], [203, 275], [205, 250], [198, 215], [195, 180], [182, 140], [186, 100], [192, 60], [188, 10]],
        labelAt: [172, 112], labelRotate: -82 },
      { id: 'mckenzie', label: 'McKENZIE', flowRef: 'mckenzie-coburg',
        points: [[425, 174], [360, 202], [330, 215], [290, 225], [260, 238], [235, 248], [205, 250]],
        labelAt: [372, 188], labelRotate: -18 },
      { id: 'sf-mckenzie', label: 'S.F. McKENZIE', flowRef: 'mckenzie-vida',
        points: [[352, 310], [348, 285], [345, 262], [338, 238], [330, 215]],
        labelAt: [366, 318], labelRotate: -80 },
      { id: 'middle-fork', label: 'MIDDLE FORK', flowRef: 'middle-fork-jasper',
        points: [[425, 492], [355, 455], [325, 430], [295, 405], [268, 382], [245, 360], [220, 335]],
        labelAt: [314, 447], labelRotate: 40 },
      { id: 'coast-fork', label: 'COAST FORK', flowRef: 'coast-fork-goshen',
        points: [[178, 498], [185, 465], [195, 435], [208, 400], [215, 365], [220, 335]],
        labelAt: [178, 446], labelRotate: -72 },
      { id: 'row', label: 'ROW R.', flowRef: 'coast-fork-goshen',
        points: [[285, 480], [245, 455], [215, 444], [195, 435]],
        labelAt: [278, 494], labelRotate: 0 },
      { id: 'long-tom', label: 'LONG TOM', flowRef: 'coast-fork-goshen',
        points: [[40, 345], [70, 300], [110, 255], [135, 215], [160, 175], [182, 140]],
        labelAt: [68, 332], labelRotate: -52 },
      { id: 'santiam', label: 'M. SANTIAM / SANTIAM', flowRef: 'mckenzie-vida',
        points: [[428, 106], [360, 90], [330, 82], [280, 70], [230, 63], [192, 60]],
        labelAt: [262, 56], labelRotate: -6 }
    ],
    places: [
      { label: 'EUGENE · SPRINGFIELD', x: 228, y: 318, anchor: 'start' },
      { label: 'TO ALBANY / SALEM ↑', x: 196, y: 22, anchor: 'start' }
    ]
  };

  // ---- Derived values ------------------------------------------------------

  function percentFull(r) {
    var x = (r.elevationFt - r.minPoolFt) / (r.fullPoolFt - r.minPoolFt);
    x = Math.min(1, Math.max(0, x));
    // Reservoirs widen with height, so storage grows faster than elevation.
    return round(Math.pow(x, 1.4) * 100, 1);
  }

  function percentAt(r, elev) {
    var x = Math.min(1, Math.max(0, (elev - r.minPoolFt) / (r.fullPoolFt - r.minPoolFt)));
    return round(Math.pow(x, 1.4) * 100, 1);
  }

  function reservoirStatus(r) {
    var dev = r.elevationFt - r.ruleCurveFt;
    if (r.elevationFt < r.minPoolFt || dev < -8) return 'low';
    if (Math.abs(dev) > 3) return 'watch';
    return 'normal';
  }

  function riverStatus(s) {
    if (s.flowCfs < s.minTargetCfs) return 'low';
    if (s.flowCfs < s.minTargetCfs * 1.1 || s.tempF > 60 || s.stageFt > s.floodStageFt * 0.8) return 'watch';
    return 'normal';
  }

  function reservoirTrend(r) {
    var rng = rngFor(r.id + ':elev');
    var w = walk(rng, r.trend.noise, 0.985);
    var phase = rng() * Math.PI * 2;
    var out = new Array(POINTS);
    for (var i = 0; i < POINTS; i++) {
      var days = ((POINTS - 1 - i) * STEP_MINUTES) / 1440;
      var diurnal = r.trend.diurnalFt * (Math.sin(2 * Math.PI * days + phase) - Math.sin(phase));
      out[i] = round(r.elevationFt + r.trend.ftPerDay * days + w[i] + diurnal, 2);
    }
    out[POINTS - 1] = r.elevationFt;
    return out;
  }

  function riverTrend(s) {
    var rng = rngFor(s.id + ':flow');
    var w = walk(rng, s.trend.noise, 0.99);
    var phase = rng() * Math.PI * 2;
    // One autumn rain event about four days back: sharp rise, slow recession.
    var peakHoursAgo = 92 + rng() * 6;
    var raw = new Array(POINTS);
    for (var i = 0; i < POINTS; i++) {
      var hoursAgo = ((POINTS - 1 - i) * STEP_MINUTES) / 60;
      var storm = hoursAgo > peakHoursAgo
        ? Math.exp(-Math.pow((hoursAgo - peakHoursAgo) / 7, 2))
        : Math.exp(-(peakHoursAgo - hoursAgo) / 26);
      var diurnal = 1 + s.trend.diurnal * Math.sin((2 * Math.PI * hoursAgo) / 24 + phase);
      raw[i] = diurnal * Math.exp(w[i]) * (1 + s.trend.storm * storm);
    }
    var scale = s.flowCfs / raw[POINTS - 1];
    var flow = new Array(POINTS);
    var stage = new Array(POINTS);
    for (var j = 0; j < POINTS; j++) {
      var q = raw[j] * scale;
      flow[j] = Math.round(q);
      stage[j] = round(s.stageFt * Math.pow(q / s.flowCfs, 0.45), 2);
    }
    flow[POINTS - 1] = s.flowCfs;
    stage[POINTS - 1] = s.stageFt;
    return { flow: flow, stage: stage };
  }

  reservoirs.forEach(function (r) {
    r.kind = 'reservoir';
    r.percentFull = percentFull(r);
    r.ruleCurvePercent = percentAt(r, r.ruleCurveFt);
    r.status = reservoirStatus(r);
    r.series = { elevationFt: reservoirTrend(r) };
  });

  rivers.forEach(function (s) {
    s.kind = 'river';
    s.status = riverStatus(s);
    var t = riverTrend(s);
    s.series = { flowCfs: t.flow, stageFt: t.stage };
  });

  function totals() {
    var hydro = reservoirs.filter(function (r) { return r.hydro; });
    var sum = function (arr, f) { return arr.reduce(function (a, x) { return a + f(x); }, 0); };
    var all = reservoirs.concat(rivers);
    // Basin storage weighted by (illustrative) conservation storage capacity.
    var weighted = sum(reservoirs, function (r) { return r.percentFull * r.storageKaf; });
    return {
      generationMW: round(sum(hydro, function (r) { return r.generationMW; }), 1),
      capacityMW: sum(hydro, function (r) { return r.capacityMW; }),
      unitsOnline: sum(hydro, function (r) { return r.unitsOnline; }),
      units: sum(hydro, function (r) { return r.units; }),
      alarms: all.filter(function (x) { return x.status !== 'normal'; }).length,
      lowAlarms: all.filter(function (x) { return x.status === 'low'; }).length,
      basinStoragePercent: round(weighted / sum(reservoirs, function (r) { return r.storageKaf; }), 1),
      totalReleaseCfs: sum(reservoirs, function (r) { return r.outflowCfs; })
    };
  }

  // Illustrative usable conservation storage, thousand acre-feet.
  var STORAGE_KAF = {
    'lookout-point': 337, 'hills-creek': 249, 'dexter': 5, 'green-peter': 268,
    'cougar': 155, 'fern-ridge': 110, 'cottage-grove': 30, 'dorena': 71
  };
  reservoirs.forEach(function (r) { r.storageKaf = STORAGE_KAF[r.id]; });

  return {
    meta: {
      title: 'Willamette Valley Hydro Dispatch',
      illustrative: true,
      disclaimer: 'Illustrative data, not live. Not affiliated with any agency.',
      seed: SEED,
      stepMinutes: STEP_MINUTES,
      days: DAYS,
      points: POINTS,
      season: 'Late-October fall drawdown'
    },
    reservoirs: reservoirs,
    rivers: rivers,
    basinMap: basinMap,
    totals: totals
  };
});
