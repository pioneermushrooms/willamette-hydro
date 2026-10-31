/*
 * CWMS location levels (USACE CWMS Data API, office NWDP): fetch, compact, cache,
 * and evaluate constant and seasonal levels client-side.
 *
 * Why client-side: the single-level evaluate endpoint (/levels/<id>?effective-date=)
 * returns HTTP 500 for seasonal levels, so we take the list endpoint
 * (/levels?office=NWDP&level-id-mask=<CODE>.*) and compute values ourselves.
 *
 * The raw response is ~550 KB per project; we keep only this project's own levels
 * (ids starting with "<CODE>." exactly; the mask also matches sub-locations such as
 * "LOP-BlackCanyon...") in a compact, unit-converted form, cached in memory and in
 * localStorage for 24 h.
 *
 * Values are PUBLISHED LEVELS / TARGETS, not live operating status.
 *
 * Browser: window.HYDRO.levels. Node: module.exports (used by check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.levels = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var TTL_MS = 24 * 3600 * 1000;
  var CACHE_PREFIX = 'wvhd:levels:v1:';
  var M_TO_FT = 1 / 0.3048;
  var CMS_TO_CFS = 35.3147;
  var M3_TO_ACFT = 1 / 1233.48184;

  var memory = {};

  // ---- Units -----------------------------------------------------------------

  // Converts a CWMS level value to display units: m -> ft, cms -> cfs, m3 -> ac-ft.
  // Other units (e.g. C, %) pass through unchanged.
  function convert(value, unit) {
    if (value == null) return { v: null, unit: unit };
    switch (unit) {
      case 'm': return { v: value * M_TO_FT, unit: 'ft' };
      case 'cms': return { v: value * CMS_TO_CFS, unit: 'cfs' };
      case 'm3': return { v: value * M3_TO_ACFT, unit: 'ac-ft' };
      default: return { v: value, unit: unit };
    }
  }

  function cToF(c) { return c == null ? null : (c * 9) / 5 + 32; }

  // 3 decimals is far below gauge precision and roughly halves the cached size.
  function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

  // ---- Compacting ------------------------------------------------------------

  /*
   * Compact form:
   *   { code, fetchedAt, levels: { "<suffix after CODE.>": [entry, ...] } }   entries sorted by date
   *   entry = { date: ms, unit, c: number }                                  (constant)
   *         | { date: ms, unit, s: { o: originMs, m: months, i: interpolate, p: [[offMonths, offMinutes, value|null], ...] } }
   * Values are already converted to display units.
   */
  function compact(json, code, fetchedAt) {
    var out = { code: code, fetchedAt: fetchedAt || Date.now(), levels: {} };
    var prefix = code + '.';
    ((json && json.levels) || []).forEach(function (l) {
      var id = l['location-level-id'];
      if (typeof id !== 'string' || id.indexOf(prefix) !== 0) return;
      var unit = l['level-units-id'];
      var date = Date.parse(l['level-date']);
      if (!unit || !isFinite(date)) return;
      var entry = { date: date, unit: convert(0, unit).unit };
      if (l['constant-value'] != null && isFinite(l['constant-value'])) {
        entry.c = r3(convert(+l['constant-value'], unit).v);
      } else if (Array.isArray(l['seasonal-values']) && l['seasonal-values'].length) {
        var origin = Date.parse(l['interval-origin']);
        var months = +l['interval-months'];
        if (!isFinite(origin) || !(months > 0)) return; // year-cycle levels only
        entry.s = {
          o: origin, m: months,
          i: String(l['interpolate-string'] || 'T').toUpperCase() !== 'F',
          p: l['seasonal-values'].map(function (sv) {
            var v = sv.value != null && isFinite(sv.value) ? r3(convert(+sv.value, unit).v) : null;
            return [+sv['offset-months'] || 0, +sv['offset-minutes'] || 0, v];
          })
        };
      } else {
        return; // no usable value (e.g. empty seasonal list)
      }
      var key = id.slice(prefix.length);
      (out.levels[key] = out.levels[key] || []).push(entry);
    });
    Object.keys(out.levels).forEach(function (k) { out.levels[k].sort(function (a, b) { return a.date - b.date; }); });
    return out;
  }

  // ---- Fetch + cache ---------------------------------------------------------

  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }

  function readCache(code, now) {
    var ls = storage();
    if (!ls) return null;
    try {
      var j = JSON.parse(ls.getItem(CACHE_PREFIX + code));
      if (j && j.code === code && now - j.fetchedAt < TTL_MS && j.levels) return j;
    } catch (e) { /* corrupt entry */ }
    return null;
  }

  function writeCache(data) {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(CACHE_PREFIX + data.code, JSON.stringify(data)); } catch (e) { /* quota: memory cache still works */ }
  }

  function levelsUrl(code, page) {
    return H.http.cwmsBase + 'levels?office=NWDP&level-id-mask=' + encodeURIComponent(code + '.*') + '&page-size=500' +
      (page ? '&page=' + encodeURIComponent(page) : '');
  }

  /*
   * Fetches (or returns cached) compact levels for one project code (e.g. 'LOP').
   * opts.force: bypass caches. Rejects only if the network fails after 3 tries.
   */
  function fetchProjectLevels(code, opts) {
    opts = opts || {};
    var now = Date.now();
    if (!opts.force) {
      var m = memory[code];
      if (m && (m.then || now - m.fetchedAt < TTL_MS)) return m.then ? m : Promise.resolve(m);
      var c = readCache(code, now);
      if (c) { memory[code] = c; return Promise.resolve(c); }
    }
    var all = { levels: [] }, guard = 0;
    var page = function (cursor) {
      return H.http.fetchJson(levelsUrl(code, cursor), { headers: { Accept: H.http.cwmsAccept } }, 45000, 3).then(function (j) {
        all.levels = all.levels.concat(j.levels || []);
        if (j['next-page'] && ++guard < 10) return page(j['next-page']);
        return all;
      });
    };
    var p = page(null).then(function (raw) {
      var data = compact(raw, code, Date.now());
      memory[code] = data;
      writeCache(data);
      return data;
    }, function (err) {
      delete memory[code];
      throw err;
    });
    memory[code] = p;
    return p;
  }

  // Cached levels only (memory or localStorage), never fetches — for optional overlays.
  function peekProjectLevels(code) {
    var m = memory[code];
    if (m && !m.then) return m;
    var c = readCache(code, Date.now());
    if (c) memory[code] = c;
    return c;
  }

  // ---- Evaluation ------------------------------------------------------------

  function addMonthsUTC(ms, k) {
    var d = new Date(ms);
    d.setUTCMonth(d.getUTCMonth() + k);
    return d.getTime();
  }

  // Latest entry whose level-date <= date (versions of the same level id).
  function pick(data, suffix, date) {
    var list = data && data.levels && data.levels[suffix];
    if (!list) return null;
    var t = +(date == null ? Date.now() : date), best = null;
    for (var i = 0; i < list.length; i++) if (list[i].date <= t) best = list[i];
    return best;
  }

  // Start of the interval cycle containing t.
  function cycleStart(s, t) {
    var a = new Date(s.o), b = new Date(t);
    var monthsBetween = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    var k = Math.floor(monthsBetween / s.m);
    var start = addMonthsUTC(s.o, k * s.m);
    while (start > t) { k--; start = addMonthsUTC(s.o, k * s.m); }
    while (addMonthsUTC(s.o, (k + 1) * s.m) <= t) { k++; start = addMonthsUTC(s.o, k * s.m); }
    return start;
  }

  // Absolute knot times for the cycle starting at `start`.
  function knots(s, start) {
    return s.p.map(function (pt) { return { t: addMonthsUTC(start, pt[0]) + pt[1] * 60000, v: pt[2] }; });
  }

  /*
   * Value of a seasonal level at `date`. Each knot sits at
   *   cycleStart + offset-months + offset-minutes,
   * cycles repeat every interval-months from interval-origin. Between consecutive knots
   * the value is interpolated linearly (or held, if interpolate-string is "F"); knots
   * without a value are gaps: any span touching a gap is null (target not applicable).
   * The pattern wraps: before the first knot we use the previous cycle's last knot.
   * Accepts a compact entry ({s: ...}) or a constant entry ({c: ...}).
   */
  function evalSeasonal(entry, date) {
    if (!entry) return null;
    if (entry.c != null) return entry.c;
    var s = entry.s;
    if (!s || !s.p.length) return null;
    var t = +(date == null ? Date.now() : date);
    var start = cycleStart(s, t);
    var cur = knots(s, start);
    var prevCycle = knots(s, addMonthsUTC(start, -s.m));
    var nextCycle = knots(s, addMonthsUTC(start, s.m));
    var seq = prevCycle.concat(cur, nextCycle);
    var j = -1;
    for (var i = 0; i < seq.length; i++) if (seq[i].t <= t) j = i;
    if (j < 0 || j >= seq.length - 1) return null;
    var a = seq[j], b = seq[j + 1];
    if (a.t === t) return a.v;
    if (a.v == null) return null;
    if (!s.i) return a.v;
    if (b.v == null) return null;
    if (b.t === a.t) return a.v;
    return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }

  // Effective value of a level id at `date` (latest version <= date), constant or seasonal.
  function valueAt(data, suffix, date) {
    var e = pick(data, suffix, date);
    return e ? evalSeasonal(e, date) : null;
  }

  // Effective constant level (null if the effective version is seasonal or missing).
  function constantAt(data, suffix, date) {
    var e = pick(data, suffix, date);
    return e && e.c != null ? e.c : null;
  }

  /*
   * Polyline of a seasonal level between t0 and t1 for charting: knots inside the window
   * plus interpolated end points; a null value means "break the line here".
   * Returns [[t, v|null], ...].
   */
  function seasonalSeries(entry, t0, t1) {
    if (!entry) return [];
    if (entry.c != null) return [[t0, entry.c], [t1, entry.c]];
    var s = entry.s, out = [[t0, evalSeasonal(entry, t0)]];
    var start = cycleStart(s, t0);
    for (var k = 0; k < 40; k++) {
      var cs = addMonthsUTC(start, k * s.m);
      if (cs > t1) break;
      knots(s, cs).forEach(function (kn) {
        if (kn.t > t0 && kn.t < t1) {
          // a gap knot breaks the line; a valued knot is a vertex
          out.push([kn.t, kn.v]);
          if (kn.v != null && !s.i) out.push([kn.t + 1, kn.v]);
        }
      });
    }
    out.push([t1, evalSeasonal(entry, t1)]);
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  // Common level ids (suffix after "<CODE>.").
  var IDS = {
    streambed: 'Elev.Inst.0.Streambed',
    bottomCons: 'Elev.Inst.0.Bottom of Conservation',
    topCons: 'Elev.Inst.0.Top of Conservation',
    topFlood: 'Elev.Inst.0.Top of Flood',
    topMaxFlood: 'Elev.Inst.0.Top of Max Flood',
    spillwayCrest: 'Elev.Inst.0.Spillway Crest',
    topDam: 'Elev.Inst.0.Top of Dam',
    bottomPower: 'Elev.Inst.0.Bottom of Power',
    topPower: 'Elev.Inst.0.Top of Power',
    topOperating: 'Elev.Inst.0.Top of Operating',
    injunctionTarget: 'Elev-Forebay.Inst.0.Injunction-Target',
    interimRisk: 'Elev.Inst.0.Interim Risk Reduction Measure',
    odeqTemp: 'Temp-Water.Inst.0.ODEQ-2006TMDL-Target',
    statsAve: 'Elev-Forebay.Ave.1Day.CENWP-30year-thru2023-STATS',
    statsMin: 'Elev-Forebay.Min.1Day.CENWP-30year-thru2023-STATS',
    statsMax: 'Elev-Forebay.Max.1Day.CENWP-30year-thru2023-STATS',
    statsP05: 'Elev-Forebay-05Percentile.Const.1Day.CENWP-30year-thru2023-STATS',
    statsP25: 'Elev-Forebay-25Percentile.Const.1Day.CENWP-30year-thru2023-STATS',
    statsP75: 'Elev-Forebay-75Percentile.Const.1Day.CENWP-30year-thru2023-STATS',
    statsP95: 'Elev-Forebay-95Percentile.Const.1Day.CENWP-30year-thru2023-STATS'
  };

  return {
    IDS: IDS,
    TTL_MS: TTL_MS,
    convert: convert,
    cToF: cToF,
    compact: compact,
    levelsUrl: levelsUrl,
    fetchProjectLevels: fetchProjectLevels,
    peekProjectLevels: peekProjectLevels,
    pick: pick,
    evalSeasonal: evalSeasonal,
    valueAt: valueAt,
    constantAt: constantAt,
    seasonalSeries: seasonalSeries,
    _clearMemory: function () { memory = {}; }
  };
});
