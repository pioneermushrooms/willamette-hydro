#!/usr/bin/env node
/*
 * BPA Daily Interruptions Report -> data/bpa-outages.json (transmission lines, customer-service
 * feeders and transformers out in the Eugene area, plus anything naming the Willamette projects).
 *
 *   node scripts/fetch-bpa-outages.js            fetch + write data/bpa-outages.json
 *   node scripts/fetch-bpa-outages.js --stdout   fetch + print JSON, write nothing
 *   parse(html)                                  exported for check.js
 *
 * BPA publishes one HTML page per weekday (rolling 7 days), each covering 05:00–04:59 Pacific plus
 * everything still out: https://transmission.bpa.gov/Business/Operations/Outages/DIR/{Mon..Sun}.HTM
 * Tables: "Customer Service Interruptions", "Transmission Line Interruptions", "Transformer
 * Interruptions"; columns include Out/In Datetime (PPT), Name, Kilovolt, Outage Type (Auto/Plan),
 * Cause, O&M District, OARS Outage ID. No CORS, so this runs in GitHub Actions (update-bpa.yml).
 * Verified against the live pages on 2026-11-28. Node 20+, no deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://transmission.bpa.gov/Business/Operations/Outages/DIR/';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OUT = path.join(__dirname, '..', 'data', 'bpa-outages.json');
// Eugene O&M district, or names of substations / lines serving the southern Willamette projects.
const LOCAL_DISTRICT = /\bEUG\b/;
const LOCAL_NAME = /Lookout Point|Dexter|Hills Creek|Cougar|Green Peter|Foster|Detroit|Big Cliff|Alvey|Lane\b|Eugene|Springfield|Thurston|Jasper|Goshen|Oakridge|Leaburg|Walterville|Blue River|McKenzie|Cal Young|Santa Clara|Marcola|Lowell|Fall Creek|Cottage Grove|Dorena|Fern Ridge|Veneta|Creswell|Junction City|Lebanon|Sweet Home|Santiam/i;

function unescape(s) {
  return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

// "11/20/2026 14:43" (Pacific) -> ISO string with the Pacific offset of that date.
function pacificIso(s) {
  const m = /^(\d\d)\/(\d\d)\/(\d{4})\s+(\d\d):(\d\d)/.exec(s || '');
  if (!m) return null;
  const utcGuess = Date.UTC(+m[3], m[1] - 1, +m[2], +m[4], +m[5]);
  // Pacific is UTC−8 (PST) or UTC−7 (PDT); pick the one whose wall clock matches.
  for (const off of [8, 7]) {
    const t = utcGuess + off * 3600e3;
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(t);
    if (+p === +m[4]) return new Date(t).toISOString();
  }
  return new Date(utcGuess + 8 * 3600e3).toISOString();
}

// One report page -> [{ table, name, kv, out, in, stillOut, type, cause, district, id }]
function parse(html) {
  const items = [];
  const re = /class="tablelabel">([^<]+)<\/div>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = re.exec(html))) {
    const table = m[1].replace(/\(.*\)/, '').trim();
    const heads = (m[2].match(/<th[^>]*>[\s\S]*?<\/th>/g) || []).map((h) => unescape(h).toLowerCase());
    const col = (re2) => heads.findIndex((h) => re2.test(h));
    const C = { out: col(/^out datetime/), in: col(/^in datetime/), name: col(/^name/), kv: col(/kilovolt/), type: col(/outage type/), cause: col(/^cause/),
      district: col(/district/), id: col(/oars/) };
    (m[2].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).forEach((tr) => {
      const c = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(unescape);
      if (c.length < 5 || C.name < 0) return;
      const get = (k) => (C[k] >= 0 ? c[C[k]] || '' : '');
      const inRaw = get('in');
      items.push({
        table, name: get('name'), kv: parseFloat(get('kv')) || null,
        out: pacificIso(get('out')), in: pacificIso(inRaw), stillOut: !pacificIso(inRaw),
        type: get('type'), cause: get('cause'), district: get('district'), id: get('id') || null
      });
    });
  }
  return items;
}

function isLocal(it) { return LOCAL_DISTRICT.test(it.district || '') || LOCAL_NAME.test(it.name || ''); }

async function main() {
  const all = [], errors = [];
  for (const d of DAYS) {
    try {
      const r = await fetch(BASE + d + '.HTM', { headers: { 'User-Agent': 'willamette-hydro outage copier (GitHub Actions)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      all.push(...parse(await r.text()));
    } catch (e) { errors.push(d + ': ' + e.message); }
  }
  if (!all.length) throw new Error('no rows parsed (' + errors.join('; ') + ')');
  // De-duplicate across days (same outage appears on several pages while still out); keep the newest info.
  const byKey = new Map();
  all.filter(isLocal).forEach((it) => {
    const k = it.id || it.table + '|' + it.name + '|' + it.out;
    const prev = byKey.get(k);
    if (!prev || (prev.stillOut && !it.stillOut)) byKey.set(k, it);
  });
  const items = [...byKey.values()].sort((a, b) => (b.out || '').localeCompare(a.out || ''));
  const out = { fetchedAt: new Date().toISOString(), source: BASE, rowsParsed: all.length, errors, items };
  return out;
}

if (require.main === module) {
  main().then((j) => {
    const txt = JSON.stringify(j, null, 1) + '\n';
    if (process.argv.includes('--stdout')) process.stdout.write(txt);
    else {
      // Only rewrite when the content (not just fetchedAt) changed, so the job does not commit every run.
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
      if (prev && JSON.stringify(prev.items) === JSON.stringify(j.items) && Date.now() - Date.parse(prev.fetchedAt) < 6 * 3600e3) { console.log('bpa-outages unchanged (' + j.items.length + ' local items)'); return; }
      fs.writeFileSync(OUT, txt);
      console.log('wrote ' + OUT + ': ' + j.items.length + ' local items of ' + j.rowsParsed + ' rows');
    }
  }, (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { parse, isLocal, pacificIso };
