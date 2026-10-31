/* Reports & Tables view — placeholder (filled in a later stage). */
(function (root) {
  'use strict';
  var H = root.HYDRO;
  H.views = H.views || {};
  H.views.tables = {
    title: 'Reports & Tables',
    render: function (el) {
      el.querySelector('.view-body').innerHTML =
        '<p>Coming in a later stage: published rating tables, including reservoir elevation–storage and ' +
        'elevation–area tables and spillway ratings (USACE CWMS), and USGS stage–discharge ratings for the river ' +
        'gauges, with a lookup tool, curve chart and paged table.</p>';
    }
  };
})(typeof self !== 'undefined' ? self : this);
