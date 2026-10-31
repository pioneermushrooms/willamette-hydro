#!/usr/bin/env node
/*
 * Checks every external link on the Docs page once.
 *   node scripts/check-links.js      (also: node check.js --links)
 * Sends a browser-like User-Agent and a small Range request (bytes 0-500); 200 and 206 pass.
 * nwp.usace.army.mil pages block automated clients (HTTP 403) but work in a browser:
 * a 403 from that host is reported as "expected", not a failure.
 */
'use strict';

const path = require('path');

// Load js/views/docs.js with a tiny HYDRO stub and read its link list.
function docLinks() {
  const root = { HYDRO: {} };
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'js', 'views', 'docs.js'), 'utf8');
  new Function('self', src)(root);
  return [...new Set(root.HYDRO.views.docs.LINKS())];
}

const EXPECTED_403 = /^https:\/\/www\.nwp\.usace\.army\.mil\//;

// Some hosts (water.usace.army.mil) ignore Range and stream 12-64 MB PDFs, and occasionally
// stall: only the status line is needed, the body is cancelled, and each link gets 3 tries.
async function checkOne(url) {
  let r;
  for (let k = 0; k < 3; k++) {
    r = await checkOnce(url);
    if (r.ok || (typeof r.status === 'number' && r.status >= 400 && r.status < 500)) return r;
  }
  return r;
}

async function checkOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-500' }, redirect: 'follow', signal: ctrl.signal });
    try { await r.body?.cancel(); } catch (e) { /* ignore */ }
    const ok = r.status === 200 || r.status === 206;
    const expected = !ok && r.status === 403 && EXPECTED_403.test(url);
    return { url, status: r.status, ok: ok || expected, note: expected ? 'expected 403 to bots (works in a browser)' : '' };
  } catch (e) {
    return { url, status: 'ERR', ok: false, note: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const links = docLinks();
  const results = [];
  let i = 0;
  await Promise.all([0, 1, 2, 3].map(async () => { while (i < links.length) results.push(await checkOne(links[i++])); }));
  results.sort((a, b) => links.indexOf(a.url) - links.indexOf(b.url));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${r.url.length > 110 ? r.url.slice(0, 107) + '...' : r.url}${r.note ? '  (' + r.note + ')' : ''}`);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} links ok`);
  return bad.length;
}

module.exports = { docLinks, checkOne, main };

if (require.main === module) main().then((bad) => process.exit(bad ? 1 : 0));
