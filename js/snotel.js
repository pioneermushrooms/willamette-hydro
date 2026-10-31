/*
 * SNOTEL snowpack (NRCS Air & Water Database REST API; CORS *).
 *   GET https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data
 *       ?stationTriplets=<id:OR:SNTL,...>&elements=WTEQ,SNWD&duration=DAILY&beginDate=&endDate=
 *   -> [{ stationTriplet, data:[{ stationElement:{elementCode, storedUnitCode}, values:[{date, value}] }] }]
 * WTEQ = snow water equivalent (in), SNWD = snow depth (in). Daily values; the latest day is
 * usually yesterday. Zero is a real reading and is shown as 0. Median normals are not shown
 * (the API returned none in testing).
 *
 * Station list verified against /services/v1/stations on 2026-10-30 (names, elevations, HUCs).
 * Browser: window.HYDRO.snotel. Node: module.exports.
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.snotel = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var BASE = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data';
  var TTL_MS = 60 * 60 * 1000; // daily data: refetch at most hourly
  // basin from the station HUC (HUC-8 17090001 Middle Fork, 17090002 Coast Fork, 17090004 McKenzie)
  var STATIONS = [
    { triplet: '388:OR:SNTL', name: 'Cascade Summit', elevFt: 5100, huc: '170900010301', basin: 'Middle Fork Willamette' },
    { triplet: '729:OR:SNTL', name: 'Salt Creek Falls', elevFt: 4220, huc: '170900010301', basin: 'Middle Fork Willamette' },
    { triplet: '710:OR:SNTL', name: 'Railroad Overpass', elevFt: 2680, huc: '170900010302', basin: 'Middle Fork Willamette' },
    { triplet: '529:OR:SNTL', name: 'Holland Meadows', elevFt: 4930, huc: '170900020201', basin: 'Coast Fork Willamette' },
    { triplet: '719:OR:SNTL', name: 'Roaring River', elevFt: 4960, huc: '170900040302', basin: 'McKenzie' },
    { triplet: '619:OR:SNTL', name: 'McKenzie', elevFt: 4770, huc: '170900040207', basin: 'McKenzie' },
    { triplet: '1166:OR:SNTL', name: 'Bear Grass', elevFt: 4720, huc: '170900040203', basin: 'McKenzie' },
    { triplet: '733:OR:SNTL', name: 'Santiam Jct.', elevFt: 3740, huc: '170900040201', basin: 'McKenzie' }
  ];

  function ymd(t) { return new Date(t).toISOString().slice(0, 10); }

  function url(days, now) {
    var t1 = now || Date.now();
    return BASE + '?stationTriplets=' + STATIONS.map(function (s) { return s.triplet; }).join(',') +
      '&elements=WTEQ,SNWD&duration=DAILY&beginDate=' + ymd(t1 - (days || 9) * 864e5) + '&endDate=' + ymd(t1);
  }

  // API response -> { <triplet>: { swe:{dates[], v[]}, depth:{dates[], v[]}, last: 'YYYY-MM-DD'|null } }
  function parse(j) {
    var out = {};
    (Array.isArray(j) ? j : []).forEach(function (st) {
      var o = { swe: { dates: [], v: [] }, depth: { dates: [], v: [] }, last: null };
      (st.data || []).forEach(function (d) {
        var code = d.stationElement && d.stationElement.elementCode;
        var key = code === 'WTEQ' ? 'swe' : code === 'SNWD' ? 'depth' : null;
        if (!key) return;
        (d.values || []).forEach(function (x) {
          if (x && x.value != null && isFinite(x.value) && x.date) { o[key].dates.push(String(x.date).slice(0, 10)); o[key].v.push(+x.value); }
        });
      });
      var ls = o.swe.dates[o.swe.dates.length - 1] || null, ld = o.depth.dates[o.depth.dates.length - 1] || null;
      o.last = ls && ld ? (ls > ld ? ls : ld) : ls || ld;
      out[st.stationTriplet] = o;
    });
    return out;
  }

  var cache = null;

  // Never rejects: { fetchedAt, stations: {...}, error }.
  function load(opts) {
    opts = opts || {};
    if (!opts.force && cache && (cache.then || Date.now() - cache.fetchedAt < TTL_MS)) return cache.then ? cache : Promise.resolve(cache);
    var p = H.http.fetchJson(url(9, opts.now), {}, 30000, 3).then(function (j) {
      cache = { fetchedAt: Date.now(), stations: parse(j), error: null };
      return cache;
    }, function (err) {
      cache = null;
      return { fetchedAt: Date.now(), stations: {}, error: err.message || 'failed' };
    });
    cache = p;
    return p;
  }

  return { BASE: BASE, STATIONS: STATIONS, url: url, parse: parse, load: load, _clear: function () { cache = null; } };
});
