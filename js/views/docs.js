/*
 * Docs view (#/docs): verified public documents and the data sources this site uses.
 * Every external link here is checked by `node check.js --links` (scripts/check-links.js).
 */
(function (root) {
  'use strict';
  var H = root.HYDRO;
  H.views = H.views || {};

  var EIS = 'https://www.nwp.usace.army.mil/WVS-EIS/';
  var INJ = 'https://www.nwp.usace.army.mil/Locations/Willamette-Valley/Injunction/';

  // Kept as data so check-links.js can verify them; [title, url, description].
  var SECTIONS = [
    {
      id: 'eis', title: 'Operating plan & environmental review',
      links: [
        ['Willamette Valley System EIS (USACE Portland District)', EIS,
          'Project page for the Willamette Valley System operations EIS: Final Supplemental EIS published May 22, 2026; Record of Decision June 23, 2026; ESA consultation reinitiated. Earlier EIS ROD May 13, 2025.'],
        ['Record of Decision, Supplemental EIS (June 23, 2026)', 'https://publibrary.sec.usace.army.mil/api/download?filename=ROD_Willamette_Valley_OM_Supplemental_EIS_23_June_2026.pdf&id=9726a545-fc77-46c4-91f1-833dd65560c4&preview=true',
          'PDF of the June 23, 2026 ROD for Willamette Valley System operations and maintenance.'],
        ['Final SEIS Appendix N: adaptive management / interim operations', 'https://www.bpa.gov/-/media/Aep/efw/nepa/active/willamette-valley-system-eis/final-supp/WVS_Final_SEIS_Appendix-N.pdf',
          'PDF appendix describing adaptive management and the interim operations plan (hosted by BPA as a cooperating agency).']
      ]
    },
    {
      id: 'court', title: 'Court & consultation',
      links: [
        ['Willamette injunction (USACE Portland District)', INJ,
          'Court orders, implementation plans and six-month reports for the 2021 injunction measures.'],
        ['2024 NMFS Biological Opinion (NOAA Fisheries)', 'https://www.fisheries.noaa.gov/resource/document/endangered-species-act-section-7a2-biological-opinion-and-magnuson-stevens-0',
          'Landing page for the ESA section 7(a)(2) Biological Opinion and Magnuson-Stevens EFH consultation, issued Dec 26, 2024.'],
        ['Injunction research, monitoring & evaluation index', 'https://public.crohms.org/tmt/documents/FPOM/2010/Willamette_Coordination/Willamette%20RME/InjunctionRME.html',
          'Index of RM&E documents produced under the injunction (CROHMS public document library).']
      ]
    }
  ];

  var MANUALS = [
    ['Lookout Point & Dexter', '1-K', 'https://water.usace.army.mil/cda/documents/wc/2620/WaterControlManual_Lookout_Point_2017_Redacted.pdf'],
    ['Hills Creek', '1-J', 'https://water.usace.army.mil/cda/documents/wc/2616/Hills%20Creek%20WCM%202017_Redacted.pdf'],
    ['Green Peter', '1-I', 'https://water.usace.army.mil/cda/documents/wc/2615/Water-Control-Manual_GreenPeter_2017_Redacted.pdf'],
    ['Fern Ridge', '1-G', 'https://water.usace.army.mil/cda/documents/wc/2613/WaterControlManualforFernRidgeLake_2017_Redacted.pdf'],
    ['Dorena', '1-E', 'https://water.usace.army.mil/cda/documents/wc/2611/Dorena%20WCM%202017_Redacted.pdf'],
    ['Cougar', '1-C', 'https://water.usace.army.mil/cda/documents/wc/2534/WaterControlManualforCougar_2017_Redacted.pdf'],
    ['Cottage Grove', '1-B', 'https://water.usace.army.mil/cda/documents/wc/2533/Cottage_Grove_Water_Control_Manual_2017_Redacted.pdf']
  ];

  // [source, what this site uses it for, kind, url]
  var SOURCES = [
    ['USGS NWIS Instantaneous Values', 'River discharge, gage height, water temperature (6 gauges)', 'LIVE', 'https://waterservices.usgs.gov/'],
    ['USGS NWIS rating files (exsa)', 'Stage–discharge ratings on the Tables page', 'PUBLISHED', 'https://nwis.waterdata.usgs.gov/nwisweb/get_ratings?site_no=14166000&file_type=exsa'],
    ['USACE CWMS Data API (office NWDP) — time series', 'Pool elevation, storage, outflow, computed inflow, daily rule curve', 'LIVE', 'https://cwms-data.usace.army.mil/cwms-data/'],
    ['USACE CWMS — TDG time series', 'Total dissolved gas % saturation below Dexter and Cougar (CWMS reported, provisional)', 'LIVE', 'https://cwms-data.usace.army.mil/cwms-data/timeseries?office=NWDP&name=DEXO.%25-Saturation-TDG.Inst.0.0.MIXED-REV&unit=%25'],
    ['USACE CWMS — location levels', 'Structural elevations, conservation pool limits, 30-yr statistics, published targets (incl. ODEQ 2006 TMDL temperature targets)', 'PUBLISHED', 'https://cwms-data.usace.army.mil/cwms-data/levels?office=NWDP&level-id-mask=LOP.Elev.Inst.0.Top%20of%20Dam'],
    ['USACE CWMS — ratings', 'Elevation–storage, elevation–area, spillway and outlet ratings', 'PUBLISHED', 'https://cwms-data.usace.army.mil/cwms-data/ratings/LOP-Spillway.Elev-Forebay%3BFlow-Free.Standard.CENWP?office=NWDP'],
    ['NOAA National Water Prediction Service (NWPS)', 'Flood categories, NWS/NWRFC river forecasts, historic crests', 'LIVE', 'https://water.noaa.gov/'],
    ['NRCS AWDB / SNOTEL', 'Snowpack panel on Overview: SWE, snow depth, 7-day SWE (8 Willamette-basin stations)', 'LIVE (daily)', 'https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html'],
    ['BPA balancing-authority totals', 'BPA-wide hydro generation (copied every 30 min by a GitHub Action)', 'LIVE (30 min)', 'https://transmission.bpa.gov/business/operations/Wind/baltwg.txt']
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function a(url, text) { return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text) + ' ↗</a>'; }

  function render(el) {
    var h = '';
    SECTIONS.forEach(function (sec) {
      h += '<section class="panel doc-sec" id="docs-' + sec.id + '"><div class="panel-head"><h2>' + esc(sec.title) + '</h2></div><ul class="doc-list">' +
        sec.links.map(function (l) { return '<li>' + a(l[1], l[0]) + '<p>' + esc(l[2]) + '</p></li>'; }).join('') + '</ul>' +
        (sec.id === 'eis' ? '<p class="hint doc-note">Note: pages on nwp.usace.army.mil (here and below) may block automated tools; they work in a browser.</p>' : '') + '</section>';
    });

    h += '<section class="panel doc-sec" id="docs-manuals"><div class="panel-head"><h2>Water control manuals</h2></div>' +
      '<div class="table-scroll doc-table"><table><thead><tr><th>Project</th><th>Appendix</th><th>Manual (PDF)</th></tr></thead><tbody>' +
      MANUALS.map(function (m) { return '<tr><td>' + esc(m[0]) + '</td><td>Appendix ' + esc(m[1]) + '</td><td>' + a(m[2], 'Water control manual') + '</td></tr>'; }).join('') +
      '</tbody></table></div>' +
      '<p class="hint doc-note">Redacted public versions, July 2017 revisions. Lookout Point and Dexter share one manual. The Willamette Basin Master Manual was still a draft as of 2017.</p></section>';

    h += '<section class="panel doc-sec" id="docs-interim"><div class="panel-head"><h2>Interim operations in force</h2></div>' +
      '<p class="hint doc-note">This is our own short summary of the USACE pages linked above, not an official description, and it is not live operating status. Check the source pages for the current plan.</p>' +
      '<ul class="doc-bullets">' +
      '<li><b>Green Peter:</b> deep fall drawdown, with spill in spring.</li>' +
      '<li><b>Lookout Point:</b> deep drawdown in late fall, and use of the spillway in spring.</li>' +
      '<li><b>Cougar:</b> deep drawdown in late fall, then a delayed refill in spring.</li>' +
      '<li><b>Foster:</b> delayed spring refill and a fish weir in summer.</li>' +
      '<li><b>Hills Creek:</b> winter releases prioritized at night.</li>' +
      '<li><b>Big Cliff:</b> spill spread across spillway bays to reduce total dissolved gas.</li>' +
      '<li><b>Detroit:</b> phased deep fall drawdown (to 1,425 ft in the first year, 2026, then 1,395 ft in later years), with real-time turbidity monitoring.</li>' +
      '</ul>' +
      '<p>Examples of the court-ordered 2021 injunction measures, as described on the USACE injunction page and later folded into the 2025 and 2026 RODs: Green Peter drawn down to 780 ft by Nov 15 and held to Dec 15; ' +
      'Cougar to 1,505 ft by Nov 15 until Dec 15, refilled to 1,532 ft, then drafted to 1,520 ft from Mar 1 to Apr 1; Lookout Point deep drawdown Nov 15–Dec 15, with spring spill once the pool reaches 890 ft, held at 890–893 ft.</p>' +
      '<p class="hint">Sources: ' + a(EIS, 'WVS EIS page') + ' · ' + a(INJ, 'injunction page') + '. The <a href="#/teacup">Teacup</a> page shows the published CWMS target levels for LOP, GPR, CGR and HCR (published targets, not statements of current operations).</p></section>';

    h += '<section class="panel doc-sec" id="docs-sources"><div class="panel-head"><h2>Data sources used on this site</h2></div>' +
      '<div class="table-scroll doc-table"><table><thead><tr><th>Source</th><th>What</th><th>Type</th><th>Link</th></tr></thead><tbody>' +
      SOURCES.map(function (s) { return '<tr><td>' + esc(s[0]) + '</td><td>' + esc(s[1]) + '</td><td><span class="lbl">' + esc(s[2]) + '</span></td><td>' + a(s[3], 'open') + '</td></tr>'; }).join('') +
      '</tbody></table></div>' +
      '<p class="hint doc-note">LIVE = fetched while you use the page; PUBLISHED = reference tables or levels, not measurements; DERIVED = computed on this site and labelled as such where shown.</p></section>';

    h += '<section class="panel doc-sec doc-disclaimer" id="docs-disclaimer"><div class="panel-head"><h2>Disclaimer</h2></div>' +
      '<p>This is an unofficial, independent dashboard. It is not affiliated with, endorsed by, or operated by the U.S. Army Corps of Engineers, USGS, NOAA / National Weather Service, NRCS, BPA, or any other agency or utility. ' +
      'Data is provisional and may be incomplete, delayed or wrong. Published targets and ratings are shown for reference only. Do not use this site for safety, navigation, recreation or operational decisions; consult the official sources above.</p></section>';

    el.querySelector('.view-body').innerHTML = h;
  }

  H.views.docs = {
    title: 'Docs',
    render: render,
    // exported for scripts/check-links.js
    LINKS: function () {
      var out = [];
      SECTIONS.forEach(function (s) { s.links.forEach(function (l) { out.push(l[1]); }); });
      MANUALS.forEach(function (m) { out.push(m[2]); });
      SOURCES.forEach(function (s) { out.push(s[3]); });
      return out;
    }
  };
})(typeof self !== 'undefined' ? self : this);
