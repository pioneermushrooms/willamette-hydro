#!/usr/bin/env node
/*
 * Checks for Willamette Valley Hydro Dispatch.
 *
 *   node check.js          validate config shape, pure helpers, page wiring (offline)
 *   node check.js --live   also hit USGS NWIS, USACE CWMS and BPA for real and print
 *                          a table of which fields are live / missing
 *
 * Exits non-zero on any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./js/data.js');
const BPA = require('./scripts/fetch-bpa.js');
const LV = require('./js/cwms-levels.js');
const NW = require('./js/nwps.js');
const TC = require('./js/teacup-core.js');
const RT = require('./js/ratings.js');

const LIVE = process.argv.includes('--live');
let passes = 0;
let failures = 0;

function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error('  FAIL ' + msg); }
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- 1. Config shape -------------------------------------------------------
console.log('config');
const expectStations = {
  'willamette-eugene': '14158050', 'willamette-harrisburg': '14166000', 'mckenzie-vida': '14162500',
  'mckenzie-coburg': '14165500', 'middle-fork-jasper': '14152000', 'coast-fork-goshen': '14157500'
};
check(H.stations.length === 6, '6 USGS stations');
H.stations.forEach((s) => {
  const p = 'station ' + s.id + ': ';
  check(expectStations[s.id] === s.site, p + 'USGS site id ' + s.site);
  check(typeof s.name === 'string' && typeof s.river === 'string' && typeof s.short === 'string', p + 'names');
  check(Array.isArray(s.params) && s.params.every((k) => ['flow', 'stage', 'tempC'].includes(k)), p + 'params');
  check(s.params.includes(s.primary), p + 'primary param is listed');
  check(s.sourceUrl === 'https://waterdata.usgs.gov/monitoring-location/' + s.site + '/', p + 'source link');
});
const eug = H.stations.find((s) => s.id === 'willamette-eugene');
check(!eug.params.includes('flow') && eug.primary === 'stage', 'Eugene has no discharge; charts stage');
check(H.stations.find((s) => s.id === 'mckenzie-coburg').name === 'McKenzie near Coburg', 'Coburg label');

const expectProjects = { 'lookout-point': 'LOP', 'hills-creek': 'HCR', dexter: 'DEX', 'green-peter': 'GPR', cougar: 'CGR', 'fern-ridge': 'FRN', 'cottage-grove': 'COT', dorena: 'DOR', 'fall-creek': 'FAL', 'blue-river': 'BLU' };
const hydro = ['LOP', 'HCR', 'DEX', 'GPR', 'CGR'];
const consLimits = {
  LOP: [825.0, 926.0, 113619, 438179], HCR: [1448.0, 1541.0, 155400, 350000], GPR: [922.0, 1010.0, 165628, 424402],
  CGR: [1532.0, 1690.0, 52200, 189000], COT: [750.0, 790.0, 3140, 31780], DOR: [770.5, 832.0, 7100, 72100], FRN: [353.0, 373.5, 2800, 97280]
};
check(H.projects.length === 10, '10 USACE projects');
['FAL', 'COT', 'DOR', 'FRN', 'BLU', 'CGR', 'LOP', 'DEX', 'HCR'].forEach((c) => check(H.projects.some((p) => p.code === c), 'required project present: ' + c));
H.projects.forEach((p) => {
  const pre = 'project ' + p.code + ': ';
  check(expectProjects[p.id] === p.code, pre + 'id/code');
  check(p.hydro === hydro.includes(p.code), pre + 'hydropower flag');
  // No invented operating values may remain in config.
  ['generationMW', 'capacityMW', 'units', 'unitsOnline', 'ruleCurveFt', 'elevationFt', 'inflowCfs', 'outflowCfs', 'minTargetCfs', 'floodStageFt', 'trend']
    .forEach((k) => check(!(k in p), pre + 'no invented field "' + k + '"'));
  check(p.series.elev.name === p.code + '.Elev-Forebay.Inst.0.0.MIXED-REV', pre + 'elevation series name');
  check(p.series.rule.name === p.code + '.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC', pre + 'rule-curve series name');
  const cbt = p.code === 'LOP' || p.code === 'GPR';
  check(p.series.out.name === (cbt ? p.code + '.Flow-Out.Ave.1Hour.1Hour.CBT-REV' : p.code + '.Flow-Out.Inst.0.0.MIXED-COMPUTED-REV'), pre + 'outflow series name');
  check(p.series.inflow.name === p.code + (cbt ? '.Flow-In.Ave.15Minutes.6Hours.CBT-COMPUTED-REV' : '.Flow-In.Ave.15Minutes.6Hours.MIXED-COMPUTED-REV'), pre + 'inflow series name');
  Object.values(p.series).forEach((sp) => { if (sp) check(!/Power|%-Full|Stor-Filled/.test(sp.name), pre + 'no restricted series ' + sp.name); });
  if (p.code === 'DEX') {
    check(p.cons === null && p.series.stor === null, 'DEX: no conservation pool / no storage series');
    check(p.powerPool.elevBottom === 690 && p.powerPool.elevTop === 695, 'DEX: power pool band 690-695');
  } else if (p.consFromLevels) {
    check(p.cons === null && !p.powerPool, pre + 'conservation limits read from CWMS levels at runtime');
    check(p.series.stor.name === p.code + '.Stor.Inst.0.0.MIXED-COMPUTED-REV', pre + 'storage series name');
  } else {
    const c = consLimits[p.code];
    check(p.cons.elevBottom === c[0] && p.cons.elevTop === c[1] && p.cons.storBottom === c[2] && p.cons.storTop === c[3], pre + 'CWMS conservation limits');
    check(p.series.stor.name === p.code + '.Stor.Inst.0.0.MIXED-COMPUTED-REV', pre + 'storage series name');
  }
  check(/^https:\/\//.test(p.sourceUrl) && p.apiUrl.includes(encodeURIComponent(p.series.elev.name)), pre + 'source links');
});

const ids = H.projects.concat(H.stations).map((e) => e.id);
check(new Set(ids).size === ids.length, 'ids unique');
const vb = H.basinMap.viewBox;
H.projects.concat(H.stations).forEach((e) => {
  check(e.map.x >= vb[0] && e.map.x <= vb[2] && e.map.y >= vb[1] && e.map.y <= vb[3], e.id + ': map node inside viewBox');
  check(H.basinMap.rivers.some((rv) => rv.points.some((pt) => pt[0] === e.map.x && pt[1] === e.map.y)), e.id + ': node lies on a river line');
});

// ---- 2. Pure helpers (fixtures, no network) --------------------------------
console.log('helpers');
const now = Date.UTC(2026, 9, 31, 0, 0);
const lop = H.projects.find((p) => p.code === 'LOP');
const pf = H.percentFull(lop, 70838.8);
check(pf.below && pf.clamped === 0 && pf.pct < 0, 'percentFull: below bottom of conservation clamps to 0 and flags below');
check(Math.abs(H.percentFull(lop, 438179).pct - 100) < 1e-9, 'percentFull: top = 100%');
check(H.percentFull(H.projects.find((p) => p.code === 'DEX'), 1000) === null, 'percentFull: n/a for Dexter');
check(H.freshness(now - 30 * 60e3, now) === 'fresh' && H.freshness(now - 4 * 3600e3, now) === 'stale' &&
  H.freshness(now - 13 * 3600e3, now) === 'very-stale' && H.freshness(null, now) === 'none', 'freshness thresholds 3 h / 12 h');
const rule = { t: [now - 86400e3, now + 3600e3], v: [880, 870] };
check(H.ruleToday(rule, now).v === 880, 'ruleToday picks latest daily value <= now');
check(H.interpolate(rule, now - 43200e3) > 870 && H.interpolate(rule, now - 43200e3) < 880, 'interpolate between daily rule values');
const mk = (elevV, ageH) => ({ elev: { t: [now - ageH * 3600e3], v: [elevV] }, rule });
check(H.reservoirStatus(lop, mk(860, 0.2), now).label === 'BELOW RULE CURVE', 'status: >10 ft below rule');
check(H.reservoirStatus(lop, mk(883, 0.2), now).label === 'ABOVE RULE CURVE', 'status: >2 ft above rule');
check(H.reservoirStatus(lop, mk(879, 0.2), now).level === 'normal', 'status: near rule');
check(H.reservoirStatus(lop, mk(879, 5), now).label === 'STALE', 'status: stale >3 h');
check(H.reservoirStatus(lop, mk(879, 13), now).level === 'low', 'status: red when >12 h');
check(H.reservoirStatus(lop, { elev: { t: [], v: [] } }, now).label === 'NO DATA', 'status: no data');
const usgsFixture = { value: { timeSeries: [
  { sourceInfo: { siteCode: [{ value: '14166000' }] }, variable: { variableCode: [{ value: '00060' }], unit: { unitCode: 'ft3/s' }, noDataValue: -999999 },
    values: [{ value: [{ value: '4190', dateTime: '2026-10-30T17:00:00.000-07:00', qualifiers: ['P'] }, { value: '-999999', dateTime: '2026-10-30T17:15:00.000-07:00', qualifiers: ['P'] }] }] }
] } };
const pu = H.parseUsgs(usgsFixture);
check(pu['14166000'].flow.v.length === 1 && pu['14166000'].flow.v[0] === 4190, 'parseUsgs drops -999999');
check(pu['14166000'].flow.t[0] === Date.UTC(2026, 9, 31, 0, 0) && pu['14166000'].flow.q[0] === 'P', 'parseUsgs time offset + qualifier');
check(Math.abs(H.cToF(12.9) - 55.22) < 1e-9, 'cToF');

// BPA parser incl. DST fall-back repeat hour
const bpaText = ['header', 'Date/Time       \tLoad\tVER\tHydro\tFossil/Biomass\tNuclear',
  '11/01/2026 01:55\t1\t2\t3000\t4\t5', '11/01/2026 01:00\t1\t2\t3100\t4\t5', '11/01/2026 01:05\t\t\t\t\t'].join('\r\n');
const bp = BPA.parseBpa(bpaText);
check(bp.rows.length === 2, 'BPA: empty future rows skipped');
check(bp.rows[0].iso === '2026-11-01T01:55:00-07:00' && bp.rows[1].iso === '2026-11-01T01:00:00-08:00', 'BPA: DST repeated hour mapped PDT then PST');
check(BPA.isoPacific(Date.UTC(2026, 6, 1, 19)) === '2026-07-01T12:00:00-07:00' && BPA.isoPacific(Date.UTC(2026, 11, 1, 20)) === '2026-12-01T12:00:00-08:00', 'BPA: isoPacific offsets');

// ---- 2b. CWMS levels: seasonal evaluator (hand-made fixture, LOP injunction shape) ---
console.log('levels');
{
  const ft = (m) => m / 0.3048;
  // Mimics LOP.Elev-Forebay.Inst.0.Injunction-Target (2025-02-01 version): origin Jan 1 08:00Z,
  // 12-month cycle, gaps (points without value), spring hold, fall drawdown, Dec deep pool.
  const fixture = { levels: [
    { 'location-level-id': 'LOP.Elev-Forebay.Inst.0.Injunction-Target', 'level-units-id': 'm', 'level-date': '2023-03-01T08:00:00Z',
      'interval-origin': '2023-01-01T08:00:00Z', 'interval-months': 12, 'interpolate-string': 'T',
      'seasonal-values': [{ value: 260, 'offset-months': 0, 'offset-minutes': 0 }, { value: 260, 'offset-months': 11, 'offset-minutes': 0 }] },
    { 'location-level-id': 'LOP.Elev-Forebay.Inst.0.Injunction-Target', 'level-units-id': 'm', 'level-date': '2025-02-01T08:00:00Z',
      'interval-origin': '2023-01-01T08:00:00Z', 'interval-months': 12, 'interpolate-string': 'T',
      'seasonal-values': [
        { 'offset-months': 0, 'offset-minutes': 0 },
        { value: 271.4244, 'offset-months': 2, 'offset-minutes': 14 * 1440 },   // Mar 15
        { value: 271.4244, 'offset-months': 3, 'offset-minutes': 14 * 1440 },   // Apr 15
        { 'offset-months': 3, 'offset-minutes': 15 * 1440 },                    // Apr 16: gap starts
        { value: 274.32, 'offset-months': 8, 'offset-minutes': 29 * 1440 },     // Sep 30: 900 ft
        { value: 251.46, 'offset-months': 9, 'offset-minutes': 30 * 1440 },     // Oct 31: 825 ft
        { value: 228.6, 'offset-months': 11, 'offset-minutes': 0 },             // Dec 1: 750 ft
        { value: 228.6, 'offset-months': 11, 'offset-minutes': 14 * 1440 },     // Dec 15
        { 'offset-months': 11, 'offset-minutes': 15 * 1440 }                    // Dec 16: gap
      ] },
    { 'location-level-id': 'LOP.Elev.Inst.0.Top of Dam', 'level-units-id': 'm', 'level-date': '1900-01-01T08:00:00Z', 'constant-value': 286.8168 },
    { 'location-level-id': 'LOP.Elev.Inst.0.Bottom of Flood', 'level-units-id': 'm', 'level-date': '1900-01-01T08:00:00Z', 'seasonal-values': [] },
    { 'location-level-id': 'LOP-BlackCanyon.Elev.Inst.0.Top of Dam', 'level-units-id': 'm', 'level-date': '1900-01-01T08:00:00Z', 'constant-value': 1 },
    { 'location-level-id': 'LOP.Flow.Inst.0.Min', 'level-units-id': 'cms', 'level-date': '1900-01-01T08:00:00Z', 'constant-value': 10 },
    { 'location-level-id': 'LOP.Elev.Inst.0.Step', 'level-units-id': 'm', 'level-date': '1900-01-01T08:00:00Z',
      'interval-origin': '2000-01-01T08:00:00Z', 'interval-months': 12, 'interpolate-string': 'F',
      'seasonal-values': [{ value: 100, 'offset-months': 0, 'offset-minutes': 0 }, { value: 200, 'offset-months': 6, 'offset-minutes': 0 }] }
  ] };
  const c = LV.compact(fixture, 'LOP', 0);
  const near = (a, b, tol) => a != null && Math.abs(a - b) <= (tol || 0.01);
  const at = (iso) => LV.valueAt(c, 'Elev-Forebay.Inst.0.Injunction-Target', Date.parse(iso));
  check(!('LOP-BlackCanyon' in c.levels) && !Object.keys(c.levels).some((k) => /BlackCanyon/.test(k)), 'levels: sub-location ids (LOP-...) excluded');
  check(!c.levels['Elev.Inst.0.Bottom of Flood'], 'levels: empty seasonal entries dropped');
  check(near(LV.constantAt(c, 'Elev.Inst.0.Top of Dam'), ft(286.8168)), 'levels: constant m -> ft');
  check(near(LV.constantAt(c, 'Flow.Inst.0.Min'), 353.147, 0.01), 'levels: cms -> cfs');
  check(LV.pick(c, 'Elev-Forebay.Inst.0.Injunction-Target', Date.parse('2024-06-01')).date === Date.parse('2023-03-01T08:00:00Z'), 'levels: picks version effective at the date');
  check(LV.pick(c, 'Elev-Forebay.Inst.0.Injunction-Target', Date.parse('2026-10-30')).date === Date.parse('2025-02-01T08:00:00Z'), 'levels: picks latest version <= date');
  check(near(at('2026-03-15T08:00:00Z'), ft(271.4244)) && near(at('2026-04-01T08:00:00Z'), ft(271.4244)), 'seasonal: knot value + flat hold (890.5 ft)');
  check(at('2026-03-01T08:00:00Z') === null, 'seasonal: before first valued knot (after Jan 1 gap) -> null');
  check(at('2026-07-01T08:00:00Z') === null, 'seasonal: inside gap (Apr 16 - Sep 30) -> null');
  check(at('2026-04-15T20:00:00Z') === null, 'seasonal: span ending at a gap knot -> null');
  const mid = at('2026-10-15T20:00:00Z');
  check(near(mid, 900 + (825 - 900) * ((Date.parse('2026-10-15T20:00:00Z') - Date.parse('2026-09-30T08:00:00Z')) / (Date.parse('2026-10-31T08:00:00Z') - Date.parse('2026-09-30T08:00:00Z'))), 0.01),
    'seasonal: linear interpolation between knots (Sep 30 -> Oct 31)');
  check(near(at('2026-12-10T08:00:00Z'), 750), 'seasonal: Dec deep pool 750 ft');
  check(at('2026-12-20T08:00:00Z') === null && at('2027-01-10T08:00:00Z') === null, 'seasonal: gap after Dec 16 wraps over new year -> null');
  check(near(at('2031-03-20T08:00:00Z'), ft(271.4244)), 'seasonal: repeats in later cycles');
  check(near(LV.valueAt(c, 'Elev.Inst.0.Step', Date.parse('2026-03-01T08:00:00Z')), ft(100)) &&
    near(LV.valueAt(c, 'Elev.Inst.0.Step', Date.parse('2026-09-01T08:00:00Z')), ft(200)), 'seasonal: interpolate-string F holds previous value (and wraps)');
  const ser = LV.seasonalSeries(LV.pick(c, 'Elev-Forebay.Inst.0.Injunction-Target', Date.parse('2026-10-30')), Date.parse('2026-09-01T08:00:00Z'), Date.parse('2026-12-31T08:00:00Z'));
  check(ser[0][1] === null && ser.some((p) => p[1] === null && p[0] > Date.parse('2026-12-15')) && ser.some((p) => near(p[1], 750)), 'seasonalSeries: knots + null breaks');
}

// ---- 2c. NWPS parsing (fixtures with sentinels) -----------------------------------
console.log('nwps');
{
  const g = NW.parseGauge({ lid: 'HARO3', name: 'Willamette River at Harrisburg', usgsId: '14166000',
    flood: { stageUnits: 'ft', categories: { action: { stage: 10.8, flow: 37000 }, minor: { stage: 14, flow: -9999 }, moderate: { stage: -9999, flow: -9999 }, major: { stage: 17, flow: 100000 } },
      crests: { historic: [{ occurredTime: '1943-01-01T00:00:00Z', stage: 21.1 }, { occurredTime: '1861-12-04T00:00:00Z', stage: 23 }, { occurredTime: '1999-01-01T00:00:00Z', stage: -999 }] } },
    status: { observed: { primary: 1.86, secondary: 4.19, secondaryUnit: 'kcfs', floodCategory: 'no_flooding', validTime: '2026-10-31T00:45:00Z' },
      forecast: { primary: -999, secondary: -999, floodCategory: 'fcst_not_current', validTime: '0001-01-01T00:00:00Z' } } });
  check(g.thresholds.action.stage === 10.8 && g.thresholds.moderate.stage === null && g.thresholds.minor.flow === null, 'nwps: -9999 thresholds -> null');
  check(g.observed.flow === 4190 && g.observed.category === 'none', 'nwps: kcfs -> cfs, no_flooding -> none');
  check(g.nwsForecastCategory === null, 'nwps: fcst_not_current -> no category');
  check(g.crests.length === 2 && g.crests[0].stage === 23, 'nwps: crests sorted, sentinels dropped');
  check(NW.categoryFor(12, g.thresholds) === 'action' && NW.categoryFor(15, g.thresholds) === 'minor' && NW.categoryFor(18, g.thresholds) === 'major' && NW.categoryFor(2, g.thresholds) === 'none', 'nwps: categoryFor');
  check(NW.parseGauge({ flood: { categories: { action: { stage: -9999 }, minor: { stage: -9999 }, moderate: { stage: -9999 }, major: { stage: -9999 } } }, status: {} }).thresholds === null, 'nwps: all -9999 -> no thresholds');
  check(NW.parseForecast({ issuedTime: '0001-01-01T00:00:00Z', data: [] }) === null, 'nwps: empty forecast -> null');
  const f = NW.parseForecast({ issuedTime: '2026-10-30T20:38:00Z', secondaryUnits: 'kcfs',
    data: [{ validTime: '2026-10-31T00:00:00Z', primary: 1.84, secondary: 4.16 }, { validTime: '2026-10-31T06:00:00Z', primary: 2.5, secondary: -999 }] });
  check(f.t.length === 2 && f.flow[0] === 4160 && f.flow[1] === null && f.stage[1] === 2.5, 'nwps: forecast parse + -999 -> null');
  const pk = NW.forecastPeak({ forecast: f, thresholds: g.thresholds }, Date.parse('2026-10-30T23:00:00Z'));
  check(pk.stage === 2.5 && pk.category === 'none', 'nwps: forecast peak + derived category');
  check(NW.LIDS['mckenzie-coburg'] === null && ['EUGO3', 'HARO3', 'VIDO3', 'JASO3', 'GOSO3'].every((l) => Object.values(NW.LIDS).includes(l)), 'nwps: LID map');
  check(NW.gaugeUrl('HARO3') === 'https://water.noaa.gov/gauges/HARO3', 'nwps: gauge link');
}

// ---- 2d. Teacup pure helpers ---------------------------------------------------------
console.log('teacup');
{
  const near = (a, b, tol) => a != null && Math.abs(a - b) <= (tol || 1e-6);
  const pf = TC.percentFull(70838.8, 113619, 438179);
  check(pf.below && pf.clamped === 0 && near(pf.pct, -13.18, 0.01), 'teacup: percentFull below bottom (LOP-like) clamps to 0');
  check(near(TC.percentFull(30218.5, 2800, 97280).pct, 29.02, 0.01), 'teacup: percentFull FRN-like 29.0 %');
  check(TC.percentFull(500, 100, 300).above && TC.percentFull(500, 100, 300).clamped === 100, 'teacup: percentFull above top clamps to 100');
  check(TC.percentFull(null, 1, 2) === null && TC.percentFull(5, 2, 2) === null, 'teacup: percentFull guards');
  check(TC.elevFraction(800, 825, 926) === 0 && near(TC.elevFraction(875.5, 825, 926), 0.5) && TC.elevFraction(999, 825, 926) === 1, 'teacup: elevFraction clamps');
  check(TC.ruleDelta(800.4, 875, 10, 2).status === 'below' && near(TC.ruleDelta(800.4, 875, 10, 2).delta, -74.6, 1e-9), 'teacup: ruleDelta below');
  check(TC.ruleDelta(693.2, 690.3, 10, 2).status === 'above', 'teacup: ruleDelta above (>2 ft)');
  check(TC.ruleDelta(363.6, 363.8, 10, 2).status === 'near' && TC.ruleDelta(870, 875, 10, 2).status === 'near', 'teacup: ruleDelta near band');
  check(TC.ruleDelta(null, 875, 10, 2).status === null, 'teacup: ruleDelta no data');

  // next target changes on a fixture shaped like the LOP injunction target (values in ft)
  const entry = { date: 0, unit: 'ft', s: { o: Date.parse('2023-01-01T08:00:00Z'), m: 12, i: true, p: [
    [0, 0, null], [2, 14 * 1440, 890.5], [3, 14 * 1440, 890.5], [3, 15 * 1440, null],
    [8, 29 * 1440, 900], [9, 30 * 1440, 825], [11, 0, 750], [11, 14 * 1440, 750], [11, 15 * 1440, null]] } };
  const ch = TC.nextTargetChanges(entry, Date.parse('2026-10-30T12:00:00Z'), 3);
  check(ch.length === 3 && ch[0].v === 825 && ch[0].t === Date.parse('2026-10-31T08:00:00Z'), 'teacup: next change 1 = 825 ft on Oct 31');
  check(ch[1].v === 750 && ch[1].t === Date.parse('2026-12-01T08:00:00Z'), 'teacup: next change 2 = 750 ft on Dec 1 (Dec 15 hold skipped)');
  check(ch[2].v === null && ch[2].t === Date.parse('2026-12-16T08:00:00Z'), 'teacup: next change 3 = target ends Dec 16');
  const ch2 = TC.nextTargetChanges(entry, Date.parse('2026-12-20T12:00:00Z'), 2);
  check(ch2[0].v === 890.5 && ch2[0].t === Date.parse('2027-03-15T08:00:00Z') && ch2[1].v === null, 'teacup: next changes wrap into next year');
  check(TC.nextTargetChanges({ date: 0, unit: 'ft', c: 900 }, Date.now(), 3).length === 0, 'teacup: constant level has no changes');

  // ruler scale
  const sc = TC.rulerScale({ hi: 945, lo: 795, floor: 688, top: 18, bottom: 540 });
  check(sc.broken, 'teacup: ruler breaks when streambed is far below focus range');
  check(near(sc.y(945), 18) && near(sc.y(688), 540), 'teacup: ruler endpoints map to top/bottom');
  check(sc.y(900) < sc.y(850) && sc.y(850) < sc.y(795) && sc.y(795) < sc.y(700), 'teacup: ruler monotonic (higher elevation = higher on screen)');
  const pxPerFtFocus = (sc.y(800) - sc.y(900)) / 100, pxPerFtBreak = (sc.y(688) - sc.y(795)) / 107;
  check(pxPerFtFocus > 3 * pxPerFtBreak, 'teacup: focus span gets more px/ft than the compressed span');
  check(sc.ticks.length >= 3 && sc.ticks.every((t) => t >= sc.lo - 1e-9 && t <= 945 + 1e-9), 'teacup: ruler ticks inside focus range');
  const sc2 = TC.rulerScale({ hi: 1550, lo: 1440, floor: 1430, top: 0, bottom: 100 });
  check(!sc2.broken && near(sc2.y(1430), 100) && near(sc2.y(1550), 0), 'teacup: no break when floor is near; linear to floor');
  const sp = TC.spreadLabels([{ y: 100 }, { y: 101 }, { y: 103 }, { y: 300 }], 14, 0, 400);
  check(sp.every((it, i) => !i || it.ly - sp[i - 1].ly >= 14 - 1e-6) && sp[3].ly === 300, 'teacup: labels spread >= gap, far label untouched');
  const sp2 = TC.spreadLabels([{ y: 2 }, { y: 3 }], 14, 0, 400);
  check(sp2[0].ly >= 0 && sp2[1].ly - sp2[0].ly >= 14 - 1e-6, 'teacup: spread respects min bound');

  const yr = TC.annualSeries(entry, 2026);
  check(yr.length === 365 && yr.some((p) => p[1] === null) && yr.some((p) => p[1] === 750), 'teacup: annualSeries 365 daily points with gaps');
  const cl = TC.consLimits(null, { cons: { elevBottom: 825, elevTop: 926, storBottom: 1, storTop: 2 } });
  check(cl.elevBottom === 825 && !cl.fromLevels, 'teacup: consLimits falls back to project constants');
}

// ---- 2e. Ratings (fixtures) -----------------------------------------------------------
console.log('ratings');
{
  const near = (a, b, tol) => a != null && Math.abs(a - b) <= (tol || 1e-6);
  // simple-rating as ARRAY (several versions); rating-points as {point:[...]} with string numbers
  const arr = { 'rating-template': {}, 'simple-rating': [
    { 'rating-spec-id': 'X.Elev-Forebay;Stor.Standard.CENWP', 'units-id': 'ft;ac-ft', 'effective-date': '1988-01-01T02:00:00Z', 'create-date': '2022-04-14T20:47:00Z', 'rating-points': { point: [{ ind: '700.0', dep: '100.0' }, { ind: '710.0', dep: '300.0' }] } },
    { 'rating-spec-id': 'X.Elev-Forebay;Stor.Standard.CENWP', 'units-id': 'ft;ac-ft', 'effective-date': '2014-01-01T02:00:00Z', 'create-date': '2022-04-14T20:47:00Z', 'rating-points': { point: [{ ind: '710.0', dep: '500.0' }, { ind: '700.0', dep: '200.0' }, { ind: '720.0', dep: '900.0' }] } },
    { 'rating-spec-id': 'X', 'units-id': 'ft;ac-ft', 'effective-date': '2099-01-01T00:00:00Z', 'rating-points': { point: [{ ind: '1', dep: '1' }] } }] };
  const a = RT.parseCwms(arr, Date.parse('2026-10-30'));
  check(a.kind === '1d' && a.versions === 3 && a.effective === Date.parse('2014-01-01T02:00:00Z'), 'ratings: array form -> latest version <= today (future version ignored)');
  check(a.xs.join() === '700,710,720' && a.ys.join() === '200,500,900', 'ratings: string points parsed and sorted by ind');
  // simple-rating as OBJECT
  const obj = RT.parseCwms({ 'simple-rating': { 'units-id': 'ft;cfs', 'effective-date': '1954-01-01T02:00:00Z', 'rating-points': { point: [{ ind: '889.0', dep: '1610.0' }, { ind: '890.0', dep: '3010.0' }] } } });
  check(obj.kind === '1d' && obj.xs.length === 2 && obj.units === 'ft;cfs', 'ratings: object form');
  // 2-D: array of {other-ind, point}; a single-point curve serialized as an object
  const two = RT.parseCwms({ 'simple-rating': { 'units-id': 'ft,ft;cfs', 'effective-date': '1954-01-01T02:00:00Z', 'rating-points': [
    { 'other-ind': { position: '1', value: '1.0' }, point: [{ ind: '800', dep: '100' }, { ind: '900', dep: '200' }] },
    { 'other-ind': { position: '1', value: '2.0' }, point: [{ ind: '800', dep: '300' }, { ind: '900', dep: '500' }] },
    { 'other-ind': { position: '1', value: '0.5' }, point: { ind: '850', dep: '40' } }] } });
  check(two.kind === '2d' && two.others.join() === '0.5,1,2' && !two.transposed && two.curves[0].xs.length === 1, 'ratings: 2-D parse, openings sorted, single-point object curve');
  check(near(RT.interp2d(two, 1.5, 850).y, 275) && near(RT.interp2d(two, 1, 850).y, 150), 'ratings: 2-D interpolation between and on opening curves');
  check(RT.interp2d(two, 3, 850).out === 'above-opening', 'ratings: 2-D opening out of range flagged');
  // 2-D published with swapped axes (other-ind holds elevations) -> transposed
  const sw = RT.parseCwms({ 'simple-rating': { 'units-id': 'ft,ft;cfs', 'effective-date': '2000-01-01T00:00:00Z', 'rating-points': [
    { 'other-ind': { position: '1', value: '1658.0' }, point: [{ ind: '0.25', dep: '70' }, { ind: '0.5', dep: '140' }] },
    { 'other-ind': { position: '1', value: '1660.0' }, point: [{ ind: '0.25', dep: '90' }, { ind: '0.5', dep: '180' }] }] } });
  check(sw.transposed && sw.others.join() === '0.25,0.5' && sw.curves[1].xs.join() === '1658,1660' && sw.curves[1].ys.join() === '140,180', 'ratings: swapped 2-D axes detected and transposed');
  let threw = false; try { RT.parseCwms({ message: 'Failed to process request' }); } catch (e) { threw = true; }
  check(threw, 'ratings: error payload rejected');

  // USGS RDB (exsa) with comments, header, format row, STOR flag
  const rdb = ['# //WARNING The stage-discharge rating provided in this file should be', '# //RATING SHIFTED="20260603161002 PST"',
    '# //RATING ID="32.0" TYPE="STGQ" NAME="stage-discharge" AGING=????', 'INDEP\tSHIFT\tDEP\tSTOR', '16N\t16N\t16N\t1S',
    '1.00\t0.30\t2800.00\t', '1.01\t0.30\t2815.50\t*', '1.02\t0.30\t2831.00\t', ''].join('\n');
  const u = RT.parseUsgsRdb(rdb);
  check(u.xs.join() === '1,1.01,1.02' && u.ys[1] === 2815.5 && u.shift[0] === 0.3, 'ratings: USGS rdb rows parsed (format row skipped)');
  check(u.ratingId === '32.0' && u.shifted === '2026-06-03' && !u.baseOnly, 'ratings: USGS rating id + shift date');
  check(RT.parseUsgsRdb('# //WARNING This rating does not include any shifts that may have been\nINDEP\tSHIFT\tDEP\tSTOR\n16N\t16N\t16N\t1S\n').baseOnly &&
    RT.parseUsgsRdb('# nothing here\n').xs.length === 0, 'ratings: base-only flag; empty file -> no rows');
  // gage height is looked up directly (DEP already includes the shift; verified against live NWIS)
  check(near(RT.interp(u.xs, u.ys, 1.005).y, 2807.75), 'ratings: USGS lookup by gage height (no extra shift)');

  // interpolation
  check(near(RT.interp([700, 710, 720], [200, 500, 900], 705).y, 350) && RT.interp([700, 710], [1, 2], 710).y === 2, 'ratings: forward interpolation');
  check(RT.interp([700, 710], [1, 2], 699).out === 'below' && RT.interp([700, 710], [1, 2], 711).out === 'above', 'ratings: out of range flagged');
  check(near(RT.inverse([700, 710, 720], [200, 500, 900], 700).x, 715), 'ratings: reverse interpolation');
  check(RT.inverse([1, 2, 3], [5, 4, 6], 4.5).notMonotonic, 'ratings: reverse refused when not monotonic');
  check(RT.nearestIndex([1, 2, 3, 4], 2.6) === 2, 'ratings: nearest row');
  const csvExpected = 'A (ft),"B, ""x""' + '"\r\n1,"a,b"\r\n2,\r\n';
  check(RT.toCSV(['A (ft)', 'B, "x"'], [[1, 'a,b'], [2, null]]) === csvExpected, 'ratings: CSV quoting');
  check(RT.cwmsUrl('LOP.Elev-Forebay;Stor.Standard.CENWP') === 'https://cwms-data.usace.army.mil/cwms-data/ratings/LOP.Elev-Forebay%3BStor.Standard.CENWP?office=NWDP' &&
    RT.cwmsUrl('LOP-RegulatingOutlets.Opening,Elev-Forebay;Flow.Standard.CENWP').includes('Opening%2CElev-Forebay%3BFlow'), 'ratings: ids URL-encoded (; and ,)');
  check(RT.cwmsDefs('area', 'DEX').length === 0 && RT.cwmsDefs('area', 'LOP').length === 1 && RT.cwmsDefs('storage', 'DEX').length === 1, 'ratings: catalog (no DEX area)');
  const allR = RT.allDefs();
  check(allR.filter((d) => d.group === 'storage').length === 10 && allR.filter((d) => d.group === 'area').length === 9 &&
    allR.filter((d) => d.key === 'spillway').length === 8 && allR.filter((d) => d.group === 'usgs').length === 14, 'ratings: catalog counts storage 10 / area 9 / spillway 8 / USGS 14 (6 river gauges + 8 below-dam gages)');
}

// ---- 2f. TDG, SNOTEL, ODEQ (fixtures) -----------------------------------------------------
console.log('tdg / snotel / odeq');
{
  const TD = require('./js/tdg.js'), SN = require('./js/snotel.js');
  const p = TD.parse({ units: '%', values: [[1793300400000, 107, 0], [1793296800000, 106, 0], [1793304000000, null, 0]] });
  check(p.t.length === 2 && p.t[0] < p.t[1] && p.v.join() === '106,107', 'tdg: parse sorts and drops nulls');
  check(TD.level(110) === 'ok' && TD.level(110.1) === 'over' && TD.level(null) === null, 'tdg: >110 % flagged, 110 itself is not');
  check(H.cwmsUrl(TD.SERIES.DEX.name, '%', 0, 1).includes('name=DEXO.%25-Saturation-TDG') && H.cwmsUrl(TD.SERIES.DEX.name, '%', 0, 1).includes('unit=%25'), 'tdg: % URL-encoded in name and unit');
  const chip = TD.chipHTML('CGR', { series: { t: [Date.now() - 7200e3, Date.now() - 3600e3], v: [109, 111.5], name: 'x' } }, () => 'T', Date.now());
  check(/tdg-over/.test(chip) && /111\.5/.test(chip) && chip.includes(TD.REF_LABEL) && /CWMS reported, provisional/.test(chip), 'tdg: chip over 110 coloured, labelled, reference text');
  check(/no data/.test(TD.chipHTML('DEX', { series: { t: [], v: [] }, error: 'no data' })) && TD.chipHTML('LOP', {}) === '', 'tdg: no-data chip; no chip for projects without TDG');
  check(TD.REF_LABEL === '110% - Oregon/EPA TDG standard (reference)', 'tdg: reference label text');

  const sj = SN.parse([{ stationTriplet: '388:OR:SNTL', data: [
    { stationElement: { elementCode: 'WTEQ', storedUnitCode: 'in' }, values: [{ date: '2026-10-28', value: 0 }, { date: '2026-10-29', value: 0.1 }] },
    { stationElement: { elementCode: 'SNWD', storedUnitCode: 'in' }, values: [{ date: '2026-10-29', value: 0 }] },
    { stationElement: { elementCode: 'PREC', storedUnitCode: 'in' }, values: [{ date: '2026-10-29', value: 0.8 }] }] },
    { stationTriplet: '729:OR:SNTL', data: [{ stationElement: { elementCode: 'WTEQ' }, values: [{ date: '2026-10-29', value: null }] }] }]);
  check(sj['388:OR:SNTL'].swe.v.join() === '0,0.1' && sj['388:OR:SNTL'].depth.v[0] === 0 && sj['388:OR:SNTL'].last === '2026-10-29', 'snotel: parse SWE/depth, zeros kept, last date');
  check(sj['729:OR:SNTL'].swe.v.length === 0 && sj['729:OR:SNTL'].last === null, 'snotel: null values dropped');
  check(SN.STATIONS.length === 8 && SN.STATIONS.every((s) => /^\d+:OR:SNTL$/.test(s.triplet) && s.elevFt > 0), 'snotel: 8 Oregon SNOTEL stations configured');
  check(/stationTriplets=388:OR:SNTL,/.test(SN.url(9, Date.UTC(2026, 9, 30))) && /beginDate=2026-10-21&endDate=2026-10-30/.test(SN.url(9, Date.UTC(2026, 9, 30))) && /elements=WTEQ,SNWD/.test(SN.url()), 'snotel: request URL');

  // ODEQ 2006 TMDL target: monthly steps (interpolate-string F), degC -> degF
  const odeq = LV.compact({ levels: [{ 'location-level-id': 'DEX.Temp-Water.Inst.0.ODEQ-2006TMDL-Target', 'level-units-id': 'C', 'level-date': '2012-01-01T08:00:00Z',
    'interval-origin': '2012-01-01T08:00:00Z', 'interval-months': 12, 'interpolate-string': 'F',
    'seasonal-values': [{ 'offset-months': 0, 'offset-minutes': 0 }, { value: 6.5, 'offset-months': 3, 'offset-minutes': 0 }, { value: 10.222, 'offset-months': 9, 'offset-minutes': 0 }, { 'offset-months': 11, 'offset-minutes': 0 }] }] }, 'DEX');
  const ov = LV.valueAt(odeq, LV.IDS.odeqTemp, Date.parse('2026-10-30T20:00:00Z'));
  check(ov === 10.222 && Math.abs(H.cToF(ov) - 50.4) < 0.05, 'odeq: step value today 10.222 °C = 50.4 °F');
  check(LV.valueAt(odeq, LV.IDS.odeqTemp, Date.parse('2026-12-15T20:00:00Z')) === null && LV.valueAt(odeq, LV.IDS.odeqTemp, Date.parse('2026-06-15T20:00:00Z')) === 6.5, 'odeq: winter gap null; held value mid-year');
  check(/ODEQ_AT = \{\s*'middle-fork-jasper'/.test(fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8')) && !/'coast-fork-goshen': \{ code/.test(fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8')),
    'odeq: target drawn for Jasper only (not Goshen)');
}

// ---- 2g. Hourly Snapshot + long-range history (fixtures) ---------------------------------
console.log('snapshot / history');
{
  const SN = require('./js/snapshot.js');
  const HI = require('./js/history.js');
  const keys = [].concat(...SN.GROUPS.map((g) => g.items.map((it) => it.key)));
  check(SN.GROUPS.map((g) => g.code).join() === 'HCR,LOP,DEX,CGR', 'snapshot: groups HCR, LOP, DEX, CGR in order');
  check(keys.join() === 'HCR.elev,HCR.tw,HCRO,LOP.elev,DEX.fb,DEX.tw,DEXO,CGR.fb,CGR.tw,CGRO', 'snapshot: the 10 requested values');
  const item = (k) => [].concat(...SN.GROUPS.map((g) => g.items)).find((it) => it.key === k);
  check(item('HCRO').main.site === '14145500' && item('DEXO').main.site === '14150000' && item('CGRO').main.site === '14159500', 'snapshot: HCRO/DEXO/CGRO = USGS 14145500/14150000/14159500');
  check(item('DEX.tw').main.name === 'DEX.Elev-Tailwater.Inst.0.0.MIXED-REV' && item('LOP.elev').main.name === 'LOP.Elev-Forebay.Inst.0.0.MIXED-REV', 'snapshot: CWMS series ids');
  check(item('HCR.tw').main.site === '14145110' && item('CGR.tw').main.site === '14159410' && item('HCR.tw').main.param === '00065' && !item('HCR.tw').none && !item('CGR.tw').none, 'snapshot: HCR/CGR tailwater = USGS dam tailwater gages 14145110/14159410 (datum 0 ft NGVD29)');
  {
    const st = SN.state, it = item('HCRO'), hr = Date.parse('2026-10-31T04:00:00Z');
    st.series['usgs:14145500:00060'] = { t: [hr - 900e3, hr, hr + 900e3], v: [900, 1000, 1100] };
    st.series['usgs:14145500:00065'] = { t: [hr - 900e3, hr, hr + 900e3], v: [2.9, 3.0, 3.1] };
    const a = SN.shown(SN.itemModel(it, hr + 20 * 60e3));
    check(a.hour && a.v === 1000 && a.sub === 3.0 && a.t === hr, 'snapshot: one value = the :00 reading (with its stage) once published');
    const b = SN.shown(SN.itemModel(it, hr + 3600e3 + 5 * 60e3));
    check(!b.hour && b.v === 1100 && b.sub === 3.1 && b.t === hr + 900e3, 'snapshot: :00 not yet published -> latest, marked as latest');
    check(/\[latest /.test(SN.groupText(SN.GROUPS[0], hr + 3600e3 + 5 * 60e3)) && !/\[latest /.test(SN.groupText(SN.GROUPS[0], hr + 20 * 60e3).split('HCRO')[1]), 'snapshot: copy text labels latest only when :00 is missing');
    delete st.series['usgs:14145500:00060']; delete st.series['usgs:14145500:00065'];
  }
  const t20 = Date.parse('2026-10-31T03:00:00Z'); // 20:00 PDT
  check(SN.topOfHour(t20 + 47 * 60e3) === t20, 'snapshot: top of hour');
  check(SN.nextPollAt(Date.parse('2026-10-31T03:47:12Z')) === Date.parse('2026-10-31T03:50:40Z'), 'snapshot: next poll on the 5-minute mark + 40 s');
  check(SN.nextPollAt(Date.parse('2026-10-31T03:45:40Z')) === Date.parse('2026-10-31T03:50:40Z'), 'snapshot: poll exactly on a mark schedules the next one');
  const ser = { t: [t20 - 3600e3, t20 - 900e3, t20, t20 + 900e3], v: [1, 2, 3, 4] };
  const hv = SN.hourValue(ser, t20 + 40 * 60e3);
  check(hv.v === 3 && !hv.pending, 'snapshot: :00 value is the reading stamped exactly at the hour');
  const hp = SN.hourValue({ t: [t20 - 3600e3, t20 - 900e3], v: [1, 2] }, t20 + 10 * 60e3);
  check(hp.pending && hp.v === 1 && hp.prevT === t20 - 3600e3, 'snapshot: :00 not yet published -> pending, previous hour shown');
  check(SN.ageClass(t20, t20 + 30 * 60e3) === 'ok' && SN.ageClass(t20, t20 + 60 * 60e3) === 'lag' && SN.ageClass(t20, t20 + 120 * 60e3) === 'stale' && SN.ageClass(null, t20) === 'none', 'snapshot: age classes 45/90 min');
  const pc = SN.parseCwms({ values: [[2, 5, 0], [1, null, 0], [1, 4, 0]] });
  check(pc.t.join() === '1,2' && pc.v.join() === '4,5', 'snapshot: CWMS parse drops nulls, sorts');
  const pu2 = SN.parseUsgs({ value: { timeSeries: [{ sourceInfo: { siteCode: [{ value: '14150000' }] }, variable: { variableCode: [{ value: '00060' }], noDataValue: -999999 },
    values: [{ value: [{ value: '1250', dateTime: '2026-10-30T20:00:00.000-07:00' }, { value: '-999999', dateTime: '2026-10-30T20:05:00.000-07:00' }] }] }] } });
  check(pu2['usgs:14150000:00060'].v.join() === '1250' && pu2['usgs:14150000:00060'].t[0] === t20, 'snapshot: USGS parse keyed by site+param, no-data dropped');
  check(/sites=14145100,14145500|parameterCd=/.test(SN.usgsUrl()) && /period=PT3H/.test(SN.usgsUrl()), 'snapshot: one USGS request, last 3 h');
  // history
  check(HI.RANGES['30d'] === 30 && HI.RANGES['6m'] === 182 && HI.RANGES['1y'] === 365, 'history: ranges 30 D / 6 MO / 1 YR');
  check(Object.keys(HI.LAKE_SITE).length === 8 && HI.LAKE_SITE.LOP === '14149000' && HI.LAKE_SITE.FRN === '14168000', 'history: USGS lake gage for all 8 projects');
  check(HI.pacificMidnight(2026, 11, 1) === Date.parse('2026-11-01T07:00:00Z') && HI.pacificMidnight(2026, 12, 1) === Date.parse('2026-12-01T08:00:00Z'), 'history: Pacific midnight (PDT and PST)');
  check(HI.dvTime('2026-10-29T00:00:00.000', true) === Date.parse('2026-10-30T07:00:00Z'), 'history: USGS 24:00 observation stamped at end of day');
  const mt = HI.monthTicks(Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'));
  check(mt.map((o) => o.m).join() === '5,6,7,8,9,10' && mt[0].t === Date.parse('2026-05-01T07:00:00Z'), 'history: monthly ticks at Pacific month starts');
  const wk = HI.dayTicks(Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'), true);
  check(wk.every((o) => o.dow === 1) && wk.length === 4 && wk[0].t === Date.parse('2026-10-05T07:00:00Z'), 'history: weekly ticks on Mondays');
  const bm = HI.bucketMean({ t: [0, 1000, 3600e3, 3600e3 + 1], v: [1, 3, 10, 20] }, 3600e3);
  check(bm.t.join() === '1800000,5400000' && bm.v.join() === '2,15', 'history: bucket means');
  const al = HI.appendLive({ t: [1, 2], v: [1, 2] }, { t: [1, 2, 3600e3 * 5, 3600e3 * 5 + 10], v: [9, 9, 4, 6] });
  check(al.t.length === 3 && al.v[2] === 6 && al.t[2] === 3600e3 * 5 + 10, 'history: live points appended after the history, last reading per hour (real timestamps)');
  const html2 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check(html2.indexOf('id="snapshot"') > html2.indexOf('</header>') && html2.indexOf('id="snapshot"') < html2.indexOf('class="tabs routes"'), 'snapshot: strip sits above the page tabs (every page)');
  check(['24h', '7d', '30d', '6m', '1y'].every((r) => html2.includes('data-range="' + r + '"')), 'trend: 24 H, 7 D, 30 D, 6 MO, 1 YR buttons');
  check(html2.indexOf('js/snapshot.js') > html2.indexOf('js/data.js') && html2.indexOf('js/history.js') < html2.indexOf('js/views/teacup.js'), 'script order: snapshot/history after data, before views');
  const tcs = fs.readFileSync(path.join(__dirname, 'js', 'views', 'teacup.js'), 'utf8');
  check(/data-open-trend/.test(tcs) && !/renderAnnual/.test(tcs), 'teacup: lake chart moved to the Trend Recorder (Open in Trend Recorder button)');
}

// ---- 2d. Storage / drawdown calculator (js/drawdown.js) ------------------------
console.log('drawdown calculator');
{
  const D = require('./js/drawdown.js');
  const close = (a, b, e) => Math.abs(a - b) <= e;
  check(close(D.AF_PER_CFS_HR, 0.082645, 1e-6) && D.FT3_PER_AF === 43560, 'calc: 1 cfs·hr = 0.082645 ac-ft, 1 ac-ft = 43,560 ft³');

  // Interpolation on an elevation–storage table, both directions; out of range is an error.
  const rt = D.makeRating([800, 850, 900], [0, 40000, 100000]);
  check(rt.stor(825) === 20000 && rt.stor(850) === 40000 && rt.stor(875) === 70000, 'calc: elevation -> storage (linear)');
  check(rt.elev(20000) === 825 && rt.elev(70000) === 875 && rt.elev(100000) === 900, 'calc: storage -> elevation (linear)');
  const throws = (f) => { try { f(); return false; } catch (e) { return e instanceof RangeError && /outside/.test(e.message); } };
  check(throws(() => rt.stor(799.9)) && throws(() => rt.stor(900.1)) && throws(() => rt.elev(-1)) && throws(() => rt.elev(100001)), 'calc: out-of-table values are errors');

  // Calculator 1 acceptance values.
  const c1 = D.convert({ volume: 1000, netFlow: 700 });
  check(c1.hours.toFixed(2) === '17.29', 'calc1: 1000 ac-ft @ 700 cfs net -> 17.29 hr');
  check(c1.steps[0] === '1,000 ac-ft × 43,560 = 43,560,000 ft³ ÷ 700 cfs = 62,229 s = 17.29 hr', 'calc1: math steps shown');
  check(D.convert({ volume: 1000, netFlow: 1200 }).hours.toFixed(2) === '10.08', 'calc1: 1000 ac-ft @ 1200 cfs net -> 10.08 hr');
  check(D.convert({ volume: 1000, outflow: 1500, inflow: 800 }).hours.toFixed(2) === '17.29', 'calc1: net flow = outflow − inflow');
  check(close(D.convert({ netFlow: 700, hours: 24 }).volume, 700 * 24 * 0.0826446, 0.01) && close(D.convert({ volume: 1000, hours: 10 }).netFlow, 1210, 0.01), 'calc1: solves for volume and for flow');
  const c1e = D.convert({ volume: 4000, netFlow: 1000, startElev: 850, rating: rt });
  check(c1e.elev.storStart === 40000 && c1e.elev.storEnd === 36000 && close(c1e.elev.end, 845, 1e-9) && close(c1e.elev.change, -5, 1e-9), 'calc1: elevation change from the starting pool (800 ac-ft/ft below 850)');
  const bad = (o) => { try { D.convert(o); return false; } catch (e) { return true; } };
  check(bad({ volume: 1000 }) && bad({ volume: 1000, netFlow: 700, hours: 3 }) && bad({ volume: 1000, netFlow: -700 }), 'calc1: needs exactly two inputs with consistent signs');

  // Calculator 2, hand-checked: linear table 800-900 ft <-> 0-100,000 ac-ft (1,000 ac-ft/ft),
  // S0 = 50,000, inflow 500 cfs, Q0 = Q_end = 500, ramps 100 cfs/hr, 24 h, 1-h steps.
  // With Qp = 1,000: outflows 500..900 (5 h), 1,000 x 14 h, then 1,000..600 (5 h)
  // = 21,500 cfs·h; inflow 12,000; net 9,500 cfs·h = 785.12 ac-ft.
  const lin = D.makeRating([800, 900], [0, 100000]);
  const t0 = Date.UTC(2026, 10, 10, 8), HR = 3600e3;
  const St = 50000 - 9500 * D.AF_PER_CFS_HR;
  const base = { rating: lin, S0: 50000, St, t0, tEnd: t0 + 24 * HR, Q0: 500, inflow: 500, ru: 100, rd: 100, Qmin: 300, Qmax: 3000, dtHr: 1 };
  const p1 = D.plan(base);
  check(p1.status === 'ok' && close(p1.Qp, 1000, 1), 'calc2: plateau 1,000 cfs (bisection) — got ' + (p1.Qp && p1.Qp.toFixed(2)));
  check(close(p1.Sfinal, St, 1) && close(p1.Efinal, 849.2149, 0.002), 'calc2: ends at target storage (±1 ac-ft) / 849.21 ft');
  check(p1.tPlateau === t0 + 5 * HR && p1.tRampDown === t0 + 19 * HR && p1.schedule.length === 25, 'calc2: plateau at +5 h, ramp-down at +19 h, 24 hourly steps');
  check(p1.schedule.slice(0, 6).map((r) => Math.round(r.O)).join() === '500,600,700,800,900,1000' && Math.round(p1.schedule[23].O) === 600, 'calc2: ramp-limited trapezoid steps');
  check(close(p1.netReleased, 785.12, 0.5) && close(p1.released, 21500 * D.AF_PER_CFS_HR, 1), 'calc2: total and net volume released');
  check(/^Ramp up from 500 to 1,000 cfs at 100 cfs\/hr by \d\d:00, hold until \d\d:00, ramp down to 500 cfs by \d\d:00/.test(p1.plain), 'calc2: plain-language line — ' + p1.plain);
  check(p1.belowMin.length === 0 && p1.label === D.LABEL && /Planning aid/.test(D.LABEL), 'calc2: no min-flow flags; planning-aid label');

  // Infeasible: max outflow 700 cfs. Net per hour at the plateau is 200 cfs, so
  // 9,500 cfs·h needs 400 + 200 (T − 4) >= 9,500 -> T = 50 h.
  const p2 = D.plan(Object.assign({}, base, { Qmax: 700 }));
  check(p2.status === 'infeasible-max' && !p2.ok, 'calc2: infeasible target reported');
  check(close(p2.Efinal, 849.636, 0.001), 'calc2: elevation reached at the deadline (849.64 ft)');
  check(p2.earliest === t0 + 50 * HR, 'calc2: earliest achievable time = +50 h');

  // Ramps alone exceed the window; overshoot below target; minimum-flow flag; rounding; 15-min steps.
  const p3 = D.plan(Object.assign({}, base, { Qend: 3000, Qmax: 4000 }));
  check(p3.status === 'ramp-window' && /longer than the 24\.00 hr window/.test(p3.messages[0]), 'calc2: ramp segments longer than the window reported');
  check(D.plan(Object.assign({}, base, { St: 49990, Qmin: 1500, Qmax: 3000 })).status === 'infeasible-min', 'calc2: even the minimum plateau overshoots below target');
  const p4 = D.plan(Object.assign({}, base, { Qmin: 600 }));
  check(p4.belowMin.join() === '0' && p4.messages.some((m) => /below the 600 cfs minimum/.test(m)), 'calc2: steps below min outflow flagged');
  const p5 = D.plan(Object.assign({}, base, { roundTo: 50, St: St - 10 }));
  check(p5.Qp % 50 === 0, 'calc2: plateau rounded to 50 cfs steps');
  const p6 = D.plan(Object.assign({}, base, { dtHr: 0.25 }));
  check(p6.schedule.length === 97 && close(p6.Sfinal, St, 1), 'calc2: 15-minute steps');
  check(D.parseSeries('900\n920, \n2026-11-10 03:00, 1,050\n\n') .join() === '900,920,1050', 'calc2: pasted hourly inflow series');
  const p7 = D.plan(Object.assign({}, base, { inflow: [500, 500, 600] }));
  check(p7.schedule[2].I === 600 && p7.schedule[10].I === 600 && p7.Qend === 600, 'calc2: hourly inflow series, last value held; Q_end defaults to inflow at target');
  // Ending outflow never below the minimum: inflow 259 at the target, min 600 -> ramp down to 600, not 259.
  const pMinEnd = D.plan(Object.assign({}, base, { inflow: 259, Q0: 900, Qmin: 600, Qmax: 3000, St: 49500 }));
  check(pMinEnd.Qend === 600 && pMinEnd.belowMin.length === 0 && Math.round(pMinEnd.schedule[pMinEnd.steps].O) === 600 && pMinEnd.messages.some((m) => /raised to the 600 cfs minimum/.test(m)), 'calc2: ending outflow raised to the minimum outflow (no steps below min) — ' + pMinEnd.plain);
  const pMinEnd2 = D.plan(Object.assign({}, base, { inflow: 259, Q0: 900, Qmin: 600, Qmax: 3000, St: 49500, Qend: 400 }));
  check(pMinEnd2.Qend === 600 && pMinEnd2.messages.some((m) => /entered 400 cfs/.test(m)), 'calc2: a typed ending outflow below the minimum is raised too');
  // Min / max outflow optional: drawdown and fill both plan without them.
  const pNo = D.plan(Object.assign({}, base, { Qmin: undefined, Qmax: undefined }));
  const pFill = D.plan(Object.assign({}, base, { Qmin: undefined, Qmax: undefined, Q0: 1500, inflow: 900, St: 50300 }));
  check(pNo.status === 'ok' && Math.abs(pNo.Qp - 1000) < 1 && pFill.status === 'ok' && pFill.Qp < 900 && /^Ramp down from 1,500/.test(pFill.plain), 'calc2: min/max outflow optional (drawdown and fill)');
  // Ramp limits in gage height: rating q = 100·h² (h 0–10 ft), 0.2 ft/hr from 400 cfs (h = 2 ft).
  const rxs = [], rys = [];
  for (let h = 0; h <= 10.001; h += 0.1) { rxs.push(+h.toFixed(1)); rys.push(Math.round(100 * h * h)); }
  const sgm = D.stageFromRating(rxs, rys, 0, 'Test gage', 'test rating');
  check(Math.abs(sgm.stage(400) - 2) < 1e-9 && Math.abs(sgm.flow(3) - 900) < 1e-9 && sgm.qMax === 10000, 'stage ramp: rating converts flow <-> gage height');
  const rmS = D.rampModel(0.2, 0.2, sgm);
  check(Math.abs(rmS.time(400, 900) - 5) < 1e-9 && Math.abs(rmS.along(400, 900, 1) - 484) < 1e-6 && rmS.along(400, 900, 9) === 900, 'stage ramp: 2 -> 3 ft at 0.2 ft/hr takes 5 h; flow follows the rating (484 cfs after 1 h)');
  const ps = D.plan(Object.assign({}, base, { Q0: 400, inflow: 400, ru: 0.2, rd: 0.2, Qmin: 100, Qmax: 9000, St: 49500, stage: sgm }));
  const hs = ps.schedule.slice(0, 4).map((r) => r.h);
  check(ps.status === 'ok' && Math.abs(ps.Sfinal - 49500) <= 1 && hs.every((h, i) => !i || Math.abs(h - hs[i - 1] - 0.2) < 1e-6) && /at 0\.20 ft\/hr at Test gage/.test(ps.plain), 'stage ramp: plan meets target with gage height rising 0.2 ft per step — ' + ps.plain);
  const sgo = D.stageFromRating(rxs, rys, 300, 'Test gage', 'test rating');
  check(Math.abs(sgo.stage(100) - 2) < 1e-9 && sgo.qMax === 9700, 'stage ramp: other flow at the gage is added before reading the rating');
  let outErr = '';
  try { D.plan(Object.assign({}, base, { Q0: 20000, ru: 0.2, rd: 0.2, stage: sgm })); } catch (e) { outErr = e.message; }
  check(/outside the stage–discharge rating/.test(outErr), 'stage ramp: flows outside the rating are reported');
  const calcSrc = fs.readFileSync(path.join(__dirname, 'js', 'views', 'calc.js'), 'utf8');
  const RTs = require('./js/ratings.js'), belowSites = RTs.SITES.filter((x) => x.below);
  check(/id="c2-tsrc"/.test(calcSrc) && /value="limit"/.test(calcSrc) && /Math\.min\(rv, tv\)/.test(calcSrc) && /dd-l-pubtgt/.test(calcSrc), 'calc2: target from rule curve, published interim/injunction target, or the lower (more limiting) of the two; target curve on the chart');
  const rg = {}; (calcSrc.match(/^\s{4}([A-Z]{3}): \{ site: '(\d{8})'/gm) || []).forEach((l) => { const m = /([A-Z]{3}): \{ site: '(\d{8})'/.exec(l); rg[m[1]] = m[2]; });
  check(['HCR', 'LOP', 'DEX', 'FAL', 'CGR', 'BLU', 'GPR', 'COT', 'DOR'].every((c) => rg[c]) && !rg.FRN && rg.HCR === '14145500' && rg.DEX === '14150000' && rg.CGR === '14159500' && !/c2-rg|gageList/.test(calcSrc),
    'stage ramp: one fixed downstream gage per dam (no gage list); none for Fern Ridge (FRNO not published)');
  check(Object.keys(rg).every((c) => RTs.SITES.some((x) => x.site === rg[c])) && belowSites.every((x) => /^[A-Z]{4} · below /.test(x.name)), 'stage ramp: every planner gage has its stage–discharge table on the Tables page (names lead with the 4-letter code)');
  // Gate openings from a 2-D rating: flow per ft of opening = 10 × (elev − 800) cfs, openings 0–4 ft.
  const g2 = { kind: '2d', others: [0, 1, 2, 4], curves: [0, 1, 2, 4].map((o) => ({ xs: [800, 900], ys: [0, o * 1000] })) };
  check(Math.abs(D.gateOpening(g2, 850, 750).opening - 1.5) < 1e-3 && D.gateOpening(g2, 850, 750).status === 'ok', 'gates: 750 cfs at 850 ft -> 1.5 ft opening');
  const gmax = D.gateOpening(g2, 850, 2500);
  check(gmax.status === 'max' && gmax.opening === 4 && gmax.qMax === 2000, 'gates: flow above full opening flagged (2,000 cfs max at 850 ft)');
  check(D.gateOpening(g2, 950, 100).status === 'elev' && D.gateOpening(g2, 850, 0).status === 'closed' && D.gateOpening(g2, null, 100).status === 'elev', 'gates: elevation outside rating / zero flow / no elevation');
  // Ramp 100 cfs/step at 850 ft (500 cfs per ft of opening there), hold 700 cfs while the pool falls, ramp down.
  const gsch = D.gateSchedule([{ O: 700, E: 850 }, { O: 800, E: 850 }, { O: 900, E: 850 }, { O: 900, E: 845 }, { O: 900, E: 840 }, { O: 800, E: 840 }], g2, { powerhouse: 200 });
  check(gsch.rows.map((g) => g.opening).join() === '1,1.2,1.4,1.56,1.75,1.5' && gsch.rows.map((g) => g.kind).join() === 'start,ramp,ramp,hold,hold,ramp', 'gates: exact openings per step (0.01 ft), net of other release; ramp vs hold steps');
  check(gsch.changes.map((c) => c.kind + '@' + c.i).join() === 'start@0,ramp@1,ramp@2,trim@3,trim@4,ramp@5' && gsch.changes[1].dq === 100 && gsch.changes[3].dq === 0, 'gates: ramp steps listed with their flow change; holds become trims once the opening drifts ≥ 0.1 ft');
  check(gsch.steps.up.min === 0.2 && gsch.steps.up.max === 0.2 && gsch.steps.down.min === 0.25 && gsch.steps.up.eMax === 850, 'gates: gate step implied by the ramp limit reported (+0.20 ft per 100 cfs at 850 ft; −0.25 ft at 840 ft)');
  const gsch3 = D.gateSchedule([{ O: 700, E: 850 }, { O: 700, E: 849 }, { O: 700, E: 848 }], g2, { powerhouse: 200, trim: 0.25 });
  check(gsch3.changes.length === 1, 'gates: small drifts during a hold stay below the trim threshold');
  const gsch2 = D.gateSchedule([{ O: 1000, E: 850 }], g2, { gates: 2 });
  check(gsch2.rows[0].q === 500 && gsch2.rows[0].opening === 1, 'gates: flow split across gates opened equally');
  const html2 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check(html2.indexOf('js/update-check.js') > html2.indexOf('js/app.js'), 'update check loads last');
  check(html2.indexOf('js/drawdown.js') > html2.indexOf('js/ratings.js') && html2.indexOf('js/views/calc.js') < html2.indexOf('js/router.js'), 'script order: drawdown after ratings, calc view before router');
}

// ---- 2e. Past-years overlay (js/history.js) -------------------------------------
console.log('past years');
{
  const HS = require('./js/history.js');
  const y = 2025, jan1 = HS.pacificMidnight(y, 1, 1);
  check(jan1 === Date.UTC(2025, 0, 1, 8) && HS.yearFrac(jan1, y) === 0 && HS.yearFrac(HS.pacificMidnight(y + 1, 1, 1), y) === 1, 'years: year fraction 0 at Jan 1, 1 at next Jan 1 (Pacific)');
  check(Math.abs(HS.yearFrac(HS.pacificMidnight(y, 7, 2), y) - 0.4986) < 0.001, 'years: Jul 2 is mid-year');
  const pool = { t: [HS.pacificMidnight(y, 5, 1), HS.pacificMidnight(y, 11, 20), HS.pacificMidnight(y, 12, 1), HS.pacificMidnight(y, 12, 20)], v: [1690, 1505, 1502.07, 1520] };
  const sm = HS.yearSummary(pool, y);
  check(sm.min === 1502.07 && sm.minT === pool.t[2] && sm.max === 1690 && sm.fallMean === (1505 + 1502.07) / 2 && sm.fallN === 2, 'years: summary low/high with dates, Nov 15–Dec 15 mean');
  check(HS.yearSummary(null, y) === null && typeof HS.loadYear === 'function', 'years: empty summary; loader exported');
  const tc = fs.readFileSync(path.join(__dirname, 'js', 'pastyears.js'), 'utf8'), idxY = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check(idxY.includes('data-range="years"') && idxY.includes('data-range="year"') && /MAX_YEARS = 6/.test(tc), 'years: YEAR and PAST YEARS ranges on the Trend Recorder, up to 6 years');
  const TCZ = require('./js/teacup-core.js'), eq = (z, a, b) => Math.abs(z[0] - a) < 1e-9 && Math.abs(z[1] - b) < 1e-9;
  // Band check: 10 readings; band 100-110 every day, mean 105.
  const band = (v) => Array.from({ length: 366 }, (_, i) => [i / 365, v]);
  const bc = TCZ.bandCheck([[0.1, 99], [0.2, 100], [0.3, 104], [0.4, 105], [0.5, 106], [0.6, 110], [0.7, 111], [0.8, 108], [0.9, 107], [0.95, 103]], band(100), band(110), band(105));
  check(bc.n === 10 && bc.inside === 0.8 && bc.below === 0.1 && bc.above === 0.1 && bc.medianVsMean === 1, 'band check: share inside / below / above p05–p95 and median vs mean');
  // Derived bands: 20 years, each a constant level 100..119 -> p05 ≈ 100.95, mean 109.5, p95 ≈ 118.05 every day; a one-day spike in one year barely moves it.
  const yrs = Array.from({ length: 20 }, (_, k) => Array.from({ length: 365 }, (_, d) => [d / 365, 100 + k + (k === 19 && d === 100 ? 300 : 0)]));
  const dbs = TCZ.derivedBands(yrs, 7, 5), at = (arr, f) => arr.reduce((b, p) => (Math.abs(p[0] - f) < Math.abs(b[0] - f) ? p : b))[1];
  check(dbs.statsAve.length >= 360 && Math.abs(at(dbs.statsP05, 0.5) - 100.95) < 0.01 && Math.abs(at(dbs.statsP95, 0.5) - 118.05) < 0.01 && Math.abs(at(dbs.statsAve, 0.5) - 109.5) < 0.01, 'derived bands: percentiles pooled across years');
  check(at(dbs.statsP95, 100 / 365) < 120 && at(dbs.statsP05, 100 / 365) > 100, 'derived bands: a one-day spike in one year does not make the band edge spike');
  check(TCZ.derivedBands([[[0.5, 1]]], 7, 5).statsAve.length === 0, 'derived bands: too few readings -> no band');
  const off = TCZ.bandCheck([[0.5, 120]], band(100), band(110), band(105));
  check(off.above === 1 && off.medianVsMean === 15 && TCZ.bandCheck([[0.5, 1]], [], [], []).n === 0, 'band check: offset shows as a steady difference; no band -> no readings counted');
  check(eq(TCZ.zoomBy([0, 1], 0.5), 0.25, 0.75) && eq(TCZ.zoomBy([0.25, 0.75], 2), 0, 1) && eq(TCZ.zoomBy([0, 0.5], 4), 0, 1), 'zoom: in/out about the centre, clamped to the year');
  check(eq(TCZ.zoomBy([0, 1], 0.5, 0.1), 0, 0.5), 'zoom: about a point near the edge stays inside the year');
  check(eq(TCZ.panBy([0.5, 0.75], 1), 0.625, 0.875) && eq(TCZ.panBy([0.8, 1], 1), 0.8, 1) && eq(TCZ.panBy([0, 0.2], -1), 0, 0.2), 'zoom: pan by half a window, stopping at year ends');
  const tiny = TCZ.clampZoom(0.5, 0.5001);
  check(Math.abs(tiny[1] - tiny[0] - TCZ.MIN_SPAN) < 1e-9 && eq(TCZ.clampZoom(0.9, 0.2), 0.2, 0.9), 'zoom: minimum ~3-day window; reversed drags are ordered');
  check(TCZ.dayTickStep(30, 800) <= 2 && TCZ.dayTickStep(90, 300) >= 14 && TCZ.niceStep(3) === 0.5 && TCZ.niceStep(0.3) === 0.05 && TCZ.niceStep(180) === 50, 'zoom: day-tick and elevation-grid steps adapt to the window');
  check(/data-tczoom/.test(tc) && /data-tcmonth/.test(tc) && /setPointerCapture/.test(tc), 'zoom: buttons, month labels and drag-to-zoom wired');
  const ZM = require('./js/zoom.js');
  check(eq(ZM.apply([0, 1], 'in', 0.01), 0.25, 0.75) && eq(ZM.apply([0.25, 0.75], 'out', 0.01), 0, 1) && eq(ZM.apply([0.2, 0.4], 'reset'), 0, 1), 'shared zoom: in / out / reset');
  check(eq(ZM.apply([0, 0.5], 'left', 0.01), 0, 0.5) && eq(ZM.apply([0.25, 0.5], 'right', 0.01), 0.375, 0.625) && eq(ZM.apply([0, 1], 'in', 0.01, 0.9), 0.5, 1), 'shared zoom: pan stops at the ends; zoom about a point');
  const zmin = ZM.clamp([0.5, 0.5], 2 / 24);
  check(Math.abs(zmin[1] - zmin[0] - 2 / 24) < 1e-9 && eq(ZM.clamp([0.7, 0.3], 0.01), 0.3, 0.7), 'shared zoom: per-chart minimum window (2 h of 24 H); reversed drag ordered');
  check(/function bar\(/.test(fs.readFileSync(path.join(__dirname, 'js', 'zoom.js'), 'utf8')) && /setYearsMode/.test(fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8')), 'trend recorder: PAST YEARS hosted in the Trend Recorder');
  const appSrc = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8'), idx = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check(/H\.zoom\.attach\(svg/.test(appSrc) && /state\.tzoom = \[0, 1\]/.test(appSrc) && idx.includes('id="trend-zoom"') && idx.indexOf('js/zoom.js') < idx.indexOf('js/app.js'), 'trend recorder: zoom wired, reset on range/point change');
}

// ---- 2f. Chart layers (js/layers.js) ---------------------------------------------
console.log('layers');
{
  const H0 = require('./js/data.js');
  H0.levels = require('./js/cwms-levels.js');
  H0.history = require('./js/history.js');
  const LY = require('./js/layers.js');
  check(LY.LEVELS.map((l) => l.key).join() === 'topDam,topMaxFlood,topFlood,topCons,spillwayCrest,topPower,bottomPower,bottomCons' && LY.LEVELS.every((l) => H0.levels.IDS[l.key]), 'layers: level lines map to CWMS level ids');
  const lvFix = H0.levels.compact({ levels: [
    { 'location-level-id': 'CGR.Elev.Inst.0.Top of Conservation', 'level-units-id': 'ft', 'level-date': '2020-01-01T08:00:00Z', 'constant-value': 1690 },
    { 'location-level-id': 'CGR.Elev.Inst.0.Spillway Crest', 'level-units-id': 'ft', 'level-date': '2020-01-01T08:00:00Z', 'constant-value': 1656 },
    { 'location-level-id': 'CGR.Elev.Inst.0.Bottom of Conservation', 'level-units-id': 'ft', 'level-date': '2020-01-01T08:00:00Z', 'constant-value': 1532 }] }, 'CGR', Date.now());
  const lvv = LY.levelValues(lvFix, Date.now());
  check(lvv.map((l) => l.key + '=' + Math.round(l.v)).join() === 'topCons=1690,spillwayCrest=1656,bottomCons=1532', 'layers: level values only for published levels, top to bottom — got ' + lvv.map((l) => l.key + '=' + l.v).join());
  const falLv = H0.levels.compact({ levels: [
    { 'location-level-id': 'FAL.Elev.Inst.0.Top of Conservation', 'level-units-id': 'ft', 'level-date': '2020-01-01T08:00:00Z', 'constant-value': 830 },
    { 'location-level-id': 'FAL.Temp-Water.Inst.0.ODEQ-2006TMDL-Target', 'level-units-id': 'C', 'level-date': '2012-01-01T08:00:00Z', 'constant-value': 13 },
    { 'location-level-id': 'FAL.Elev-Forebay.Inst.0.Injunction-Target', 'level-units-id': 'ft', 'level-date': '2023-01-01T08:00:00Z', 'interval-origin': '2023-01-01T08:00:00Z', 'interval-months': 12,
      'seasonal-values': [{ 'offset-months': 0, 'offset-minutes': 0, value: 728 }, { 'offset-months': 6, 'offset-minutes': 0, value: 820 }] }] }, 'FAL', Date.now());
  const ft = LY.targetFor('FAL', falLv);
  check(ft && ft.id === 'Elev-Forebay.Inst.0.Injunction-Target' && ft.discovered && /Injunction Target/i.test(ft.label) && H0.levels.pick(falLv, ft.id, Date.now()), 'layers: Fall Creek target found in its CWMS levels (not the ODEQ temperature target) — ' + (ft && ft.label));
  check(LY.targetFor('CGR', null).id === H0.levels.IDS.injunctionTarget && LY.targetFor('DEX', { levels: {} }) === null, 'layers: known targets still used; none -> null');
  check(LY.TARGETS.CGR.idKey === 'injunctionTarget' && LY.TARGETS.HCR.idKey === 'interimRisk' && !LY.TARGETS.DEX, 'layers: published targets for LOP/GPR/CGR (injunction) and HCR (IRRM)');
  const res = H0.projects.find((p) => p.code === 'CGR'), riv = H0.stations.find((s) => s.id === 'middle-fork-jasper'), eug = H0.stations.find((s) => s.id === 'willamette-eugene');
  check(LY.stripsFor(res).map((x) => x.key).join() === 'flows,temp,turb,tdg', 'layers: reservoir strips = inflow/outflow, temp, turbidity, TDG');
  check(LY.stripsFor(riv, 'flow').map((x) => x.key).join() === 'stage,temp,turb' && LY.stripsFor(eug, 'stage').map((x) => x.key).join() === 'temp,turb', 'layers: river strips exclude the main parameter (and flow where none is published)');
  check(LY.PCODE.turb === '63680' && LY.PCODE.temp === '00010' && LY.TDG.DEX && LY.TDG.CGR && LY.BELOW_DAM.CGR.site === '14159500', 'layers: USGS turbidity 63680 / temp 00010; TDG for DEX, CGR; CGR downstream gage 14159500');
  check(LY.CHART_TOGGLES.filter((t) => t.on).map((t) => t.key).join() === 'rule,stats,target' && LY.STRIPS.reservoir.filter((t) => t.on).map((t) => t.key).join() === 'flows', 'layers: defaults (rule curve, bands, target; inflow/outflow strip)');
  const appS = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8'), idxL = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check(idxL.includes('id="trend-layers"') && idxL.includes('id="trend-strips"') && idxL.includes('id="years-box"') && /H\.trend = \{/.test(appS) && /syncStrips\(t\)/.test(appS), 'layers: toggle bar, strips with synced cursor, PAST YEARS box and open() wired');
  check(idxL.indexOf('js/layers.js') > idxL.indexOf('js/cwms-levels.js') && idxL.indexOf('js/pastyears.js') < idxL.indexOf('js/app.js'), 'script order: layers and pastyears before app');
}

// ---- 2g. Every browser script parses -----------------------------------------------
{
  const vm = require('vm');
  const files = fs.readdirSync(path.join(__dirname, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f)
    .concat(fs.readdirSync(path.join(__dirname, 'js', 'views')).filter((f) => f.endsWith('.js')).map((f) => 'js/views/' + f));
  const bad = files.filter((f) => { try { new vm.Script(fs.readFileSync(path.join(__dirname, f), 'utf8'), { filename: f }); return false; } catch (e) { console.error('  ' + f + ': ' + e.message); return true; } });
  check(!bad.length, 'all ' + files.length + ' browser scripts parse' + (bad.length ? ' (failed: ' + bad.join(', ') + ')' : ''));
}

// ---- 3. Page wiring ---------------------------------------------------------
console.log('page');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const header = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];
const footer = (html.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
const NOTICE = 'Live data from USGS and USACE; provisional, not official.';
check(header.includes(NOTICE) && footer.includes(NOTICE), 'header + footer carry the live-data notice');
{
  // Every local script/stylesheet carries the same ?v= tag, so a new index.html never runs with old cached code.
  const assets = html.match(/(?:src|href)="(?:js|css)\/[^"]+"/g) || [];
  const tags = new Set(assets.map((a) => (a.match(/\?v=([\w.-]+)"$/) || [])[1]));
  check(assets.length >= 15 && tags.size === 1 && !tags.has(undefined), 'all ' + assets.length + ' local scripts/styles share one ?v= cache-busting tag');
  const SV = require('./scripts/stamp-version.js');
  check(tags.has(SV.tag()), 'cache-busting tag is current (?v=' + SV.tag() + '); run node scripts/stamp-version.js after code changes');
}
check(/not affiliated with USGS, USACE or BPA/.test(header) && /not affiliated with USGS, USACE or BPA/.test(footer), 'not-affiliated text in header + footer');
check(!/illustrative/i.test(html), 'no "illustrative" wording left in page');
(html.match(/(?:src|href)="([^"#:]+)"/g) || []).forEach((m) => {
  const ref = m.replace(/^(?:src|href)="/, '').replace(/"$/, '').replace(/\?.*$/, '');
  check(fs.existsSync(path.join(__dirname, ref)), 'referenced file exists: ' + ref);
});
['README.md', 'LICENSE', '.nojekyll', 'data/bpa.json', '.github/workflows/update-bpa.yml', 'scripts/stamp-version.js', 'js/router.js', 'js/teacup-core.js', 'js/ratings.js', 'scripts/check-links.js', 'js/tdg.js', 'js/snotel.js', 'js/views/teacup.js', 'js/views/tables.js', 'js/views/docs.js'].forEach((f) => check(fs.existsSync(path.join(__dirname, f)), f + ' exists'));
['overview', 'teacup', 'tables', 'calc', 'docs'].forEach((r) => {
  check(html.includes('href="#/' + r + '"') && html.includes('data-view="' + r + '"'), 'route + view exist: ' + r);
});
check(html.indexOf('js/teacup-core.js') > html.indexOf('js/cwms-levels.js') && html.indexOf('js/teacup-core.js') < html.indexOf('js/views/teacup.js'), 'script order: teacup-core after levels, before teacup view');
check(!/biological-opinion-upper-willamette-valley/.test(fs.readFileSync(path.join(__dirname, 'js', 'views', 'docs.js'), 'utf8')), 'docs: 404 BiOp URL not linked');
check((fs.readFileSync(path.join(__dirname, 'js', 'views', 'docs.js'), 'utf8').match(/target="_blank" rel="noopener"/g) || []).length >= 1, 'docs: external links open in new tab with rel=noopener');
check(/Published target — not a statement of current operations\./.test(fs.readFileSync(path.join(__dirname, 'js', 'views', 'teacup.js'), 'utf8')), 'teacup view carries the mandatory target disclaimer');
check(html.indexOf('js/cwms-levels.js') < html.indexOf('js/router.js') && html.indexOf('js/router.js') < html.indexOf('js/app.js') &&
  html.indexOf('js/views/docs.js') < html.indexOf('js/router.js'), 'script order: modules, views, router, app');
const app = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'js', 'data.js'), 'utf8');
check(!/mulberry|seeded|gauss\(/i.test(app), 'no seeded generator left in JS');
const bj = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bpa.json'), 'utf8'));
check(isNum(bj.latest.hydroMW) && /[+-]\d{2}:\d{2}$/.test(bj.latest.time) && Array.isArray(bj.series) && bj.series.length > 0, 'data/bpa.json shape');

// ---- 4. Live ---------------------------------------------------------------
async function live() {
  console.log('\nlive (real APIs)');
  const t0 = Date.now();
  const snap = await H.loadAll();
  const ms = Date.now() - t0;
  const nowL = Date.now();
  const rows = [];
  const fmtAge = (t) => (t == null ? '' : ((nowL - t) / 60000).toFixed(0) + ' min');
  const cell = (s, d) => {
    const l = H.latest(s);
    return l ? `${l.v.toFixed(d)} (${fmtAge(l.t)})` : 'MISSING';
  };

  check(snap.sources.usgs.ok, 'USGS request succeeded' + (snap.sources.usgs.error ? ' (' + snap.sources.usgs.error + ')' : ''));
  H.stations.forEach((s) => {
    const d = snap.stations[s.id] || {};
    s.params.forEach((k) => check(d[k] && d[k].t.length > 0, `USGS ${s.site} ${k} returns data`));
    check(H.stationPrimary(s, d) !== null, `USGS ${s.site} primary (${s.primary}) has data`);
    if (!s.params.includes('flow')) check(!d.flow || !d.flow.t.length, `USGS ${s.site} still has no discharge series (else update config)`);
    rows.push({ site: s.site, name: s.name, flow_cfs: s.params.includes('flow') ? cell(d.flow, 0) : 'n/a (no gauge)', stage_ft: cell(d.stage, 2),
      temp_C: cell(d.tempC, 1), status: H.stationStatus(s, d, nowL).label });
  });
  console.table(rows);

  const prow = [];
  H.projects.forEach((p) => {
    const d = snap.projects[p.id] || {};
    check(d.elev && d.elev.t.length > 0, `CWMS ${p.series.elev.name} returns data`);
    const r = H.ruleToday(d.rule, nowL);
    check(r != null && isNum(r.v), `CWMS ${p.code} rule curve has a value for today`);
    const st = H.latest(d.stor);
    const pfv = st ? H.percentFull(p, st.v) : null;
    prow.push({ code: p.code, elev_ft: cell(d.elev, 1), rule_today_ft: r ? r.v.toFixed(1) : 'MISSING', stor_acft: p.noStorage ? 'n/a' : cell(d.stor, 0),
      pct_full: pfv ? (pfv.below ? 'below cons.' : pfv.pct.toFixed(1)) : 'n/a', out_cfs: cell(d.out, 0), comp_in_cfs: cell(d.inflow, 0), status: H.reservoirStatus(p, d, nowL).label });
  });
  console.table(prow);
  console.log('CWMS series ok/empty/failed: %d/%d/%d', snap.sources.cwms.ok, snap.sources.cwms.empty, snap.sources.cwms.failed);
  snap.sources.cwms.errors.forEach((e) => console.log('  ' + e));
  const bs = H.basinStorage(snap, nowL), tr = H.totalRelease(snap, nowL);
  console.log('derived: basin storage %s%% (%d/%d), total release %s cfs (%d/%d); fetched in %d ms',
    bs.pct == null ? 'n/a' : bs.pct.toFixed(1), bs.reporting, bs.total, tr.cfs == null ? 'n/a' : tr.cfs.toFixed(0), tr.reporting, tr.total, ms);


  // NOAA NWPS: thresholds + forecasts
  console.log('\nNOAA NWPS');
  const nw = await NW.loadAll();
  const nrows = [];
  for (const [id, o] of Object.entries(nw)) {
    const g = o.gauge;
    if (o.lid) {
      check(g && g.thresholds && g.thresholds.action.stage != null, `NWPS ${o.lid} returns flood thresholds` + (o.error ? ' (' + o.error + ')' : ''));
      check(g && g.forecast && g.forecast.t.length > 0, `NWPS ${o.lid} returns a forecast`);
    } else check(!o.gauge, `${id}: no NWPS gauge mapped (no flood stages published)`);
    nrows.push({ station: id, lid: o.lid || '—', thresholds_ft: g && g.thresholds ? NW.CATS.map((c) => g.thresholds[c].stage ?? '-').join('/') : 'none',
      observed: g ? `${g.observed.stage} ft ${g.observed.category}` : (o.error || 'n/a'), issued: g && g.forecast ? new Date(g.forecast.issued).toISOString().slice(0, 16) : '—',
      peak7d: g && g.peak ? `${g.peak.stage} ft ${new Date(g.peak.t).toISOString().slice(5, 16)} ${g.peak.category}` : '—' });
  }
  console.table(nrows);

  // CWMS levels: real LOP injunction target today
  console.log('\nCWMS levels (LOP)');
  try {
    const lv = await LV.fetchProjectLevels('LOP');
    const e = LV.pick(lv, LV.IDS.injunctionTarget);
    check(e && e.s, 'LOP injunction target found (seasonal)');
    const v = LV.valueAt(lv, LV.IDS.injunctionTarget);
    console.log('  LOP Injunction-Target version %s, today = %s ft (published target, not current operations)',
      e ? new Date(e.date).toISOString().slice(0, 10) : '—', v == null ? 'null (gap: target not applicable today)' : v.toFixed(1));
    check(LV.constantAt(lv, LV.IDS.bottomCons) != null && Math.abs(LV.constantAt(lv, LV.IDS.bottomCons) - 825) < 0.1, 'LOP bottom of conservation = 825 ft');
    const stats = ['statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95'].map((k) => LV.valueAt(lv, LV.IDS[k]));
    check(stats.every((x) => x != null) && stats.every((x, i) => !i || x >= stats[i - 1]), 'LOP 30-yr stats for today are ordered p05<=p25<=avg<=p75<=p95');
    console.log('  LOP 30-yr stats today (ft): p05 %s  p25 %s  avg %s  p75 %s  p95 %s', ...stats.map((x) => x.toFixed(1)));
  } catch (e) {
    check(false, 'LOP levels fetch: ' + e.message);
  }


  // CWMS levels availability matrix (all 8 projects, concurrency 3)
  console.log('\nCWMS levels availability (today)');
  const codes = ['LOP', 'HCR', 'DEX', 'GPR', 'CGR', 'FRN', 'COT', 'DOR'];
  const got = {};
  let qi = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (qi < codes.length) { const c = codes[qi++]; try { got[c] = await LV.fetchProjectLevels(c); } catch (e) { got[c] = e; } }
  }));
  const rulerKeys = ['streambed', 'bottomCons', 'topCons', 'topFlood', 'topMaxFlood', 'spillwayCrest', 'topDam'];
  const statKeys = ['statsMin', 'statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95', 'statsMax'];
  const targetIds = { inj_elev: 'Elev-Forebay.Inst.0.Injunction-Target', irrm_elev: 'Elev.Inst.0.Interim Risk Reduction Measure', interim_stor: 'Stor.Inst.0.Interim_Operations', inj_stor: 'Stor.Inst.0.Injunction-Target' };
  const mrows = [];
  for (const c of codes) {
    const d = got[c];
    if (d instanceof Error) { check(false, `levels ${c}: ${d.message}`); mrows.push({ code: c, error: d.message }); continue; }
    const row = { code: c };
    const have = rulerKeys.filter((k) => LV.constantAt(d, LV.IDS[k]) != null);
    row.ruler = have.length + '/7';
    row.missing = rulerKeys.filter((k) => !have.includes(k)).join(',') || '—';
    const stats = statKeys.map((k) => LV.valueAt(d, LV.IDS[k]));
    row.stats = stats.filter((v) => v != null).length + '/7';
    for (const [k, id] of Object.entries(targetIds)) {
      const e = LV.pick(d, id);
      row[k] = !e ? '—' : (e.c != null ? 'const ' : '') + (LV.evalSeasonal(e, Date.now()) == null ? 'null today' : LV.evalSeasonal(e, Date.now()).toFixed(1));
    }
    mrows.push(row);
    check(LV.constantAt(d, LV.IDS.topDam) != null && LV.constantAt(d, LV.IDS.streambed) != null, `levels ${c}: top of dam + streambed published`);
    check(stats.every((v) => v != null), `levels ${c}: 30-yr stats available today`);
  }
  console.table(mrows);
  for (const c of ['LOP', 'GPR', 'CGR']) check(LV.pick(got[c], targetIds.inj_elev) != null, `levels ${c}: elevation injunction target published`);
  check(LV.pick(got.HCR, targetIds.irrm_elev) != null, 'levels HCR: elevation Interim Risk Reduction Measure published');


  // Published ratings: every catalogued rating must load (documented-unavailable ones are not catalogued)
  console.log('\nPublished ratings (CWMS + USGS)');
  const defs = RT.allDefs(), rrows = [];
  let ri = 0;
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (ri < defs.length) {
      const d = defs[ri++];
      try {
        const e = await RT.load(d);
        const r = e.data;
        const xs = r.kind === '2d' ? [].concat(...r.curves.map((cv) => cv.xs)) : r.xs, ys = r.kind === '2d' ? [].concat(...r.curves.map((cv) => cv.ys)) : r.ys;
        rrows.push({ rating: d.source === 'usgs' ? 'USGS ' + d.site + ' exsa' : d.id.replace('.Standard.CENWP', ''), kind: r.kind + (r.kind === '2d' ? ' ' + r.others.length + ' openings' : '') + (r.transposed ? ' (transposed)' : ''),
          points: xs.length, x: `${Math.min(...xs)}–${Math.max(...xs)} ${d.xu}`, y: `${+Math.min(...ys).toPrecision(4)}–${+Math.max(...ys).toPrecision(6)} ${d.yu}`,
          effective: d.source === 'usgs' ? 'rating ' + r.ratingId + ', shifts ' + r.shifted + (r.baseOnly ? ' (base only)' : '') : new Date(r.effective).toISOString().slice(0, 10) });
        check(xs.length > 0, `rating ${d.id} has points`);
      } catch (err) {
        rrows.push({ rating: d.id, kind: 'FAILED', points: 0, x: err.message });
        check(false, `rating ${d.id}: ${err.message}`);
      }
    }
  }));
  rrows.sort((a, b) => (a.rating < b.rating ? -1 : 1));
  console.table(rrows);
  console.log('Documented unavailable (not catalogued): DEX area; ' + Object.entries(RT.UNAVAILABLE.structures).map(([k, v]) => k + ' (' + v + ')').join('; '));


  // TDG (CWMS), SNOTEL (NRCS AWDB), ODEQ targets (CWMS levels)
  console.log('\nTDG / SNOTEL / ODEQ');
  const TDl = require('./js/tdg.js'), SNl = require('./js/snotel.js');
  const tdg = await TDl.loadAll();
  for (const [k, o] of Object.entries(tdg)) {
    const s = o.series, n = s ? s.t.length : 0;
    check(n > 0, `TDG ${k} returns data` + (o.error ? ' (' + o.error + ')' : ''));
    if (n) console.log(`  TDG ${k}: ${s.v[n - 1]} % at ${new Date(s.t[n - 1]).toISOString()} (${n} pts, 7-d range ${Math.min(...s.v)}–${Math.max(...s.v)} %)`);
  }
  const sn = await SNl.load({ force: true });
  check(!sn.error, 'SNOTEL request ok' + (sn.error ? ' (' + sn.error + ')' : ''));
  const srows = SNl.STATIONS.map((st) => {
    const o = sn.stations[st.triplet];
    check(o && o.swe.v.length > 0 && o.last, `SNOTEL ${st.triplet} ${st.name} returns SWE`);
    return { station: st.name, triplet: st.triplet, swe_in: o ? o.swe.v.at(-1) : 'MISSING', depth_in: o && o.depth.v.length ? o.depth.v.at(-1) : 'MISSING', last: o ? o.last : '—' };
  });
  console.table(srows);
  const odeqRows = [];
  for (const c of ['LOP', 'HCR', 'DEX', 'FAL', 'GPR', 'CGR', 'BLU', 'FRN', 'COT', 'DOR']) {
    const d = got[c];
    if (!d || d instanceof Error) continue;
    const e = LV.pick(d, LV.IDS.odeqTemp), v = e ? LV.evalSeasonal(e, Date.now()) : null;
    odeqRows.push({ code: c, published: e ? 'yes (' + new Date(e.date).toISOString().slice(0, 10) + ')' : 'no', today_C: v == null ? '—' : v.toFixed(2), today_F: v == null ? '—' : H.cToF(v).toFixed(1) });
  }
  console.table(odeqRows);
  check(odeqRows.find((r) => r.code === 'DEX' && r.published !== 'no'), 'ODEQ target published for DEX (drawn at Jasper)');

  // Hourly Snapshot: every value against the raw APIs
  console.log('\nHourly Snapshot (live)');
  {
    const SN = require('./js/snapshot.js');
    const nowS = Date.now();
    await SN.load(nowS);
    const rows = [];
    SN.GROUPS.forEach((g) => g.items.forEach((it) => {
      const m = SN.itemModel(it, Date.now());
      rows.push({ key: it.key, latest: m.latest ? m.latest.v : null, at: m.latest ? new Date(m.latest.t).toISOString().slice(11, 16) + 'Z' : '', ageMin: m.latest ? Math.round((Date.now() - m.latest.t) / 60e3) : '',
        hour: m.hour ? (m.hour.pending ? 'pending' : m.hour.v) : '', sub: m.sub ? m.sub.v : '', usgsCheck: m.check ? m.check.v : '' });
      if (it.none) check(true, 'snapshot ' + it.key + ': documented not public (' + (m.latest ? 'NOW RETURNS DATA - update config' : 'still empty') + ')');
      else check(m.latest && (Date.now() - m.latest.t) < 3 * 3600e3, 'snapshot ' + it.key + ' has a reading in the last 3 h');
    }));
    console.table(rows);
  }

  // Long-range history: one reservoir and one river per range
  console.log('\nHistory (30 D / 6 MO / 1 YR)');
  {
    const HI = require('./js/history.js');
    const lopP = H.projects.find((p) => p.code === 'LOP'), jas = H.stations.find((s) => s.id === 'middle-fork-jasper');
    for (const r of ['30d', '6m', '1y']) {
      const a = await HI.load(lopP, r);
      check(!a.error && a.pool && a.pool.t.length > (r === '30d' ? 1000 : 100) && a.rule && a.rule.t.length >= HI.RANGES[r] - 2,
        `history LOP ${r}: ${a.pool ? a.pool.t.length : 0} pool pts, ${a.rule ? a.rule.t.length : 0} rule pts (${a.src || a.error})`);
      const b = await HI.load(jas, r);
      check(!b.error && b.flow && b.flow.t.length > (r === '30d' ? 1000 : 100), `history Jasper ${r}: ${b.flow ? b.flow.t.length : 0} flow pts`);
    }
  }

  // BPA: parse the real file
  try {
    const text = await BPA.fetchText(BPA.SOURCE);
    const parsed = BPA.parseBpa(text);
    const j = BPA.buildJson(parsed, Date.now());
    check(parsed.rows.length > 100, 'BPA real file parsed (' + parsed.rows.length + ' rows)');
    check(isNum(j.latest.hydroMW) && (Date.now() - j.latest.epochMs) < 3 * 3600e3, 'BPA latest hydro is recent: ' + j.latest.hydroMW + ' MW @ ' + j.latest.time);
    const ts = parsed.rows.map((r) => r.t);
    check(ts.every((t, i) => !i || t > ts[i - 1]), 'BPA timestamps strictly increasing');
  } catch (e) {
    check(false, 'BPA fetch/parse: ' + e.message);
  }
}

// --links: verify every external link on the Docs page (scripts/check-links.js)
const LINKS = process.argv.includes('--links');
async function links() {
  console.log('\nDocs links');
  const bad = await require('./scripts/check-links.js').main();
  check(bad === 0, 'all Docs links reachable (' + bad + ' failed)');
}

(LIVE ? live() : Promise.resolve()).then(() => (LINKS ? links() : null)).then(() => {
  console.log('\n' + passes + ' passed, ' + failures + ' failed' + (LIVE ? '' : '  (run with --live to test real APIs)'));
  process.exit(failures ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
