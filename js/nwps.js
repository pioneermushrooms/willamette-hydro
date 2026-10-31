/*
 * NOAA National Water Prediction Service (NWPS) — flood categories, observed flood
 * category and the NWS river forecast (issued by NWRFC) for the site's USGS gauges.
 *
 *   https://api.water.noaa.gov/nwps/v1/gauges/<LID>                     thresholds, status, crests
 *   https://api.water.noaa.gov/nwps/v1/gauges/<LID>/stageflow/forecast  ~6-hourly stage (ft) + flow (kcfs)
 *
 * Both send Access-Control-Allow-Origin: *. Thresholds are read live, never hardcoded.
 * Sentinels: undefined thresholds are -9999, missing values -999; anything <= -900 is "none".
 * A forecast with issuedTime 0001-01-01 and no data means "no forecast for this gauge".
 *
 * Browser: window.HYDRO.nwps. Node: module.exports (used by check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.nwps = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var BASE = 'https://api.water.noaa.gov/nwps/v1/gauges/';
  var TTL_MS = 10 * 60 * 1000;
  var DAY = 24 * 3600 * 1000;
  var CATS = ['action', 'minor', 'moderate', 'major'];
  var LABEL = { none: 'No flooding', action: 'Action', minor: 'Minor', moderate: 'Moderate', major: 'Major' };

  // Station id (js/data.js) -> NWS location id. null: NWPS publishes no flood
  // stages or forecast for that gauge (Coburg/MRGO3 returns -9999 everywhere).
  var LIDS = {
    'willamette-eugene': 'EUGO3',
    'willamette-harrisburg': 'HARO3',
    'mckenzie-vida': 'VIDO3',
    'mckenzie-coburg': null,
    'middle-fork-jasper': 'JASO3',
    'coast-fork-goshen': 'GOSO3'
  };

  var memory = {};

  function num(v) { return v == null || !isFinite(v) || v <= -900 ? null : +v; }

  // Flow in cfs from a value + unit ('kcfs' or 'cfs').
  function toCfs(v, unit) {
    var n = num(v);
    if (n == null) return null;
    return /^kcfs$/i.test(unit || '') ? n * 1000 : n;
  }

  function gaugeUrl(lid) { return 'https://water.noaa.gov/gauges/' + lid; }

  // NWPS floodCategory strings -> 'none' | 'action' | 'minor' | 'moderate' | 'major' | null.
  // 'not_defined', 'fcst_not_current', 'obs_not_current' etc. map to null (no category).
  function normCategory(s) {
    var k = String(s || '').toLowerCase();
    if (k === 'no_flooding') return 'none';
    return CATS.indexOf(k) >= 0 ? k : null;
  }

  // Category for a stage from live thresholds (DERIVED by this site).
  function categoryFor(stage, th) {
    if (stage == null || !th) return null;
    var cat = null, any = false;
    CATS.forEach(function (c) {
      if (th[c] && th[c].stage != null) { any = true; if (stage >= th[c].stage) cat = c; }
    });
    return any ? cat || 'none' : null;
  }

  function parseGauge(j) {
    var cats = (j && j.flood && j.flood.categories) || {};
    var th = {}, has = false;
    CATS.forEach(function (c) {
      var o = cats[c] || {};
      th[c] = { stage: num(o.stage), flow: num(o.flow) };
      if (th[c].stage != null) has = true;
    });
    var obs = (j && j.status && j.status.observed) || {};
    var fst = (j && j.status && j.status.forecast) || {};
    var crests = ((j && j.flood && j.flood.crests && j.flood.crests.historic) || [])
      .map(function (c) { return { t: Date.parse(c.occurredTime), stage: num(c.stage), flow: num(c.flow) || null, preliminary: c.preliminary }; })
      .filter(function (c) { return c.stage != null && isFinite(c.t); })
      .sort(function (a, b) { return b.stage - a.stage; });
    return {
      lid: j.lid, name: j.name, usgsId: j.usgsId, rfc: j.rfc && (j.rfc.abbreviation || j.rfc), wfo: j.wfo && (j.wfo.abbreviation || j.wfo),
      stageUnits: (j.flood && j.flood.stageUnits) || 'ft',
      thresholds: has ? th : null,
      observed: {
        t: Date.parse(obs.validTime) > 0 ? Date.parse(obs.validTime) : null,
        stage: num(obs.primary), flow: toCfs(obs.secondary, obs.secondaryUnit),
        category: normCategory(obs.floodCategory)
      },
      nwsForecastCategory: normCategory(fst.floodCategory),
      crests: crests.slice(0, 3)
    };
  }

  function parseForecast(j) {
    var issued = Date.parse(j && j.issuedTime);
    var data = (j && j.data) || [];
    if (!data.length || !(issued > Date.UTC(1971, 0, 1))) return null;
    var f = { issued: issued, t: [], stage: [], flow: [], units: j.primaryUnits || 'ft' };
    data.forEach(function (d) {
      var t = Date.parse(d.validTime);
      if (!isFinite(t)) return;
      f.t.push(t);
      f.stage.push(num(d.primary));
      f.flow.push(toCfs(d.secondary, j.secondaryUnits));
    });
    return f.t.length ? f : null;
  }

  // Highest forecast stage within `days` of now (default 7).
  function forecastPeak(g, now, days) {
    var f = g && g.forecast;
    if (!f) return null;
    var t0 = now || Date.now(), end = t0 + (days || 7) * DAY, best = null;
    for (var i = 0; i < f.t.length; i++) {
      // only forecast points after now (the first points can predate the page load)
      if (f.t[i] <= t0 || f.t[i] > end || f.stage[i] == null) continue;
      if (!best || f.stage[i] > best.stage) best = { t: f.t[i], stage: f.stage[i], flow: f.flow[i] };
    }
    if (best) best.category = categoryFor(best.stage, g.thresholds);
    return best;
  }

  /*
   * Loads one gauge (metadata + forecast). Resolves to a gauge object; rejects only when the
   * metadata request fails. A failed forecast request leaves forecast null with forecastError set.
   */
  function loadGauge(lid, opts) {
    opts = opts || {};
    var now = Date.now(), m = memory[lid];
    if (!opts.force && m && (m.then || now - m.fetchedAt < TTL_MS)) return m.then ? m : Promise.resolve(m);
    var meta = H.http.fetchJson(BASE + lid, {}, 20000, 3);
    var fc = H.http.fetchJson(BASE + lid + '/stageflow/forecast', {}, 20000, 3);
    var p = meta.then(function (j) {
      var g = parseGauge(j);
      g.lid = g.lid || lid;
      g.url = gaugeUrl(lid);
      return fc.then(function (f) { g.forecast = parseForecast(f); }, function (err) { g.forecast = null; g.forecastError = err.message; })
        .then(function () {
          g.fetchedAt = Date.now();
          g.peak = forecastPeak(g);
          memory[lid] = g;
          return g;
        });
    }, function (err) {
      fc.catch(function () {});
      delete memory[lid];
      throw err;
    });
    memory[lid] = p;
    return p;
  }

  // Loads every mapped gauge. Never rejects: { <stationId>: { lid, gauge, error } }.
  function loadAll(opts) {
    var out = {};
    var jobs = Object.keys(LIDS).map(function (id) {
      var lid = LIDS[id];
      out[id] = { lid: lid, gauge: null, error: null };
      if (!lid) return Promise.resolve();
      return loadGauge(lid, opts).then(function (g) { out[id].gauge = g; }, function (err) { out[id].error = err.message || 'failed'; });
    });
    return Promise.all(jobs).then(function () { return out; });
  }

  return {
    BASE: BASE,
    LIDS: LIDS,
    CATS: CATS,
    LABEL: LABEL,
    gaugeUrl: gaugeUrl,
    normCategory: normCategory,
    categoryFor: categoryFor,
    parseGauge: parseGauge,
    parseForecast: parseForecast,
    forecastPeak: forecastPeak,
    loadGauge: loadGauge,
    loadAll: loadAll,
    _clearMemory: function () { memory = {}; }
  };
});
