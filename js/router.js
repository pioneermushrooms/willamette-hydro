/*
 * Hash router: #/overview (default), #/teacup, #/tables, #/docs.
 * Plain in-page anchors (#trends, #reservoirs, ...) keep the Overview view and scroll as usual.
 * Views register in HYDRO.views[name] = { title, render(el) } and render once, lazily, on first visit.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO;
  var ROUTES = ['overview', 'teacup', 'tables', 'docs'];
  var TITLES = { overview: 'Overview', teacup: 'Teacup', tables: 'Reports & Tables', docs: 'Docs' };
  var BASE_TITLE = document.title;
  var rendered = {};
  var last = null;

  H.views = H.views || {};

  function current() {
    var m = /^#\/([a-z]+)/.exec(location.hash);
    return m && ROUTES.indexOf(m[1]) >= 0 ? m[1] : 'overview';
  }

  function apply() {
    var r = current();
    document.querySelectorAll('[data-view]').forEach(function (el) { el.hidden = el.getAttribute('data-view') !== r; });
    document.querySelectorAll('.routes a[data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === r) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = (r === 'overview' ? '' : TITLES[r] + ' · ') + BASE_TITLE;
    var v = H.views[r], el = document.querySelector('[data-view="' + r + '"]');
    if (v && el && !rendered[r]) {
      rendered[r] = true;
      try { v.render(el); } catch (e) { el.insertAdjacentHTML('beforeend', '<p class="na">This view failed to load.</p>'); throw e; }
    }
    if (last !== null && r !== last && /^#\//.test(location.hash)) window.scrollTo(0, 0);
    last = r;
    document.dispatchEvent(new CustomEvent('hydro:route', { detail: { route: r } }));
  }

  window.addEventListener('hashchange', apply);
  H.router = { ROUTES: ROUTES, current: current, apply: apply, go: function (r) { location.hash = '#/' + r; } };
  apply();
})(typeof self !== 'undefined' ? self : this);
