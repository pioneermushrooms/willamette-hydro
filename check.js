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
['README.md', 'LICENSE', '.nojekyll', 'data/bpa.json', '.github/workflows/update-bpa.yml'].forEach((f) => check(fs.existsSync(path.join(__dirname, f)), f + ' exists'));
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
