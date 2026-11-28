/*
 * NWRFC reservoir inflow forecasts (dashed line right of "now" on the Trend Recorder's
 * inflow / outflow strip).
 *
 *   data/inflow-fcst.json, copied every 30 minutes by GitHub Actions (scripts/fetch-inflow-fcst.js)
 *   from the NW River Forecast Center's text pages (nwrfc.noaa.gov sends no CORS headers):
 *   { fetchedAt, source, errors, projects: { CODE: { lid, name, issued (ISO), obs: [[ms, cfs]...],
 *     fcst: [[ms, cfs]...] (~6-hourly, ~10 days), page } } }
 *   Projects NWRFC does not forecast are simply absent.
 *
 * Browser: window.HYDRO.inflowFc. Node: module.exports (parse, for check.js).
 */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? null : root.HYDRO);
  if (node) module.exports = api;
  else root.HYDRO.inflowFc = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var FILE = 'data/inflow-fcst.json';
  var TTL = 5 * 60000;

  function pairs(a) {
    var s = { t: [], v: [] };
    (Array.isArray(a) ? a : []).forEach(function (p) {
      if (Array.isArray(p) && isFinite(p[0]) && p[1] != null && isFinite(p[1])) { s.t.push(+p[0]); s.v.push(+p[1]); }
    });
    var idx = s.t.map(function (_, i) { return i; }).sort(function (x, y) { return s.t[x] - s.t[y]; });
    return { t: idx.map(function (i) { return s.t[i]; }), v: idx.map(function (i) { return s.v[i]; }) };
  }

  // File -> { fetchedAt (ms), projects: { CODE: { lid, name, issued (ms|null), t, v, obs: { t, v }, page } }, errors }
  function parse(j) {
    var out = { fetchedAt: j && Date.parse(j.fetchedAt) || null, projects: {}, errors: (j && j.errors) || [] };
    var pr = (j && j.projects) || {};
    Object.keys(pr).forEach(function (code) {
      var p = pr[code] || {}, f = pairs(p.fcst);
      if (!f.t.length) return;
      out.projects[code] = { lid: p.lid || null, name: p.name || null, issued: Date.parse(p.issued) || null, t: f.t, v: f.v, obs: pairs(p.obs), page: p.page || null };
    });
    return out;
  }

  var cache = null;
  // Never rejects: { fetchedAt, projects, errors, error }.
  function load(opts) {
    opts = opts || {};
    if (!opts.force && cache && (cache.then || Date.now() - cache.at < TTL)) return cache.then ? cache : Promise.resolve(cache);
    var url = (opts.url || FILE) + '?t=' + Math.floor(Date.now() / 300000);
    var p = H.http.fetchJson(url, { cache: 'no-store' }, 15000, 1).then(function (j) {
      cache = parse(j); cache.at = Date.now(); cache.error = null;
      return cache;
    }, function (err) {
      cache = { at: Date.now(), fetchedAt: null, projects: {}, errors: [], error: err.message || 'failed' };
      return cache;
    });
    cache = p;
    return p;
  }

  return { FILE: FILE, parse: parse, load: load, _clear: function () { cache = null; } };
});
