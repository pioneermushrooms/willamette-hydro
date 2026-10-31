/*
 * Long-range history for the rule-curve views (Trend Recorder and Teacup chart): 30 D, 6 MO, 1 YR.
 *
 * Reservoirs (pool elevation, ft):
 *   30 D   USACE CWMS <P>.Elev-Forebay.Inst.0.0.MIXED-REV (15-min, same series as the live view)
 *   6 MO,  USGS daily values, parameter 62614 (lake elevation, observation at 24:00) at the
 *   1 YR   USGS lake gage for the project. Same datum as CWMS (checked: within ±0.06 ft).
 *          CWMS publishes no public daily/hourly pool series, and a year of 15-min CWMS data
 *          is ~35,000 points per lake, so daily USGS values keep this fast. If USGS fails,
 *          CWMS 15-min data is fetched in monthly chunks and reduced to 6-hour means.
 *   Rule curve: CWMS <P>.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC for the whole window.
 * Rivers: USGS IV (30 D, as reported) or USGS daily means (statCd 00003; 6 MO, 1 YR).
 *
 * Results are cached for 30 minutes per point and range.
 * Browser: window.HYDRO.history. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.history = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var HOUR = 3600 * 1000, DAY = 24 * HOUR;
  var TZ = 'America/Los_Angeles';
  var USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
  var USGS_DV = 'https://waterservices.usgs.gov/nwis/dv/';
  var RANGES = { '30d': 30, '6m': 182, '1y': 365 };
  var LAKE_SITE = { HCR: '14145100', LOP: '14149000', DEX: '14149500', GPR: '14186100', CGR: '14159400', FRN: '14168000', COT: '14153000', DOR: '14155000' };
  var TTL = 30 * 60 * 1000;
  var cache = {};

  // UTC offset (ms) of Pacific time at instant t.
  var fOff = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  function pacificOffset(t) {
    var o = {};
    fOff.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute) - Math.floor(t / 60000) * 60000;
  }
  // Pacific local midnight that starts calendar day y-m-d (m 1-based).
  function pacificMidnight(y, m, d) {
    var guess = Date.UTC(y, m - 1, d, 8);
    return Date.UTC(y, m - 1, d) - pacificOffset(guess);
  }
  // USGS DV dateTime "2026-10-29T00:00:00.000" (local date, no zone) -> epoch ms.
  // atEnd: value is an observation at 24:00 (end of that day) rather than a daily mean (stamped at noon).
  function dvTime(s, atEnd) {
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    return atEnd ? pacificMidnight(y, m, d + 1) : pacificMidnight(y, m, d) + 12 * HOUR;
  }

  // Mean of the values in each fixed bucket of `ms`; point stamped at the bucket centre.
  function bucketMean(s, ms) {
    var out = { t: [], v: [] };
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

  // USGS JSON -> { <param>: {t, v} } for one site. dv: daily-value response.
  function parseUsgs(j, dv) {
    var out = {};
    ((j && j.value && j.value.timeSeries) || []).forEach(function (ts) {
      var code = ts.variable.variableCode[0].value, nd = ts.variable.noDataValue;
      var opt = (((ts.variable.options || {}).option || [])[0] || {}).value || '';
      var atEnd = dv && /24:00/.test(opt);
      var s = { t: [], v: [] };
      (ts.values || []).forEach(function (b) {
        (b.value || []).forEach(function (p) {
          var v = parseFloat(p.value), t = dv ? dvTime(p.dateTime, atEnd) : Date.parse(p.dateTime);
          if (isFinite(v) && isFinite(t) && v !== nd && v > -999999) { s.t.push(t); s.v.push(v); }
        });
      });
      if (s.t.length && (!out[code] || s.t.length > out[code].t.length)) out[code] = s;
    });
    return out;
  }

  // Month boundaries (Pacific) inside [start, end] — x-axis ticks for 6 MO / 1 YR.
  function monthTicks(start, end) {
    var o = {}, out = [];
    fOff.formatToParts(new Date(start)).forEach(function (p) { o[p.type] = p.value; });
    var y = +o.year, m = +o.month;
    for (var i = 0; i < 26; i++) {
      var t = pacificMidnight(y, m, 1);
      if (t > end) break;
      if (t >= start) out.push({ t: t, y: y, m: m });
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Pacific midnights inside [start, end]; weekly=true keeps Mondays only.
  function dayTicks(start, end, weekly) {
    var out = [], o = {};
    fOff.formatToParts(new Date(start)).forEach(function (p) { o[p.type] = p.value; });
    var y = +o.year, m = +o.month, d = +o.day;
    for (var i = 0; i < 400; i++) {
      var t = pacificMidnight(y, m, d + i);
      if (t > end) break;
      if (t < start) continue;
      var dow = new Date(t + 12 * HOUR + pacificOffset(t)).getUTCDay();
      if (!weekly || dow === 1) out.push({ t: t, dow: dow });
    }
    return out;
  }

  function limit(n) {
    var active = 0, queue = [];
    function next() {
      if (active >= n || !queue.length) return;
      active++;
      var job = queue.shift();
      job.fn().then(job.ok, job.no).then(function () { active--; next(); });
    }
    return function (fn) { return new Promise(function (ok, no) { queue.push({ fn: fn, ok: ok, no: no }); next(); }); };
  }

  function cwmsChunks(spec, start, end) {
    var run = limit(4), chunks = [];
    for (var b = start; b < end; b += 31 * DAY) chunks.push([b, Math.min(end, b + 31 * DAY)]);
    var parts = [];
    return Promise.all(chunks.map(function (c, i) {
      return run(function () { return H.fetchCwms(spec, c[0], c[1]); }).then(function (s) { parts[i] = bucketMean(s, 6 * HOUR); });
    })).then(function () {
      var s = { t: [], v: [] };
      parts.forEach(function (p) { s.t = s.t.concat(p.t); s.v = s.v.concat(p.v); });
      return s;
    });
  }

  // Appends live points newer than the history's last point (one per hour).
  function appendLive(hist, live) {
    if (!live || !live.t || !live.t.length) return hist;
    var last = hist.t.length ? hist.t[hist.t.length - 1] : -Infinity;
    var tail = { t: [], v: [] };
    for (var i = 0; i < live.t.length; i++) if (live.t[i] > last) { tail.t.push(live.t[i]); tail.v.push(live.v[i]); }
    // Last actual reading in each hour (real timestamps, so "latest" never points into the future).
    var bt = [], bv = [];
    for (var j = 0; j < tail.t.length; j++) {
      var k = Math.floor(tail.t[j] / HOUR);
      if (bt.length && Math.floor(bt[bt.length - 1] / HOUR) === k) { bt[bt.length - 1] = tail.t[j]; bv[bv.length - 1] = tail.v[j]; }
      else { bt.push(tail.t[j]); bv.push(tail.v[j]); }
    }
    return { t: hist.t.concat(bt), v: hist.v.concat(bv), liveFrom: bt.length ? bt[0] : null };
  }

  /*
   * e: a HYDRO project or station. Resolves { range, start, end, pool|flow|stage|tempC, rule, src, error }.
   * Never rejects. `live` (optional): the project's live 7-day elevation series to append.
   */
  function load(e, range, live, now) {
    now = now || Date.now();
    var days = RANGES[range];
    if (!days) return Promise.resolve({ range: range, error: 'unknown range' });
    var key = e.id + ':' + range, c = cache[key];
    if (c && now - c.at < TTL) return c.p;
    var start = now - days * DAY, out = { range: range, start: start, end: now, error: null };
    var p;
    if (e.kind === 'reservoir') {
      var site = LAKE_SITE[e.code];
      var poolP;
      if (range === '30d' || !site) {
        poolP = range === '30d'
          ? H.fetchCwms(e.series.elev, start, now).then(function (s) { out.pool = s; out.src = 'USACE CWMS ' + e.series.elev.name + ' (15-min)'; })
          : cwmsChunks(e.series.elev, start, now).then(function (s) { out.pool = s; out.src = 'USACE CWMS ' + e.series.elev.name + ' (6-hour means)'; });
      } else {
        poolP = H.http.fetchJson(USGS_DV + '?format=json&sites=' + site + '&parameterCd=62614&startDT=' + new Date(start - DAY).toISOString().slice(0, 10) + '&siteStatus=all', {}, 30000, 2)
          .then(function (j) {
            var s = parseUsgs(j, true)['62614'];
            if (!s || s.t.length < 10) throw new Error('USGS daily values empty');
            out.pool = appendLive(s, live);
            out.src = 'USGS ' + site + ' daily lake elevation (62614, 24:00 observation)' + (out.pool.liveFrom ? ' + CWMS live since ' : '');
          })
          .catch(function (err) {
            out.note = 'USGS daily values unavailable (' + err.message + '); using CWMS 15-min data as 6-hour means.';
            return cwmsChunks(e.series.elev, start, now).then(function (s) { out.pool = s; out.src = 'USACE CWMS ' + e.series.elev.name + ' (6-hour means)'; });
          });
      }
      var ruleP = H.fetchCwms(e.series.rule, start - DAY, now + DAY).then(function (s) { out.rule = s; }, function (err) { out.ruleError = err.message; });
      p = Promise.all([poolP, ruleP]).catch(function (err) { out.error = err.message || 'failed'; });
    } else {
      var url = range === '30d'
        ? USGS_IV + '?format=json&sites=' + e.site + '&parameterCd=00060,00065,00010&period=P30D&siteStatus=all'
        : USGS_DV + '?format=json&sites=' + e.site + '&parameterCd=00060,00065,00010&statCd=00003&startDT=' + new Date(start - DAY).toISOString().slice(0, 10) + '&siteStatus=all';
      p = H.http.fetchJson(url, {}, 45000, 2).then(function (j) {
        var r = parseUsgs(j, range !== '30d');
        out.flow = r['00060'] || null; out.stage = r['00065'] || null; out.tempC = r['00010'] || null;
        out.src = range === '30d' ? 'USGS IV (as reported)' : 'USGS daily means (statCd 00003)';
      }, function (err) { out.error = err.message || 'failed'; });
    }
    p = p.then(function () { out.fetchedAt = Date.now(); if (out.error) delete cache[key]; return out; });
    cache[key] = { at: now, p: p };
    return p;
  }

  return {
    RANGES: RANGES, LAKE_SITE: LAKE_SITE,
    pacificOffset: pacificOffset, pacificMidnight: pacificMidnight, dvTime: dvTime,
    bucketMean: bucketMean, parseUsgs: parseUsgs, monthTicks: monthTicks, dayTicks: dayTicks, appendLive: appendLive,
    load: load, _cache: cache
  };
});
