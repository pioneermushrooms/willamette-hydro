/*
 * Snapshot at the top of Overview: forebay and tailwater elevation for Hills Creek,
 * Lookout Point, Dexter and Cougar, and the downstream outflow gages HCRO, DEXO and CGRO
 * (there is no LOPO: Lookout Point releases into Dexter Reservoir). Numbers only.
 *
 * Source: USACE CWMS Data API, office NWDP; provisional.
 *   forebay      <P>.Elev-Forebay.Inst.0.0.MIXED-REV   (already loaded by js/data.js)
 *   tailwater    <P>.Elev-Tailwater.*                  (resolved at runtime)
 *   outflow gage HCRO / DEXO / CGRO .Flow.*            (resolved at runtime)
 * Tailwater and gage ids are tried from CANDIDATES first; if none returns data, the CWMS
 * catalog is searched and the series with the most recent value is used. The id in use
 * is shown in each value's tooltip.
 *
 * Browser: window.HYDRO.watch. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.watch = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var HOUR = 3600 * 1000;
  var CODES = ['HCR', 'LOP', 'DEX', 'CGR'];
  var NAMES = { HCR: 'Hills Creek', LOP: 'Lookout Point', DEX: 'Dexter', CGR: 'Cougar' };
  var GAGE = { HCR: 'HCRO', DEX: 'DEXO', CGR: 'CGRO' };   // no LOPO
  var UNIT = { tail: 'ft', gage: 'cfs' };

  var CANDIDATES = {
    tail: function (c) { return [c + '.Elev-Tailwater.Inst.0.0.MIXED-REV', c + '.Elev-Tailwater.Inst.0.0.MIXED-RAW']; },
    gage: function (c) { var g = GAGE[c]; return [g + '.Flow.Inst.0.0.MIXED-REV', g + '.Flow.Inst.0.0.USGS-REV', g + '.Flow.Inst.15Minutes.0.USGS-REV']; }
  };
  var CATALOG_LIKE = {
    tail: function (c) { return '^' + c + '\\.Elev-Tailwater\\..*'; },
    gage: function (c) { return '^' + GAGE[c] + '\\.Flow\\..*'; }
  };

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

  function catalogUrl(like) {
    return H.http.cwmsBase + 'catalog/TIMESERIES?office=NWDP&like=' + encodeURIComponent(like) + '&page-size=100';
  }

  // ---- Loading ----------------------------------------------------------------

  var names = {};     // 'HCR:tail' -> resolved series name, or null when CWMS has none
  var current = {};   // code -> { tail: {name, series, error}, gage: {...} }

  function last2Days(name, unit, now) { return H.fetchCwms({ name: name, unit: unit }, now - 2 * 24 * HOUR, now); }

  // Candidates first, then the catalog.
  function resolve(kind, code, now) {
    var cands = CANDIDATES[kind](code), unit = UNIT[kind], i = 0;
    function next() {
      if (i >= cands.length) return fromCatalog();
      var name = cands[i++];
      return last2Days(name, unit, now).then(function (s) { return s.t.length ? { name: name, series: s } : next(); }, next);
    }
    function fromCatalog() {
      return H.http.fetchJson(catalogUrl(CATALOG_LIKE[kind](code)), { headers: { Accept: H.http.cwmsAccept } }, 30000, 2).then(function (j) {
        var name = pickCatalog(j && j.entries);
        if (!name) return { name: null, series: null, error: 'not published' };
        return last2Days(name, unit, now).then(function (s) { return { name: name, series: s, error: s.t.length ? null : 'no recent data' }; });
      }).catch(function (e) { return { name: null, series: null, error: e.message || 'lookup failed' }; });
    }
    return next();
  }

  function load(kind, code, now) {
    var key = code + ':' + kind;
    if (!(key in names)) return resolve(kind, code, now).then(function (r) {
      if (r.name || r.error === 'not published') names[key] = r.name;
      return r;
    });
    if (!names[key]) return Promise.resolve({ name: null, series: null, error: 'not published' });
    return last2Days(names[key], UNIT[kind], now).then(function (s) { return { name: names[key], series: s, error: s.t.length ? null : 'no recent data' }; },
      function (e) { return { name: names[key], series: null, error: e.message }; });
  }

  // Refreshes tailwater and gage values. Never rejects.
  function refresh(now) {
    now = now || Date.now();
    var jobs = [];
    CODES.forEach(function (code) {
      var cur = current[code] || (current[code] = {});
      (GAGE[code] ? ['tail', 'gage'] : ['tail']).forEach(function (kind) {
        jobs.push(load(kind, code, now).then(function (r) {
          // Keep the last good reading if this request failed (it ages into STALE).
          if (!(r.series && r.series.t.length) && cur[kind] && cur[kind].series && cur[kind].series.t.length) return;
          cur[kind] = r;
        }));
      });
    });
    return Promise.all(jobs);
  }

  // ---- Rendering --------------------------------------------------------------

  var ui = { root: null, stamp: null, loaded: false };

  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }

  // One labelled value. series = {t, v}; pending = still loading.
  function value(label, series, d, unit, name, error, pending) {
    var n = series && series.t ? series.t.length : 0;
    if (!n) return '<div class="snap-v"><span class="snap-l">' + label + '</span><span class="na">' +
      (pending ? '<span class="loading">loading…</span>' : esc(error || 'no data')) + '</span></div>';
    var t = series.t[n - 1], stale = Date.now() - t > H.SETTINGS.staleHours * HOUR;
    return '<div class="snap-v" title="' + esc(name + ' · ' + (ui.stamp ? ui.stamp(t) : new Date(t).toISOString())) + '"><span class="snap-l">' + label + '</span>' +
      '<b>' + fmt(series.v[n - 1], d) + '</b><small>' + unit + '</small>' + (stale ? ' <span class="tag watch">STALE</span>' : '') + '</div>';
  }

  function render() {
    if (!ui.root) return;
    var snap = H.live && H.live.snap, newest = null;
    var rows = CODES.map(function (code) {
      var p = H.projects.filter(function (x) { return x.code === code; })[0];
      var fb = snap && snap.projects[p.id] && snap.projects[p.id].elev, cur = current[code] || {};
      if (fb && fb.t.length) newest = Math.max(newest || 0, fb.t[fb.t.length - 1]);
      var tw = cur.tail || {}, g = cur.gage || {};
      return '<div class="snap-row"><span class="snap-name"><b>' + code + '</b> ' + esc(NAMES[code]) + '</span>' +
        value('Forebay', fb, 2, 'ft', p.series.elev.name, null, !snap) +
        value('Tailwater', tw.series, 2, 'ft', tw.name || '', tw.error, !ui.loaded) +
        (GAGE[code] ? value(GAGE[code], g.series, 0, 'cfs', g.name || '', g.error, !ui.loaded) : '<div class="snap-v snap-none"></div>') +
        '</div>';
    }).join('');
    ui.root.innerHTML = '<div class="snap">' + rows + '</div>' +
      '<p class="hint snap-foot mono">' + (newest ? 'As of ' + esc(ui.stamp ? ui.stamp(newest) : new Date(newest).toISOString()) + ' · ' : '') +
      'USACE CWMS, provisional</p>';
  }

  function mount(el, opts) {
    ui.root = el;
    ui.stamp = opts && opts.stamp;
    render();
  }

  var busy = false;
  // Called on every dashboard poll.
  function update() {
    render();
    if (busy) return Promise.resolve();
    busy = true;
    return refresh(Date.now()).then(function () { ui.loaded = true; busy = false; render(); });
  }

  return {
    CODES: CODES, GAGE: GAGE, CANDIDATES: CANDIDATES, CATALOG_LIKE: CATALOG_LIKE,
    pickCatalog: pickCatalog, catalogUrl: catalogUrl, refresh: refresh, current: current,
    mount: mount, update: update, render: render
  };
});
