#!/usr/bin/env node
/*
 * NWRFC reservoir inflow forecasts -> data/inflow-fcst.json
 *
 *   node scripts/fetch-inflow-fcst.js            fetch + write data/inflow-fcst.json
 *   node scripts/fetch-inflow-fcst.js --stdout   fetch + print JSON, write nothing
 *   node scripts/fetch-inflow-fcst.js --debug    print raw table rows of the first page
 *   parse(html)                                  exported for check.js
 *
 * Source: the NW River Forecast Center's text summary page per dam,
 *   https://www.nwrfc.noaa.gov/station/flowplot/textPlot.cgi?id=<LID>&pe=QI
 * which lists observed inflow and the "Forecast/Trend" inflow (cfs, ~6-hourly, ~10 days) with its
 * issue time ("Issued: 2026-11-27 13:50 PST"). The page has no CORS headers, so GitHub Actions copies
 * it (update-bpa.yml). Times on the page are Pacific Standard Time (UTC−8). Node 20+, no deps.
 * The CWMS forecast series (<P>.Flow-In.Inst.~6Hours.0.RFC-FCST) are catalogued but publicly empty.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'inflow-fcst.json');
const URL = (lid) => 'https://www.nwrfc.noaa.gov/station/flowplot/textPlot.cgi?id=' + lid + '&pe=QI';
// Project -> NWRFC dam IDs to try (first that returns a forecast wins). Verified: COT, LOP, CGR, BLU, FRN.
const SITES = {
  HCR: ['HCRO3', 'HCDO3'], LOP: ['LOPO3'], DEX: ['DEXO3', 'LDXO3'], FAL: ['FALO3', 'FCLO3'], GPR: ['GPRO3'],
  CGR: ['CGRO3'], BLU: ['BLUO3'], FRN: ['FRNO3'], COT: ['COTO3'], DOR: ['DORO3']
};

function text(s) { return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
// "2026-11-27 22:00" PST -> epoch ms
function pst(s) { const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(s || ''); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4] + 8, +m[5]) : null; }

// -> { name, issued, obs: [[t, cfs]...], fcst: [[t, cfs]...] }
function parse(html) {
  const nm = /<title>\s*([^<]+?)\s*--\s*Text Summary/i.exec(html) || /([A-Z][A-Z .&'-]+--[A-Z .&'-]+\([A-Z0-9]+\))/.exec(text(html));
  const iss = /Issued:\s*(?:&nbsp;)*\s*(\d{4}-\d\d-\d\d \d\d:\d\d)/.exec(html.replace(/&nbsp;/g, ' '));
  const obs = [], fcst = [];
  (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).forEach((tr) => {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(text);
    // Rows hold an observed pair, then a spacer, then a forecast pair; either side may be blank.
    const pairs = [];
    for (let i = 0; i < cells.length - 1; i++) {
      if (/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(cells[i]) && /^-?[\d.]+$/.test(cells[i + 1])) { pairs.push({ i, t: pst(cells[i]), v: +cells[i + 1] }); i++; }
    }
    if (!pairs.length) return;
    if (pairs.length >= 2) { obs.push([pairs[0].t, pairs[0].v]); fcst.push([pairs[1].t, pairs[1].v]); }
    else if (pairs[0].i >= 2) fcst.push([pairs[0].t, pairs[0].v]);   // only the right-hand (forecast) pair
    else obs.push([pairs[0].t, pairs[0].v]);
  });
  obs.sort((a, b) => a[0] - b[0]); fcst.sort((a, b) => a[0] - b[0]);
  return { name: nm ? nm[1].trim() : null, issued: iss ? pst(iss[1]) : null, obs, fcst };
}

async function fetchText(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'willamette-hydro inflow-forecast copier (GitHub Actions)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function main() {
  if (process.argv.includes('--debug')) {
    const h = await fetchText(URL('COTO3'));
    (h.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).slice(0, 12).forEach((tr) => console.log(JSON.stringify((tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(text))));
    console.log(JSON.stringify(parse(h)).slice(0, 600));
    return null;
  }
  const out = { fetchedAt: new Date().toISOString(), source: 'https://www.nwrfc.noaa.gov/', projects: {}, errors: [] };
  for (const code of Object.keys(SITES)) {
    for (const lid of SITES[code]) {
      try {
        const p = parse(await fetchText(URL(lid)));
        if (!p.fcst.length) { out.errors.push(code + ' ' + lid + ': no forecast rows'); continue; }
        // Keep the last 2 days of observed inflow and the full forecast.
        const cut = Date.now() - 2 * 86400e3;
        out.projects[code] = { lid, name: p.name, issued: p.issued ? new Date(p.issued).toISOString() : null, obs: p.obs.filter((x) => x[0] >= cut), fcst: p.fcst,
          page: 'https://www.nwrfc.noaa.gov/river/station/flowplot/flowplot.cgi?lid=' + lid };
        break;
      } catch (e) { out.errors.push(code + ' ' + lid + ': ' + e.message); }
    }
  }
  if (!Object.keys(out.projects).length) throw new Error('no forecasts parsed: ' + out.errors.join('; '));
  return out;
}

if (require.main === module) {
  main().then((j) => {
    if (!j) return;
    const txt = JSON.stringify(j) + '\n';
    if (process.argv.includes('--stdout')) { process.stdout.write(JSON.stringify(j, null, 1).slice(0, 8000) + '\n'); return; }
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
    const strip = (o) => JSON.stringify(Object.keys(o.projects).map((k) => [k, o.projects[k].issued, o.projects[k].fcst]));
    if (prev && strip(prev) === strip(j) && Date.now() - Date.parse(prev.fetchedAt) < 3 * 3600e3) { console.log('inflow forecasts unchanged'); return; }
    fs.writeFileSync(OUT, txt);
    console.log('wrote ' + OUT + ': ' + Object.keys(j.projects).join(', ') + (j.errors.length ? ' | ' + j.errors.join('; ') : ''));
  }, (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { parse, pst, SITES };
