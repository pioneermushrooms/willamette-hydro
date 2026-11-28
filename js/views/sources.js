/*
 * Derivation & Sources view (#/sources): plain-language FAQ on where every number on this site
 * comes from, whether this site computes it, how fresh it is, and how far to trust it.
 * Content only (no fetching). Links point at the same public endpoints the site reads.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO;
  H.views = H.views || {};

  var CWMS = 'https://cwms-data.usace.army.mil/cwms-data/';
  var CWMS_TS = CWMS + 'timeseries?office=NWDP&unit=EN&name=';
  var USGS_IV = 'https://waterservices.usgs.gov/docs/instantaneous-values/';
  var A2W = 'https://water.sec.usace.army.mil/';

  // Kinds of value. Every answer is tagged with one.
  var KIND = {
    reported: ['Reported', 'Shown exactly as the agency publishes it. This site does not change the number.'],
    computed: ['Agency-computed', 'Calculated by the agency (not measured), then shown as published.'],
    derived: ['Derived here', 'Calculated by this site from agency values, with the formula shown.'],
    model: ['Weather model', 'Model output, not a gauge measurement.'],
    published: ['Published reference', 'Fixed or seasonal reference values the agency publishes (levels, ratings, targets).'],
    rule: ['Site rule', 'A threshold chosen by this site, not an agency determination.']
  };

  var GROUPS = [
    { title: 'The basics', items: [
      { q: 'Is any of this made up, simulated or filled in?', kind: null,
        a: '<p>No. Every number is fetched by <b>your browser</b>, directly from the public agency service, each time the page loads and every 5 minutes after that. Nothing is invented: if a request fails or a series is empty, the page says <i>no data</i> rather than guessing. The site’s own test suite checks that no random or seeded data generator exists in the code.</p>' +
          '<p>The one exception to “fetched by your browser” is the BPA-wide hydro total: BPA’s file cannot be read from a browser, so a scheduled GitHub Action copies it into the site every 30 minutes, unchanged.</p>' },
      { q: 'How can I check a number myself?', kind: null,
        a: '<p>Click the small <b>↗</b> next to any value. It opens the exact agency series it came from, e.g. the raw USACE CWMS series for the last 24 hours (your browser may show it as XML) or the USGS page for that gauge and parameter. The newest value there should match the one here.</p>' +
          '<p>Series names under the Trend Recorder chart (like <code>BLU.Flow-In.Ave.15Minutes.6Hours.MIXED-COMPUTED-REV</code>) are links too.</p>' },
      { q: 'How fresh is the data?', kind: null,
        a: '<p>The page checks for new data every <b>5 minutes</b>, and again as soon as you return to the tab. The Trend Recorder shows “checked hh:mm”.</p>' +
          '<p>Agencies publish with a delay: USACE CWMS values typically appear <b>15–35 minutes</b> after their timestamp, USGS <b>5–15 minutes</b>. So a reading stamped 12:30 at 12:55 can be the newest that exists. Readings older than 3 h are flagged STALE; older than 12 h, red.</p>' },
      { q: 'Are these official values?', kind: null,
        a: '<p>They are the agencies’ <b>provisional</b> real-time data, the same numbers they publish, but this is not an agency site. Real-time data can be revised later (USGS marks provisional values with a “P”). For operations, use the official sources and current operating orders.</p>' }
    ] },
    { title: 'Reservoirs (USACE)', items: [
      { q: 'Pool elevation', kind: 'reported',
        a: '<p>Forebay water-surface elevation (ft, NGVD29) from USACE CWMS, series <code>&lt;CODE&gt;.Elev-Forebay.Inst.0.0.MIXED-REV</code>, usually every 15 minutes. “MIXED” means USACE merges its sensors into one series.</p>',
        src: [['Example: Blue River raw series', CWMS_TS + 'BLU.Elev-Forebay.Inst.0.0.MIXED-REV'], ['USACE Access to Water', A2W]] },
      { q: 'Inflow — why does it jump around or go negative?', kind: 'computed',
        a: '<p>Nobody measures reservoir inflow directly. USACE computes it: <b>inflow = outflow + change in storage ÷ time</b>, with storage from the pool reading and the lake’s elevation–storage table. The series (<code>…Flow-In.Ave.15Minutes.6Hours…</code>) is a new value every 15 minutes, each the <b>average of the past 6 hours</b>, so it lags fast changes by about 3 hours compared with outflow.</p>' +
          '<p>Small pool-reading blips (wind, waves, sensor) become large inflow swings, especially on small lakes: 0.01 ft on a 1,000-acre lake over 15 minutes is about 480 cfs. That is how a value like −200 cfs appears. The site shows it as published; the Calculator uses a 24-hour mean, never below 0.</p>',
        src: [['Example: Blue River inflow', CWMS_TS + 'BLU.Flow-In.Ave.15Minutes.6Hours.MIXED-COMPUTED-REV']] },
      { q: 'Outflow', kind: 'computed',
        a: '<p>Total release from the dam, from USACE CWMS. At most projects it is <code>…Flow-Out.Inst.0.0.MIXED-COMPUTED-REV</code>, computed by USACE from gate openings and pool level with the gate ratings; at the two hydropower projects flagged in the code it is an hourly average (<code>…Flow-Out.Ave.1Hour.1Hour.CBT-REV</code>). For a measured check, compare with the USGS gage below the dam on the Tables page.</p>' },
      { q: 'Storage', kind: 'computed',
        a: '<p>Acre-feet in the reservoir, from USACE CWMS <code>…Stor.Inst.0.0.MIXED-COMPUTED-REV</code>: the pool elevation converted with the USACE elevation–storage rating. Dexter publishes no storage.</p>' },
      { q: 'Rule curve', kind: 'published',
        a: '<p>The USACE water-control-diagram elevation for each day, CWMS <code>…Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC</code>. One value per day; the chart joins days with straight lines.</p>' },
      { q: '“vs rule curve” and the status lights', kind: 'rule',
        a: '<p><b>vs rule curve = pool elevation − today’s rule-curve elevation.</b> The colour bands are this site’s choice: more than 10 ft below = below (amber), more than 2 ft above = above (blue), otherwise near (green). Lights also turn amber or red when readings are over 3 h or 12 h old. They are not an agency determination.</p>' },
      { q: '% full', kind: 'derived',
        a: '<p><b>(storage − bottom of conservation storage) ÷ (top − bottom) × 100</b>, using the USACE conservation-pool limits (hard-coded for most projects; read from CWMS location levels at runtime for Fall Creek and Blue River). The mini teacups in the list use the same idea by elevation. Below the conservation pool shows as “Below cons. pool”.</p>' },
      { q: 'Total reservoir release and basin conservation storage (top tiles)', kind: 'derived',
        a: '<p><b>Total release</b> = sum of the latest outflow of every project whose outflow reading is under 3 h old; the tile says how many are reporting.</p>' +
          '<p><b>Basin conservation storage</b> = Σ (storage − bottom) ÷ Σ (top − bottom) over projects with a fresh storage reading, i.e. one % full for the whole system.</p>' },
      { q: 'Levels, targets and the 30-year bands', kind: 'published',
        a: '<p>From USACE CWMS <b>location levels</b>: structural elevations (top of dam, flood, conservation, spillway crest), the injunction / interim-operations targets where published, and the 30-year daily statistics through 2023 (p05, p25, mean, p75, p95, min, max). Targets are <b>published targets, not a statement of current operations</b>.</p>' +
          '<p>The 30-yr p05–p95 band ranks about 30 values per calendar day separately, so its edges follow the one or two most extreme years and can look jagged. Past Years can show a smoother band derived here from the lake record (±7 days around each date).</p>',
        src: [['CWMS location levels (Lookout Point example)', CWMS + 'levels?office=NWDP&level-id-mask=LOP.*']] },
      { q: 'Total dissolved gas (Dexter, Cougar)', kind: 'reported',
        a: '<p>% saturation below the dam from USACE CWMS <code>DEXO / CGRO.%-Saturation-TDG.Inst.0.0.MIXED-REV</code>. The 110% line is the Oregon/EPA standard, drawn for reference only.</p>' }
    ] },
    { title: 'Rivers (USGS, NWS)', items: [
      { q: 'River flow, stage and water temperature', kind: 'reported',
        a: '<p>USGS real-time Instantaneous Values (discharge 00060, gage height 00065, water temperature 00010), usually every 15 minutes, provisional. Temperature is reported in °C and shown in °F (°C on hover). The 24 h change is derived here: newest − the reading 24 hours earlier.</p>',
        src: [['USGS Instantaneous Values service', USGS_IV]] },
      { q: 'Flood categories and river forecasts', kind: 'reported',
        a: '<p>From the NOAA National Water Prediction Service: the NWS flood stages (action, minor, moderate, major) for each forecast point, its current category, and the NWS / NW River Forecast Center forecast with its issue time. Gauges without NWS stages say so.</p>',
        src: [['NOAA National Water Prediction Service', 'https://water.noaa.gov/']] }
    ] },
    { title: 'Weather and snow', items: [
      { q: 'Rain above the dam — is it one gauge for the whole basin?', kind: 'model',
        a: '<p>No, and it is not a gauge. Each project has its own estimate from the <b>Open-Meteo weather model</b>, averaged over two points (near the dam and in the upper drainage). Past hours are the model’s analysis, not rain gauges or radar; amounts in the Cascades can be off by 20–50%, timing is usually good. Totals use the hours stamped in each window; an hour counts as wet at ≥ 0.01 in, and 6 dry hours end an event.</p>' +
          '<p>“Rain on the basin” = inches × drainage area × 53.33 ac-ft per inch per square mile. It is rain that fell, <b>not runoff</b>. Drainage areas and points are approximate.</p>',
        src: [['Open-Meteo forecast API', 'https://open-meteo.com/en/docs']] },
      { q: 'Wind', kind: 'model',
        a: '<p>From the same weather model at 10 m above ground, in mph: mean wind speed of the two points, the highest gust of the two, and the direction (vector average). The arrow points where the wind is blowing <i>to</i>. “Next 24 h” is the strongest forecast gust and when.</p>' +
          '<p>The breezy / advisory-level / warning-level tags use the NWS Portland criteria (advisory: sustained 31–39 mph or gusts 46–57; warning: sustained ≥ 40 or gusts ≥ 58) for reference only. They are not NWS alerts; check weather.gov for actual warnings. Model winds in steep terrain are rough estimates.</p>' },
      { q: 'The weather icon (sun, rain, snow…)', kind: 'model',
        a: '<p>The model’s standard WMO weather code for the latest hour, taking the more significant of the two points (if one says rain and the other snow, snow). Moon instead of sun at night. “Rain on and off since …” means the event is still on but the current hour is dry.</p>' },
      { q: 'Measured precipitation and snowpack (SNOTEL)', kind: 'reported',
        a: '<p>NRCS SNOTEL stations in the same basin: hourly accumulated precipitation (6 h and 24 h differences shown) and daily snow water equivalent and depth. They are high-elevation gauges, so they usually read wetter than the reservoir, and they catch snow as well as rain.</p>',
        src: [['NRCS AWDB REST API', 'https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html']] }
    ] },
    { title: 'Area status cards', items: [
      { q: 'Wildfire card', kind: 'reported',
        a: '<p>Current fire incidents from the National Interagency Fire Center’s WFIGS “Incident Locations – Current” service, for a box around the southern Willamette basin, kept when within 60 miles of a project. Shown: name, wildfire or prescribed burn, acres, % contained, cause, discovery time, and distance and direction from the nearest project. Red Flag Warnings and Fire Weather Watches come from NWS alerts. The card is red when a wildfire is within 25 miles or a Red Flag Warning is in effect, amber for other active wildfires or fire-weather alerts.</p>' +
          '<p>Incidents appear once an agency enters them, which can lag first reports by hours; Watch Duty often has earlier reports. The map is geographic (north up) with 25-mile rings around each project.</p>',
        src: [['WFIGS current incidents (query)', 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0'], ['Watch Duty', 'https://app.watchduty.org/']] },
      { q: 'NWS alerts card', kind: 'reported',
        a: '<p>Active National Weather Service alerts for Oregon from api.weather.gov, kept when the alert area names Lane, Linn or Douglas County or a Willamette / Cascade zone (wind, winter storm, flood, heat, etc.). Fire-weather alerts are shown on the wildfire card.</p>',
        src: [['NWS active alerts, Oregon', 'https://api.weather.gov/alerts/active?area=OR']] },
      { q: 'Power card (outages)', kind: 'reported',
        a: '<p>Live from the utilities’ own public outage maps, read by your browser every few minutes: <b>EWEB</b> (its ArcGIS outage layer: customers out, area, cause, status, crew remarks, estimated restore), and <b>Lane Electric, Emerald PUD and Blachly-Lane Electric</b> (their NISC outage maps, refreshed every minute: customers out per outage, start time, planned or not, notes such as “downed line”, and the areas — townships, territories or substations — with customers out). Locations are converted from each map’s coordinates.</p>' +
          '<p><b>BPA transmission</b>: BPA’s Daily Interruptions Report (lines, customer feeders and transformers; planned or automatic; cause; still out), filtered to BPA’s Eugene district and the Willamette powerhouses, copied into the site every 30 minutes by a GitHub Action because BPA’s site cannot be read from a browser. BPA updates the report daily.</p>' +
          '<p>Card levels are this site’s choice: amber when one outage affects ≥ 10 customers or ≥ 25 are out in total; red at ≥ 250 in one outage, ≥ 500 in total, or an unplanned BPA line trip still out. Not covered: Pacific Power, Springfield Utility Board and Consumers Power publish no readable outage data; the card links to their maps.</p>',
        src: [['EWEB outage layer', 'https://services7.arcgis.com/6AM8yPAeyXiPc9eF/arcgis/rest/services/PublicOutageMap_Public_View/FeatureServer/0'], ['Lane Electric outage data', 'https://outagemap-data.cloud.coop/laneelectric/Hosted_Outage_Map/summary.json'], ['Emerald PUD outage data', 'https://outagemap-data.cloud.coop/epud/Hosted_Outage_Map/summary.json'], ['BPA Daily Interruptions Report', 'https://transmission.bpa.gov/Business/Operations/Outages/default.aspx']] }
      { q: 'BPA-wide hydro', kind: 'reported',
        a: '<p>Total hydro generation in BPA’s balancing authority (the Columbia basin, federal and other), not Willamette-specific. Copied from BPA’s public file every 30 minutes by a GitHub Action, unchanged.</p>',
        src: [['BPA balancing-authority file', 'https://transmission.bpa.gov/business/operations/Wind/baltwg.txt']] }
    ] }
  ];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function badge(k) { var x = KIND[k]; return x ? '<span class="faq-kind faq-' + k + '" title="' + esc(x[1]) + '">' + esc(x[0]) + '</span>' : ''; }

  function render(el) {
    var body = el.querySelector('.view-body') || el;
    var legend = Object.keys(KIND).map(function (k) { return '<li>' + badge(k) + '<span>' + esc(KIND[k][1]) + '</span></li>'; }).join('');
    body.innerHTML =
      '<header class="faq-hero panel"><div><span class="panel-tag mono">DERIVATION &amp; SOURCES</span><h2>Where every number comes from</h2>' +
      '<p>Each value on this site is either published by an agency and shown as-is, computed by the agency, derived here with a stated formula, or weather-model output. Every answer below is tagged so you know which.</p></div>' +
      '<ul class="faq-legend">' + legend + '</ul></header>' +
      GROUPS.map(function (g, gi) {
        return '<section class="faq-group"><h3 class="faq-gh">' + esc(g.title) + '</h3><div class="faq-list">' + g.items.map(function (it, i) {
          var src = it.src ? '<p class="faq-src">Source: ' + it.src.map(function (s) { return '<a href="' + esc(s[1]) + '" target="_blank" rel="noopener">' + esc(s[0]) + ' ↗</a>'; }).join(' · ') + '</p>' : '';
          return '<details class="faq"' + (gi === 0 && i === 0 ? ' open' : '') + '><summary><span class="faq-q">' + esc(it.q) + '</span>' + badge(it.kind) + '<span class="faq-chev" aria-hidden="true"></span></summary>' +
            '<div class="faq-a">' + it.a + src + '</div></details>';
        }).join('') + '</div></section>';
      }).join('') +
      '<p class="hint faq-foot">Full list of documents and endpoints: <a href="#/docs">Docs ▸</a>. Not an official agency site; not affiliated with USGS, USACE, NOAA, NRCS or BPA.</p>';
  }

  H.views.sources = { title: 'Derivation & Sources', render: render, GROUPS: GROUPS, KIND: KIND };
})(typeof self !== 'undefined' ? self : this);
