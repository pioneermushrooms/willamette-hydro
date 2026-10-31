# Willamette Valley Hydro Dispatch

A static, dark control-room style dashboard for reservoirs and rivers in the South
Willamette Valley, Oregon, built on **live public data** from USGS and USACE.

> **Live data from USGS and USACE; provisional, not official.**
> This is not an official agency site, and it is not affiliated with USGS, USACE or BPA.
> Data is provisional and subject to revision by the publishing agencies. Do not use
> it for safety, navigation, recreation or operational decisions. Check the official sources.

## Data sources

| Field | Where shown | Source | Series / IDs | Type |
|---|---|---|---|---|
| River discharge (cfs) | river cards, details, trend | USGS NWIS Instantaneous Values | parameter `00060`; sites 14166000, 14162500, 14165500, 14152000, 14157500 | **live** |
| River discharge at Eugene | Eugene card | n/a | 14158050 publishes no `00060` series | **unavailable** (shown as "no data"; Eugene charts stage instead) |
| NWS flood categories (action / minor / moderate / major stage, ft) | gauge cards (ruler + badges), Stage chart bands | NOAA NWPS `api.water.noaa.gov/nwps/v1/gauges/<LID>` | EUGO3, HARO3, VIDO3, JASO3, GOSO3 (Coburg: none published) | **live** (read at runtime, never hardcoded) |
| Observed flood category | gauge cards | NOAA NWPS `status.observed.floodCategory` | same LIDs | **live** |
| River forecast (stage ft, flow) | dashed extension right of "now" on the trend chart, "Forecast peak (7 d)" | NOAA NWPS `/stageflow/forecast` (NWS/NWRFC-issued, ~6-hourly, ~7–10 days) | same LIDs; flow converted kcfs → cfs | **live (NWS forecast)**, issued time shown |
| Historic crests (top 3) | gauge details panel | NOAA NWPS `flood.crests.historic` | same LIDs | **published** |
| Gage height / stage (ft) | river cards, details, Eugene trend | USGS NWIS IV | parameter `00065`, all 6 sites | **live** |
| Water temperature | river cards | USGS NWIS IV | parameter `00010` (°C), all 6 sites | **live** (converted to °F for display, °C shown too) |
| 24 h change | river cards | this site | difference over the last 24 h of the series | **derived** |
| Pool elevation (ft) | reservoir cards, gauge needle, trend | USACE CWMS Data API, office NWDP | `<P>.Elev-Forebay.Inst.0.0.MIXED-REV`, all 8 projects | **live** |
| Rule curve (ft) | gauge marker, "vs rule curve", dashed trend line | USACE CWMS | `<P>.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC` (daily values incl. the coming days) | **live** |
| vs rule curve (ft) | reservoir cards | this site | pool elevation − today's rule-curve value | **derived** |
| Storage (ac-ft) | details | USACE CWMS | `<P>.Stor.Inst.0.0.MIXED-COMPUTED-REV` (not DEX) | **live**; Dexter **unavailable** |
| % full | gauge, cards | this site | (storage − bottom-of-conservation storage) ÷ (top − bottom) × 100, the USACE "teacup" definition | **derived**; Dexter n/a (no conservation pool) |
| Outflow (cfs) | reservoir cards | USACE CWMS | LOP, GPR: `<P>.Flow-Out.Ave.1Hour.1Hour.CBT-REV` (hourly avg); others: `<P>.Flow-Out.Inst.0.0.MIXED-COMPUTED-REV` | **live** |
| Computed inflow (cfs) | reservoir cards | USACE CWMS | LOP, GPR: `<P>.Flow-In.Ave.15Minutes.6Hours.CBT-COMPUTED-REV`; others: `...MIXED-COMPUTED-REV` | **live (computed by USACE)**; can be negative and is shown as reported |
| Conservation-pool limits | gauge scale, % full | CWMS location levels `<P>.Elev.Inst.0.Top/Bottom of Conservation`, `<P>.Stor.Inst.0.Top/Bottom of Conservation` (Dexter: Bottom/Top of Power, 690–695 ft) | hardcoded constants in `js/data.js`, effective 2026-10-30 | static reference |
| Total reservoir release | totals bar | this site | sum of latest fresh (≤ 3 h) outflows, "N of 8 reporting" | **derived** |
| Basin conservation storage % | totals bar | this site | Σ max(0, stor − bottom) ÷ Σ (top − bottom) over the 7 projects with storage | **derived** |
| BPA-wide hydro (MW) | totals bar | BPA balancing-authority file `baltwg.txt` | "Hydro" column, 5-minute MW | **live, copied every 30 min** by GitHub Actions. All hydro in BPA's balancing authority, **not** Willamette-specific |
| Per-dam generation MW, units online | removed | n/a | USACE power series are not public | **unavailable** |
| Status lights | map, cards | this site | see below | **derived** (not an agency determination) |

