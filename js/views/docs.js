/* Docs view — placeholder (filled in a later stage). */
(function (root) {
  'use strict';
  var H = root.HYDRO;
  H.views = H.views || {};
  H.views.docs = {
    title: 'Docs',
    render: function (el) {
      el.querySelector('.view-body').innerHTML =
        '<p>Coming in a later stage: links to verified public documents (Willamette Valley System EIS and records ' +
        'of decision, water control manuals, injunction materials) and notes on every data source this site uses.</p>' +
        '<p class="hint">For now, data sources are described in the footer and the project README.</p>';
    }
  };
})(typeof self !== 'undefined' ? self : this);
