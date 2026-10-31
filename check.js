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

const expectProjects = { 'lookout-point': 'LOP', 'hills-creek': 'HCR', dexter: 'DEX', 'green-peter': 'GPR', cougar: 'CGR', 'fern-ridge': 'FRN', 'cottage-grove': 'COT', dorena: 'DOR' };
const hydro = ['LOP', 'HCR', 'DEX', 'GPR', 'CGR'];
const consLimits = {
  LOP: [825.0, 926.0, 113619, 438179], HCR: [1448.0, 1541.0, 155400, 350000], GPR: [922.0, 1010.0, 165628, 424402],
  CGR: [1532.0, 1690.0, 52200, 189000], COT: [750.0, 790.0, 3140, 31780], DOR: [770.5, 832.0, 7100, 72100], FRN: [353.0, 373.5, 2800, 97280]
};
check(H.projects.length === 8, '8 USACE projects');
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

// ---- 3. Page wiring ---------------------------------------------------------
console.log('page');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const header = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];
const footer = (html.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
const NOTICE = 'Live data from USGS and USACE; provisional, not official.';
check(header.includes(NOTICE) && footer.includes(NOTICE), 'header + footer carry the live-data notice');
check(/not affiliated with USGS, USACE or BPA/.test(header) && /not affiliated with USGS, USACE or BPA/.test(footer), 'not-affiliated text in header + footer');
check(!/illustrative/i.test(html), 'no "illustrative" wording left in page');
(html.match(/(?:src|href)="([^"#:]+)"/g) || []).forEach((m) => {
  const ref = m.replace(/^(?:src|href)="/, '').replace(/"$/, '');
  check(fs.existsSync(path.join(__dirname, ref)), 'referenced file exists: ' + ref);
});
['README.md', 'LICENSE', '.nojekyll', 'data/bpa.json', '.github/workflows/update-bpa.yml', 'js/router.js', 'js/teacup-core.js', 'js/views/teacup.js', 'js/views/tables.js', 'js/views/docs.js'].forEach((f) => check(fs.existsSync(path.join(__dirname, f)), f + ' exists'));
['overview', 'teacup', 'tables', 'docs'].forEach((r) => {
  check(html.includes('href="#/' + r + '"') && html.includes('data-view="' + r + '"'), 'route + view exist: ' + r);
});
check(html.indexOf('js/teacup-core.js') > html.indexOf('js/cwms-levels.js') && html.indexOf('js/teacup-core.js') < html.indexOf('js/views/teacup.js'), 'script order: teacup-core after levels, before teacup view');
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

(LIVE ? live() : Promise.resolve()).then(() => {
  console.log('\n' + passes + ' passed, ' + failures + ' failed' + (LIVE ? '' : '  (run with --live to test real APIs)'));
  process.exit(failures ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
