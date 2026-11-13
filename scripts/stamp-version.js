#!/usr/bin/env node
/*
 * Cache-busting tag for index.html: every local script/stylesheet is referenced as
 * "js/x.js?v=<tag>", where <tag> is a hash of the contents of js/ and css/. A new deploy
 * therefore changes every URL, so a browser can never run a new index.html with old cached
 * code (GitHub Pages lets browsers cache files for 10 minutes).
 *
 *   node scripts/stamp-version.js           rewrite index.html with the current tag
 *   node scripts/stamp-version.js --check   exit 1 if index.html is not stamped with it
 *
 * check.js fails when the tag is stale, so run this after changing anything in js/ or css/.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(js|css)$/.test(d.name) ? [p] : [];
  });
}

function tag() {
  const h = crypto.createHash('sha1');
  ['js', 'css'].flatMap((d) => files(path.join(ROOT, d))).sort().forEach((f) => {
    h.update(path.relative(ROOT, f).split(path.sep).join('/')); h.update('\0');
    h.update(fs.readFileSync(f)); h.update('\0');
  });
  return h.digest('hex').slice(0, 10);
}

function stamp(html, t) {
  return html.replace(/((?:src|href)="(?:js|css)\/[^"?#]+\.(?:js|css))(?:\?v=[^"]*)?"/g, (m, p1) => p1 + '?v=' + t + '"');
}

module.exports = { tag, stamp };

if (require.main === module) {
  const t = tag(), html = fs.readFileSync(INDEX, 'utf8'), out = stamp(html, t);
  if (process.argv.includes('--check')) {
    if (out !== html) { console.error('index.html is not stamped with ?v=' + t + ' (run node scripts/stamp-version.js)'); process.exit(1); }
    console.log('index.html stamped ?v=' + t);
  } else if (out !== html) { fs.writeFileSync(INDEX, out); console.log('stamped ?v=' + t); }
  else console.log('already stamped ?v=' + t);
}
