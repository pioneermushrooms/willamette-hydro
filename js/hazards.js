/*
 * Area hazards for the Overview status cards: wildfires and NWS alerts near the projects.
 *
 *   Wildfires: NIFC WFIGS "Incident Locations – Current" (ArcGIS Online feature service, CORS *),
 *     queried for a box around the southern Willamette basin. Each incident: name, type (wildfire
 *     or prescribed), acres, % contained, discovered, cause, county, last update.
 *       https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query
 *   Alerts: NWS api.weather.gov active alerts for Oregon (CORS *), kept when the alert area names a
 *     county or zone in the basin: Red Flag Warning, Fire Weather Watch, wind, winter, flood, etc.
 *
 * Distances are to the nearest USACE project point (js/weather.js basin points), great-circle.
 * toSchematic(lat, lon) places a point on the Basin Schematic (affine fit through the dams).
 * Browser: window.HYDRO.hazards. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? Object.assign({}, require('./data.js'), { weather: require('./weather.js') }) : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.hazards = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';
  var NWS = 'https://api.weather.gov/alerts/active?area=OR';
  var BOX = { xmin: -124.1, ymin: 43.0, xmax: -121.4, ymax: 44.9 };   // southern Willamette basin and the Cascades crest
  var NEAR_MI = 60;                                                    // fires within this distance of a project are listed
  var TTL = 10 * 60000;
  // NWS alert areas (counties / forecast zones) that cover the projects' basins.
  var AREA_RE = /\b(Lane|Linn|Douglas)\b|Willamette|Cascade|Eugene|Springfield|Oakridge|McKenzie|Cottage Grove|Santiam|Coast Range/i;

  function fireUrl() {
    return WFIGS + '?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' +
      '&geometry=' + encodeURIComponent([BOX.xmin, BOX.ymin, BOX.xmax, BOX.ymax].join(','));
  }

  function miles(lat1, lon1, lat2, lon2) {
    var R = 3958.8, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r),
      x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  // Project dam points (first basin point of each project).
  function projectPoints() {
    var W = H.weather, out = [];
    (H.projects || []).forEach(function (p) { var b = W && W.BASINS[p.code]; if (b) out.push({ code: p.code, name: p.name, lat: b.pts[0][0], lon: b.pts[0][1] }); });
    return out;
  }

  function pick(a, names) { for (var i = 0; i < names.length; i++) if (a[names[i]] != null && a[names[i]] !== '') return a[names[i]]; return null; }
  function toMs(v) { if (v == null) return null; var n = typeof v === 'number' ? v : Date.parse(v); return isFinite(n) ? n : null; }

  // ArcGIS JSON -> [{ name, type, acres, contained, discovered, cause, county, updated, lat, lon, near: { code, name, mi, dir } }]
  function parseFires(j, now) {
    var pts = projectPoints(), W = H.weather;
    return ((j && j.features) || []).map(function (f) {
      var a = f.attributes || {}, g = f.geometry || {};
      var lat = g.y, lon = g.x;
      if (lat == null || lon == null) { lat = pick(a, ['InitialLatitude', 'POOLatitude']); lon = pick(a, ['InitialLongitude', 'POOLongitude']); }
      if (lat == null || lon == null) return null;
      var typ = String(pick(a, ['IncidentTypeCategory', 'IncidentTypeKind']) || '').toUpperCase();
      var near = null;
      pts.forEach(function (p) { var d = miles(p.lat, p.lon, lat, lon); if (!near || d < near.mi) near = { code: p.code, name: p.name, mi: d, dir: W ? W.compass(bearing(p.lat, p.lon, lat, lon)) : '' }; });
      return {
        id: pick(a, ['UniqueFireIdentifier', 'IrwinID', 'GlobalID', 'OBJECTID']),
        name: String(pick(a, ['IncidentName', 'IncidentShortDescription']) || 'Unnamed fire').trim(),
        type: typ === 'RX' ? 'prescribed' : 'wildfire',
        acres: pick(a, ['IncidentSize', 'DailyAcres', 'CalculatedAcres', 'DiscoveryAcres']),
        contained: pick(a, ['PercentContained']),
        discovered: toMs(pick(a, ['FireDiscoveryDateTime'])),
        cause: pick(a, ['FireCause', 'FireCauseGeneral']),
        county: pick(a, ['POOCounty']), state: pick(a, ['POOState']),
        updated: toMs(pick(a, ['ModifiedOnDateTime_dt', 'ModifiedOnDateTime'])),
        out: toMs(pick(a, ['FireOutDateTime'])),
        lat: +lat, lon: +lon, near: near
      };
    }).filter(function (x) { return x && !x.out && x.near && x.near.mi <= NEAR_MI; })
      .sort(function (a, b) { return a.near.mi - b.near.mi; });
  }

  // NWS GeoJSON -> alerts whose area mentions the basin; [{ event, severity, headline, area, onset, ends, url, fire }]
  function parseAlerts(j) {
    return ((j && j.features) || []).map(function (f) { return f.properties || {}; })
      .filter(function (p) { return AREA_RE.test(p.areaDesc || '') && p.status !== 'Test'; })
      .map(function (p) {
        return {
          event: p.event, severity: p.severity, headline: p.headline || p.event, area: p.areaDesc,
          onset: toMs(p.onset || p.effective), ends: toMs(p.ends || p.expires), url: p['@id'] || p.id || null,
          fire: /red flag|fire weather/i.test(p.event || '')
        };
      });
  }

  // Overall fire status for the card: { level: 'ok'|'watch'|'alert', fires, rx, fireAlerts }
  function fireStatus(fires, alerts) {
    var wf = (fires || []).filter(function (f) { return f.type === 'wildfire'; }), rx = (fires || []).filter(function (f) { return f.type === 'prescribed'; });
    var fa = (alerts || []).filter(function (a) { return a.fire; });
    var level = wf.some(function (f) { return f.near.mi <= 25; }) || fa.some(function (a) { return /red flag/i.test(a.event); }) ? 'alert' : wf.length || fa.length ? 'watch' : 'ok';
    return { level: level, fires: wf, rx: rx, fireAlerts: fa };
  }

  /*
   * Lat/lon -> Basin Schematic x/y (js/data.js basinMap; not to scale). Least-squares affine fit
   *   x = a0 + a1*u + a2*v,  y = b0 + b1*u + b2*v,   u = (lon - lon0) * cos(lat0), v = lat - lat0
   * through the 10 USACE project dams: each dam's first basin point (js/weather.js BASINS) paired
   * with its node on the schematic. Lookout Point and Dexter share one lat/lon but have two nodes;
   * least squares simply puts that point between them. Built once, on first use.
   */
  var fit = null;
  function solve3(A, b) {   // Gaussian elimination with partial pivoting; A 3x3, b length 3
    var M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < 3; c++) {
      var piv = c;
      for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (var r2 = c + 1; r2 < 3; r2++) { var f = M[r2][c] / M[c][c]; for (var k = c; k < 4; k++) M[r2][k] -= f * M[c][k]; }
    }
    var x = [0, 0, 0];
    for (var i = 2; i >= 0; i--) { var s = M[i][3]; for (var j = i + 1; j < 3; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }
  function schematicFit() {
    if (fit) return fit;
    var W = H.weather, pairs = [];
    (H.projects || []).forEach(function (p) { var b = W && W.BASINS[p.code]; if (b && p.map) pairs.push({ code: p.code, lat: b.pts[0][0], lon: b.pts[0][1], x: p.map.x, y: p.map.y }); });
    if (pairs.length < 3) return null;
    var lat0 = 0, lon0 = 0;
    pairs.forEach(function (q) { lat0 += q.lat / pairs.length; lon0 += q.lon / pairs.length; });
    var k = Math.cos(lat0 * Math.PI / 180), uv = function (lat, lon) { return [1, (lon - lon0) * k, lat - lat0]; };
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    pairs.forEach(function (q) {
      var r = uv(q.lat, q.lon);
      for (var i = 0; i < 3; i++) { bx[i] += r[i] * q.x; by[i] += r[i] * q.y; for (var j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; }
    });
    var cx = solve3(A, bx), cy = solve3(A, by);
    if (!cx || !cy) return null;
    var f = function (lat, lon) { var r = uv(lat, lon); return { x: cx[0] + cx[1] * r[1] + cx[2] * r[2], y: cy[0] + cy[1] * r[1] + cy[2] * r[2] }; };
    var res = pairs.map(function (q) { var p = f(q.lat, q.lon); return { code: q.code, dx: p.x - q.x, dy: p.y - q.y, d: Math.hypot(p.x - q.x, p.y - q.y) }; });
    // Local correction: near a dam, pull the point by that dam's residual so a fire 3 mi from a
    // project is drawn next to its node; it fades out with distance (half at ~CORR_MI from the
    // nearest dam), so far points follow the plain affine fit. Duplicate points (LOP/DEX) average.
    var corr = function (lat, lon) {
      var w0 = 1 / (CORR_MI * CORR_MI), sw = w0, sx = 0, sy = 0;
      pairs.forEach(function (q, i) {
        var dm = 69 * Math.hypot((lon - q.lon) * k, lat - q.lat), w = 1 / (dm * dm + 0.25);
        sw += w; sx -= w * res[i].dx; sy -= w * res[i].dy;
      });
      return { x: sx / sw, y: sy / sw };
    };
    fit = { affine: f, cx: cx, cy: cy, lat0: lat0, lon0: lon0, residuals: res,
      rms: Math.sqrt(res.reduce(function (s, r) { return s + r.d * r.d; }, 0) / res.length),
      f: function (lat, lon) { var p = f(lat, lon), c = corr(lat, lon); return { x: p.x + c.x, y: p.y + c.y }; } };
    return fit;
  }
  var CORR_MI = 12;
  // { x, y } in schematic viewBox units (may fall outside the viewBox), or null if the fit failed.
  // opts.affine: the plain least-squares fit, without the local correction near the dams.
  function toSchematic(lat, lon, opts) {
    var F = schematicFit();
    if (!F || lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
    return (opts && opts.affine ? F.affine : F.f)(+lat, +lon);
  }

  var cache = null;
  // Never rejects: { fetchedAt, fires, firesError, alerts, alertsError }
  function load(opts) {
    opts = opts || {};
    if (!opts.force && cache && (cache.then || Date.now() - cache.fetchedAt < TTL)) return cache.then ? cache : Promise.resolve(cache);
    var out = { fetchedAt: null, fires: [], firesError: null, alerts: [], alertsError: null };
    var fp = H.http.fetchJson(fireUrl(), {}, 30000, 2).then(function (j) {
      if (j && j.error) throw new Error(j.error.message || 'ArcGIS error');
      out.fires = parseFires(j, Date.now());
    }, function (e) { out.firesError = e.message || 'failed'; });
    var ap = H.http.fetchJson(NWS, { headers: { Accept: 'application/geo+json' } }, 30000, 2).then(function (j) { out.alerts = parseAlerts(j); },
      function (e) { out.alertsError = e.message || 'failed'; });
    var p = Promise.all([fp, ap]).then(function () {
      out.fetchedAt = Date.now();
      cache = out.firesError && out.alertsError ? null : out;
      return out;
    });
    cache = p;
    return p;
  }

  return {
    WFIGS: WFIGS, NWS: NWS, BOX: BOX, NEAR_MI: NEAR_MI, fireUrl: fireUrl, miles: miles, bearing: bearing,
    parseFires: parseFires, parseAlerts: parseAlerts, fireStatus: fireStatus, projectPoints: projectPoints, load: load,
    schematicFit: schematicFit, toSchematic: toSchematic,
    _clear: function () { cache = null; }
  };
});