Project codes: LOP Lookout Point, HCR Hills Creek, DEX Dexter, GPR Green Peter, CGR Cougar,
COT Cottage Grove, DOR Dorena, FRN Fern Ridge. LOP, HCR, DEX, GPR and CGR are labelled
"hydropower" as static project information. FRN, COT and DOR are flood-control projects.

Endpoints:

- USGS: `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=14158050,14166000,14162500,14165500,14152000,14157500&parameterCd=00060,00065,00010&period=P7D` (one request for all six stations). Station pages: `https://waterdata.usgs.gov/monitoring-location/<SITE>/`.
- USACE CWMS: `https://cwms-data.usace.army.mil/cwms-data/timeseries?office=NWDP&name=<series>&unit=<ft|cfs|ac-ft>&begin=<ISO>&end=<ISO>&page-size=5000`. It **requires** the header `Accept: application/json;version=2` (otherwise HTTP 406). There is one request per series, and pagination (`next-page`) is followed. `page-size=1000` is too small because 5-minute series truncate at about 3.5 days. Each card links to the raw elevation series (without dates it returns the last 24 h; browsers get XML) and to <https://water.sec.usace.army.mil/>.
- BPA: `https://transmission.bpa.gov/business/operations/Wind/baltwg.txt` (no CORS, so it can't be read from the browser).

### How the rule curve is obtained

The rule curve is USACE's water-control-diagram ("teacup") guide elevation, published in CWMS
as the daily series `<P>.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC`, with values stamped at Pacific
midnight. The page requests it from 8 days back to 8 days ahead.

- **Today's value** is the latest point at or before now. It drives the gauge marker and the "vs rule curve" readout.
- **The dashed line** on the trend chart joins the daily values linearly.

### Status lights (derived by this site)

The thresholds are this site's own choices, not an agency determination.

| Light | River gauge | Reservoir |
|---|---|---|
| green | latest reading ≤ 3 h old | elevation fresh and within −10 ft / +2 ft of today's rule curve (or rule curve unavailable: "REPORTING") |
| amber | latest reading > 3 h old (STALE) | STALE (> 3 h), **or** BELOW RULE CURVE (> 10 ft below), **or** ABOVE RULE CURVE (> 2 ft above) |
| red | no data, or > 12 h old | no elevation data, or > 12 h old |
| grey | loading | loading |

Every card shows its own last-reading time in Pacific time with an age, for example "Oct 30, 4:45 PM PDT · 23 min ago".
Readings older than 3 hours get a STALE tag.

## Pages (hash routes)

`#/overview` is the live dashboard (default). `#/teacup` is the basin teacup and lake ruler. `#/tables` has the published rating tables and `#/docs` the documents and data sources.
Plain anchors (`#trends`, `#rivers`, …) stay on Overview and scroll.

## Teacup view (`#/teacup`)

- **Basin teacup:** 8 cups in 2 columns on mobile and 4 on desktop.
  - Cup height is the conservation pool, from bottom to top elevation in CWMS levels. The water line is the **live** pool elevation and the dashed line is the **live** CWMS rule curve. The number is % full, **derived** from live storage: (storage − bottom of conservation) ÷ (top − bottom).
  - Below the conservation pool, cups say so rather than showing 0 %.
  - Colours: below rule curve (> 10 ft under), near, above (> 2 ft over). These are this site's thresholds, the same as Overview.
  - Dexter is a forebay gauge in its 690–695 ft power-pool band, with no conservation pool and no percent.
  - Live pool data is shared from the Overview loader (`HYDRO.live`) and is not refetched.
  - Why the cups use elevation geometry: a storage rule curve (`<P>.Stor-RuleCurve.Inst.~1Day.0.CENWP-CALC`) is listed in the CWMS catalog but returns no public data. So the rule curve exists only in feet, and the cup is drawn in feet so the water line and rule marker share one scale.
- **Elevation ruler:** one lake at a time, chosen with a chip row (default Lookout Point). It shows these published CWMS levels (m → ft): streambed, bottom/top of conservation, top of flood, top of max flood, spillway crest and top of dam (Dexter: power-pool band).
  - It also shows the live pool with its timestamp, today's rule curve (CWMS daily), and today's 30-year stats band (p25–p75, p05–p95, mean, min/max), **derived** from the published `…CENWP-30year-thru2023-STATS` levels.
  - Scale: the scale is linear above a marked ≈ break, and the span down to the streambed is compressed.
- **Annual chart:** shows the 30-yr bands and mean (365 daily evaluations), the full-year rule curve, the published target line (with gaps), a today line, and the **last 7 days** of pool.
  - The full-year rule curve comes from the CWMS daily `Elev-RuleCurve` series, which is published through Dec 31.
  - Longer pool history is not shown. The daily and hourly elevation series are empty or restricted publicly, and 90 days of 5–15-min data is too heavy.
- **Targets:** each is shown as **"Published target — not a statement of current operations."**, with links to Docs and the USACE injunction page. Each shows the value today and the next 3 changes.
  - **LOP, GPR, CGR:** `Elev-Forebay.Inst.0.Injunction-Target` (seasonal, latest version ≤ today).
  - **HCR:** the seasonal elevation `Elev.Inst.0.Interim Risk Reduction Measure` (2026-01-01 version: 1,511 ft mid-Mar → Oct 11). HCR's `Stor.Inst.0.Interim_Operations` and `Stor.Inst.0.Injunction-Target` are storage-only and listed in ac-ft. They are not converted to elevation.
- **Loading:** levels load lazily on first visit, with the selected lake first and the rest 3 at a time. They are cached for 24 h. Failures show "Levels unavailable" with a Retry button.

Level availability (live, 2026-10-30):

| Project | Ruler levels (of 7) | 30-yr stats | Elevation target used |
|---|---|---|---|
| LOP | 7 | 7/7 | Injunction-Target (828.0 ft today) |
| HCR | 7 | 7/7 | Interim Risk Reduction Measure (none today; storage targets listed) |
| DEX | 3: no conservation/flood levels; power band 690–695 shown | 7/7 | none |
| GPR | 7 | 7/7 | Injunction-Target (924.7 ft today) |
| CGR | 7 | 7/7 | Injunction-Target (1,510.6 ft today) |
| FRN, COT, DOR | 7 | 7/7 | none published |

## Reports & Tables (`#/tables`)

These are **published** rating tables, not live data.
- Pick a rating type, then a project, gauge or structure. Each rating is fetched only when selected, with 3 tries, and cached for 7 days in memory and localStorage as compact arrays.
- Each rating shows:
  - its provenance: source, effective and create dates, the number of published versions, a link to the API, and "use for reference only";
  - a lookup with reverse lookup where the curve is monotonic, flagging out-of-range input, plus a **Use current** button with the LIVE pool or gage height;
  - a curve chart with hover readout and published-level markers when those levels are already cached;
  - a paged table (50 rows) with "jump to lookup", and a CSV download.

| Type | CWMS / USGS id | Available | Unavailable |
|---|---|---|---|
| Elevation–storage | `<P>.Elev-Forebay;Stor.Standard.CENWP` | all 8 | — |
| Elevation–area | `<P>.Elev-Forebay;Area.Standard.CENWP` | 7 | DEX (CWMS returns HTTP 500) |
| Spillway, free flow | `<P>-Spillway.Elev-Forebay;Flow-Free.Standard.CENWP` | all 8 | — |
| Spillway gates (2-D) | `<P>-Spillway.Opening,Elev-Forebay;Flow.Standard.CENWP` | LOP, HCR, DEX, GPR, CGR, FRN | COT, DOR (HTTP 500) |
| Regulating outlets (2-D) | `<P>-RegulatingOutlets.Opening,Elev-Forebay;Flow…`, CGR `-RegOutlets`, `-1Gate`, `-2Gates`, FRN `-SluiceGate` | LOP, HCR, GPR, FRN, COT, DOR, CGR (variants), FRN sluice | DEX, CGR base id (HTTP 500) |
| USGS stage–discharge | `get_ratings?site_no=<site>&file_type=exsa` (nwis host) | all 6 | — |

Notes:
- **2-D gate ratings** parse cleanly as opening × elevation grids, so they are implemented. You choose a gate opening and an elevation; openings between published curves are interpolated. CGR's gated-spillway rating publishes its axes swapped (elevations in the opening slot). It is detected, transposed, and flagged on the page.
- **USGS exsa:** look-ups use the gage height (INDEP) directly. DEP is the discharge USGS computes for that gage height with the shift already applied. This was verified against live NWIS discharge at five gauges: at Harrisburg, 1.86 ft gives 4,194 cfs from the table versus 4,190 cfs live. Adding SHIFT to INDEP would be wrong (3,673 cfs). SHIFT is shown for information only.
- **Jasper's file** is a base rating without shifts, as USGS states in the file.
- **Eugene** has a rating file (rating 3.0, shifts 2023) even though no live discharge is published there. It is shown with that caveat.

## Docs (`#/docs`)

Verified public documents:
- the WVS EIS page, the June 23, 2026 SEIS ROD and Final SEIS Appendix N;
- the injunction page, the 2024 NMFS BiOp landing page and the injunction RM&E index;
- the 7 water control manuals (2017 redacted public versions; LOP and DEX share one);
- an interim-operations summary in our own words;
- a data-sources table and a disclaimer.

Run `node scripts/check-links.js` (or `node check.js --links`) to re-check every link. It sends a browser User-Agent and a Range request, and 200/206 pass. Pages on nwp.usace.army.mil may answer 403 to bots, which is accepted. water.usace.army.mil ignores Range, sends the whole PDF and is sometimes slow, so each link gets 3 tries.

## NOAA NWPS (flood stages + forecasts)

`js/nwps.js` maps each USGS gauge to its NWS location id and loads, per gauge, the metadata
(thresholds, observed category, historic crests) and the stage/flow forecast. It uses 3 tries and a 10-min memory cache.
- Sentinels: undefined thresholds are `-9999`, missing values `-999`. Anything `<= -900` is treated as none. A forecast with `issuedTime` `0001-01-01` and no data means "no forecast".
- McKenzie near Coburg (14165500, NWS MRGO3) has no published flood stages, so its card says so.
- The Willamette at Eugene forecast has stage only (flow is `-999`). Its chart is stage-only.
- River charts have a **Flow / Stage** toggle. Stage mode draws the NWS flood-category bands (the lowest band is always in view) and the NWS stage forecast. Flow mode draws the flow forecast where NWS provides one. Each gauge card also shows a flood ruler: bands, current stage ▼, and the 7-day forecast peak (dashed).
- If NWPS fails, cards show "NWS data unavailable" and the rest of the dashboard is unaffected. A gauge that loaded earlier keeps its last good copy, marked CACHED.
- Gauge links: `https://water.noaa.gov/gauges/<LID>`.

## CWMS location levels (`js/cwms-levels.js`)

This is a shared helper for the upcoming Teacup and target overlays.
- `fetchProjectLevels(code)` calls `/levels?office=NWDP&level-id-mask=<CODE>.*` with 3 tries. It keeps only ids starting with `<CODE>.`, converts m → ft, cms → cfs and m³ → ac-ft, and caches the compact result (about 150 KB, not the ~550 KB raw response) in memory and in localStorage for 24 h.
- `pick()` returns the latest version with level-date ≤ the date. `constantAt()` and `valueAt()` evaluate a level.
- `evalSeasonal()` evaluates a seasonal level:
  - Knots sit at interval-origin + n × interval-months + offset-months + offset-minutes.
  - Values between knots are interpolated linearly, or held when `interpolate-string` is `F`.
  - Knots without a value are gaps, so any span touching one is null (target not applicable).
  - The pattern wraps across years.
- The single-level `?effective-date=` endpoint returns HTTP 500 for seasonal levels, so it is not used.
- Example: `node check.js --live` evaluates the real LOP `Elev-Forebay.Inst.0.Injunction-Target`. On 2026-10-30 that is 828.0 ft, a **published target, not a statement of current operations**.

## Polling and refresh

- **USGS and USACE** are fetched directly by the browser, since both send `Access-Control-Allow-Origin: *`. The page fetches on load and then every 15 minutes, and the **Refresh** button fetches immediately.
- **Failure handling:**
  - Each request is retried once on network errors and HTTP 5xx.
  - CWMS requests run at most 8 at a time.
  - When a single series fails on a later poll, the previous good copy is kept. Its timestamp keeps ageing, so it turns STALE honestly.
- **Header indicator:** shows LIVE, PARTIAL or OFFLINE, the last fetch time, and a countdown to the next poll. Badges show the status of each source.
- **BPA:** `.github/workflows/update-bpa.yml` runs `scripts/fetch-bpa.js` at minutes 7 and 37 of every hour (and on manual dispatch).
  - It writes `data/bpa.json` and commits only if the data changed.
  - The page reads `data/bpa.json?t=<now>`. If the file is missing, or its latest reading is more than 3 h old, the tile says so.
  - Scheduled Actions can be delayed by GitHub.
  - If your Pages site doesn't redeploy after bot commits, switch Pages to "GitHub Actions" as the source, or add a deploy step to the workflow.

## Caveats

- USGS values flagged `P` are **provisional** and may be revised. The tooltips and data table show the qualifier.
- CWMS "computed inflow" is back-calculated by USACE from storage change. It is noisy, can be **negative**, and lags about 1 h. It is shown exactly as reported.
- **Power data is not public:** CWMS power series are restricted and USACE NWD dataquery is unreachable. So there are no per-dam MW or unit counts. The BPA figure covers the whole balancing authority.
- The **Willamette at Eugene** gauge (14158050) has no discharge series. Flow is shown as "no data" and stage is charted instead.
- Dexter is a run-of-river re-regulating dam with no conservation pool or published storage. Its gauge shows elevation within the 690–695 ft power-pool band, and % full is n/a.
- Several projects (Lookout Point, Hills Creek, Green Peter, Cougar) are currently drawn down **below the bottom of their conservation pool**. They show "Below cons. pool" rather than a misleading 0 %.
- The basin map is a schematic, not to scale.

## Structure

```
index.html                      single-page dashboard
css/style.css                   theme, layout, animations (honours prefers-reduced-motion)
js/data.js                      static config (stations, projects, series, limits, links) + live loader + derived helpers
js/app.js                       Overview rendering: clock, feed status, totals, SVG map, gauges, cards, trend chart, polling
js/cwms-levels.js               CWMS location levels: fetch + 24 h cache + seasonal evaluator + unit conversion
js/nwps.js                      NOAA NWPS flood categories + NWS forecasts
js/router.js                    hash router (#/overview, #/teacup, #/tables, #/docs)
js/teacup-core.js               pure Teacup helpers (percent full, rule delta, next target changes, ruler scale)
js/views/*.js                   non-overview views (teacup, tables, docs)
js/ratings.js                   published ratings: CWMS + USGS exsa parsers, interpolation, CSV, 7-day cache
scripts/check-links.js          re-runnable check of every Docs link
scripts/fetch-bpa.js            BPA download + parser (DST-aware), writes data/bpa.json
data/bpa.json                   latest BPA balancing-authority hydro/load, last 48 h at 5-min
.github/workflows/update-bpa.yml  scheduled BPA refresh
check.js                        config/helper checks; --live tests the real APIs
.nojekyll                       serve files as-is on GitHub Pages
```

There's no build step and no third-party libraries. Everything is plain static files.

## Run locally

Use a static server, not `file://`, because the page fetches `data/bpa.json`:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Checks

```sh
for f in js/*.js check.js scripts/*.js; do node --check "$f"; done
node check.js          # config shape, helpers, DST parsing, seasonal-level evaluator, NWPS parsing, page wiring (offline)
node check.js --live   # + real USGS / CWMS / NWPS / CWMS levels / BPA requests, prints live/missing tables (Node 20+)
node scripts/fetch-bpa.js --stdout   # preview the BPA JSON without writing
```

## Deploy to GitHub Pages

1. Push this directory to a GitHub repository, with the files at the repo root.
2. In **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save.
3. In **Settings → Actions → General**, make sure workflows have **Read and write permissions**, so the BPA job can commit.
4. Run **Actions → Update BPA hydro data → Run workflow** once to confirm it works.

All paths are relative, so the site works from a project subpath.

## License

MIT. See [LICENSE](LICENSE). The data belongs to its publishers (USGS, USACE, BPA). This
project only displays it, and it is not affiliated with or endorsed by any of them.
