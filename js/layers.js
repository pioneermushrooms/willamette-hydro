/*
 * Chart layers for the Trend Recorder: what can be switched on, and where each comes from.
 *
 * On the main (elevation) chart, reservoirs only:
 *   rule curve, 30-yr statistics bands, published target    (drawn by js/app.js)
 *   level lines: CWMS location levels <P>.Elev.Inst.0.<Top of Dam | Top of Max Flood | Top of Flood |
 *                Top of Conservation | Spillway Crest | Bottom of Conservation | Top/Bottom of Power>
 * Strips under the chart (each its own small chart and axis, sharing the time axis):
 *   reservoirs  inflow / outflow    USACE CWMS <P>.Flow-In / <P>.Flow-Out (same series as the cards)
 *               water temp, turbidity below the dam   USGS 00010 / 63680 at the downstream gage
 *                                   (HCR 14145500, DEX 14150000, CGR 14159500; others not configured)
 *               TDG below the dam   USACE CWMS DEXO / CGRO %-Saturation-TDG (js/tdg.js)
 *   rivers      whichever of flow, stage, water temp, turbidity is not on the main chart (USGS IV/DV)
 * Series that a site does not publish show "not reported" in their strip rather than failing.
 *
 * Long windows use reduced data: CWMS as 6-hour means beyond 35 days, USGS daily means beyond
 * 120 days (the IV service limit). Results are cached for 10 minutes per point, layer and window.
 * Toggle choices are remembered per browser (localStorage; the page works without it).
 *
 * Browser: window.HYDRO.layers. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.layers = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var HOUR = 3600 * 1000, DAY = 24 * HOUR;
  var USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
  var USGS_DV = 'https://waterservices.usgs.gov/nwis/dv/';
  var TTL = 10 * 60 * 1000;

  // Structural level lines (keys of HYDRO.levels.IDS), top to bottom.
  var LEVELS = [
    { key: 'topDam', label: 'Top of dam' },
    { key: 'topMaxFlood', label: 'Top of max flood' },
    { key: 'topFlood', label: 'Top of flood' },
    { key: 'topCons', label: 'Top of conservation' },
    { key: 'spillwayCrest', label: 'Spillway crest' },
    { key: 'topPower', label: 'Top of power pool' },
    { key: 'bottomPower', label: 'Bottom of power pool' },
    { key: 'bottomCons', label: 'Bottom of conservation' }
  ];

  // Known published elevation targets per project; others are found in their CWMS levels (targetFor).
  var TARGETS = {
    LOP: { idKey: 'injunctionTarget', label: 'Injunction target' },
    GPR: { idKey: 'injunctionTarget', label: 'Injunction target' },
    CGR: { idKey: 'injunctionTarget', label: 'Injunction target' },
    HCR: { idKey: 'interimRisk', label: 'Interim Risk Reduction Measure' }
  };

  // USGS gage just below each dam (water temperature, turbidity).
  var BELOW_DAM = { HCR: { site: '14145500', name: 'MF Willamette abv Salt Crk (HCRO)' }, DEX: { site: '14150000', name: 'MF Willamette nr Dexter (DEXO)' }, CGR: { site: '14159500', name: 'SF McKenzie nr Rainbow (CGRO)' } };
  var TDG = { DEX: 'DEXO.%-Saturation-TDG.Inst.0.0.MIXED-REV', CGR: 'CGRO.%-Saturation-TDG.Inst.0.0.MIXED-REV' };
  var PCODE = { flow: '00060', stage: '00065', temp: '00010', turb: '63680' };

  // Toggleable items per kind; `on` = default.
  var CHART_TOGGLES = [
    { key: 'rule', label: 'Rule curve', on: true },
    { key: 'stats', label: '30-yr bands', on: true },
    { key: 'target', label: 'Published target', on: true }
  ].concat(LEVELS.map(function (l) { return { key: 'lvl:' + l.key, label: l.label, on: false, level: l.key }; }));

  var STRIPS = {
    reservoir: [
      { key: 'flows', label: 'Inflow / outflow', unit: 'cfs', dec: 0, on: true },
      { key: 'temp', label: 'Water temp below dam', unit: '°F', dec: 1, on: false },
      { key: 'turb', label: 'Turbidity below dam', unit: 'FNU', dec: 1, on: false },
      { key: 'tdg', label: 'TDG below dam', unit: '% sat', dec: 0, on: false, ref: 110, refLabel: '110% (Oregon/EPA standard, reference)' }
    ],
    river: [
      { key: 'flow', label: 'Discharge', unit: 'cfs', dec: 0, on: false },
      { key: 'stage', label: 'Gage height', unit: 'ft', dec: 2, on: false },
      { key: 'temp', label: 'Water temp', unit: '°F', dec: 1, on: false },
      { key: 'turb', label: 'Turbidity', unit: 'FNU', dec: 1, on: false }
    ]
  };

  // ---- Toggle state (per browser) ---------------------------------------------

  var KEY = 'wvhd:layers:v1';
  var saved = (function () { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })();
  function isOn(item) { return item.key in saved ? !!saved[item.key] : !!item.on; }
  function setOn(key, v) { saved[key] = !!v; try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* memory only */ } }

  // ---- Level values -----------------------------------------------------------

  // [{ key, label, v }] for the levels this project publishes (current version), top to bottom.
  function levelValues(lv, now) {
    var LV = H.levels;
    if (!lv || !LV) return [];
    return LEVELS.map(function (l) { return { key: l.key, label: l.label, v: LV.constantAt(lv, LV.IDS[l.key], now || Date.now()) }; })
      .filter(function (l) { return l.v != null; });
  }

  /*
   * Published elevation target (injunction / interim operations) for a project: the level named in
   * TARGETS, otherwise one found in its CWMS location levels (lv, from js/cwms-levels.js) whose id is
   * an elevation level mentioning Injunction, Interim or Target (Injunction preferred). Returns
   * { id: level id suffix, label, discovered } or null. Storage-only targets are not elevation curves.
   */
  function targetFor(code, lv) {
    var t = TARGETS[code], LV = H.levels;
    if (t && LV) return { id: LV.IDS[t.idKey], label: t.label };
    if (!lv || !lv.levels) return null;
    var keys = Object.keys(lv.levels).filter(function (k) {
      return /^Elev[^.;]*\.Inst\.0\./.test(k) && /injunction|interim|target/i.test(k) && !/temp|odeq/i.test(k);
    });
    if (!keys.length) return null;
    keys.sort(function (a, b) { return (/injunction/i.test(b) ? 1 : 0) - (/injunction/i.test(a) ? 1 : 0) || a.localeCompare(b); });
    var name = keys[0].split('.Inst.0.')[1].replace(/[-_]+/g, ' ');
    return { id: keys[0], label: name.charAt(0).toUpperCase() + name.slice(1), discovered: true };
  }

  // ---- Strip data ---------------------------------------------------------------

  var cache = {};

  function usgs(site, param, start, end) {
    var dv = end - start > 120 * DAY, d = function (t) { return new Date(t).toISOString().slice(0, dv ? 10 : 19) + (dv ? '' : 'Z'); };
    var url = (dv ? USGS_DV : USGS_IV) + '?format=json&sites=' + site + '&parameterCd=' + PCODE[param] + (dv ? '&statCd=00003' : '') +
      '&startDT=' + d(start) + '&endDT=' + d(end) + '&siteStatus=all';
    return H.http.fetchJson(url, {}, 45000, 2).then(function (j) {
      var s = H.history.parseUsgs(j, dv)[PCODE[param]];
      if (s && param === 'temp') s = { t: s.t, v: s.v.map(H.cToF) };
      return { s: s || null, how: dv ? 'USGS daily means' : 'USGS instantaneous' };
    });
  }

  function cwms(spec, start, end) {
    return (end - start > 35 * DAY ? H.history.cwmsChunks(spec, start, end) : H.fetchCwms(spec, start, end))
      .then(function (s) { return { s: s, how: end - start > 35 * DAY ? '6-hour means' : 'as reported' }; });
  }

  // Live 7-day series covers [start, end]?
  function liveCovers(s, start) { return s && s.t && s.t.length && s.t[0] <= start + 2 * HOUR; }

  /*
   * Data for one strip over [start, end]. Resolves { lines: [{ label, t, v, cls }], src, empty }.
   * e: project or station; key: strip key; live: the entity's live 7-day data (snapshot) or null;
   * mainParam: for rivers, the parameter already on the main chart.
   */
  function load(e, key, start, end, live) {
    var ck = e.id + '|' + key + '|' + Math.round(start / (5 * 60000)) + '|' + Math.round(end / (5 * 60000)), c = cache[ck];
    if (c && Date.now() - c.at < TTL) return c.p;
    var p, res = e.kind === 'reservoir';
    var one = function (r, label, cls, src) { return { lines: r.s && r.s.t.length ? [{ label: label, t: r.s.t, v: r.s.v, cls: cls }] : [], src: src + (r.how ? ' (' + r.how + ')' : '') }; };
    if (res && key === 'flows') {
      var useLive = live && liveCovers(live.out, start) && liveCovers(live.inflow, start);
      p = (useLive ? Promise.resolve([{ s: live.out }, { s: live.inflow }]) : Promise.all([cwms(e.series.out, start, end), cwms(e.series.inflow, start, end)]))
        .then(function (r) {
          var lines = [];
          if (r[0].s && r[0].s.t.length) lines.push({ label: 'Outflow', t: r[0].s.t, v: r[0].s.v, cls: 'st-out' });
          if (r[1].s && r[1].s.t.length) lines.push({ label: 'Computed inflow', t: r[1].s.t, v: r[1].s.v, cls: 'st-in' });
          return { lines: lines, src: 'USACE CWMS ' + e.series.out.name + ', ' + e.series.inflow.name + (useLive ? '' : ' (' + (r[0].how || '') + ')') };
        });
    } else if (res && (key === 'temp' || key === 'turb')) {
      var bd = BELOW_DAM[e.code];
      p = bd ? usgs(bd.site, key, start, end).then(function (r) { return one(r, key === 'temp' ? 'Water temp' : 'Turbidity', 'st-a', 'USGS ' + bd.site + ' ' + bd.name + ', ' + PCODE[key]); })
        : Promise.resolve({ lines: [], src: 'No USGS gage below ' + e.name + ' is configured on this site.' });
    } else if (res && key === 'tdg') {
      p = TDG[e.code] ? cwms({ name: TDG[e.code], unit: '%' }, start, end).then(function (r) { return one(r, 'TDG', 'st-a', 'USACE CWMS ' + TDG[e.code]); })
        : Promise.resolve({ lines: [], src: 'No public TDG series below ' + e.name + ' (published for Dexter and Cougar only).' });
    } else if (!res && PCODE[key]) {
      var lbl = { flow: 'Discharge', stage: 'Gage height', temp: 'Water temp', turb: 'Turbidity' }[key];
      p = usgs(e.site, key, start, end).then(function (r) { return one(r, lbl, 'st-a', 'USGS ' + e.site + ', ' + PCODE[key]); });
    } else p = Promise.resolve({ lines: [], src: 'unknown layer' });
    p = p.then(function (r) { r.empty = !r.lines.length; return r; }, function (err) { delete cache[ck]; return { lines: [], src: '', empty: true, error: err.message || 'failed' }; });
    cache[ck] = { at: Date.now(), p: p };
    return p;
  }

  // Why a strip cannot have data for this entity (known without fetching), or null.
  function unavailable(e, key) {
    if (e.kind === 'reservoir') {
      if ((key === 'temp' || key === 'turb') && !BELOW_DAM[e.code]) return 'No USGS gage below ' + e.name + ' is configured for water temperature or turbidity.';
      if (key === 'tdg' && !TDG[e.code]) return 'No public TDG series below ' + e.name + ' (published for Dexter and Cougar only).';
    }
    return null;
  }

  // Strips offered for an entity (rivers: not the parameter already on the main chart).
  function stripsFor(e, mainParam) {
    if (e.kind === 'reservoir') return STRIPS.reservoir;
    return STRIPS.river.filter(function (s) { return s.key !== mainParam && (s.key !== 'flow' || e.params.indexOf('flow') >= 0); });
  }

  return {
    LEVELS: LEVELS, TARGETS: TARGETS, BELOW_DAM: BELOW_DAM, TDG: TDG, PCODE: PCODE,
    CHART_TOGGLES: CHART_TOGGLES, STRIPS: STRIPS,
    isOn: isOn, setOn: setOn, levelValues: levelValues, targetFor: targetFor, unavailable: unavailable, stripsFor: stripsFor, load: load, _cache: cache
  };
});
