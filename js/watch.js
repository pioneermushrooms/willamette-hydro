/*
 * Watch list — the text/number panel at the top of Overview for HCR, LOP, DEX and CGR:
 * pool elevation, today's rule curve, tailwater elevation and the downstream outflow
 * gage (HCRO, DEXO, CGRO), plus pool-vs-rule-curve trends (30 d, a calendar
 * month, 12 months). All values from the USACE CWMS Data API, office NWDP; provisional.
 *
 * Series:
 *   pool        <P>.Elev-Forebay.Inst.0.0.MIXED-REV            (same as js/data.js)
 *   rule curve  <P>.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC      (same as js/data.js)
 *   tailwater   <P>.Elev-Tailwater.*                            (resolved at runtime)
 *   outflow gage HCRO / DEXO / CGRO .Flow.*                     (resolved at runtime)
 * Lookout Point has no outflow gage (LOPO does not exist; it releases into Dexter
 * Reservoir), so its row shows the dam's own release from js/data.js instead.
 * Tailwater and gage ids are tried from CANDIDATES first; if none returns data, the CWMS
 * catalog is searched and the series with the most recent value is used. The id in use
 * is shown in each cell's tooltip and in the panel footer.
 *
 * Trends use daily means of the pool series (Pacific days) against that day's rule-curve
 * value. The year of pool data is loaded once in monthly chunks; afterwards only the last
 * two days are refetched, at most once an hour.
 *
 * Browser: window.HYDRO.watch. Node: module.exports (pure helpers, for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.watch = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var HOUR = 3600 * 1000;
  var DAY = 24 * HOUR;
  var TZ = 'America/Los_Angeles';
  var CODES = ['HCR', 'LOP', 'DEX', 'CGR'];
  var NAMES = { HCR: 'Hills Creek', LOP: 'Lookout Point', DEX: 'Dexter', CGR: 'Cougar' };
  var GAGE = { HCR: 'HCRO', DEX: 'DEXO', CGR: 'CGRO' };   // no LOPO
  var YEAR_DAYS = 400;          // covers the current month plus the 12 before it
  var LONG_REFRESH_MS = HOUR;   // trend data refresh
  var BELOW_FT = H.SETTINGS.ruleBelowFt;

  var CANDIDATES = {
    tail: function (c) { return [c + '.Elev-Tailwater.Inst.0.0.MIXED-REV', c + '.Elev-Tailwater.Inst.0.0.MIXED-RAW']; },
    gage: function (c) { var g = GAGE[c]; return [g + '.Flow.Inst.0.0.MIXED-REV', g + '.Flow.Inst.0.0.USGS-REV', g + '.Flow.Inst.15Minutes.0.USGS-REV']; }
  };
  var CATALOG_LIKE = {
    tail: function (c) { return '^' + c + '\\.Elev-Tailwater\\..*'; },
    gage: function (c) { return '^' + GAGE[c] + '\\.Flow\\..*'; }
  };
  var UNIT = { tail: 'ft', gage: 'cfs' };

  // ---- Pacific calendar helpers (pure) --------------------------------------

  var fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  // epoch ms -> 'YYYY-MM-DD' (Pacific)
  function dayKey(t) { return fmtKey.format(new Date(t)); }
  function monthKey(t) { return dayKey(t).slice(0, 7); }

  // 'YYYY-MM-DD' shifted by n days (calendar arithmetic, DST-safe).
  function addDays(key, n) {
    var p = key.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  // Last n day keys ending at `key`, oldest first.
  function lastDays(key, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(addDays(key, -i));
    return out;
  }

  // Day keys of calendar month 'YYYY-MM', clipped to <= maxKey.
  function monthDays(mk, maxKey) {
    var p = mk.split('-').map(Number), out = [];
    for (var d = 1; d <= 31; d++) {
      var k = new Date(Date.UTC(p[0], p[1] - 1, d)).toISOString().slice(0, 10);
      if (k.slice(0, 7) !== mk || (maxKey && k > maxKey)) break;
      out.push(k);
    }
    return out;
  }

  // The n month keys ending at month mk, oldest first.
  function lastMonths(mk, n) {
    var p = mk.split('-').map(Number), out = [];
    for (var i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(p[0], p[1] - 1 - i, 1)).toISOString().slice(0, 7));
    return out;
  }

  // ---- Aggregation (pure) ---------------------------------------------------

  // Series {t,v} -> { 'YYYY-MM-DD': {sum, n, min, max, first, last, lastT} }, merged into `into`.
  function aggregate(s, into) {
    var out = into || {};
    if (!s || !s.t) return out;
    for (var i = 0; i < s.t.length; i++) {
      var k = dayKey(s.t[i]), v = s.v[i], a = out[k];
      if (!a) a = out[k] = { sum: 0, n: 0, min: v, max: v, first: v, firstT: s.t[i], last: v, lastT: s.t[i] };
      a.sum += v; a.n++;
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      if (s.t[i] < a.firstT) { a.first = v; a.firstT = s.t[i]; }
      if (s.t[i] >= a.lastT) { a.last = v; a.lastT = s.t[i]; }
    }
    return out;
  }

  // Rule series (Pacific-midnight stamps) -> { dayKey: ft }.
  function ruleByDay(s) {
    var out = {};
    if (s && s.t) s.t.forEach(function (t, i) { out[dayKey(t)] = s.v[i]; });
    return out;
  }

  // One row per day: { day, pool (daily mean), rule, dev }; missing values are null.
  function dailyRows(days, agg, rules) {
    return days.map(function (k) {
      var a = agg && agg[k], pool = a ? a.sum / a.n : null;
      var rule = rules && rules[k] != null ? rules[k] : null;
      return { day: k, pool: pool, rule: rule, dev: pool != null && rule != null ? pool - rule : null };
    });
  }

  /*
   * Summary of a span of daily rows. Pool start/end are the first/last daily means in
   * the span; dev stats use days that have both a pool mean and a rule value.
   */
  function spanStats(rows) {
    var withPool = rows.filter(function (r) { return r.pool != null; });
    var withDev = rows.filter(function (r) { return r.dev != null; });
    var devs = withDev.map(function (r) { return r.dev; });
    var first = withPool[0], last = withPool[withPool.length - 1];
    var sum = devs.reduce(function (a, b) { return a + b; }, 0);
    return {
      days: rows.length, poolDays: withPool.length, devDays: devs.length,
      poolStart: first ? first.pool : null, poolEnd: last ? last.pool : null,
      poolChange: first && last ? last.pool - first.pool : null,
      poolMin: withPool.length ? Math.min.apply(null, withPool.map(function (r) { return r.pool; })) : null,
      poolMax: withPool.length ? Math.max.apply(null, withPool.map(function (r) { return r.pool; })) : null,
      devStart: withDev.length ? withDev[0].dev : null,
      devEnd: withDev.length ? withDev[withDev.length - 1].dev : null,
      devAvg: devs.length ? sum / devs.length : null,
      devMin: devs.length ? Math.min.apply(null, devs) : null,
      devMax: devs.length ? Math.max.apply(null, devs) : null,
      daysAbove: devs.filter(function (d) { return d > 0; }).length,
      daysBelow: devs.filter(function (d) { return d < -BELOW_FT; }).length
    };
  }

  // CWMS catalog entries -> best series name (most recent latest-time; Inst preferred on ties).
  function pickCatalog(entries) {
    var best = null, bestT = -Infinity;
    (entries || []).forEach(function (e) {
      if (!e || !e.name) return;
      var x = (e.extents && e.extents[0]) || {};
      var t = Date.parse(x['latest-time'] || '') || 0;
      if (/\.Inst\./.test(e.name)) t += 1;
      if (t > bestT) { best = e.name; bestT = t; }
    });
    return best;
  }

  // ---- Loading (browser) ----------------------------------------------------

  var run = H.limit ? H.limit(6) : null;
  function queue(fn) { return run ? run(fn) : fn(); }

  function catalogUrl(like) {
    return H.http.cwmsBase + 'catalog/TIMESERIES?office=NWDP&like=' + encodeURIComponent(like) + '&page-size=100';
  }

  // Resolves a tailwater/gage series name: candidates first, then the catalog.
  function resolve(kind, code, now) {
    var cands = CANDIDATES[kind](code), unit = UNIT[kind];
    var t1 = now, t0 = now - 2 * DAY;
    var i = 0;
    function next() {
      if (i >= cands.length) return fromCatalog();
      var name = cands[i++];
      return queue(function () { return H.fetchCwms({ name: name, unit: unit }, t0, t1); })
        .then(function (s) { return s.t.length ? { name: name, series: s } : next(); }, next);
    }
    function fromCatalog() {
      return H.http.fetchJson(catalogUrl(CATALOG_LIKE[kind](code)), { headers: { Accept: H.http.cwmsAccept } }, 30000, 2).then(function (j) {
        var name = pickCatalog(j && j.entries);
        if (!name) return { name: null, series: null, error: 'not published in CWMS' };
        return queue(function () { return H.fetchCwms({ name: name, unit: unit }, t0, t1); }).then(function (s) {
          return { name: name, series: s, error: s.t.length ? null : 'no recent data' };
        });
      }).catch(function (e) { return { name: null, series: null, error: e.message || 'catalog failed' }; });
    }
    return next();
  }

  var mem = {
    names: {},          // 'HCR:tail' -> resolved series name (or null)
    agg: {},            // code -> daily aggregates of the pool
    rules: {},          // code -> { dayKey: ft }
    longAt: 0,          // last trend refresh
    yearLoaded: {},     // code -> true once the full year is in
    current: {}         // code -> { tail: {name, series, error}, gage: {...} }
  };

  function loadPoint(kind, code, now) {
    var key = code + ':' + kind;
    if (key in mem.names) {
      var name = mem.names[key];
      if (!name) return Promise.resolve({ name: null, series: null, error: 'not published in CWMS' });
      return queue(function () { return H.fetchCwms({ name: name, unit: UNIT[kind] }, now - 2 * DAY, now); })
        .then(function (s) { return { name: name, series: s, error: s.t.length ? null : 'no recent data' }; },
          function (e) { return { name: name, series: null, error: e.message }; });
    }
    return resolve(kind, code, now).then(function (r) {
      if (r.name || r.error === 'not published in CWMS') mem.names[key] = r.name;
      return r;
    });
  }

  // Pool year in ~monthly, non-overlapping chunks (5-minute data: ~9k points each).
  function loadPoolYear(code, now) {
    var spec = { name: code + '.Elev-Forebay.Inst.0.0.MIXED-REV', unit: 'ft' };
    var start = now - YEAR_DAYS * DAY, chunks = [];
    for (var b = start; b < now; b += 31 * DAY) chunks.push([b, Math.min(now, b + 31 * DAY - 1)]);
    var agg = {};
    return Promise.all(chunks.map(function (c) {
      return queue(function () { return H.fetchCwms(spec, c[0], c[1]); }).then(function (s) { aggregate(s, agg); });
    })).then(function () { mem.agg[code] = agg; mem.yearLoaded[code] = true; });
  }

  // Refetch from the start of yesterday (Pacific) and replace those days.
  function loadPoolRecent(code, now) {
    var spec = { name: code + '.Elev-Forebay.Inst.0.0.MIXED-REV', unit: 'ft' };
    var y = addDays(dayKey(now), -1), b = now - 3 * DAY;
    return queue(function () { return H.fetchCwms(spec, b, now); }).then(function (s) {
      var fresh = aggregate(s), agg = mem.agg[code];
      Object.keys(fresh).forEach(function (k) { if (k >= y) agg[k] = fresh[k]; });
    });
  }

  function loadRule(code, now) {
    var spec = { name: code + '.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC', unit: 'ft' };
    return queue(function () { return H.fetchCwms(spec, now - YEAR_DAYS * DAY, now + 8 * DAY); })
      .then(function (s) { if (s.t.length) mem.rules[code] = ruleByDay(s); });
  }

  /*
   * Refreshes the current tailwater/gage values (every call) and the trend data (at most
   * hourly). Never rejects. Returns { errors: [...] }.
   */
  function refresh(now) {
    now = now || Date.now();
    var errors = [], jobs = [];
    CODES.forEach(function (code) {
      var cur = mem.current[code] || (mem.current[code] = {});
      (GAGE[code] ? ['tail', 'gage'] : ['tail']).forEach(function (kind) {
        jobs.push(loadPoint(kind, code, now).then(function (r) {
          // Keep the last good series if this request failed.
          if (!(r.series && r.series.t.length) && cur[kind] && cur[kind].series && cur[kind].series.t.length) return;
          cur[kind] = r;
        }));
      });
    });
    if (now - mem.longAt >= LONG_REFRESH_MS) {
      mem.longAt = now;
      CODES.forEach(function (code) {
        var pool = mem.yearLoaded[code] ? loadPoolRecent(code, now) : loadPoolYear(code, now);
        jobs.push(pool.catch(function (e) { errors.push(code + ' pool history: ' + e.message); mem.longAt = 0; }));
        jobs.push(loadRule(code, now).catch(function (e) { errors.push(code + ' rule curve: ' + e.message); mem.longAt = 0; }));
      });
    }
    return Promise.all(jobs).then(function () { return { errors: errors }; });
  }

  // ---- Rendering (browser) --------------------------------------------------

  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n, d) { return n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function signed(n, d) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n), d); }
  function devCls(d) { return d == null ? 'na' : d > H.SETTINGS.ruleAboveFt ? 'w-above' : d < -BELOW_FT ? 'w-below' : 'w-near'; }

  var fmtMon = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  var fmtMonShort = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
  var fmtDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  function monLabel(mk, short) { return (short ? fmtMonShort : fmtMon).format(new Date(mk + '-15T00:00:00Z')); }
  function dayLabel(k) { return fmtDay.format(new Date(k + 'T12:00:00Z')); }

  var ui = { span: '30d', month: null, root: null, stamp: null, loading: true, errors: [] };

  function projectOf(code) { return H.projects.filter(function (p) { return p.code === code; })[0]; }

  function poolNow(code) {
    var p = projectOf(code), snap = H.live && H.live.snap, d = snap && snap.projects[p.id];
    var e = d && H.latest(d.elev), r = d && H.ruleToday(d.rule);
    var rules = mem.rules[code], today = dayKey(Date.now());
    return { elev: e, rule: r ? r.v : rules && rules[today] != null ? rules[today] : null };
  }

  function cell(entry, d, unit, now) {
    var lab = ' data-label="' + (unit === 'ft' ? 'Tailwater' : 'Outflow gage') + '"';
    if (!entry) return '<td class="na"' + lab + '>' + (ui.loading ? '<span class="loading">loading…</span>' : '—') + '</td>';
    var s = entry.series, n = s ? s.t.length : 0;
    if (!n) return '<td class="na"' + lab + ' title="' + esc(entry.name || entry.error || '') + '">' + esc(entry.error || 'no data') + '</td>';
    var t = s.t[n - 1], stale = now - t > H.SETTINGS.staleHours * HOUR;
    return '<td' + lab + ' title="' + esc(entry.name + ' · ' + (ui.stamp ? ui.stamp(t) : new Date(t).toISOString())) + '"><b>' + fmt(s.v[n - 1], d) +
      '</b><small>' + unit + '</small>' + (stale ? ' <span class="tag watch">STALE</span>' : '') + '</td>';
  }

  // LOP: no downstream gage; show the dam's own release (already loaded by js/data.js).
  function noGage(code) {
    var p = projectOf(code), snap = H.live && H.live.snap, d = snap && snap.projects[p.id], o = d && H.latest(d.out);
    return '<td data-label="Outflow gage" title="No ' + code + 'O gage: releases into Dexter Reservoir.' + (o ? ' Dam release: ' + esc(p.series.out.name) : '') + '">' +
      '<span class="na">no gage</span>' + (o ? '<small class="w-sub">dam release ' + fmt(o.v, 0) + ' cfs</small>' : '') + '</td>';
  }

  function currentTable(now) {
    var rows = CODES.map(function (code) {
      var pn = poolNow(code), cur = mem.current[code] || {};
      var e = pn.elev, dev = e && pn.rule != null ? e.v - pn.rule : null;
      var stale = e && now - e.t > H.SETTINGS.staleHours * HOUR;
      return '<tr><th scope="row"><b>' + code + '</b><small>' + esc(NAMES[code]) + '</small></th>' +
        (e ? '<td data-label="Pool" title="' + esc(code + '.Elev-Forebay.Inst.0.0.MIXED-REV') + '"><b>' + fmt(e.v, 2) + '</b><small>ft</small>' + (stale ? ' <span class="tag watch">STALE</span>' : '') + '</td>'
          : '<td class="na" data-label="Pool">' + (H.live ? 'no data' : '<span class="loading">loading…</span>') + '</td>') +
        '<td data-label="Rule curve">' + (pn.rule != null ? fmt(pn.rule, 2) + '<small>ft</small>' : '<span class="na">—</span>') + '</td>' +
        '<td data-label="Pool − rule" class="' + devCls(dev) + '"><b>' + signed(dev, 2) + '</b>' + (dev != null ? '<small>ft</small>' : '') + '</td>' +
        cell(cur.tail, 2, 'ft', now) +
        (GAGE[code] ? cell(cur.gage, 0, 'cfs', now) : noGage(code)) +
        '<td class="w-time" data-label="Pool reading">' + (e ? esc(ui.stamp ? ui.stamp(e.t) : new Date(e.t).toISOString()) : '—') + '</td></tr>';
    }).join('');
    return '<div class="table-scroll w-scroll"><table class="w-table w-current">' +
      '<thead><tr><th scope="col">Project</th><th scope="col">Pool elev</th><th scope="col">Rule curve</th><th scope="col">Pool − rule</th>' +
      '<th scope="col">Tailwater</th><th scope="col">Outflow gage</th><th scope="col">Pool reading</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function spanDays(now) {
    var today = dayKey(now);
    if (ui.span === '30d') return lastDays(today, 30);
    return monthDays(ui.month || monthKey(now), today);
  }

  function statsTable(days) {
    var rows = CODES.map(function (code) {
      var st = spanStats(dailyRows(days, mem.agg[code], mem.rules[code]));
      var noPool = !st.poolDays;
      return '<tr><th scope="row"><b>' + code + '</b></th>' +
        (noPool ? '<td colspan="8" class="na">' + (ui.loading && !mem.yearLoaded[code] ? '<span class="loading">loading history…</span>' : 'no pool data for this span') + '</td>' :
          '<td>' + fmt(st.poolStart, 2) + ' → ' + fmt(st.poolEnd, 2) + '</td>' +
          '<td class="' + (st.poolChange < 0 ? 'w-fall' : 'w-rise') + '"><b>' + signed(st.poolChange, 2) + '</b></td>' +
          '<td>' + fmt(st.poolMin, 2) + ' / ' + fmt(st.poolMax, 2) + '</td>' +
          '<td class="' + devCls(st.devStart) + '">' + signed(st.devStart, 2) + '</td>' +
          '<td class="' + devCls(st.devEnd) + '">' + signed(st.devEnd, 2) + '</td>' +
          '<td class="' + devCls(st.devAvg) + '"><b>' + signed(st.devAvg, 2) + '</b></td>' +
          '<td>' + signed(st.devMin, 1) + ' / ' + signed(st.devMax, 1) + '</td>' +
          '<td>' + (st.devDays ? st.daysAbove + ' / ' + st.daysBelow + '<small> of ' + st.devDays + '</small>' : '<span class="na">no rule curve</span>') + '</td>') + '</tr>';
    }).join('');
    return '<div class="table-scroll w-scroll"><table class="w-table w-stats"><thead><tr><th scope="col">Project</th>' +
      '<th scope="col">Pool start → end (ft)</th><th scope="col">Pool change</th><th scope="col">Pool min / max</th>' +
      '<th scope="col">vs rule, start</th><th scope="col">vs rule, end</th><th scope="col">vs rule, avg</th><th scope="col">vs rule min / max</th>' +
      '<th scope="col" title="Days with the daily mean above the rule curve / more than ' + BELOW_FT + ' ft below it">Days above / &gt;' + BELOW_FT + ' ft below</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function dailyTable(days) {
    var data = CODES.map(function (code) { return dailyRows(days, mem.agg[code], mem.rules[code]); });
    var head = '<tr><th scope="col" rowspan="2">Day</th>' + CODES.map(function (c) { return '<th scope="colgroup" colspan="3">' + c + '</th>'; }).join('') + '</tr><tr>' +
      CODES.map(function () { return '<th scope="col">pool</th><th scope="col">rule</th><th scope="col">Δ</th>'; }).join('') + '</tr>';
    var body = days.slice().reverse().map(function (k, ri) {
      var i = days.length - 1 - ri;
      return '<tr><th scope="row">' + dayLabel(k) + '</th>' + data.map(function (rows) {
        var r = rows[i];
        return '<td>' + fmt(r.pool, 2) + '</td><td>' + fmt(r.rule, 2) + '</td><td class="' + devCls(r.dev) + '">' + signed(r.dev, 2) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<details class="table-view"><summary>Daily values (' + days.length + ' days, newest first)</summary>' +
      '<div class="table-scroll"><table class="w-table w-daily"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></details>';
  }

  function yearTable(now) {
    var months = lastMonths(monthKey(now), 12), today = dayKey(now);
    var head = '<tr><th scope="col">Avg pool − rule (ft)</th>' + months.map(function (m) { return '<th scope="col">' + monLabel(m, true) + '<small>' + m.slice(2, 4) + '</small></th>'; }).join('') +
      '<th scope="col">12 mo</th><th scope="col" title="Days with the daily mean more than ' + BELOW_FT + ' ft below the rule curve">Days &gt;' + BELOW_FT + ' ft below</th></tr>';
    var body = CODES.map(function (code) {
      var all = [];
      var cells = months.map(function (m) {
        var rows = dailyRows(monthDays(m, today), mem.agg[code], mem.rules[code]);
        all = all.concat(rows);
        var st = spanStats(rows);
        return '<td class="' + devCls(st.devAvg) + '" title="' + esc(monLabel(m) + ': pool ' + fmt(st.poolStart, 2) + ' → ' + fmt(st.poolEnd, 2) + ' ft, ' + st.devDays + ' days') + '">' + signed(st.devAvg, 1) + '</td>';
      }).join('');
      var tot = spanStats(all);
      return '<tr><th scope="row"><b>' + code + '</b></th>' + cells + '<td class="' + devCls(tot.devAvg) + '"><b>' + signed(tot.devAvg, 1) + '</b></td><td>' + (tot.devDays ? tot.daysBelow : '—') + '</td></tr>';
    }).join('');
    var poolHead = '<tr><th scope="col">Month-end pool (ft)</th>' + months.map(function (m) { return '<th scope="col">' + monLabel(m, true) + '</th>'; }).join('') + '<th scope="col">12 mo Δ</th><th></th></tr>';
    var poolBody = CODES.map(function (code) {
      var ends = months.map(function (m) { return spanStats(dailyRows(monthDays(m, today), mem.agg[code], mem.rules[code])).poolEnd; });
      var vals = ends.filter(function (v) { return v != null; });
      return '<tr><th scope="row"><b>' + code + '</b></th>' + ends.map(function (v) { return '<td>' + fmt(v, 1) + '</td>'; }).join('') +
        '<td><b>' + (vals.length > 1 ? signed(vals[vals.length - 1] - vals[0], 1) : '—') + '</b></td><td></td></tr>';
    }).join('');
    return '<div class="table-scroll w-scroll"><table class="w-table w-year"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-scroll w-scroll"><table class="w-table w-year"><thead>' + poolHead + '</thead><tbody>' + poolBody + '</tbody></table></div>';
  }

  function render() {
    if (!ui.root) return;
    var now = Date.now(), cur = monthKey(now);
    var monthOpts = lastMonths(cur, 13).reverse().map(function (m) {
      return '<option value="' + m + '"' + (m === (ui.month || cur) ? ' selected' : '') + '>' + monLabel(m) + (m === cur ? ' (to date)' : '') + '</option>';
    }).join('');
    var seg = function (k, label) { return '<button type="button" data-wspan="' + k + '" aria-pressed="' + (ui.span === k) + '">' + label + '</button>'; };
    var days = ui.span === 'year' ? null : spanDays(now);
    var used = [];
    CODES.forEach(function (c) { ['tail', 'gage'].forEach(function (k) { var n = mem.names[c + ':' + k]; if (n) used.push(n); }); });
    ui.root.innerHTML =
      '<div class="panel-head"><h2>Watch List · HCR · LOP · DEX · CGR</h2><span class="panel-tag mono">USACE CWMS · PROVISIONAL · TRENDS HOURLY</span></div>' +
      currentTable(now) +
      '<div class="trend-controls w-controls"><div class="seg" role="group" aria-label="Trend span">' + seg('30d', '30 D') + seg('month', 'MONTH') + seg('year', '12 MO') + '</div>' +
      (ui.span === 'month' ? '<label class="field"><span class="field-label">Month</span><select id="w-month">' + monthOpts + '</select></label>' : '') +
      '<span class="hint mono">Pool elevation vs USACE rule curve' + (days ? ' · ' + dayLabel(days[0]) + ' – ' + dayLabel(days[days.length - 1]) : ' · last 12 months') + '</span></div>' +
      (days ? statsTable(days) + dailyTable(days) : yearTable(now)) +
      '<p class="hint w-note">Daily means of the 5-min pool series (Pacific days) minus that day’s rule-curve value; today is partial. ' +
      'Colours: within −' + BELOW_FT + ' / +' + H.SETTINGS.ruleAboveFt + ' ft of the rule curve, more than ' + BELOW_FT + ' ft below, or more than ' + H.SETTINGS.ruleAboveFt + ' ft above (this site’s thresholds). ' +
      'Tailwater and outflow-gage series' + (used.length ? ': ' + used.map(esc).join(', ') : ' are looked up in the CWMS catalog') + '.' +
      (ui.errors.length ? ' <span class="w-err">Last refresh: ' + esc(ui.errors.join('; ')) + '</span>' : '') + '</p>';
  }

  function mount(el, opts) {
    ui.root = el;
    ui.stamp = opts && opts.stamp;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-wspan]');
      if (!b) return;
      ui.span = b.getAttribute('data-wspan');
      render();
    });
    el.addEventListener('change', function (e) {
      if (e.target.id !== 'w-month') return;
      ui.month = e.target.value;
      render();
    });
    render();
  }

  var busy = false;
  // Called on every dashboard poll; the trend part self-limits to hourly.
  function update() {
    render();
    if (busy) return Promise.resolve();
    busy = true;
    return refresh(Date.now()).then(function (r) {
      ui.errors = r.errors; ui.loading = false; busy = false;
      render();
    });
  }

  return {
    CODES: CODES, GAGE: GAGE, CANDIDATES: CANDIDATES, CATALOG_LIKE: CATALOG_LIKE,
    dayKey: dayKey, monthKey: monthKey, addDays: addDays, lastDays: lastDays, monthDays: monthDays, lastMonths: lastMonths,
    aggregate: aggregate, ruleByDay: ruleByDay, dailyRows: dailyRows, spanStats: spanStats, pickCatalog: pickCatalog,
    catalogUrl: catalogUrl, refresh: refresh, mount: mount, update: update, render: render,
    _mem: mem  // for check.js --live
  };
});
