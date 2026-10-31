/*
 * Total dissolved gas (TDG, % saturation) below Dexter and Cougar dams — USACE CWMS
 * time series (office NWDP), hourly, CWMS reported, provisional:
 *   DEXO.%-Saturation-TDG.Inst.0.0.MIXED-REV   (Dexter tailwater)
 *   CGRO.%-Saturation-TDG.Inst.0.0.MIXED-REV   (Cougar tailwater)
 * The "%" in the id must be URL-encoded (%25); unit is "%". Other projects publish no
 * public TDG series, so nothing is shown for them.
 *
 * The 110% line is a REFERENCE line for the Oregon/EPA TDG water-quality standard; it is
 * not a statement about compliance.
 *
 * Browser: window.HYDRO.tdg. Node: module.exports.
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.tdg = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var DAY = 24 * 3600 * 1000;
  var STANDARD = 110;
  var REF_LABEL = '110% - Oregon/EPA TDG standard (reference)';
  var SERIES = {
    DEX: { name: 'DEXO.%-Saturation-TDG.Inst.0.0.MIXED-REV', unit: '%', label: 'Dexter tailwater' },
    CGR: { name: 'CGRO.%-Saturation-TDG.Inst.0.0.MIXED-REV', unit: '%', label: 'Cougar tailwater' }
  };

  // CWMS response -> { t:[], v:[] } (nulls dropped, sorted).
  function parse(j) {
    var rows = ((j && j.values) || []).filter(function (r) { return r && r[1] != null && isFinite(r[1]); });
    rows.sort(function (a, b) { return a[0] - b[0]; });
    return { t: rows.map(function (r) { return r[0]; }), v: rows.map(function (r) { return +r[1]; }) };
  }

  // 'over' above the 110% reference, 'ok' at or below, null without data.
  function level(v) { return v == null ? null : v > STANDARD ? 'over' : 'ok'; }

  // Loads 7 days for one project code (3 tries: CWMS has occasional TLS/500 hiccups).
  function load(code, now) {
    var spec = SERIES[code];
    if (!spec) return Promise.resolve(null);
    var t1 = now || Date.now(), t0 = t1 - 7 * DAY;
    var url = H.cwmsUrl(spec.name, spec.unit, t0, t1);
    return H.http.fetchJson(url, { headers: { Accept: H.http.cwmsAccept } }, 30000, 3).then(function (j) {
      var s = parse(j);
      s.name = spec.name; s.label = spec.label; s.unit = j.units || '%';
      return s;
    });
  }

  // Never rejects: { DEX: {series|null, error}, CGR: {...} }.
  function loadAll(now) {
    var out = {};
    return Promise.all(Object.keys(SERIES).map(function (code) {
      return load(code, now).then(function (s) { out[code] = { series: s, error: s && s.t.length ? null : 'no data' }; },
        function (err) { out[code] = { series: null, error: err.message || 'failed' }; });
    })).then(function () { return out; });
  }

  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // 7-day sparkline with the 110% reference line (domain always includes 110).
  function spark(s) {
    var w = 200, h = 40, pad = 3;
    if (!s || s.t.length < 2) return '';
    var lo = Math.min(Math.min.apply(null, s.v), STANDARD), hi = Math.max(Math.max.apply(null, s.v), STANDARD);
    var span = hi - lo || 1; lo -= span * 0.15; hi += span * 0.15;
    var t0 = s.t[0], t1 = s.t[s.t.length - 1];
    var x = function (t) { return ((t - t0) / (t1 - t0 || 1)) * w; };
    var y = function (v) { return pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad); };
    var d = s.t.map(function (t, i) { return (i ? 'L' : 'M') + x(t).toFixed(1) + ' ' + y(s.v[i]).toFixed(1); }).join('');
    var yr = y(STANDARD).toFixed(1);
    return '<svg class="tdg-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<line class="tdg-ref-line" x1="0" x2="' + w + '" y1="' + yr + '" y2="' + yr + '"/><path class="tdg-line" d="' + d + '"/></svg>';
  }

  /*
   * Chip HTML for one project. entry = { series, error } from loadAll; stamp(t) formats a time.
   * Returns '' for projects without a TDG series.
   */
  function chipHTML(code, entry, stamp, now) {
    var spec = SERIES[code];
    if (!spec) return '';
    var s = entry && entry.series, n = s ? s.t.length : 0;
    if (!entry) return '<div class="tdg-chip tdg-na"><div class="tdg-head"><span class="tdg-lbl">TDG · ' + esc(spec.label) + '</span><span class="tdg-val na loading">loading…</span></div></div>';
    if (!n) return '<div class="tdg-chip tdg-na"><div class="tdg-head"><span class="tdg-lbl">TDG · ' + esc(spec.label) + '</span><span class="tdg-val na">no data</span></div>' +
      '<div class="tdg-foot">' + esc(entry.error || 'no data') + '</div></div>';
    var v = s.v[n - 1], t = s.t[n - 1], lv = level(v), stale = (now || Date.now()) - t > 3 * 3600e3;
    return '<div class="tdg-chip tdg-' + lv + '" title="' + esc(spec.name) + '">' +
      '<div class="tdg-head"><span class="tdg-lbl">TDG · ' + esc(spec.label) + ' <span class="lbl">LIVE</span></span>' +
      '<span class="tdg-val">' + (lv === 'over' ? '▲ ' : '') + (v % 1 ? v.toFixed(1) : v.toFixed(0)) + '<small>% sat.</small></span></div>' +
      spark(s) +
      '<div class="tdg-foot">' + esc(stamp ? stamp(t) : new Date(t).toISOString()) + (stale ? ' <span class="tag watch">STALE</span>' : '') +
      ' · CWMS reported, provisional · 7 d</div>' +
      '<div class="tdg-foot"><i class="tdg-ref-key"></i>' + esc(REF_LABEL) + (lv === 'over' ? ' · <b>above reference</b>' : '') + '</div></div>';
  }

  return { SERIES: SERIES, STANDARD: STANDARD, REF_LABEL: REF_LABEL, parse: parse, level: level, load: load, loadAll: loadAll, spark: spark, chipHTML: chipHTML };
});
