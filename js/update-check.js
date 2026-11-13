/*
 * Picks up new deploys of this site in pages that are already open.
 *
 * GitHub Pages has no build stamp, so the page fingerprints its own code: index.html plus every
 * same-origin script and stylesheet it loads (fetched with cache: 'no-store', FNV-1a hash).
 * It checks every 10 minutes and whenever the tab becomes visible again. When the fingerprint
 * changes it reloads, keeping the current route. On the Calculator page, or while a form field
 * has focus, it shows a banner with a Reload button instead, so typed inputs are not lost.
 * Data files (data/bpa.json) are not part of the fingerprint.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO || (root.HYDRO = {});
  var EVERY_MS = 10 * 60 * 1000;
  var base = null, busy = false, lastCheck = 0;

  function fnv(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  function assets() {
    var out = [location.pathname || './'];
    document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach(function (el) {
      var u = new URL(el.getAttribute('src') || el.getAttribute('href'), location.href);
      if (u.origin === location.origin) out.push(u.pathname);
    });
    return out;
  }

  // Fingerprint of the deployed code, or null if any file could not be read (offline, etc.).
  function fingerprint() {
    return Promise.all(assets().map(function (p) {
      return fetch(p, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
    })).then(function (texts) { return fnv(texts.join('\u0000')); }, function () { return null; });
  }

  function editing() {
    var a = document.activeElement;
    return /^#\/calc/.test(location.hash) || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  function banner() {
    if (document.getElementById('update-banner')) return;
    var d = document.createElement('div');
    d.id = 'update-banner';
    d.className = 'update-banner';
    d.setAttribute('role', 'status');
    d.innerHTML = '<span>A new version of this site is available.</span> <button type="button" class="btn">Reload</button>';
    d.querySelector('button').addEventListener('click', function () { location.reload(); });
    document.body.appendChild(d);
  }

  function check() {
    if (busy || !base) return;
    busy = true; lastCheck = Date.now();
    fingerprint().then(function (fp) {
      busy = false;
      if (!fp || fp === base) return;
      if (editing()) banner();
      else location.reload();
    });
  }

  function start() {
    fingerprint().then(function (fp) { base = fp; });
    setInterval(check, EVERY_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastCheck > 60 * 1000) check();
    });
  }

  H.updateCheck = { check: check, fingerprint: fingerprint, fnv: fnv };
  if (typeof document !== 'undefined' && location.protocol !== 'file:') start();
})(typeof self !== 'undefined' ? self : this);
