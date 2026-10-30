#!/usr/bin/env node
/*
 * Data-shape and sanity checks for js/data.js. Run with:  node check.js
 * Exits non-zero on any failure.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var DATA_PATH = path.join(__dirname, 'js', 'data.js');
var failures = 0;
var passes = 0;

function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error('  FAIL ' + msg); }
}

function isNum(v) { return typeof v === 'number' && isFinite(v); }

function load() {
  delete require.cache[require.resolve(DATA_PATH)];
  return require(DATA_PATH);
}

var D = load();
var STATUSES = ['normal', 'watch', 'low'];

// ---- meta -----------------------------------------------------------------
console.log('meta');
check(D.meta && D.meta.illustrative === true, 'meta.illustrative must be true');
check(/illustrative/i.test(D.meta.disclaimer || ''), 'meta.disclaimer mentions illustrative');
check(isNum(D.meta.seed), 'meta.seed is a number');
check(D.meta.points === (D.meta.days * 24 * 60) / D.meta.stepMinutes + 1, 'meta.points matches days/stepMinutes');

// ---- reservoirs -----------------------------------------------------------
console.log('reservoirs');
var expectRes = ['lookout-point', 'hills-creek', 'dexter', 'green-peter', 'cougar', 'fern-ridge', 'cottage-grove', 'dorena'];
var expectHydro = ['lookout-point', 'hills-creek', 'dexter', 'green-peter', 'cougar'];
check(Array.isArray(D.reservoirs) && D.reservoirs.length === 8, '8 reservoirs');
check(JSON.stringify(D.reservoirs.map(function (r) { return r.id; })) === JSON.stringify(expectRes), 'reservoir ids/order');

D.reservoirs.forEach(function (r) {
  var p = 'reservoir ' + r.id + ': ';
  ['name', 'river', 'purpose', 'note'].forEach(function (k) { check(typeof r[k] === 'string' && r[k].length > 0, p + k + ' is a non-empty string'); });
  ['fullPoolFt', 'minPoolFt', 'ruleCurveFt', 'elevationFt', 'inflowCfs', 'outflowCfs', 'percentFull', 'ruleCurvePercent', 'storageKaf']
    .forEach(function (k) { check(isNum(r[k]), p + k + ' is a finite number'); });
  check(r.kind === 'reservoir', p + 'kind');
  check(r.fullPoolFt > r.minPoolFt, p + 'full pool above min pool');
  check(r.elevationFt <= r.fullPoolFt && r.elevationFt > r.minPoolFt - 60, p + 'elevation in plausible range');
  check(r.ruleCurveFt >= r.minPoolFt && r.ruleCurveFt <= r.fullPoolFt, p + 'rule curve within pool');
  check(r.percentFull >= 0 && r.percentFull <= 100, p + 'percentFull 0..100');
  // Late-October drawdown: pools well below full.
  check(r.percentFull < 75, p + 'percentFull consistent with fall drawdown');
  check(r.inflowCfs >= 0 && r.outflowCfs >= 0, p + 'flows non-negative');
  check(STATUSES.indexOf(r.status) >= 0, p + 'status enum');
  var hydro = expectHydro.indexOf(r.id) >= 0;
  check(r.hydro === hydro, p + 'hydro flag');
  if (hydro) {
    check(isNum(r.generationMW) && r.generationMW >= 0 && r.generationMW <= r.capacityMW, p + 'generationMW within capacity');
    check(Number.isInteger(r.units) && r.units > 0, p + 'units');
    check(Number.isInteger(r.unitsOnline) && r.unitsOnline >= 0 && r.unitsOnline <= r.units, p + 'unitsOnline <= units');
    check((r.unitsOnline === 0) === (r.generationMW === 0), p + 'zero units iff zero MW');
  } else {
    check(r.generationMW === undefined && r.capacityMW === undefined && r.units === undefined, p + 'flood-control-only has no MW/units fields');
  }
  var s = r.series && r.series.elevationFt;
  check(Array.isArray(s) && s.length === D.meta.points, p + 'elevation series length');
  if (Array.isArray(s)) {
    check(s.every(isNum), p + 'elevation series finite');
    check(s[s.length - 1] === r.elevationFt, p + 'series ends at current elevation');
    check(Math.max.apply(null, s) <= r.fullPoolFt, p + 'series never exceeds full pool');
    var maxStep = 0;
    for (var i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i] - s[i - 1]));
    check(maxStep < 0.5, p + 'no implausible 15-min jumps (max ' + maxStep.toFixed(3) + ' ft)');
  }
});

// ---- rivers ---------------------------------------------------------------
console.log('rivers');
var expectRiv = ['willamette-eugene', 'willamette-harrisburg', 'mckenzie-vida', 'mckenzie-coburg', 'middle-fork-jasper', 'coast-fork-goshen'];
check(Array.isArray(D.rivers) && D.rivers.length === 6, '6 river stations');
check(JSON.stringify(D.rivers.map(function (r) { return r.id; })) === JSON.stringify(expectRiv), 'river ids/order');

var R = {};
D.rivers.forEach(function (s) {
  R[s.id] = s;
  var p = 'river ' + s.id + ': ';
  ['name', 'river', 'note'].forEach(function (k) { check(typeof s[k] === 'string' && s[k].length > 0, p + k + ' is a non-empty string'); });
  check(/ at /.test(s.name), p + 'name has "<river> at <place>" form');
  ['flowCfs', 'stageFt', 'tempF', 'minTargetCfs', 'floodStageFt'].forEach(function (k) { check(isNum(s[k]), p + k + ' is a finite number'); });
  check(s.kind === 'river', p + 'kind');
  check(s.flowCfs > 0 && s.flowCfs < 100000, p + 'flow plausible');
  check(s.stageFt > 0 && s.stageFt < s.floodStageFt, p + 'stage below flood stage');
  check(s.tempF > 38 && s.tempF < 65, p + 'late-October water temp plausible');
  check(STATUSES.indexOf(s.status) >= 0, p + 'status enum');
  ['flowCfs', 'stageFt'].forEach(function (k) {
    var a = s.series && s.series[k];
    check(Array.isArray(a) && a.length === D.meta.points, p + k + ' series length');
    if (Array.isArray(a)) {
      check(a.every(function (v) { return isNum(v) && v > 0; }), p + k + ' series positive & finite');
      check(a[a.length - 1] === s[k], p + k + ' series ends at current value');
    }
  });
});
check(R['willamette-harrisburg'].flowCfs > R['willamette-eugene'].flowCfs, 'Harrisburg flow > Eugene flow (McKenzie joins between)');
check(R['mckenzie-coburg'].flowCfs > R['mckenzie-vida'].flowCfs, 'Coburg flow > Vida flow');

// ---- ids / map ------------------------------------------------------------
console.log('map');
var all = D.reservoirs.concat(D.rivers);
var ids = all.map(function (e) { return e.id; });
check(new Set(ids).size === ids.length, 'ids unique');
var vb = D.basinMap.viewBox;
all.forEach(function (e) {
  check(e.map && isNum(e.map.x) && isNum(e.map.y), e.id + ': map coords');
  check(e.map.x >= vb[0] && e.map.x <= vb[2] && e.map.y >= vb[1] && e.map.y <= vb[3], e.id + ': map coords inside viewBox');
  // Every node sits on one of the drawn river polylines (as a vertex).
  var onRiver = D.basinMap.rivers.some(function (rv) {
    return rv.points.some(function (pt) { return pt[0] === e.map.x && pt[1] === e.map.y; });
  });
  check(onRiver, e.id + ': node lies on a river line');
});
D.basinMap.rivers.forEach(function (rv) {
  check(Array.isArray(rv.points) && rv.points.length >= 2, 'river ' + rv.id + ': has points');
  check(ids.indexOf(rv.flowRef) >= 0, 'river ' + rv.id + ': flowRef is a known station');
});

// ---- totals ---------------------------------------------------------------
console.log('totals');
var t = D.totals();
var expectMW = D.reservoirs.filter(function (r) { return r.hydro; }).reduce(function (a, r) { return a + r.generationMW; }, 0);
check(Math.abs(t.generationMW - expectMW) < 0.05, 'total MW = sum of plants');
check(t.basinStoragePercent >= 0 && t.basinStoragePercent <= 100, 'basin storage 0..100');
check(t.alarms === all.filter(function (e) { return e.status !== 'normal'; }).length, 'alarm count');
check(t.unitsOnline <= t.units, 'units online <= units');

// ---- determinism ----------------------------------------------------------
console.log('determinism');
var D2 = load();
check(D2 !== D, 'fresh module instance loaded');
check(JSON.stringify(D2.reservoirs) === JSON.stringify(D.reservoirs) && JSON.stringify(D2.rivers) === JSON.stringify(D.rivers),
  'two loads produce identical data');

// ---- page wiring ----------------------------------------------------------
console.log('page');
var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
var header = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];
var footer = (html.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
check(/Illustrative data, not live/i.test(header), 'header shows "Illustrative data, not live"');
check(/Illustrative data, not live/i.test(footer), 'footer shows "Illustrative data, not live"');
(html.match(/(?:src|href)="([^"#:]+)"/g) || []).forEach(function (m) {
  var ref = m.replace(/^(?:src|href)="/, '').replace(/"$/, '');
  check(fs.existsSync(path.join(__dirname, ref)), 'referenced file exists: ' + ref);
});
['README.md', 'LICENSE'].forEach(function (f) { check(fs.existsSync(path.join(__dirname, f)), f + ' exists'); });

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
