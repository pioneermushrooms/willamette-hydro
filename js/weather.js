/*
 * Basin precipitation for each USACE project: recent rain, rain/stop timing and the forecast.
 *
 *   Model (past + forecast): Open-Meteo forecast API (CORS *, no key), hourly precipitation
 *     (in, sum over the preceding hour), freezing level and 2 m temperature, at two points per
 *     project (near the dam and in the upper basin), averaged. Past hours are the weather model's
 *     own analysis/short-range forecast, NOT gauge or radar measurements.
 *       https://api.open-meteo.com/v1/forecast?latitude=a,b&longitude=c,d&hourly=precipitation,...
 *     Windows longer than 92 days: Open-Meteo archive (ERA5 reanalysis), daily sums, ~5-day lag.
 *   Measured: NRCS SNOTEL hourly accumulated precipitation (PREC) at the stations in the same
 *     basin (js/snotel.js list), where there are any. High-elevation gauges; they catch snow too.
 *
 * Basin points and drainage areas are approximate (hand-placed, rounded published areas); the
 * volume figure is rain that fell on the basin, not runoff.
 * Browser: window.HYDRO.weather. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? Object.assign({}, require('./data.js'), { snotel: require('./snotel.js') }) : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.weather = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var BASE = 'https://api.open-meteo.com/v1/forecast';
  var ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  var AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data';
  var HOUR = 3600000, DAY = 24 * HOUR;
  var TTL = 15 * 60000;
  var WET = 0.01;       // in/hr: an hour at or above this counts as raining
  var DRY_GAP = 6;      // hours: this many dry hours in a row separate two rain events
  var ACFT_PER_IN_SQMI = 53.33;   // 1 inch over 1 sq mi
  var CFS_DAY_ACFT = 1.9835;      // 1 cfs for 24 h

  // Two points per project: [near the dam], [upper basin]. Areas: drainage above the dam, sq mi (approx.).
  // snotel: basin name in js/snotel.js whose stations are compared (null = none in that basin).
  var BASINS = {
    HCR: { area: 389, pts: [[43.71, -122.42], [43.55, -122.28]], snotel: 'Middle Fork Willamette' },
    LOP: { area: 991, pts: [[43.80, -122.55], [43.62, -122.30]], snotel: 'Middle Fork Willamette' },
    DEX: { area: 996, pts: [[43.80, -122.55], [43.62, -122.30]], snotel: 'Middle Fork Willamette' },
    FAL: { area: 184, pts: [[43.95, -122.75], [43.93, -122.58]], snotel: 'Middle Fork Willamette' },
    GPR: { area: 277, pts: [[44.45, -122.55], [44.42, -122.35]], snotel: null },
    CGR: { area: 208, pts: [[44.13, -122.24], [43.98, -122.17]], snotel: 'McKenzie' },
    BLU: { area: 88, pts: [[44.17, -122.33], [44.23, -122.24]], snotel: 'McKenzie' },
    FRN: { area: 252, pts: [[44.12, -123.30], [44.00, -123.38]], snotel: null },
    COT: { area: 104, pts: [[43.72, -123.05], [43.62, -122.98]], snotel: 'Coast Fork Willamette' },
    DOR: { area: 265, pts: [[43.78, -122.96], [43.70, -122.75]], snotel: 'Coast Fork Willamette' }
  };
  var CODES = Object.keys(BASINS);

  function pointList(codes) {
    var lat = [], lon = [];
    codes.forEach(function (c) { BASINS[c].pts.forEach(function (p) { lat.push(p[0]); lon.push(p[1]); }); });
    return 'latitude=' + lat.join(',') + '&longitude=' + lon.join(',');
  }

  function url(codes, pastDays, fcDays) {
    return BASE + '?' + pointList(codes) + '&hourly=precipitation,freezing_level_height,temperature_2m,weather_code,is_day,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m' +
      '&precipitation_unit=inch&temperature_unit=fahrenheit&wind_speed_unit=mph&timeformat=unixtime&timezone=GMT' +
      '&past_days=' + (pastDays == null ? 3 : pastDays) + '&forecast_days=' + (fcDays == null ? 3 : fcDays);
  }

  function archiveUrl(code, start, end) {
    var d = function (t) { return new Date(t).toISOString().slice(0, 10); };
    return ARCHIVE + '?' + pointList([code]) + '&daily=precipitation_sum&precipitation_unit=inch&timeformat=unixtime&timezone=GMT' +
      '&start_date=' + d(start) + '&end_date=' + d(end);
  }

  // Average the points of each project. key: 'hourly' | 'daily'. -> { CODE: { t[], p[], fz[], temp[] } }
  function parse(j, codes, key) {
    var arr = Array.isArray(j) ? j : [j], out = {}, k = 0;
    key = key || 'hourly';
    codes.forEach(function (c) {
      var n = BASINS[c].pts.length, parts = arr.slice(k, k + n).filter(function (x) { return x && x[key] && x[key].time; });
      k += n;
      if (!parts.length) return;
      var base = parts[0][key], s = { t: [], p: [], fz: [], temp: [], wc: [], day: [], cc: [], ws: [], wg: [], wd: [] };
      var pk = key === 'daily' ? 'precipitation_sum' : 'precipitation';
      var avg = function (name, i, scale) {
        var sum = 0, m = 0;
        parts.forEach(function (x) { var v = x[key][name] && x[key][name][i]; if (v != null && isFinite(v)) { sum += +v; m++; } });
        return m ? (sum / m) * (scale || 1) : null;
      };
      base.time.forEach(function (ts, i) {
        var p = avg(pk, i);
        if (p == null) return;
        s.t.push(ts * 1000); s.p.push(Math.max(0, p));
        s.fz.push(avg('freezing_level_height', i, 3.28084)); s.temp.push(avg('temperature_2m', i));
        // Weather code: the most significant of the points (WMO codes rise with severity).
        var wc = null;
        parts.forEach(function (x) { var c = x[key].weather_code && x[key].weather_code[i]; if (c != null && isFinite(c) && (wc == null || +c > wc)) wc = +c; });
        s.wc.push(wc); s.day.push(parts[0][key].is_day ? parts[0][key].is_day[i] : null); s.cc.push(avg('cloud_cover', i));
        // Wind (mph, 10 m): mean speed of the points, the highest gust, and the vector-mean direction.
        var gust = null, ux = 0, uy = 0, nd = 0;
        parts.forEach(function (x) {
          var g = x[key].wind_gusts_10m && x[key].wind_gusts_10m[i], d = x[key].wind_direction_10m && x[key].wind_direction_10m[i], sp = x[key].wind_speed_10m && x[key].wind_speed_10m[i];
          if (g != null && isFinite(g) && (gust == null || +g > gust)) gust = +g;
          if (d != null && isFinite(d)) { var wgt = sp != null && isFinite(sp) ? Math.max(+sp, 0.1) : 1; ux += wgt * Math.sin(d * Math.PI / 180); uy += wgt * Math.cos(d * Math.PI / 180); nd++; }
        });
        s.ws.push(avg('wind_speed_10m', i)); s.wg.push(gust); s.wd.push(nd ? (Math.atan2(ux, uy) * 180 / Math.PI + 360) % 360 : null);
      });
      out[c] = s;
    });
    return out;
  }

  function sumBetween(s, a, b) {   // hours stamped in (a, b]
    var x = 0;
    for (var i = 0; i < s.t.length; i++) if (s.t[i] > a && s.t[i] <= b) x += s.p[i];
    return x;
  }

  /*
   * Rain picture at `now` from one hourly series:
   *   past6/past24/past72, next6/next24/next72 (in), rateNow (in in the latest complete hour),
   *   raining (any wet hour in the last 2 h), event: { start, end (null while ongoing), total },
   *   nextStart (first wet hour ahead when dry now), ends (first hour followed by DRY_GAP dry
   *   hours, forecast, while raining), fzNow (ft), tempNow (°F).
   */
  function summarize(s, now, area) {
    if (!s || !s.t.length) return null;
    var iNow = -1;
    for (var i = 0; i < s.t.length; i++) if (s.t[i] <= now) iNow = i;
    if (iNow < 0) return null;
    var r = {
      past6: sumBetween(s, now - 6 * HOUR, now), past24: sumBetween(s, now - DAY, now), past72: sumBetween(s, now - 3 * DAY, now),
      next6: sumBetween(s, now, now + 6 * HOUR), next24: sumBetween(s, now, now + DAY), next72: sumBetween(s, now, now + 3 * DAY),
      rateNow: s.p[iNow], tNow: s.t[iNow], fzNow: s.fz[iNow], tempNow: s.temp[iNow],
      wcNow: s.wc ? s.wc[iNow] : null, dayNow: s.day ? s.day[iNow] : null, ccNow: s.cc ? s.cc[iNow] : null,
      wind: windSummary(s, iNow, now),
      raining: s.p[iNow] >= WET || (iNow > 0 && s.p[iNow - 1] >= WET),
      event: null, nextStart: null, ends: null, horizon: s.t[s.t.length - 1]
    };
    // Most recent event at or before now: walk back to the last wet hour, then to the start of its run.
    var last = -1;
    for (i = iNow; i >= 0 && s.t[i] > now - 3 * DAY; i--) if (s.p[i] >= WET) { last = i; break; }
    if (last >= 0) {
      var start = last, dry = 0;
      for (i = last - 1; i >= 0; i--) {
        if (s.p[i] >= WET) { start = i; dry = 0; } else if (++dry >= DRY_GAP) break;
      }
      var ongoing = iNow - last < DRY_GAP;
      var tot = 0;
      for (i = start; i <= iNow; i++) tot += s.p[i];
      // A run that begins at the first hour returned may have started earlier.
      r.event = { start: s.t[start] - HOUR, end: ongoing ? null : s.t[last], total: tot, openStart: start === 0 && dry < DRY_GAP };
    }
    // Forecast: when it ends (if raining) or next starts (if dry).
    if (r.event && !r.event.end) {
      var lastWet = iNow, d2 = 0;
      for (i = iNow + 1; i < s.t.length; i++) {
        if (s.p[i] >= WET) { lastWet = i; d2 = 0; } else if (++d2 >= DRY_GAP) break;
      }
      r.ends = d2 >= DRY_GAP ? s.t[lastWet] : null;   // null: still raining at the forecast horizon
    } else {
      for (i = iNow + 1; i < s.t.length; i++) if (s.p[i] >= WET) { r.nextStart = s.t[i] - HOUR; break; }
    }
    if (area) {
      r.area = area;
      r.vol24 = r.past24 * area * ACFT_PER_IN_SQMI;                 // ac-ft fell on the basin
      r.vol24cfs = r.vol24 / CFS_DAY_ACFT;                         // same, as a 24-h mean flow
      r.volNext24 = r.next24 * area * ACFT_PER_IN_SQMI;
      r.volNext24cfs = r.volNext24 / CFS_DAY_ACFT;
    }
    return r;
  }

  // NWS Portland wind criteria (reference for the colour only): advisory = sustained 31–39 mph or
  // gusts 46–57; high wind warning = sustained ≥ 40 or gusts ≥ 58.
  function windLevel(speed, gust) {
    if ((speed != null && speed >= 40) || (gust != null && gust >= 58)) return 'warning';
    if ((speed != null && speed >= 31) || (gust != null && gust >= 46)) return 'advisory';
    if (gust != null && gust >= 30) return 'breezy';
    return 'calm';
  }
  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(deg) { return deg == null ? '' : COMPASS[Math.round(deg / 22.5) % 16]; }

  // Wind now (latest complete hour), the strongest gust in the past 24 h, and the strongest in the
  // next 24 h and 72 h with their times.
  function windSummary(s, iNow, now) {
    if (!s.ws || iNow < 0 || s.ws[iNow] == null) return null;
    var peak = function (a, b) {
      var best = null;
      for (var i = 0; i < s.t.length; i++) if (s.t[i] > a && s.t[i] <= b && s.wg[i] != null && (!best || s.wg[i] > best.gust)) best = { gust: s.wg[i], t: s.t[i], speed: s.ws[i], dir: s.wd[i] };
      return best;
    };
    var w = { speed: s.ws[iNow], gust: s.wg[iNow], dir: s.wd[iNow], from: compass(s.wd[iNow]), past24: peak(now - DAY, now), next24: peak(now, now + DAY), next72: peak(now, now + 3 * DAY) };
    w.level = windLevel(w.speed, w.gust);
    if (w.next24) w.next24.level = windLevel(w.next24.speed, w.next24.gust);
    if (w.next72) w.next72.level = windLevel(w.next72.speed, w.next72.gust);
    return w;
  }

  /*
   * Current condition for the icon: { key, label } from the WMO weather code of the latest hour
   * (falling back to precipitation, temperature and cloud cover when there is no code).
   * keys: clear, partly, cloudy, fog, drizzle, rain, freezing, snow, thunder.
   */
  function condition(w) {
    if (!w) return null;
    var c = w.wcNow, night = w.dayNow === 0;
    var k = c == null ? null
      : c >= 95 ? 'thunder' : c === 85 || c === 86 || (c >= 71 && c <= 77) ? 'snow' : c === 56 || c === 57 || c === 66 || c === 67 ? 'freezing'
        : (c >= 61 && c <= 65) || (c >= 80 && c <= 82) ? 'rain' : c >= 51 && c <= 55 ? 'drizzle' : c === 45 || c === 48 ? 'fog'
          : c === 3 ? 'cloudy' : c === 2 || c === 1 ? 'partly' : 'clear';
    if (!k) k = w.rateNow >= WET ? (w.tempNow != null && w.tempNow <= 32 ? 'snow' : 'rain') : w.ccNow == null ? null : w.ccNow > 80 ? 'cloudy' : w.ccNow > 30 ? 'partly' : 'clear';
    if (!k) return null;
    var LABEL = { clear: night ? 'Clear' : 'Sunny', partly: 'Partly cloudy', cloudy: 'Cloudy', fog: 'Fog', drizzle: 'Drizzle', rain: 'Rain', freezing: 'Freezing rain', snow: 'Snow', thunder: 'Thunderstorms' };
    return { key: k, label: LABEL[k], night: night, wet: /drizzle|rain|freezing|snow|thunder/.test(k) };
  }

  // ---- SNOTEL hourly accumulated precipitation (measured) --------------------------------------

  // AWDB hourly dates are station local standard time (PST, UTC−8) as "YYYY-MM-DD HH:mm".
  function pstMs(d) { var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(String(d)); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4] + 8, +m[5]) : NaN; }

  function snotelUrl(triplets, now) {
    var t = now || Date.now(), d = function (x) { return new Date(x - 8 * HOUR).toISOString().slice(0, 10); };
    return AWDB + '?stationTriplets=' + triplets.join(',') + '&elements=PREC&duration=HOURLY&beginDate=' + d(t - 4 * DAY) + '&endDate=' + d(t + DAY);
  }

  // -> { triplet: { t[], acc[] } } (accumulated precipitation, in)
  function parseSnotel(j) {
    var out = {};
    (Array.isArray(j) ? j : []).forEach(function (st) {
      var s = { t: [], acc: [] };
      (st.data || []).forEach(function (d) {
        if (!d.stationElement || d.stationElement.elementCode !== 'PREC') return;
        (d.values || []).forEach(function (x) {
          var t = pstMs(x && x.date);
          if (x && x.value != null && isFinite(x.value) && isFinite(t)) { s.t.push(t); s.acc.push(+x.value); }
        });
      });
      out[st.stationTriplet] = s;
    });
    return out;
  }

  // Measured precipitation over the last `hours` from an accumulation series (gauge jitter clipped at 0).
  function accumDiff(s, now, hours) {
    if (!s || s.t.length < 2) return null;
    var iEnd = -1, iStart = -1;
    for (var i = 0; i < s.t.length; i++) { if (s.t[i] <= now) iEnd = i; if (s.t[i] <= now - hours * HOUR) iStart = i; }
    if (iEnd < 0 || iStart < 0 || s.t[iEnd] < now - 3 * HOUR) return null;
    return { v: Math.max(0, s.acc[iEnd] - s.acc[iStart]), t: s.t[iEnd] };
  }

  function stationsFor(code) {
    var b = BASINS[code], SN = H.snotel;
    return b && b.snotel && SN ? SN.STATIONS.filter(function (s) { return s.basin === b.snotel; }) : [];
  }

  // ---- Loading ------------------------------------------------------------------------------

  var cache = null, snoCache = null;

  // All projects, past 3 days + 3-day forecast. Never rejects: { fetchedAt, basins: { CODE: series }, error }.
  function load(opts) {
    opts = opts || {};
    if (!opts.force && cache && (cache.then || Date.now() - cache.fetchedAt < TTL)) return cache.then ? cache : Promise.resolve(cache);
    var p = H.http.fetchJson(url(CODES, 3, 3), {}, 30000, 2).then(function (j) {
      cache = { fetchedAt: Date.now(), basins: parse(j, CODES), error: null };
      return cache;
    }, function (err) { cache = null; return { fetchedAt: Date.now(), basins: {}, error: err.message || 'failed' }; });
    cache = p;
    return p;
  }

  // SNOTEL hourly PREC for every listed station. Never rejects: { fetchedAt, stations, error }.
  function loadSnotel(opts) {
    opts = opts || {};
    if (!H.snotel) return Promise.resolve({ fetchedAt: Date.now(), stations: {}, error: 'no SNOTEL list' });
    if (!opts.force && snoCache && (snoCache.then || Date.now() - snoCache.fetchedAt < TTL)) return snoCache.then ? snoCache : Promise.resolve(snoCache);
    var trip = H.snotel.STATIONS.map(function (s) { return s.triplet; });
    var p = H.http.fetchJson(snotelUrl(trip), {}, 30000, 2).then(function (j) {
      snoCache = { fetchedAt: Date.now(), stations: parseSnotel(j), error: null };
      return snoCache;
    }, function (err) { snoCache = null; return { fetchedAt: Date.now(), stations: {}, error: err.message || 'failed' }; });
    snoCache = p;
    return p;
  }

  // Strip series for one project over [start, end]: hourly (≤ 92 days back) or daily (archive).
  function loadRange(code, start, end) {
    var back = Math.ceil((Date.now() - start) / DAY) + 1;
    if (back <= 92) {
      return H.http.fetchJson(url([code], back, 1), {}, 45000, 2).then(function (j) {
        var s = parse(j, [code])[code];
        return { s: s, hourly: true, src: 'Open-Meteo weather model, hourly precipitation, basin mean of ' + BASINS[code].pts.length + ' points (model, not gauges)' };
      });
    }
    return H.http.fetchJson(archiveUrl(code, start, Math.min(end, Date.now() - DAY)), {}, 60000, 2).then(function (j) {
      var s = parse(j, [code], 'daily')[code];
      if (s) s.t = s.t.map(function (t) { return t + DAY; });   // daily sum stamped at the end of its day
      return { s: s, hourly: false, src: 'Open-Meteo archive (ERA5 reanalysis), daily precipitation, basin mean (model; ~5-day lag)' };
    });
  }

  function pageUrl(code) {
    var p = BASINS[code] && BASINS[code].pts[1];
    return p ? 'https://open-meteo.com/en/docs#latitude=' + p[0] + '&longitude=' + p[1] + '&hourly=precipitation&precipitation_unit=inch&past_days=3' : null;
  }
  function nwsUrl(code) {
    var p = BASINS[code] && BASINS[code].pts[1];
    return p ? 'https://forecast.weather.gov/MapClick.php?lat=' + p[0] + '&lon=' + p[1] : null;
  }

  return {
    BASE: BASE, BASINS: BASINS, CODES: CODES, WET: WET, DRY_GAP: DRY_GAP, ACFT_PER_IN_SQMI: ACFT_PER_IN_SQMI,
    url: url, archiveUrl: archiveUrl, parse: parse, summarize: summarize, sumBetween: sumBetween, condition: condition, windLevel: windLevel, compass: compass,
    snotelUrl: snotelUrl, parseSnotel: parseSnotel, accumDiff: accumDiff, stationsFor: stationsFor, pstMs: pstMs,
    load: load, loadSnotel: loadSnotel, loadRange: loadRange, pageUrl: pageUrl, nwsUrl: nwsUrl,
    _clear: function () { cache = null; snoCache = null; }
  };
});
