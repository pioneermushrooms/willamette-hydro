/*
 * Power outages in the basin, from the utilities' own public outage-map data (verified 2026-11-28
 * from GitHub Actions; all three send Access-Control-Allow-Origin: *, so the browser reads them live):
 *
 *   EWEB (Eugene)          ArcGIS feature service behind eweb.org's outage map (polygons per incident):
 *     https://services7.arcgis.com/6AM8yPAeyXiPc9eF/arcgis/rest/services/PublicOutageMap_Public_View/FeatureServer/0
 *     fields: incidentid, custcnt, ostart, etor, name, remarks, cause, status
 *   Lane Electric, Emerald PUD, Blachly-Lane   NISC Hosted Outage Map, refreshed each minute:
 *     https://outagemap-data.cloud.coop/<slug>/Hosted_Outage_Map/summary.json
 *       { totalServed, outages:[{ id, nbrOut, timeOff?, planned, x, y, comment? }], regionDataSets:[…], lastUpdate }
 *     x/y are metres east/north of the SW corner of config.json mapSettings.boundaryExtent (Web Mercator).
 *   BPA transmission (Eugene district / Willamette names): data/bpa-outages.json, copied from BPA's Daily
 *     Interruptions Report by GitHub Actions (scripts/fetch-bpa-outages.js; BPA sends no CORS).
 *
 * Not available: Pacific Power (map data not exposed on its pages), Springfield Utility Board (no
 * public map data), Consumers Power (web viewer with no documented feed).
 * Browser: window.HYDRO.outages. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.outages = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var EWEB = 'https://services7.arcgis.com/6AM8yPAeyXiPc9eF/arcgis/rest/services/PublicOutageMap_Public_View/FeatureServer/0';
  var NISC = 'https://outagemap-data.cloud.coop/';
  var COOPS = [
    { key: 'lane', slug: 'laneelectric', name: 'Lane Electric', map: 'https://laneelectric.outagemap.coop/' },
    { key: 'epud', slug: 'epud', name: 'Emerald PUD', map: 'https://epud.outagemap.coop/' },
    { key: 'blachly', slug: 'blachlylane', name: 'Blachly-Lane Electric', map: 'https://blachlylane.outagemap.coop/' }
  ];
  var BPA_FILE = 'data/bpa-outages.json';
  var TTL = 2 * 60000;
  // Card levels (this site's thresholds): watch when any single outage affects ≥ 10 customers or
  // ≥ 25 are out in total; alert at ≥ 250 in one outage or ≥ 500 in total, or an unplanned BPA line trip.
  var LEVEL = { incidentWatch: 10, totalWatch: 25, incidentAlert: 250, totalAlert: 500 };

  var R = 6378137;
  function mercToLonLat(x, y) { return { lon: x / R * 180 / Math.PI, lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI }; }
  function lonLatToMerc(lon, lat) { return { x: lon * Math.PI / 180 * R, y: R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) }; }

  function toMs(v) { if (v == null || v === '') return null; var n = typeof v === 'number' ? v : Date.parse(v); return isFinite(n) ? n : null; }

  // NISC summary + boundaryExtent -> utility record
  function parseNisc(coop, summary, extent) {
    var ex = extent || [0, 0];
    var inc = ((summary && summary.outages) || []).map(function (o) {
      var ll = mercToLonLat(ex[0] + (+o.x || 0), ex[1] + (+o.y || 0));
      return { id: o.id, n: +o.nbrOut || 0, start: toMs(o.timeOff), etr: toMs(o.etr || o.etor), planned: !!o.planned, cause: o.cause || null, comment: o.comment || null, lat: ll.lat, lon: ll.lon, area: null };
    });
    var regions = [];
    ((summary && summary.regionDataSets) || []).forEach(function (ds, i) {
      if (i > 0 && regions.length) return;   // first data set with outages (Township / Territory / Substation / Zip)
      (ds.regions || []).forEach(function (r) { if (r.numberOut > 0) regions.push({ name: titleCase(r.id), set: ds.description || ds.id, out: r.numberOut, served: r.numberServed }); });
    });
    return { key: coop.key, name: coop.name, map: coop.map, served: summary ? summary.totalServed : null, updated: summary ? toMs(summary.lastUpdate) : null,
      incidents: inc, regions: regions, out: inc.reduce(function (s, x) { return s + x.n; }, 0) };
  }

  function titleCase(s) { s = String(s || ''); return /^[A-Z0-9 .'-]+$/.test(s) && /[A-Z]{2}/.test(s) ? s.toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }) : s; }

  // EWEB ArcGIS (outSR 4326) -> utility record; incident location = mean of its polygon vertices.
  function parseEweb(j) {
    var inc = ((j && j.features) || []).map(function (f) {
      var a = f.attributes || {}, ring = f.geometry && f.geometry.rings && f.geometry.rings[0], lat = null, lon = null;
      if (ring && ring.length) { var sx = 0, sy = 0; ring.forEach(function (p) { sx += p[0]; sy += p[1]; }); lon = sx / ring.length; lat = sy / ring.length; }
      // ostart / etor are text fields in EWEB's layer (local time, format not documented): shown as published,
      // only treated as times when they are epoch numbers.
      var num = function (v) { return typeof v === 'number' || /^\d{11,13}$/.test(String(v || '')) ? +v : null; };
      return { id: a.incidentid || a.OBJECTID, n: +a.custcnt || 0, start: num(a.ostart), etr: num(a.etor), etrText: a.etor || null, startText: a.ostart || null, planned: /plan/i.test(a.status || ''),
        cause: a.cause || null, comment: a.remarks || null, status: a.status || null, area: a.name || null, lat: lat, lon: lon };
    });
    return { key: 'eweb', name: 'EWEB', map: 'https://www.eweb.org/outages-and-safety/power-outages/power-outage-map', served: null, updated: Date.now(),
      incidents: inc, regions: [], out: inc.reduce(function (s, x) { return s + x.n; }, 0) };
  }

  // Overall status for the card: { level, out, incidents, worst }
  function status(utilities, bpa) {
    var inc = [], out = 0;
    (utilities || []).forEach(function (u) { if (u && !u.error) { out += u.out; u.incidents.forEach(function (x) { inc.push(Object.assign({ utility: u.name }, x)); }); } });
    inc.sort(function (a, b) { return b.n - a.n; });
    var worst = inc[0] || null, bpaTrip = (bpa || []).some(function (b) { return b.stillOut && /auto/i.test(b.type) && /line/i.test(b.table); });
    var level = out >= LEVEL.totalAlert || (worst && worst.n >= LEVEL.incidentAlert) || bpaTrip ? 'alert'
      : out >= LEVEL.totalWatch || (worst && worst.n >= LEVEL.incidentWatch) ? 'watch' : 'ok';
    return { level: level, out: out, incidents: inc, worst: worst, bpaTrip: bpaTrip };
  }

  var extents = {}, cache = null;
  function loadCoop(c) {
    var ext = extents[c.slug] ? Promise.resolve(extents[c.slug]) : H.http.fetchJson(NISC + c.slug + '/Hosted_Outage_Map/config.json', {}, 20000, 1).then(function (cfg) {
      var e = cfg && cfg.mapSettings && (cfg.mapSettings.boundaryExtent || cfg.mapSettings.fullExtent);
      if (!e) throw new Error('no map extent');
      extents[c.slug] = e; return e;
    });
    return ext.then(function (e) {
      return H.http.fetchJson(NISC + c.slug + '/Hosted_Outage_Map/summary.json?t=' + Math.floor(Date.now() / 60000), {}, 20000, 1).then(function (s) { return parseNisc(c, s, e); });
    }).catch(function (err) { return { key: c.key, name: c.name, map: c.map, error: err.message || 'failed', incidents: [], regions: [], out: 0 }; });
  }

  // Never rejects: { fetchedAt, utilities: [...], bpa: { items, fetchedAt } | null, bpaError }
  function load(opts) {
    opts = opts || {};
    if (!opts.force && cache && (cache.then || Date.now() - cache.fetchedAt < TTL)) return cache.then ? cache : Promise.resolve(cache);
    var eweb = H.http.fetchJson(EWEB + '/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json', {}, 20000, 1).then(function (j) {
      if (j && j.error) throw new Error(j.error.message || 'ArcGIS error');
      return parseEweb(j);
    }).catch(function (err) { return { key: 'eweb', name: 'EWEB', error: err.message || 'failed', incidents: [], regions: [], out: 0, map: 'https://www.eweb.org/outages-and-safety/power-outages/power-outage-map' }; });
    var bpaUrl = (opts.bpaUrl || BPA_FILE) + '?t=' + Math.floor(Date.now() / 300000);
    var bpa = H.http.fetchJson(bpaUrl, { cache: 'no-store' }, 15000, 1).then(function (j) { return j; }, function () { return null; });
    var p = Promise.all([eweb].concat(COOPS.map(loadCoop)).concat([bpa])).then(function (r) {
      var b = r.pop();
      cache = { fetchedAt: Date.now(), utilities: r, bpa: b && b.items ? b : null, bpaError: b ? null : 'not available yet' };
      return cache;
    });
    cache = p;
    return p;
  }

  return {
    EWEB: EWEB, NISC: NISC, COOPS: COOPS, LEVEL: LEVEL, mercToLonLat: mercToLonLat, lonLatToMerc: lonLatToMerc,
    parseNisc: parseNisc, parseEweb: parseEweb, status: status, load: load, titleCase: titleCase,
    UNAVAILABLE: [
      { name: 'Pacific Power', why: 'its outage map data is not exposed on its public pages', map: 'https://www.pacificpower.net/outages-safety.html' },
      { name: 'Springfield Utility Board', why: 'no public outage map data', map: 'https://www.subutil.com/outages/' },
      { name: 'Consumers Power', why: 'outage viewer with no documented data feed', map: 'https://outage.cpi.coop/' }
    ],
    _clear: function () { cache = null; extents = {}; }
  };
});
