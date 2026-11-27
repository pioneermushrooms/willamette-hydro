/*
 * Picks up new deploys of this site in pages that are already open.
 *
 * GitHub Pages has no build stamp, so the page fingerprints its own code: index.html plus every
 * same-origin script and stylesheet it loads (fetched with cache: 'no-store', FNV-1a hash).
 * It checks every 10 minutes and whenever the tab becomes visible again. When the fingerprint
 * changes while the tab is hidden it reloads quietly (keeping the route), so the page is already
 * current when you come back. While you are looking at the page it never reloads by itself: it
 * shows a banner with a Reload button instead. The Calculator page always gets the banner.
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
      if (document.hidden && !/^#\/calc/.test(location.hash)) { saveScroll(); location.reload(); }
      else banner();
    });
  }

  /*
   * Scroll position across reloads. The browser's own restoration jumps to a pixel offset before the
   * live data has filled the page, which can land on the reservoir or river cards. Instead remember
   * the section at the top of the screen and the offset into it, and return there once data is drawn.
   */
  var ANCHORS = ['#totals', '#workspace', '#trends', '#ws-more', '#snow'];
  var SKEY = 'wvhd:scroll';
  function saveScroll() {
    try {
      var best = null;
      ANCHORS.forEach(function (sel) {
        var el = document.querySelector(sel);
        if (el && el.offsetParent !== null && el.getBoundingClientRect().top <= 1) best = { sel: sel, off: Math.round(-el.getBoundingClientRect().top) };
      });
      sessionStorage.setItem(SKEY, JSON.stringify({ hash: location.hash, y: scrollY, a: best }));
    } catch (e) { /* storage unavailable */ }
  }
  function restoreScroll() {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); sessionStorage.removeItem(SKEY); } catch (e) { return; }
    if (!saved || saved.hash !== location.hash) return;
    var go = function () {
      var el = saved.a && document.querySelector(saved.a.sel);
      window.scrollTo(0, el ? el.getBoundingClientRect().top + scrollY + saved.a.off : saved.y);
    };
    // After the first data render; then keep the section in place while late content above it
    // (detail panel, weather, history) changes height, for up to 10 s or until the reader scrolls.
    var once = function () {
      document.removeEventListener('hydro:data', once);
      go();
      if (typeof ResizeObserver === 'undefined') return;
      var ro = new ResizeObserver(function () { go(); });
      var stop = function () { ro.disconnect(); ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) { removeEventListener(ev, stop, true); }); };
      ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) { addEventListener(ev, stop, true); });
      ro.observe(document.body);
      setTimeout(stop, 10000);
    };
    document.addEventListener('hydro:data', once);
    setTimeout(function () { document.removeEventListener('hydro:data', once); }, 30000);
  }

  function start() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.addEventListener('pagehide', saveScroll);
    restoreScroll();
    fingerprint().then(function (fp) { base = fp; });
    setInterval(check, EVERY_MS);
    document.addEventListener('visibilitychange', function () {
      if (Date.now() - lastCheck > 60 * 1000) check();
    });
  }

  H.updateCheck = { check: check, fingerprint: fingerprint, fnv: fnv };
  if (typeof document !== 'undefined' && location.protocol !== 'file:') start();
})(typeof self !== 'undefined' ? self : this);
