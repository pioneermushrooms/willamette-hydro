/*
 * Published rating tables: USACE CWMS reservoir ratings (elevation–storage, elevation–area,
 * spillway, gated outlets) and USGS stage–discharge ("exsa") ratings.
 *
 * These are PUBLISHED RATINGS, not live data. Fetched lazily, one at a time, with 3 tries,
 * then cached (compact arrays) in memory and localStorage for 7 days.
 *
 *   CWMS: GET /ratings/<encodeURIComponent(id)>?office=NWDP  (Accept: application/json;version=2)
 *         simple-rating is an object OR an array (several effective dates; use the latest
 *         effective-date <= today); rating-points is {point:[{ind,dep}]} (1-D) or an array of
 *         {other-ind:{position,value}, point:[...]} (2-D); numbers are strings.
 *   USGS: https://nwis.waterdata.usgs.gov/nwisweb/get_ratings?site_no=<site>&file_type=exsa
 *         RDB text: '#' comments, header "INDEP SHIFT DEP STOR", a format row, then rows.
 *         INDEP is the gage height; DEP is the discharge USGS computes for that gage height
 *         with the current shift already applied (verified against live NWIS discharge at
 *         five sites). SHIFT is shown for information only.
 *
 * Browser: window.HYDRO.ratings. Node: module.exports.
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.ratings = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var CWMS = 'https://cwms-data.usace.army.mil/cwms-data/ratings/';
  var USGS = 'https://nwis.waterdata.usgs.gov/nwisweb/get_ratings?file_type=exsa&site_no=';
  var TTL_MS = 7 * 24 * 3600 * 1000;
  var CACHE_PREFIX = 'wvhd:rating:v1:';
  var CODES = ['LOP', 'HCR', 'DEX', 'GPR', 'CGR', 'FRN', 'COT', 'DOR'];

  // ---- Catalog (verified live 2026-10-30) --------------------------------------
  // Ratings that CWMS lists but answers with HTTP 500 are recorded as unavailable.

  var GROUPS = [
    { id: 'storage', label: 'Reservoir elevation–storage' },
    { id: 'area', label: 'Reservoir elevation–area' },
    { id: 'outlet', label: 'Spillway / outlet' },
    { id: 'usgs', label: 'River stage–flow (USGS)' }
  ];

  var STRUCTURES = [
    { key: 'spillway', label: 'Spillway (free flow)', id: function (c) { return c + '-Spillway.Elev-Forebay;Flow-Free.Standard.CENWP'; },
      codes: CODES },
    { key: 'spillwayGated', label: 'Spillway gates (2-D)', id: function (c) { return c + '-Spillway.Opening,Elev-Forebay;Flow.Standard.CENWP'; },
      codes: ['LOP', 'HCR', 'DEX', 'GPR', 'CGR', 'FRN'] },
    { key: 'ro', label: 'Regulating outlets (2-D)', id: function (c) { return c + '-RegulatingOutlets.Opening,Elev-Forebay;Flow.Standard.CENWP'; },
      codes: ['LOP', 'HCR', 'GPR', 'FRN', 'COT', 'DOR'] },
    { key: 'roCgr', label: 'Regulating outlets (2-D)', id: function () { return 'CGR-RegOutlets.Opening,Elev-Forebay;Flow.Standard.CENWP'; }, codes: ['CGR'] },
    { key: 'ro1', label: 'Reg. outlets, 1 gate (2-D)', id: function () { return 'CGR-RegulatingOutlets-1Gate.Opening,Elev-Forebay;Flow.Standard.CENWP'; }, codes: ['CGR'] },
    { key: 'ro2', label: 'Reg. outlets, 2 gates (2-D)', id: function () { return 'CGR-RegulatingOutlets-2Gates.Opening,Elev-Forebay;Flow.Standard.CENWP'; }, codes: ['CGR'] },
    { key: 'sluice', label: 'Sluice gate (2-D)', id: function () { return 'FRN-SluiceGate.Opening,Elev-Forebay;Flow.Standard.CENWP'; }, codes: ['FRN'] }
  ];

  var UNAVAILABLE = {
    area: { DEX: 'No area rating published for DEX (CWMS answers HTTP 500).' },
    outlet: {},
    structures: {
      'DEX-RegulatingOutlets': 'listed in CWMS but returns HTTP 500',
      'COT-Spillway.Opening': 'listed in CWMS but returns HTTP 500',
      'DOR-Spillway.Opening': 'listed in CWMS but returns HTTP 500',
      'CGR-RegulatingOutlets.Opening': 'base id returns HTTP 500 (1-gate / 2-gate / RegOutlets variants shown)'
    }
  };

  var SITES = [
    { site: '14158050', name: 'Willamette at Eugene', note: 'USGS publishes no live discharge series for this gauge; this rating file (last shifted 2023) may not be in active use.' },
    { site: '14166000', name: 'Willamette at Harrisburg' },
    { site: '14162500', name: 'McKenzie near Vida' },
    { site: '14165500', name: 'McKenzie near Coburg' },
    { site: '14152000', name: 'Middle Fork Willamette at Jasper' },
    { site: '14157500', name: 'Coast Fork Willamette near Goshen' }
  ];

  function cwmsDefs(group, code) {
    if (group === 'storage') return [{ id: code + '.Elev-Forebay;Stor.Standard.CENWP', label: 'Elevation–storage', x: 'Elevation', xu: 'ft', y: 'Storage', yu: 'ac-ft' }];
    if (group === 'area') return UNAVAILABLE.area[code] ? [] : [{ id: code + '.Elev-Forebay;Area.Standard.CENWP', label: 'Elevation–area', x: 'Elevation', xu: 'ft', y: 'Area', yu: 'acres' }];
    return STRUCTURES.filter(function (s) { return s.codes.indexOf(code) >= 0; }).map(function (s) {
      return { id: s.id(code), key: s.key, label: s.label, x: 'Elevation', xu: 'ft', y: 'Flow', yu: 'cfs', o: 'Opening', ou: 'ft' };
    });
  }

  function allDefs() {
    var out = [];
    ['storage', 'area', 'outlet'].forEach(function (g) {
      CODES.forEach(function (c) { cwmsDefs(g, c).forEach(function (d) { out.push(Object.assign({ group: g, code: c, source: 'cwms' }, d)); }); });
    });
    SITES.forEach(function (s) { out.push(usgsDef(s.site)); });
    return out;
  }

  function usgsDef(site) {
    var s = SITES.filter(function (x) { return x.site === site; })[0];
    return { group: 'usgs', source: 'usgs', site: site, id: 'USGS-' + site + '-exsa', label: 'Stage–discharge', name: s && s.name, note: s && s.note,
      x: 'Gage height', xu: 'ft', y: 'Discharge', yu: 'cfs' };
  }

  function cwmsUrl(id) { return CWMS + encodeURIComponent(id) + '?office=NWDP'; }
  function usgsUrl(site) { return USGS + site; }

  // ---- Parsing -------------------------------------------------------------------

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  // Latest version with effective-date <= now (falls back to the earliest if all are future).
  function pickVersion(sr, now) {
    var arr = (Array.isArray(sr) ? sr : [sr]).filter(Boolean);
    if (!arr.length) return { r: null, n: 0 };
    var t = now == null ? Date.now() : now;
    var ok = arr.filter(function (r) { return Date.parse(r['effective-date']) <= t; });
    var pool = ok.length ? ok : arr;
    pool.sort(function (a, b) { return Date.parse(a['effective-date']) - Date.parse(b['effective-date']); });
    return { r: ok.length ? pool[pool.length - 1] : pool[0], n: arr.length };
  }

  function pointsOf(list) {
    var xs = [], ys = [];
    // a curve with a single point is serialized as an object, not a list
    (Array.isArray(list) ? list : list ? [list] : []).forEach(function (p) {
      var x = num(p.ind), y = num(p.dep);
      if (x != null && y != null) { xs.push(x); ys.push(y); }
    });
    var idx = xs.map(function (_, i) { return i; }).sort(function (a, b) { return xs[a] - xs[b]; });
    return { xs: idx.map(function (i) { return xs[i]; }), ys: idx.map(function (i) { return ys[i]; }) };
  }

  function median(a) { var b = a.slice().sort(function (p, q) { return p - q; }); return b.length ? b[Math.floor(b.length / 2)] : 0; }

  /*
   * Parses a CWMS rating response -> compact object:
   *   1-D: { kind:'1d', xs, ys, units, effective, created, versions, id }
   *   2-D: { kind:'2d', others:[opening...], curves:[{xs, ys}], transposed, ... }
   * For 2-D ratings the template says position 1 = Opening, 2 = Elevation. If the published
   * data has them swapped (other-ind values look like elevations, points like openings),
   * the grid is transposed into opening × elevation and `transposed` is set.
   */
  function parseCwms(j, now) {
    if (!j || !j['simple-rating']) throw new Error('no simple-rating in response');
    var pv = pickVersion(j['simple-rating'], now), r = pv.r;
    if (!r) throw new Error('empty rating');
    var base = {
      id: r['rating-spec-id'] || (j['rating-spec'] && j['rating-spec']['rating-spec-id']) || null,
      units: r['units-id'], effective: Date.parse(r['effective-date']) || null, created: Date.parse(r['create-date']) || null,
      versions: pv.n
    };
    var rp = r['rating-points'];
    if (rp && !Array.isArray(rp) && Array.isArray(rp.point)) {
      var p = pointsOf(rp.point);
      if (!p.xs.length) throw new Error('rating has no points');
      return Object.assign(base, { kind: '1d', xs: p.xs, ys: p.ys });
    }
    if (Array.isArray(rp) || (rp && rp['other-ind'])) {
      var blocks = Array.isArray(rp) ? rp : [rp];
      var others = [], curves = [];
      blocks.forEach(function (b) {
        var o = num(b['other-ind'] && b['other-ind'].value);
        var c = pointsOf(b.point);
        if (o != null && c.xs.length) { others.push(o); curves.push(c); }
      });
      if (!others.length) throw new Error('2-D rating has no curves');
      var allInd = [].concat.apply([], curves.map(function (c) { return c.xs; }));
      var transposed = median(others) > 5 * Math.max(1, median(allInd));
      if (transposed) {
        // rebuild as opening (other) x elevation (ind) grid
        var map = {};
        others.forEach(function (elev, i) {
          curves[i].xs.forEach(function (op, k) { (map[op] = map[op] || { xs: [], ys: [] }); map[op].xs.push(elev); map[op].ys.push(curves[i].ys[k]); });
        });
        others = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
        curves = others.map(function (op) {
          var m = map[op], idx = m.xs.map(function (_, i) { return i; }).sort(function (a, b) { return m.xs[a] - m.xs[b]; });
          return { xs: idx.map(function (i) { return m.xs[i]; }), ys: idx.map(function (i) { return m.ys[i]; }) };
        });
      }
      var order = others.map(function (_, i) { return i; }).sort(function (a, b) { return others[a] - others[b]; });
      return Object.assign(base, { kind: '2d', others: order.map(function (i) { return others[i]; }), curves: order.map(function (i) { return curves[i]; }), transposed: transposed });
    }
    throw new Error('unrecognised rating-points structure');
  }

  /*
   * Parses a USGS RDB "exsa" rating file -> { kind:'1d', xs (gage height), shift, ys (discharge),
   * ratingId, shifted, baseOnly, comments }. Returns xs.length === 0 when the file has no rows.
   */
  function parseUsgsRdb(text) {
    var lines = String(text || '').split(/\r?\n/), comments = [], hi = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].charAt(0) === '#') { comments.push(lines[i]); continue; }
      if (/^INDEP\t/.test(lines[i])) { hi = i; break; }
    }
    var out = { kind: '1d', xs: [], shift: [], ys: [], ratingId: null, shifted: null, baseOnly: false, comments: comments };
    var cm = comments.join('\n');
    var mId = cm.match(/RATING ID="([^"]+)"/); if (mId) out.ratingId = mId[1];
    var mSh = cm.match(/RATING SHIFTED="(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
    if (mSh) out.shifted = mSh[1] + '-' + mSh[2] + '-' + mSh[3];
    out.baseOnly = /does not include any shifts/i.test(cm);
    if (hi < 0) return out;
    var cols = lines[hi].split('\t'), ci = cols.indexOf('INDEP'), cs = cols.indexOf('SHIFT'), cd = cols.indexOf('DEP');
    // skip the RDB format row (e.g. "16N\t16N\t16N\t1S")
    for (var k = hi + 1; k < lines.length; k++) {
      var l = lines[k];
      if (!l.trim() || l.charAt(0) === '#' || /^\d+[NSD]\t/.test(l)) continue;
      var c = l.split('\t'), x = num(c[ci]), d = num(c[cd]);
      if (x == null || d == null) continue;
      out.xs.push(x); out.ys.push(d); out.shift.push(cs >= 0 ? num(c[cs]) || 0 : 0);
    }
    return out;
  }

  // ---- Interpolation ---------------------------------------------------------------

  function isMonotonic(a) {
    for (var i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return false;
    return a.length > 1;
  }

  // Linear interpolation; out of range -> { y: null, out: 'below' | 'above' }.
  function interp(xs, ys, x) {
    if (x == null || !isFinite(x) || !xs.length) return { y: null, out: null };
    if (x < xs[0]) return { y: null, out: 'below' };
    if (x > xs[xs.length - 1]) return { y: null, out: 'above' };
    var lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    if (xs[hi] === x) return { y: ys[hi], out: null };
    if (xs[lo] === x || xs[hi] === xs[lo]) return { y: ys[lo], out: null };
    return { y: ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]), out: null };
  }

  // Reverse lookup (dependent -> independent) when the dependent column is monotonic.
  function inverse(xs, ys, y) {
    if (!isMonotonic(ys)) return { x: null, out: null, notMonotonic: true };
    // skip leading flat runs so a value on a plateau maps to its first occurrence
    var r = interp(ys, xs, y);
    return { x: r.y, out: r.out, notMonotonic: false };
  }

  // 2-D: flow at (opening, elevation), linear between the bracketing opening curves.
  function interp2d(rt, opening, x) {
    var o = rt.others;
    if (opening == null || x == null) return { y: null, out: null };
    if (opening < o[0]) return { y: null, out: 'below-opening' };
    if (opening > o[o.length - 1]) return { y: null, out: 'above-opening' };
    var j = 0;
    while (j < o.length - 1 && o[j + 1] <= opening) j++;
    var a = interp(rt.curves[j].xs, rt.curves[j].ys, x);
    if (o[j] === opening || j === o.length - 1) return a;
    var b = interp(rt.curves[j + 1].xs, rt.curves[j + 1].ys, x);
    if (a.y == null || b.y == null) return { y: null, out: a.out || b.out };
    return { y: a.y + ((b.y - a.y) * (opening - o[j])) / (o[j + 1] - o[j]), out: null };
  }

  // Index of the row nearest to x (for "jump to lookup").
  function nearestIndex(xs, x) {
    if (!xs.length || x == null) return -1;
    var best = 0;
    for (var i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    return best;
  }

  // RFC 4180-ish CSV.
  function toCSV(headers, rows) {
    var q = function (v) {
      if (v == null) return '';
      var s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers].concat(rows).map(function (r) { return r.map(q).join(','); }).join('\r\n') + '\r\n';
  }

  // ---- Fetch + cache -------------------------------------------------------------------

  var memory = {};

  function storage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }

  function readCache(key) {
    var ls = storage();
    if (!ls) return null;
    try {
      var j = JSON.parse(ls.getItem(CACHE_PREFIX + key));
      if (j && Date.now() - j.fetchedAt < TTL_MS && j.data) return j;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeCache(key, entry) {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(CACHE_PREFIX + key, JSON.stringify(entry)); } catch (e) { /* quota: memory only */ }
  }

  function fetchText(url, tries) {
    var n = 0, max = tries || 3;
    var attempt = function () {
      n++;
      return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).catch(function (err) {
        if (/^HTTP 4/.test(err.message) || n >= max) throw err;
        return new Promise(function (res) { setTimeout(res, 1500 * n); }).then(attempt);
      });
    };
    return attempt();
  }

  /*
   * Loads one rating definition -> { data, fetchedAt, url, fromCache }.
   * opts.force bypasses caches.
   */
  function load(def, opts) {
    opts = opts || {};
    var key = def.id;
    if (!opts.force) {
      if (memory[key]) return memory[key].then ? memory[key] : Promise.resolve(memory[key]);
      var c = readCache(key);
      if (c) { c.fromCache = true; memory[key] = c; return Promise.resolve(c); }
    }
    var url = def.source === 'usgs' ? usgsUrl(def.site) : cwmsUrl(def.id);
    var p = (def.source === 'usgs'
      ? fetchText(url, 3).then(function (t) { return parseUsgsRdb(t); })
      : H.http.fetchJson(url, { headers: { Accept: H.http.cwmsAccept } }, 45000, 3).then(function (j) { return parseCwms(j); })
    ).then(function (data) {
      var entry = { data: data, fetchedAt: Date.now(), url: url };
      memory[key] = entry;
      writeCache(key, entry);
      return entry;
    }, function (err) {
      delete memory[key];
      throw err;
    });
    memory[key] = p;
    return p;
  }

  return {
    GROUPS: GROUPS, CODES: CODES, SITES: SITES, STRUCTURES: STRUCTURES, UNAVAILABLE: UNAVAILABLE, TTL_MS: TTL_MS,
    cwmsDefs: cwmsDefs, usgsDef: usgsDef, allDefs: allDefs, cwmsUrl: cwmsUrl, usgsUrl: usgsUrl,
    pickVersion: pickVersion, parseCwms: parseCwms, parseUsgsRdb: parseUsgsRdb,
    isMonotonic: isMonotonic, interp: interp, inverse: inverse, interp2d: interp2d, nearestIndex: nearestIndex, toCSV: toCSV,
    load: load, _clearMemory: function () { memory = {}; }
  };
});
