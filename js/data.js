/*
 * Willamette Valley Hydro Dispatch — static configuration + live-data loader.
 *
 * LIVE sources (fetched from the browser, both send Access-Control-Allow-Origin: *):
 *   - USGS NWIS Instantaneous Values (river discharge, gage height, water temperature)
 *   - USACE CWMS Data API, office NWDP (reservoir elevation, storage, outflow,
 *     computed inflow, and the daily rule-curve / water-control-diagram elevation)
 * BPA-wide hydro generation is not CORS-enabled; a GitHub Action writes it to
 * data/bpa.json, which the page reads from the same origin.
 *
 * This file contains NO measured values. Every number shown on the page comes from
 * those sources at runtime, or is derived from them (and labelled as derived).
 * Data is provisional and this is not an official site.
 *
 * Works in the browser (window.HYDRO) and in Node 20+ (module.exports) for check.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOUR = 3600 * 1000;
  var DAY = 24 * HOUR;

  var SETTINGS = {
    pollMinutes: 15,
    historyDays: 7,
    staleHours: 3,        // older than this -> STALE (amber)
    veryStaleHours: 12,   // older than this -> red
    // Reservoir status thresholds used by THIS SITE (not an agency determination).
    ruleBelowFt: 10,      // pool more than 10 ft below rule curve -> "below rule curve"
    ruleAboveFt: 2,       // pool more than 2 ft above rule curve  -> "above rule curve"
    timeoutMs: 30000
  };

  var USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
  var CWMS_TS = 'https://cwms-data.usace.army.mil/cwms-data/timeseries';
  var CWMS_ACCEPT = 'application/json;version=2';
  var USACE_PORTAL = 'https://water.sec.usace.army.mil/';

  // USGS parameter codes.
  var PARAM = { flow: '00060', stage: '00065', tempC: '00010' };

  // ---- USGS river gauges ---------------------------------------------------

  var stations = [
    { id: 'willamette-eugene', site: '14158050', name: 'Willamette at Eugene', short: 'EUGENE',
      river: 'Willamette', usgsName: 'WILLAMETTE RIVER AT EUGENE, OR',
      // No discharge (00060) series is published for this site: chart stage instead.
      params: ['stage', 'tempC'], primary: 'stage',
      map: { x: 205, y: 305, lx: -12, ly: 4, anchor: 'end' } },
    { id: 'willamette-harrisburg', site: '14166000', name: 'Willamette at Harrisburg', short: 'HARRISBURG',
      river: 'Willamette', usgsName: 'WILLAMETTE RIVER AT HARRISBURG, OR',
      params: ['flow', 'stage', 'tempC'], primary: 'flow',
      map: { x: 195, y: 180, lx: -12, ly: 4, anchor: 'end' } },
    { id: 'mckenzie-vida', site: '14162500', name: 'McKenzie near Vida', short: 'VIDA',
      river: 'McKenzie', usgsName: 'MCKENZIE RIVER NEAR VIDA, OR',
      params: ['flow', 'stage', 'tempC'], primary: 'flow',
      map: { x: 290, y: 225, lx: 0, ly: -14, anchor: 'middle' } },
    { id: 'mckenzie-coburg', site: '14165500', name: 'McKenzie near Coburg', short: 'COBURG',
      river: 'McKenzie', usgsName: 'MCKENZIE RIVER NEAR COBURG, OR',
      params: ['flow', 'stage', 'tempC'], primary: 'flow',
      map: { x: 235, y: 248, lx: 0, ly: -14, anchor: 'middle' } },
    { id: 'middle-fork-jasper', site: '14152000', name: 'Middle Fork Willamette at Jasper', short: 'JASPER',
      river: 'Middle Fork Willamette', usgsName: 'MIDDLE FORK WILLAMETTE RIVER AT JASPER, OR',
      params: ['flow', 'stage', 'tempC'], primary: 'flow',
      map: { x: 245, y: 360, lx: 8, ly: -9, anchor: 'start' } },
    { id: 'coast-fork-goshen', site: '14157500', name: 'Coast Fork Willamette near Goshen', short: 'GOSHEN',
      river: 'Coast Fork Willamette', usgsName: 'COAST FORK WILLAMETTE RIVER NEAR GOSHEN, OR',
      params: ['flow', 'stage', 'tempC'], primary: 'flow',
      map: { x: 208, y: 400, lx: 12, ly: 4, anchor: 'start' } }
  ];

  stations.forEach(function (s) {
    s.kind = 'river';
    s.sourceUrl = 'https://waterdata.usgs.gov/monitoring-location/' + s.site + '/';
  });

  // ---- USACE reservoirs ----------------------------------------------------
  // Conservation-pool limits are hardcoded from CWMS location levels effective
  // 2026-10-30: "<P>.Elev.Inst.0.Top of Conservation" / "<P>.Elev.Inst.0.Bottom of
  // Conservation" and "<P>.Stor.Inst.0.Top of Conservation" / "...Bottom of
  // Conservation". Dexter has no conservation pool (run-of-river re-regulating
  // dam); its band is "DEX.Elev.Inst.0.Bottom of Power" / "Top of Power".

  var projects = [
    { id: 'lookout-point', code: 'LOP', name: 'Lookout Point', river: 'Middle Fork Willamette',
      purpose: 'Flood control · Hydropower', hydro: true, cbt: true,
      cons: { elevBottom: 825.0, elevTop: 926.0, storBottom: 113619, storTop: 438179 },
      map: { x: 325, y: 430, lx: 12, ly: -6, anchor: 'start' } },
    { id: 'hills-creek', code: 'HCR', name: 'Hills Creek', river: 'Middle Fork Willamette',
      purpose: 'Flood control · Hydropower', hydro: true,
      cons: { elevBottom: 1448.0, elevTop: 1541.0, storBottom: 155400, storTop: 350000 },
      map: { x: 355, y: 455, lx: 12, ly: 4, anchor: 'start' } },
    { id: 'dexter', code: 'DEX', name: 'Dexter', river: 'Middle Fork Willamette',
      purpose: 'Re-regulating · Hydropower', hydro: true, noStorage: true,
      cons: null, powerPool: { elevBottom: 690.0, elevTop: 695.0 },
      map: { x: 295, y: 405, lx: 10, ly: -8, anchor: 'start' } },
    { id: 'green-peter', code: 'GPR', name: 'Green Peter', river: 'Middle Santiam',
      purpose: 'Flood control · Hydropower', hydro: true, cbt: true,
      cons: { elevBottom: 922.0, elevTop: 1010.0, storBottom: 165628, storTop: 424402 },
      map: { x: 330, y: 82, lx: 0, ly: -14, anchor: 'middle' } },
    { id: 'cougar', code: 'CGR', name: 'Cougar', river: 'South Fork McKenzie',
      purpose: 'Flood control · Hydropower', hydro: true,
      cons: { elevBottom: 1532.0, elevTop: 1690.0, storBottom: 52200, storTop: 189000 },
      map: { x: 345, y: 262, lx: -12, ly: 4, anchor: 'end' } },
    { id: 'fern-ridge', code: 'FRN', name: 'Fern Ridge', river: 'Long Tom',
      purpose: 'Flood control · Irrigation', hydro: false,
      cons: { elevBottom: 353.0, elevTop: 373.5, storBottom: 2800, storTop: 97280 },
      map: { x: 110, y: 255, lx: -12, ly: 4, anchor: 'end' } },
    { id: 'cottage-grove', code: 'COT', name: 'Cottage Grove', river: 'Coast Fork Willamette',
      purpose: 'Flood control', hydro: false,
      cons: { elevBottom: 750.0, elevTop: 790.0, storBottom: 3140, storTop: 31780 },
      map: { x: 185, y: 465, lx: -12, ly: 4, anchor: 'end' } },
    { id: 'dorena', code: 'DOR', name: 'Dorena', river: 'Row River',
      purpose: 'Flood control', hydro: false,
      cons: { elevBottom: 770.5, elevTop: 832.0, storBottom: 7100, storTop: 72100 },
      map: { x: 245, y: 455, lx: 10, ly: 18, anchor: 'start' } }
  ];

  projects.forEach(function (p) {
    var c = p.code;
    p.kind = 'reservoir';
    // Only series verified to return public data are listed.
    p.series = {
      elev: { name: c + '.Elev-Forebay.Inst.0.0.MIXED-REV', unit: 'ft' },
      stor: p.noStorage ? null : { name: c + '.Stor.Inst.0.0.MIXED-COMPUTED-REV', unit: 'ac-ft' },
      out: { name: p.cbt ? c + '.Flow-Out.Ave.1Hour.1Hour.CBT-REV' : c + '.Flow-Out.Inst.0.0.MIXED-COMPUTED-REV', unit: 'cfs' },
      inflow: { name: c + (p.cbt ? '.Flow-In.Ave.15Minutes.6Hours.CBT-COMPUTED-REV' : '.Flow-In.Ave.15Minutes.6Hours.MIXED-COMPUTED-REV'), unit: 'cfs' },
      rule: { name: c + '.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC', unit: 'ft' }
    };
    p.sourceUrl = USACE_PORTAL;
    // Without begin/end CWMS returns the last 24 h; browsers receive XML, other clients JSON.
    p.apiUrl = CWMS_TS + '?office=NWDP&name=' + encodeURIComponent(p.series.elev.name) + '&unit=ft';
  });

  // ---- Schematic map geometry (viewBox 0 0 440 500, north up, not to scale) -

  var basinMap = {
    viewBox: [0, 0, 440, 500],
    // Listed upstream -> downstream so the flow animation runs downstream.
    rivers: [
      { id: 'willamette', label: 'WILLAMETTE', main: true,
        points: [[220, 335], [205, 305], [203, 275], [205, 250], [198, 215], [195, 180], [182, 140], [186, 100], [192, 60], [188, 10]],
        labelAt: [172, 112], labelRotate: -82 },
      { id: 'mckenzie', label: 'McKENZIE',
        points: [[425, 174], [360, 202], [330, 215], [290, 225], [260, 238], [235, 248], [205, 250]],
        labelAt: [372, 188], labelRotate: -18 },
      { id: 'sf-mckenzie', label: 'S.F. McKENZIE',
        points: [[352, 310], [348, 285], [345, 262], [338, 238], [330, 215]],
        labelAt: [366, 318], labelRotate: -80 },
      { id: 'middle-fork', label: 'MIDDLE FORK',
        points: [[425, 492], [355, 455], [325, 430], [295, 405], [268, 382], [245, 360], [220, 335]],
        labelAt: [314, 447], labelRotate: 40 },
      { id: 'coast-fork', label: 'COAST FORK',
        points: [[178, 498], [185, 465], [195, 435], [208, 400], [215, 365], [220, 335]],
        labelAt: [178, 446], labelRotate: -72 },
      { id: 'row', label: 'ROW R.',
        points: [[285, 480], [245, 455], [215, 444], [195, 435]],
        labelAt: [278, 494], labelRotate: 0 },
      { id: 'long-tom', label: 'LONG TOM',
        points: [[40, 345], [70, 300], [110, 255], [135, 215], [160, 175], [182, 140]],
        labelAt: [68, 332], labelRotate: -52 },
      { id: 'santiam', label: 'M. SANTIAM / SANTIAM',
        points: [[428, 106], [360, 90], [330, 82], [280, 70], [230, 63], [192, 60]],
        labelAt: [262, 56], labelRotate: -6 }
    ],
    places: [
      { label: 'EUGENE · SPRINGFIELD', x: 228, y: 318, anchor: 'start' },
      { label: 'TO ALBANY / SALEM ↑', x: 196, y: 22, anchor: 'start' }
    ]
  };

  // ---- Fetch helpers -------------------------------------------------------

  function fetchWithTimeout(url, opts, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || SETTINGS.timeoutMs) : null;
    var o = Object.assign({}, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    }, function (err) {
      throw new Error(err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'network error');
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  // One retry after a short pause for network errors and HTTP 5xx (not for 4xx).
  // `tries` attempts in total (default 2), pausing 1.5 s, 3 s, ... between them.
  // Retries network errors, timeouts and HTTP 5xx; never retries 4xx.
  function fetchJson(url, opts, ms, tries) {
    var max = tries || 2, n = 0;
    var attempt = function () {
      n++;
      return fetchWithTimeout(url, opts, ms).then(function (r) { return r.json(); }).catch(function (err) {
        if (/^HTTP 4/.test(err.message) || n >= max) throw err;
        return new Promise(function (res) { setTimeout(res, 1500 * n); }).then(attempt);
      });
    };
    return attempt();
  }

  // Runs promise-returning tasks with at most `n` in flight.
  function limit(n) {
    var active = 0, queue = [];
    function next() {
      if (active >= n || !queue.length) return;
      active++;
      var job = queue.shift();
      job.fn().then(job.resolve, job.reject).finally(function () { active--; next(); });
    }
    return function (fn) {
      return new Promise(function (resolve, reject) { queue.push({ fn: fn, resolve: resolve, reject: reject }); next(); });
    };
  }

  function emptySeries(meta) {
    return Object.assign({ t: [], v: [], q: null }, meta || {});
  }

  // ---- USGS ----------------------------------------------------------------

  function usgsUrl(days) {
    var sites = stations.map(function (s) { return s.site; }).join(',');
    return USGS_IV + '?format=json&sites=' + sites + '&parameterCd=00060,00065,00010&period=P' + (days || SETTINGS.historyDays) + 'D';
  }

  // Returns { <site>: { flow: Series, stage: Series, tempC: Series } } (only series present in the response).
  function parseUsgs(json) {
    var byCode = {};
    Object.keys(PARAM).forEach(function (k) { byCode[PARAM[k]] = k; });
    var out = {};
    var list = (json && json.value && json.value.timeSeries) || [];
    list.forEach(function (ts) {
      var site = ts.sourceInfo && ts.sourceInfo.siteCode && ts.sourceInfo.siteCode[0] && ts.sourceInfo.siteCode[0].value;
      var code = ts.variable && ts.variable.variableCode && ts.variable.variableCode[0] && ts.variable.variableCode[0].value;
      var key = byCode[code];
      if (!site || !key) return;
      var noData = ts.variable.noDataValue;
      var s = emptySeries({ source: 'USGS', param: code, unit: ts.variable.unit && ts.variable.unit.unitCode, q: [] });
      (ts.values || []).forEach(function (block) {
        (block.value || []).forEach(function (pt) {
          var v = parseFloat(pt.value);
          var t = Date.parse(pt.dateTime);
          if (!isFinite(v) || !isFinite(t) || v === noData || v <= -999999) return;
          s.t.push(t); s.v.push(v); s.q.push((pt.qualifiers || []).join(','));
        });
      });
      sortSeries(s);
      out[site] = out[site] || {};
      out[site][key] = s;
    });
    return out;
  }

  // ---- USACE CWMS ----------------------------------------------------------

  function cwmsUrl(name, unit, begin, end, page) {
    var q = 'office=NWDP&name=' + encodeURIComponent(name) + '&unit=' + encodeURIComponent(unit) +
      '&begin=' + new Date(begin).toISOString() + '&end=' + new Date(end).toISOString() + '&page-size=5000';
    if (page) q += '&page=' + encodeURIComponent(page);
    return CWMS_TS + '?' + q;
  }

  // Fetches one series, following pagination. Null values are dropped.
  function fetchCwms(spec, begin, end) {
    var s = emptySeries({ source: 'USACE CWMS', name: spec.name, unit: spec.unit });
    var guard = 0;
    function page(cursor) {
      return fetchJson(cwmsUrl(spec.name, spec.unit, begin, end, cursor), { headers: { Accept: CWMS_ACCEPT } }).then(function (j) {
        (j.values || []).forEach(function (row) {
          if (row && row[1] != null && isFinite(row[1])) { s.t.push(row[0]); s.v.push(row[1]); }
        });
        if (j['next-page'] && ++guard < 10) return page(j['next-page']);
        sortSeries(s);
        return s;
      });
    }
    return page(null);
  }

  function sortSeries(s) {
    var idx = s.t.map(function (_, i) { return i; }).sort(function (a, b) { return s.t[a] - s.t[b]; });
    var sorted = idx.every(function (v, i) { return v === i; });
    if (sorted) return;
    s.t = idx.map(function (i) { return s.t[i]; });
    s.v = idx.map(function (i) { return s.v[i]; });
    if (s.q) { var q = s.q; s.q = idx.map(function (i) { return q[i]; }); }
  }

  // ---- Loader --------------------------------------------------------------

  /*
   * Loads everything. Never throws; failures are reported per source/series.
   * opts.bpaUrl: URL of data/bpa.json (browser) or null to skip.
   */
  function loadAll(opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var begin = now - SETTINGS.historyDays * DAY;
    var snap = {
      startedAt: now, fetchedAt: null,
      stations: {}, projects: {}, bpa: null,
      sources: {
        usgs: { ok: false, error: null, series: 0 },
        cwms: { ok: 0, failed: 0, empty: 0, errors: [] },
        bpa: { ok: false, error: null, skipped: !opts.bpaUrl }
      }
    };

    var usgsP = fetchJson(usgsUrl(), {}, SETTINGS.timeoutMs).then(function (j) {
      var parsed = parseUsgs(j);
      stations.forEach(function (st) {
        snap.stations[st.id] = parsed[st.site] || {};
        Object.keys(snap.stations[st.id]).forEach(function (k) { if (snap.stations[st.id][k].t.length) snap.sources.usgs.series++; });
      });
      snap.sources.usgs.ok = true;
    }, function (err) {
      stations.forEach(function (st) { snap.stations[st.id] = {}; });
      snap.sources.usgs.error = err.message;
    });

    var jobs = [], run = limit(8);
    projects.forEach(function (p) {
      snap.projects[p.id] = {};
      Object.keys(p.series).forEach(function (key) {
        var spec = p.series[key];
        if (!spec) return;
        // Rule curve: daily values including the next several days.
        var b = key === 'rule' ? now - 8 * DAY : begin;
        var e = key === 'rule' ? now + 8 * DAY : now;
        jobs.push(run(function () { return fetchCwms(spec, b, e); }).then(function (s) {
          snap.projects[p.id][key] = s;
          if (s.t.length) snap.sources.cwms.ok++;
          else { snap.sources.cwms.empty++; snap.sources.cwms.errors.push(spec.name + ': empty'); }
        }, function (err) {
          snap.projects[p.id][key] = null;
          snap.sources.cwms.failed++;
          snap.sources.cwms.errors.push(spec.name + ': ' + err.message);
        }));
      });
    });

    var bpaP = !opts.bpaUrl ? Promise.resolve() : fetchJson(opts.bpaUrl + (opts.bpaUrl.indexOf('?') < 0 ? '?' : '&') + 't=' + now, { cache: 'no-store' }, 15000)
      .then(function (j) {
        if (!j || !j.latest || !isFinite(j.latest.hydroMW)) throw new Error('bad file');
        snap.bpa = j;
        snap.sources.bpa.ok = true;
      }, function (err) { snap.sources.bpa.error = err.message; });

    var settle = Promise.allSettled ? Promise.allSettled.bind(Promise) : function (ps) {
      return Promise.all(ps.map(function (p) { return p.then(function () {}, function () {}); }));
    };
    return settle([usgsP, bpaP].concat(jobs)).then(function () {
      snap.fetchedAt = Date.now();
      return snap;
    });
  }

  // ---- Long-range history (Trend Recorder 30 D / 12 MO) ----------------------

  var RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30, '12m': 365 };
  var USGS_DV = 'https://waterservices.usgs.gov/nwis/dv/';

  // Mean of the values in each fixed bucket of `ms` (epoch-aligned); point stamped at the bucket centre.
  function bucketMean(s, ms) {
    var out = emptySeries({ source: s && s.source, name: s && s.name, unit: s && s.unit });
    if (!s || !s.t || !s.t.length) return out;
    var key = null, sum = 0, n = 0;
    for (var i = 0; i <= s.t.length; i++) {
      var k = i < s.t.length ? Math.floor(s.t[i] / ms) : null;
      if (k !== key && n) { out.t.push(key * ms + ms / 2); out.v.push(sum / n); sum = 0; n = 0; }
      if (k == null) break;
      key = k; sum += s.v[i]; n++;
    }
    return out;
  }

  /*
   * History for one chart point over `range` ('30d' | '12m'). Never rejects.
   * Reservoir: { elev, rule }, elevation reduced to hourly (30 d) or 3-hourly (12 mo) means and
   * fetched in ~31-day chunks (5-minute data). River: { flow, stage, tempC } from USGS IV
   * (30 d, as reported) or USGS daily means (12 mo, statCd 00003).
   */
  function loadHistory(e, range, now) {
    now = now || Date.now();
    var days = RANGE_DAYS[range] || 30, begin = now - days * DAY, out = { range: range, fetchedAt: null, error: null };
    var done = function () { out.fetchedAt = Date.now(); return out; };
    if (e.kind === 'reservoir') {
      var bucket = range === '12m' ? 3 * HOUR : HOUR, run = limit(6), chunks = [];
      for (var b = begin; b < now; b += 31 * DAY) chunks.push([b, Math.min(now, b + 31 * DAY - 1)]);
      var parts = [];
      var elevP = Promise.all(chunks.map(function (c, i) {
        return run(function () { return fetchCwms(e.series.elev, c[0], c[1]); }).then(function (s) { parts[i] = bucketMean(s, bucket); });
      })).then(function () {
        var s = emptySeries({ source: 'USACE CWMS', name: e.series.elev.name, unit: 'ft' });
        parts.forEach(function (p) { s.t = s.t.concat(p.t); s.v = s.v.concat(p.v); });
        out.elev = s;
      });
      var ruleP = fetchCwms(e.series.rule, begin - DAY, now + 8 * DAY).then(function (s) { out.rule = s; });
      return Promise.all([elevP, ruleP]).then(done, function (err) { out.error = err.message; return done(); });
    }
    var url = range === '12m'
      ? USGS_DV + '?format=json&sites=' + e.site + '&parameterCd=00060,00065,00010&statCd=00003&period=P' + days + 'D'
      : USGS_IV + '?format=json&sites=' + e.site + '&parameterCd=00060,00065,00010&period=P' + days + 'D';
    return fetchJson(url, {}, 60000).then(function (j) {
      var parsed = parseUsgs(j)[e.site] || {};
      ['flow', 'stage', 'tempC'].forEach(function (k) { if (parsed[k]) out[k] = parsed[k]; });
    }, function (err) { out.error = err.message; }).then(done);
  }

  // ---- Derived values (pure) -----------------------------------------------

  function latest(s) {
    if (!s || !s.t || !s.t.length) return null;
    var i = s.t.length - 1;
    return { t: s.t[i], v: s.v[i], q: s.q ? s.q[i] : null };
  }

  // Latest point with time <= t.
  function atOrBefore(s, t) {
    if (!s || !s.t || !s.t.length || s.t[0] > t) return null;
    var lo = 0, hi = s.t.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (s.t[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return { t: s.t[lo], v: s.v[lo], q: s.q ? s.q[lo] : null };
  }

  // Linear interpolation (used for the daily rule curve between midnights).
  function interpolate(s, t) {
    if (!s || !s.t || !s.t.length || t < s.t[0] || t > s.t[s.t.length - 1]) return null;
    var a = atOrBefore(s, t);
    var i = s.t.indexOf(a.t);
    if (a.t === t || i === s.t.length - 1) return a.v;
    var t1 = s.t[i + 1], v1 = s.v[i + 1];
    return a.v + ((v1 - a.v) * (t - a.t)) / (t1 - a.t);
  }

  function ageHours(t, now) { return t == null ? Infinity : ((now || Date.now()) - t) / HOUR; }

  // 'fresh' | 'stale' | 'very-stale' | 'none'
  function freshness(t, now) {
    if (t == null) return 'none';
    var h = ageHours(t, now);
    if (h > SETTINGS.veryStaleHours) return 'very-stale';
    if (h > SETTINGS.staleHours) return 'stale';
    return 'fresh';
  }

  // USACE "teacup" definition, from live storage. pct may be < 0 or > 100; clamp only for display.
  function percentFull(p, stor) {
    if (!p.cons || stor == null) return null;
    var pct = ((stor - p.cons.storBottom) / (p.cons.storTop - p.cons.storBottom)) * 100;
    return { pct: pct, clamped: Math.max(0, Math.min(100, pct)), below: stor < p.cons.storBottom, above: stor > p.cons.storTop };
  }

  // Rule curve value for "today": latest daily point at or before now (Pacific midnight stamps).
  function ruleToday(rule, now) { return atOrBefore(rule, now || Date.now()); }

  // Status lights are derived by THIS SITE from data freshness and the USACE rule curve.
  // level: 'normal' (green) | 'watch' (amber) | 'low' (red) | 'pending' (grey)
  function reservoirStatus(p, d, now) {
    if (!d) return { level: 'pending', label: 'LOADING' };
    var e = latest(d.elev);
    var f = freshness(e && e.t, now);
    if (f === 'none') return { level: 'low', label: 'NO DATA', reason: 'No pool elevation reading returned.' };
    if (f === 'very-stale') return { level: 'low', label: 'STALE >12H', reason: 'Latest pool elevation is more than ' + SETTINGS.veryStaleHours + ' h old.' };
    if (f === 'stale') return { level: 'watch', label: 'STALE', reason: 'Latest pool elevation is more than ' + SETTINGS.staleHours + ' h old.' };
    var r = ruleToday(d.rule, now);
    if (!r) return { level: 'normal', label: 'REPORTING', reason: 'Rule curve unavailable; elevation reporting.' };
    var dev = e.v - r.v;
    if (dev < -SETTINGS.ruleBelowFt) return { level: 'watch', label: 'BELOW RULE CURVE', reason: 'Pool is ' + Math.abs(dev).toFixed(1) + ' ft below the USACE rule curve (site threshold ' + SETTINGS.ruleBelowFt + ' ft).' };
    if (dev > SETTINGS.ruleAboveFt) return { level: 'watch', label: 'ABOVE RULE CURVE', reason: 'Pool is ' + dev.toFixed(1) + ' ft above the USACE rule curve (site threshold ' + SETTINGS.ruleAboveFt + ' ft).' };
    return { level: 'normal', label: 'NEAR RULE CURVE', reason: 'Pool within the site band of the USACE rule curve.' };
  }

  function stationPrimary(st, d) {
    if (!d) return null;
    return d[st.primary] && d[st.primary].t.length ? d[st.primary] : null;
  }

  function stationStatus(st, d, now) {
    if (!d) return { level: 'pending', label: 'LOADING' };
    var newest = null;
    st.params.forEach(function (k) { var l = latest(d[k]); if (l && (newest == null || l.t > newest)) newest = l.t; });
    var f = freshness(newest, now);
    if (f === 'none') return { level: 'low', label: 'NO DATA', reason: 'USGS returned no readings.' };
    if (f === 'very-stale') return { level: 'low', label: 'STALE >12H', reason: 'Latest reading is more than ' + SETTINGS.veryStaleHours + ' h old.' };
    if (f === 'stale') return { level: 'watch', label: 'STALE', reason: 'Latest reading is more than ' + SETTINGS.staleHours + ' h old.' };
    return { level: 'normal', label: 'REPORTING', reason: 'Fresh reading from USGS.' };
  }

  // Sum of (storage - bottom of conservation) clamped >= 0 over projects with storage,
  // divided by the sum of conservation capacities of those projects.
  function basinStorage(snap, now) {
    var num = 0, den = 0, n = 0, total = 0;
    projects.forEach(function (p) {
      if (!p.cons) return;
      total++;
      var d = snap && snap.projects[p.id];
      var s = d && latest(d.stor);
      if (!s || freshness(s.t, now) === 'none' || freshness(s.t, now) === 'very-stale') return;
      n++;
      num += Math.max(0, s.v - p.cons.storBottom);
      den += p.cons.storTop - p.cons.storBottom;
    });
    return { pct: n ? (num / den) * 100 : null, reporting: n, total: total };
  }

  // Sum of latest outflows from projects whose outflow reading is fresh (<= staleHours).
  function totalRelease(snap, now) {
    var sum = 0, n = 0;
    projects.forEach(function (p) {
      var d = snap && snap.projects[p.id];
      var o = d && latest(d.out);
      if (!o || freshness(o.t, now) !== 'fresh') return;
      n++;
      sum += o.v;
    });
    return { cfs: n ? sum : null, reporting: n, total: projects.length };
  }

  function cToF(c) { return c == null ? null : (c * 9) / 5 + 32; }

  return {
    meta: {
      title: 'Willamette Valley Hydro Dispatch',
      notice: 'Live data from USGS and USACE; provisional, not official.',
      disclaimer: 'Not an official agency site; not affiliated with USGS, USACE or BPA.'
    },
    SETTINGS: SETTINGS,
    // Shared HTTP helper for the other modules (js/cwms-levels.js, js/nwps.js).
    http: { fetchJson: fetchJson, cwmsAccept: CWMS_ACCEPT, cwmsBase: 'https://cwms-data.usace.army.mil/cwms-data/' },
    PARAM: PARAM,
    endpoints: { usgs: USGS_IV, cwms: CWMS_TS, cwmsAccept: CWMS_ACCEPT, usacePortal: USACE_PORTAL },
    stations: stations,
    projects: projects,
    basinMap: basinMap,
    usgsUrl: usgsUrl,
    cwmsUrl: cwmsUrl,
    parseUsgs: parseUsgs,
    fetchCwms: fetchCwms,
    limit: limit,
    RANGE_DAYS: RANGE_DAYS,
    bucketMean: bucketMean,
    loadHistory: loadHistory,
    loadAll: loadAll,
    latest: latest,
    atOrBefore: atOrBefore,
    interpolate: interpolate,
    freshness: freshness,
    ageHours: ageHours,
    percentFull: percentFull,
    ruleToday: ruleToday,
    reservoirStatus: reservoirStatus,
    stationStatus: stationStatus,
    stationPrimary: stationPrimary,
    basinStorage: basinStorage,
    totalRelease: totalRelease,
    cToF: cToF
  };
});
