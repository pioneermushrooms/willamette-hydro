/* Teacup view — placeholder (filled in a later stage). */
(function (root) {
  'use strict';
  var H = root.HYDRO;
  H.views = H.views || {};
  H.views.teacup = {
    title: 'Teacup',
    render: function (el) {
      el.querySelector('.view-body').innerHTML =
        '<p>Coming in a later stage: a “teacup” view of all eight lakes, with a per-lake elevation ruler showing ' +
        'the live pool against the USACE rule curve, the published conservation and flood levels, the 30-year ' +
        'statistics band (DERIVED from CWMS published stats) and interim-operations / injunction targets ' +
        '(PUBLISHED TARGET, not a statement of current operations).</p>' +
        '<p class="hint">Meanwhile, live pool elevations and rule curves are on the <a href="#/overview">Overview</a>.</p>';
    }
  };
})(typeof self !== 'undefined' ? self : this);
