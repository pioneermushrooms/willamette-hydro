#!/usr/bin/env node
/*
 * Downloads BPA's balancing-authority 5-minute file and writes data/bpa.json.
 *
 *   node scripts/fetch-bpa.js            fetch + write data/bpa.json
 *   node scripts/fetch-bpa.js --stdout   fetch + print JSON, write nothing
 *
 * The BPA file has no CORS headers, so the browser cannot read it directly; this
 * runs in GitHub Actions (see .github/workflows/update-bpa.yml). Node 20+, no deps.
 *
 * Source: https://transmission.bpa.gov/business/operations/Wind/baltwg.txt
 * Format: tab-separated rows "MM/DD/YYYY HH:MM<TAB>Load<TAB>VER<TAB>Hydro<TAB>Fossil/Biomass<TAB>Nuclear",
 * times in Pacific local time (PST/PDT), MW. Rows for future intervals are present but empty.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://transmission.bpa.gov/business/operations/Wind/baltwg.txt';
const OUT = path.join(__dirname, '..', 'data', 'bpa.json');
const TZ = 'America/Los_Angeles';
const SERIES_HOURS = 48;

const pacificParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function wallClockOf(epoch) {
  const o = {};
  for (const p of pacificParts.formatToParts(new Date(epoch))) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day} ${o.hour === '24' ? '00' : o.hour}:${o.minute}`;
}

/*
 * Converts a Pacific wall-clock time to UTC epoch ms. Tries PDT (-7) and PST (-8)
 * and keeps the candidates whose wall clock round-trips. During the repeated hour
 * at the end of DST both match: pick the earliest one later than `prev` so a
 * chronological file maps 01:xx PDT then 01:xx PST. Times in the skipped spring
 * hour do not exist; they are returned as null.
 */
function pacificToEpoch(y, mo, d, h, mi, prev) {
  const wall = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  const cands = [7, 8]
    .map((off) => Date.UTC(y, mo - 1, d, h + off, mi))
    .filter((t) => wallClockOf(t) === wall)
    .sort((a, b) => a - b);
  if (!cands.length) return null;
  if (prev != null) {
    const later = cands.find((t) => t > prev);
    if (later != null) return later;
  }
  return cands[0];
}

// ISO 8601 with the correct Pacific offset, e.g. 2026-10-30T17:05:00-07:00.
function isoPacific(epoch) {
  const minute = epoch - (((epoch % 60000) + 60000) % 60000);
  const sec = String(Math.floor((epoch - minute) / 1000)).padStart(2, '0');
  const wall = wallClockOf(minute); // YYYY-MM-DD HH:MM
  const asUtc = Date.parse(wall.replace(' ', 'T') + ':00Z');
  const offMin = Math.round((asUtc - minute) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const a = Math.abs(offMin);
  return `${wall.replace(' ', 'T')}:${sec}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function num(s) {
  if (s == null) return null;
  const t = s.trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/*
 * Parses the BPA text. Returns { columns, rows: [{t, iso, load, ver, hydro, fossil, nuclear}], fileUpdated }.
 * Only rows with a numeric Hydro value are kept.
 */
function parseBpa(text) {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => /^\s*Date\/Time\s*\t/.test(l));
  if (hi < 0) throw new Error('BPA header row "Date/Time<TAB>..." not found');
  const columns = lines[hi].split('\t').map((c) => c.trim());
  const col = (name) => columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  const ix = { load: col('Load'), ver: col('VER'), hydro: col('Hydro'), fossil: col('Fossil/Biomass'), nuclear: col('Nuclear') };
  if (ix.hydro < 0 || ix.load < 0) throw new Error('BPA columns missing: ' + columns.join('|'));

  let fileUpdated = null;
  const m = text.match(/last updated (\d{1,2})([A-Za-z]{3})(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) + 1;
    const t = mon ? pacificToEpoch(+m[3], mon, +m[1], +m[4], +m[5]) : null;
    if (t != null) fileUpdated = isoPacific(t + Number(m[6]) * 1000);
  }

  const rows = [];
  let prev = null;
  for (let i = hi + 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const dm = (cells[0] || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
    if (!dm) continue;
    const t = pacificToEpoch(+dm[3], +dm[1], +dm[2], +dm[4], +dm[5], prev);
    if (t == null) continue;
    prev = t;
    const hydro = num(cells[ix.hydro]);
    if (hydro == null) continue; // future / missing interval
    rows.push({
      t, iso: isoPacific(t), hydro,
      load: num(cells[ix.load]),
      ver: ix.ver >= 0 ? num(cells[ix.ver]) : null,
      fossil: ix.fossil >= 0 ? num(cells[ix.fossil]) : null,
      nuclear: ix.nuclear >= 0 ? num(cells[ix.nuclear]) : null
    });
  }
  if (!rows.length) throw new Error('BPA file contained no hydro values');
  return { columns, rows, fileUpdated };
}

function buildJson(parsed, fetchedAt) {
  const last = parsed.rows[parsed.rows.length - 1];
  const cutoff = last.t - SERIES_HOURS * 3600 * 1000;
  return {
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: SOURCE,
    note: "BPA Balancing Authority totals (all hydro in BPA's BA, federal and non-federal). Not Willamette-specific. 5-minute SCADA MW, Pacific time.",
    fileUpdated: parsed.fileUpdated,
    latest: {
      time: last.iso, epochMs: last.t,
      hydroMW: last.hydro, loadMW: last.load, verMW: last.ver, fossilBiomassMW: last.fossil, nuclearMW: last.nuclear
    },
    seriesColumns: ['time', 'hydroMW', 'loadMW'],
    series: parsed.rows.filter((r) => r.t >= cutoff).map((r) => [r.iso, r.hydro, r.load])
  };
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'willamette-hydro-dispatch (GitHub Actions; static dashboard)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let text, lastErr;
  for (let attempt = 1; attempt <= 3 && !text; attempt++) {
    try { text = await fetchText(SOURCE); } catch (e) { lastErr = e; console.error(`attempt ${attempt} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 3000 * attempt)); }
  }
  if (!text) throw lastErr;
  const json = buildJson(parseBpa(text), Date.now());
  if (process.argv.includes('--stdout')) {
    process.stdout.write(JSON.stringify(json, null, 1) + '\n');
    return;
  }
  // Skip the write when only fetchedAt would change, so the workflow commits only real updates.
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const strip = (o) => JSON.stringify(Object.assign({}, o, { fetchedAt: null }));
    if (strip(old) === strip(json)) {
      console.log('bpa.json unchanged (latest ' + json.latest.time + ')');
      return;
    }
  } catch (e) { /* no previous file */ }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(json) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: latest ${json.latest.time} hydro ${json.latest.hydroMW} MW, ${json.series.length} points`);
}

module.exports = { SOURCE, parseBpa, buildJson, pacificToEpoch, isoPacific, fetchText };

if (require.main === module) {
  main().catch((err) => {
    console.error('fetch-bpa failed:', err.message);
    process.exit(1);
  });
}
