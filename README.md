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
| River discharge (cfs) | river cards, details, trend | USGS NWIS Instantaneous Values | parameter `00060`; sites 14166000, 14162500, 14163150 (McKenzie below Leaburg Dam), 14165500, 14152000, 14157500 | **live** |
| River discharge at Eugene | Eugene card | n/a | 14158050 publishes no `00060` series | **unavailable** (shown as "no data"; Eugene charts stage instead) |
| NWS flood categories (action / minor / moderate / major stage, ft) | gauge cards (ruler + badges), Stage chart bands | NOAA NWPS `api.water.noaa.gov/nwps/v1/gauges/<LID>` | EUGO3, HARO3, VIDO3, JASO3, GOSO3 (Coburg: none published) | **live** (read at runtime, never hardcoded) |
| Observed flood category | gauge cards | NOAA NWPS `status.observed.floodCategory` | same LIDs | **live** |
| River forecast (stage ft, flow) | dashed extension right of "now" on the trend chart, "Forecast peak (7 d)" | NOAA NWPS `/stageflow/forecast` (NWS/NWRFC-issued, ~6-hourly, ~7–10 days) | same LIDs; flow converted kcfs → cfs | **live (NWS forecast)**, issued time shown |
| Historic crests (top 3) | gauge details panel | NOAA NWPS `flood.crests.historic` | same LIDs | **published** |
| Gage height / stage (ft) | river cards, details, Eugene trend | USGS NWIS IV | parameter `00065`, all 6 sites | **live** |
| Water temperature | river cards | USGS NWIS IV | parameter `00010` (°C), all 6 sites | **live** (converted to °F for display, °C shown too) |
| 24 h change | river cards | this site | difference over the last 24 h of the series | **derived** |
| Pool elevation (ft) | reservoir cards, gauge needle, trend | USACE CWMS Data API, office NWDP | `<P>.Elev-Forebay.Inst.0.0.MIXED-REV`, all 10 projects | **live** |
| Rule curve (ft) | gauge marker, "vs rule curve", dashed trend line | USACE CWMS | `<P>.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC` (daily values incl. the coming days) | **live** |
| vs rule curve (ft) | reservoir cards | this site | pool elevation − today's rule-curve value | **derived** |
| Storage (ac-ft) | details | USACE CWMS | `<P>.Stor.Inst.0.0.MIXED-COMPUTED-REV` (not DEX) | **live**; Dexter **unavailable** |
| % full | gauge, cards | this site | (storage − bottom-of-conservation storage) ÷ (top − bottom) × 100, the USACE "teacup" definition | **derived**; Dexter n/a (no conservation pool) |
| Outflow (cfs) | reservoir cards | USACE CWMS | LOP, GPR: `<P>.Flow-Out.Ave.1Hour.1Hour.CBT-REV` (hourly avg); others: `<P>.Flow-Out.Inst.0.0.MIXED-COMPUTED-REV` | **live** |
| Computed inflow (cfs) | reservoir cards | USACE CWMS | LOP, GPR: `<P>.Flow-In.Ave.15Minutes.6Hours.CBT-COMPUTED-REV`; others: `...MIXED-COMPUTED-REV` | **live (computed by USACE)**; can be negative and is shown as reported |
| Conservation-pool limits | gauge scale, % full | CWMS location levels `<P>.Elev.Inst.0.Top/Bottom of Conservation`, `<P>.Stor.Inst.0.Top/Bottom of Conservation` (Dexter: Bottom/Top of Power, 690–695 ft) | hardcoded constants in `js/data.js`, effective 2026-10-30 | static reference |
| Total reservoir release | totals bar | this site | sum of latest fresh (≤ 3 h) outflows, "N of 10 reporting" | **derived** |
| Basin conservation storage % | totals bar | this site | Σ max(0, stor − bottom) ÷ Σ (top − bottom) over the 7 projects with storage | **derived** |
| BPA-wide hydro (MW) | totals bar | BPA balancing-authority file `baltwg.txt` | "Hydro" column, 5-minute MW | **live, copied every 30 min** by GitHub Actions. All hydro in BPA's balancing authority, **not** Willamette-specific |
| Hourly Snapshot: forebay elevation (HCR, LOP, DEX, CGR), Dexter tailwater (ft) | Snapshot strip, top of every page | USACE CWMS | `<P>.Elev-Forebay.Inst.0.0.MIXED-REV`, `DEX.Elev-Tailwater.Inst.0.0.MIXED-REV` (15-min) | **live**, refreshed every 5 min |
| Hourly Snapshot: Hills Creek and Cougar tailwater (ft) | Snapshot strip | USGS NWIS IV | 14145110 (Hills Creek Dam tailwater), 14159410 (Cougar Dam tailwater); 00065 gage height. Gage datum is 0 ft NGVD29, so gage height **is** the elevation (same datum as the CWMS forebays) | **live**, refreshed every 5 min |
| Hourly Snapshot: HCRO, DEXO, CGRO (cfs + stage ft) | Snapshot strip | USGS NWIS IV | 14145500 (MF Willamette abv Salt Crk = HCRO), 14150000 (MF Willamette nr Dexter = DEXO), 14159500 (SF McKenzie nr Rainbow = CGRO); 00060, 00065 | **live**, refreshed every 5 min |
| Forebay cross-check, long-range pool history | Snapshot (USGS line), 6 MO / 1 YR charts | USGS lake gages, parameter 62614 | HCR 14145100, LOP 14149000, DEX 14149500, GPR 14186100, CGR 14159400, FRN 14168000, COT 14153000, DOR 14155000 (IV and daily values) | **live** / USGS daily (provisional) |
| TDG, % saturation (Dexter, Cougar tailwater) | DEX/CGR reservoir cards and details, Teacup detail | USACE CWMS time series | `DEXO.%-Saturation-TDG.Inst.0.0.MIXED-REV`, `CGRO.%-Saturation-TDG.Inst.0.0.MIXED-REV` (`%` URL-encoded as `%25`) | **live** (CWMS reported, provisional); 110 % line is a reference only |
| ODEQ 2006 TMDL temperature target | Jasper water-temperature chart (dashed) and Jasper details | USACE CWMS location level | `DEX.Temp-Water.Inst.0.ODEQ-2006TMDL-Target` (°C → °F; monthly steps) | **published target**; defined at the dam tailwater, shown at the nearest gauge for context |
| Snowpack: SWE, snow depth (in) | Overview → Snowpack (SNOTEL) | NRCS AWDB REST `/services/v1/data` | 8 SNOTEL stations: 388, 729, 710, 529, 719, 619, 1166, 733 (`:OR:SNTL`) | **live** (daily) |
| Published rating tables | Tables page | CWMS ratings, USGS exsa | see Reports & Tables | **published** |
| Structural levels, 30-yr stats, injunction / interim targets | Teacup page | CWMS location levels | see Teacup view | **published / derived** |
| Per-dam generation MW, units online | removed | n/a | USACE power series are not public | **unavailable** |
| Status lights | map, cards | this site | see below | **derived** (not an agency determination) |

Project codes: LOP Lookout Point, HCR Hills Creek, DEX Dexter, GPR Green Peter, CGR Cougar,
COT Cottage Grove, DOR Dorena, FRN Fern Ridge, FAL Fall Creek, BLU Blue River. LOP, HCR, DEX, GPR and CGR are labelled
"hydropower" as static project information. FRN, COT, DOR, FAL and BLU are flood-control projects.

**Fall Creek and Blue River** use the same CWMS series patterns as the other projects. Their conservation-pool limits are not hardcoded: they are read at runtime from the CWMS location levels `<P>.Elev.Inst.0.Top/Bottom of Conservation` and `<P>.Stor.Inst.0.Top/Bottom of Conservation`. Until those load (or if CWMS has none), the gauge scales to the recent pool and rule-curve values and % full shows no data. They are not yet on the Tables page.

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

### Overview layout (one workspace)

Overview is: feed status → four totals tiles → **workspace** → Snowpack.

- **Left column:** the **Basin map** on top (always open), then Reservoirs and River gauges as aligned list rows. Reservoirs: mini teacup, name, pool ft · vs rule · in cfs · out cfs. Gauges: status light, name (NWS flood category badge when there is one), 24 h sparkline, current flow or stage, 24 h change.
- **Right column (the selected point):** a header with name, status and one row of key numbers (reservoirs: pool, vs rule, % full, outflow, inflow, basin rain 24 h, plus a raining/dry line; gauges: flow, stage, temperature, 24 h change, NWS flood), then the Trend Recorder (ranges, zoom, layers, chart, strips, stats, sources, data table), then **More about …** (collapsed, remembered) with only what is not shown above: levels and targets; storage and the conservation pool; freezing level and the SNOTEL gauges' measured precipitation; TDG (Dexter, Cougar); NWS flood stages and forecast for gauges. The chart key sits directly under the pool chart; the stats row and the source line under the chart were removed (the source is the chart title's tooltip and on the Sources page).
- Selecting a row or a map dot drives all of it. There is no separate details panel, card grid or point dropdown any more. On phones the selected point comes first and the list follows; tapping a row scrolls back up to it.
- Notes under the header numbers and "derived"/"model" hints appear on hover or focus.

### Scroll position

The page never moves the view on its own during a refresh. Across a reload (yours, or the quiet one after a deploy while the tab is hidden) it remembers the section at the top of the screen and returns to it once data is drawn, holding it there while content above settles (browser scroll restoration is turned off because it landed on the cards).

### Reservoir inflow forecasts (NWRFC)

`scripts/fetch-inflow-fcst.js` copies the NW River Forecast Center's reservoir inflow forecast (text summary page `textPlot.cgi?id=<LID>&pe=QI`: observed inflow plus the ~6-hourly forecast for ~10 days, with its issue time, PST) into `data/inflow-fcst.json` every 30 minutes from `update-bpa.yml` (nwrfc.noaa.gov sends no CORS). The CWMS forecast series (`<P>.Flow-In.Inst.~6Hours.0.RFC-FCST`) are catalogued but publicly empty (checked 2026-11-28).

### Top bar, project tabs, notifications

- The page tabs, the clock / data-status readout and the live-feed bell sit in one sticky top bar (`#topbar`) that stays at the top while scrolling.
- The project panel has folder tabs (`#ws-tabs`) for the ten reservoirs (a selected river gauge gets its own tab); the active tab is bright and joins the panel. Arrow keys move between tabs.
- Toasts stack at the bottom-left (newest at the bottom, at most 5) and fade away on their own (12 s, alerts 25 s; hover pauses). Clicking one opens its project without clearing anything. Opening the bell acknowledges everything: toasts and desktop notifications close and all events are marked read.
- Desktop notifications (opt-in in the bell panel) show whenever the page is open, with a test notification when turned on; at most 5 per batch and 5 open at once. Some browsers (e.g. Android Chrome without an installed app) do not allow page notifications; the panel says so.

### Trend Recorder readouts

Hovering shows one time label, on the main chart's axis, and a value box beside the cursor on every chart (main chart and strips, same style; values only). Under each strip a summary line gives the current numbers instead of the source (the source is on the strip title's tooltip and the Sources page): latest outflow and inflow with their times; rain in the last 4 h and 24 h and the next 24 h. The below-dam gage is not drawn on the inflow/outflow strip because USACE's outflow is that gage reading (the lines coincide); it is in the project header.

### Gage below the dam

Each project with a USGS gage directly below it (`BELOW_GAGE` in `js/data.js`: HCRO 14145500, DEXO 14150000, FALO 14151000, COTO 14153500, DORO 14155500, CGRO 14159500, BLUO 14162200, Fern Ridge: Long Tom nr Alvadore 14169000; names verified against USGS 2026-11-28; over 24 h every one matched the USACE outflow reading for reading, median difference ≤ 0.2 %, with USACE posting ~15 min later) shows that gage's discharge as a header cell ("COTO gage 148 cfs"), and the inflow/outflow strip draws it as a dashed green line. It is fetched in the same USGS request as the river gauges. Reason: USACE's computed outflow follows the gage but is posted 15–35 min after each reading (vs 5–15 for USGS), so a release change shows on the gage first. Not listed: LOP (flows into Dexter; its USACE outflow is an hourly average about 40 min old), GPR (nearest gage is below Foster and does not match).

### Source links on every value

Each displayed value has a small **↗** next to its label (cards, detail panel, Hourly Snapshot, Teacup, Calculator live line). It opens the exact series the value came from:

- USACE values: the raw CWMS Data API series, e.g. `https://cwms-data.usace.army.mil/cwms-data/timeseries?office=NWDP&name=BLU.Flow-In.Ave.15Minutes.6Hours.MIXED-COMPUTED-REV&unit=cfs` (last 24 h; browsers get XML).
- USGS values: the site's monitoring-location page opened on that parameter (00060 flow, 00065 gage height, 00010 temperature).

The series names in the source notes under the Trend Recorder, its strips and the past-years table are links too (`H.srcLink`, `H.linkSources` in `js/data.js`).

### Basin precipitation (`js/weather.js`)

Each reservoir card has a **BASIN RAIN** line (past 24 h, next 24 h, raining since / dry since / next rain), and the reservoir detail panel has a full block:

- past and next 6 / 24 / 72 h totals, the current event (start, total, forecast end), freezing level and basin-mean temperature;
- rain volume on the basin: inches × drainage area × 53.33 ac-ft, also as a 24-h mean cfs. This is rain that fell, **not runoff**;
- an hourly bar chart, past 72 h (solid) and 72-h forecast (faded), with a NOW line;
- measured precipitation from the NRCS SNOTEL gauges in the same basin (hourly accumulated PREC, 6 h and 24 h). None for Green Peter or Fern Ridge.

The current-conditions line has an icon and label from the model's WMO weather code for the latest hour (the most significant of the project's two points): sunny / clear (moon at night), partly cloudy, cloudy, fog, drizzle, rain, freezing rain, snow, thunderstorms. While an event is on: "Raining / Snowing / Drizzle … since <time>" when it is wet now, "Rain on and off since <time>" during a break; otherwise "Dry since <time>". The forecast end or next rain follows.

Each project has its own estimate (its own two points), so neighbouring basins can differ; it is not one shared gauge. **Wind** (same model, 10 m, mph): a second line under the rain line — direction (arrow points where the wind blows to), mean speed of the two points, the highest gust, and the strongest gust in the next 24 h with its time; "More" adds the past-24 h and 3-day peaks. Tags use NWS Portland criteria for reference only: breezy (gusts ≥ 30), advisory-level (sustained 31–39 or gusts 46–57), warning-level (sustained ≥ 40 or gusts ≥ 58). Not an NWS alert.

Model data: Open-Meteo forecast API, hourly precipitation averaged over two hand-placed points per project (near the dam, upper basin). Past hours are the model's analysis, not rain gauges or radar. An hour counts as wet at ≥ 0.01 in; 6 dry hours in a row end an event. Drainage areas and points are approximate.

The Trend Recorder has a **Basin precipitation** strip for reservoirs: hourly model data up to 92 days back, Open-Meteo archive (ERA5) daily sums beyond that.

**Forecast zone (reservoirs, 24 H / 7 D: +72 h; 30 D: +7 days).** The time axis of the chart and every strip continues past "now" into a hatched zone labelled FORECAST; the pool line stops at now (no pool forecast is published). The precipitation strip shows past hours as solid bars and the model's forecast hours faded; the inflow / outflow strip adds the **NWRFC inflow forecast** as a dashed line ("Inflow forecast (NWRFC, issued …)", `data/inflow-fcst.json`, copied every 30 min by GitHub Actions, read by `js/inflowfc.js`); projects without one show "No NWRFC inflow forecast for …". Zoom, pan and the synced cursor work across the whole range; readouts in the zone show only forecast values, marked FORECAST.

**Rain selection → volume → pool rise (`js/runoff.js`).** Drag across the precipitation strip (mouse or a horizontal touch drag; Esc or Clear removes it; it survives refreshes). A floating box gives the basin-mean rain in the span (and how much is forecast), rain volume on the basin (in × area × 53.33 ac-ft), estimated runoff into the pool (× an empirical runoff ratio) and the pool rise at the current pool from the USACE elevation–storage rating, as if outflow stays equal to the pre-event inflow (none for Dexter: no storage rating). The runoff ratio is derived per project from the last 45 days: rain events (days ≥ 0.1 in) vs USACE computed inflow above baseflow (lowest daily inflow in the 3 days before) over the event + 2 days, clamped to 0.05–0.9; under 1 in of event rain the default 0.4 is used and labelled as such. A rough estimate: model rain, simple baseflow split, soil and snow state ignored.

The strips below the chart share its time axis (same tick labels). Hovering or touching the chart or any strip moves one synced cursor through all of them, with a boxed time label on each x-axis (e.g. "Fri 27 03:00") and the time at the start of each strip's readout ("Fri 03:00 · Outflow 900 cfs · Computed inflow 640 cfs"); the readout floats over the plot, so the strip never changes height.

## Hourly Snapshot (removed from the page)

Removed from the top of the page at the user's request; `js/snapshot.js` and its tests are kept but the page no longer loads it. The notes below describe it as it was.

A compact strip above the page tabs with the values recorded hourly:
**Hills Creek** Elev · TW · HCRO, **Lookout Point** Elev, **Dexter** FB · TW · DEXO, **Cougar** FB · TW · CGRO. Code: `js/snapshot.js`.

- Each item shows **one value**: the reading stamped exactly at the most recent top of the hour (amber **hh:00**) once it is
  published; until then the newest reading, marked **latest hh:mm**. HCRO/DEXO/CGRO show gage stage (ft) small on the time line.
- Edge colour: green ≤ 45 min old, amber **LAG** ≤ 90 min, red **STALE** beyond (age of the newest reading).
- Forebays are cross-checked against the USGS lake gage (62614, same datum). An amber dot appears when CWMS and USGS differ by
  ≥ 0.1 ft (CWMS `MIXED-REV` sometimes switches sensors); hover/tap shows the difference.
- **Copy** puts a group's values (the :00 values, or latest labelled `[latest hh:mm]`) on the clipboard; **Copy all** copies all four lines.
- **Refresh:** every 5 minutes on the clock (:00:40, :05:40, … so :45:40 and :50:40 run every hour), on return to the tab (phones pause timers), and with ↻.
- **Publishing lag (measured Oct 30, 2026):** CWMS 15-minute values appear about 15–35 min after their timestamp
  (e.g. the 20:15 reading was posted 20:36–20:38), so the :00 value is normally available by :20–:35. USGS IV readings appear 5–15 min after their timestamp.
  At :50 the strip therefore shows the :00 value plus a latest reading from :15–:30 (CWMS) or :35–:45 (USGS).
- **Tailwater sources.** Dexter: CWMS `DEX.Elev-Tailwater.Inst.0.0.MIXED-REV`. Hills Creek and Cougar: CWMS catalogues
  `HCR/CGR.Elev-Tailwater.*` in every version and interval (MIXED-REV, CBT-REV/RAW 1Hour and ~1Day, GOES/IRIDIUM/USGS-RAW, 15-min
  subsample), but the public API returns no values for any of them (checked Oct 30, 2026, offices NWDP/NWP/NWD; the NWD Dataquery
  service has no Willamette data). The CWMS `USGS-RAW` versions indicate a USGS feed; USGS publishes its dam tailwater gages, so the strip
  reads those directly: **14145110** Hills Creek Dam Tailwater and **14159410** Cougar Dam Tailwater (00065, gage datum 0 ft NGVD29, so the
  reading is the true tailwater elevation, not a derived value).

## Long ranges on the rule-curve views (30 D, 6 MO, 1 YR)

The Trend Recorder (Overview) is the one time chart: **24 H · 7 D · 30 D · 6 MO · 1 YR · YEAR (this calendar year, Jan–Dec) · PAST YEARS**. The Teacup page links to it ("Open in Trend Recorder"). Code: `js/history.js`.

- **30 D:** CWMS 15-minute pool elevation (same series as live). Daily grid lines, Mondays labelled.
- **6 MO / 1 YR:** USGS daily lake elevation (62614, observation at 24:00) plus live CWMS readings (last one per hour) since the last daily value. Month grid lines and labels.
  CWMS publishes no public daily or hourly pool series, and a year of 15-minute data is ~35,000 points per lake; if USGS fails, CWMS is fetched in monthly chunks and reduced to 6-hour means.
- **Rule curve:** the CWMS daily rule curve for the whole window. Rivers use USGS IV (30 D) or USGS daily means (6 MO / 1 YR); NWS forecasts are only drawn on 24 H / 7 D.
- History is fetched when a range is picked and cached for 30 minutes.

### Storage / Drawdown Calculator (`#/calc`)

A planning aid — verify against the water control manual and current operating orders. Every output carries that label.

- **Data:** the project's published CWMS elevation–storage rating (`<P>.Elev-Forebay;Stor.Standard.CENWP`, same loader and 7-day cache as the Tables page), linear interpolation both ways; values outside the table are errors. Current pool, outflow and USACE computed inflow prefill the inputs from the live data. The rule curve for the window is read from `<P>.Elev-RuleCurve.Inst.~1Day.0.CENWP-CALC`.
- **Units:** cfs, ac-ft, ft. 1 ac-ft = 43,560 ft³; 1 cfs·hr = 3600 / 43,560 = 0.082645 ac-ft.
- **1 · Volume / Flow / Time:** enter any two of volume change, net flow (or outflow and inflow) and duration; the third is solved with the arithmetic shown. Instead of a duration you can set a **target date**: the duration is the time from the start (default now) to the target, e.g. volume + target date gives the net flow needed. When the duration is given or solved, the result shows when it ends. With a starting elevation, the end elevation and change are given (positive volume = net release).
- **2 · Target Drawdown Planner:** a trapezoid release Q0 → plateau Qp → Q_end, ramp-limited (separate up/down rates), arriving exactly at the target time; Q_end defaults to the inflow at the target time. Simulation per step: `S[i+1] = S[i] + (I[i] − O[i]) × 0.082645 × Δt` (outflow held from each step's start; 1 h, 30 min or 15 min). Qp is found by bisection on the ending storage (±1 ac-ft). Reports: not reachable by the deadline (elevation reached, earliest achievable time within 90 days), ramps alone longer than the window (best achievable ramp), overshoot below target even at the lowest plateau, and any step below the minimum outflow. Outputs a summary, a plain-language schedule line, elevation vs rule curve and outflow/inflow charts, the step table and a CSV. Optional rounding of the plateau to 25/50/100 cfs.
- **Ramp limits in gage height (optional):** "Ramp limits in: Gage height (ft per hour)" applies the ramp-up/down limits to gage height at the USGS gage immediately downstream of the dam, fixed per dam: HCR 14145500, DEX 14150000, LOP 14150000 (releases into Dexter Reservoir; first gage is below Dexter), FAL 14151000, CGR 14159500, BLU 14162200, GPR 14187200 (releases into Foster Lake; first gage is below Foster), COT 14153500, DOR 14155500. Names lead with the gage's four-letter code (e.g. DEXO · MF Willamette nr Dexter). Fern Ridge's downstream gage, FRNO (Long Tom below the dam), has no public USGS gage height or rating set here, so ramps stay in cfs there. If USGS publishes no stage–discharge rating for a gage, the planner reports the rating as unavailable. The gage and a link to its USGS page are shown. The gage's published USGS stage–discharge (exsa) rating converts gage height ↔ flow, so the release ramps linearly in feet and its flow steps follow the rating. "Other flow at the gage" adds tributary flow between the dam and the gage (gage flow = release + other); travel time is not modelled. Flows outside the rating are reported; max outflow is capped at the rating's top. The schedule and CSV gain a gage-height column and the result names the rating used (ID and shift date).
- **Gate settings (optional):** pick a gated structure with a published CWMS 2-D opening rating (the free-flow spillway is not offered), the flow released elsewhere (e.g. powerhouse) and the number of gates opened equally (the rating's flow is treated as per gate). The gate step is **not** an input: on each ramp step the planner solves the rating backwards at that step's planned pool elevation, so the opening changes by exactly what passes the ramp-limited flow change (cfs/hr, or the flow equivalent of a gage-height limit). The result states that step (e.g. "Ramping up at 100 cfs/hr: +0.07–0.08 ft of gate per hour"), lists each ramp step with its opening change and flow change, and lists *trims* separately: during a hold the same flow needs a little more opening as the pool falls, and a trim is listed once that drift reaches the chosen threshold (0.05–0.5 ft, default 0.1). Openings are to 0.01 ft; the schedule and CSV carry opening and change per step, and steps beyond full opening or outside the rating are flagged.
- **Target from:** *Rule curve*, *Published interim / injunction target* (the dam's CWMS target level, as on the Teacup page; greyed out where none is published), or *Most limiting* (the lower of the two at the target time, since both cap the pool). The note shows both values and which was used; the published target is also drawn on the planner's elevation chart and added to the schedule and CSV.
- **Use current conditions** (both calculators) fills the latest live pool elevation and outflow, the start time (planner), and for inflow the **24-hour mean of USACE computed inflow, never below 0**. Computed inflow is outflow plus storage change, so pool-reading noise swings single values by hundreds of cfs, even below zero on small reservoirs such as Blue River; a single reading is a poor planning value. Min and max outflow are optional but always honoured when set: the plateau stays within them and the ending outflow (default: inflow at the target time) is raised to the min or capped at the max if it would fall outside them. If the minimum outflow is above inflow, so the pool must pass the target, the plan says when it passes and how far below it ends. Blank min = 0, blank max = no limit (the ramp limits and window still bound the plateau), so ramp-downs plan without inventing a maximum.
- **Inflow:** constant, or an hourly series pasted one value per line (last value held). No inflow forecasting, tailwater/stage ramp limits or unit dispatch (out of scope).
- **Code / tests:** `js/drawdown.js` (pure, tested in `check.js` against 1,000 ac-ft @ 700 cfs = 17.29 hr, @ 1,200 cfs = 10.08 hr, a hand-checked constant-inflow plan, and an infeasible target), `js/views/calc.js` (page).

### Picking up new deploys

Every local script and stylesheet in `index.html` is loaded as `?v=<hash of js/ and css/>`, so a newly deployed page can never run with code the browser cached from the previous version (GitHub Pages allows 10-minute browser caching). After changing anything in `js/` or `css/`, run `node scripts/stamp-version.js`; `check.js` fails if the tag is stale.


`js/update-check.js` fingerprints the deployed code (index.html plus every same-origin script and stylesheet, fetched uncached) when the page loads, then re-checks every 10 minutes and when the tab becomes visible. If the code changed while the tab is hidden, the page reloads itself quietly on the same route. While the page is on screen it never reloads by itself: it shows a "new version available · Reload" banner instead (the Calculator page always gets the banner, so inputs are not lost). Data files are not part of the fingerprint, so the BPA data commits do not trigger reloads.

## Area status cards (`js/hazards.js`)

A row of small cards under the totals; each shows one status line with an icon (green / amber / red / grey) and opens on click. An open card's details float over the page below it (as wide as the row, up to 70 % of the screen tall, scrolling inside), so nothing underneath moves; one card is open at a time, and clicking elsewhere or pressing Escape closes it:

- **Wildfire:** NIFC WFIGS current incidents in a box around the basin (`BOX` in `js/hazards.js`), kept within 60 mi of a project: name, wildfire/prescribed, acres, % contained, cause, discovered, distance and direction from the nearest project, plus NWS Red Flag Warnings / Fire Weather Watches. Red when a wildfire is within 25 mi or a Red Flag Warning is in effect. Expanded: table and links to Watch Duty, InciWeb and the raw query. The fires themselves are drawn on the Basin map (flame: red wildfire, amber prescribed burn, sized by acres; hover, focus or tap for name, size, containment, cause, discovered and distance from the nearest project). The schematic is not to scale, so `H.hazards.toSchematic(lat, lon)` places a point with a least-squares affine fit through the 10 dams (`js/weather.js` BASINS point → node position), plus a correction that fades out within ~12 mi of a dam so a fire next to a project is drawn next to its node; fires beyond the schematic sit on its edge with a chevron pointing outward. `drawHazardMarkers(kind, items)` in `js/app.js` takes `{ lat, lon, title, lines[] }` items and also draws a power-outage marker (bolt with a slash) for a future `state.mapLayers.outage` list. Watch Duty has no public API, so it is linked, not embedded.
- **NWS alerts:** api.weather.gov active alerts for Oregon whose area names Lane, Linn, Douglas or a Willamette/Cascade zone (fire-weather alerts go on the wildfire card).
- **Power:** live outages from EWEB (ArcGIS outage layer), Lane Electric, Emerald PUD and Blachly-Lane (NISC outage maps, `outagemap-data.cloud.coop/<slug>/Hosted_Outage_Map/summary.json`; x/y are metres from the SW corner of `config.json` `boundaryExtent`, Web Mercator), all CORS-readable (`js/outages.js`), plus BPA transmission/feeder/transformer interruptions in BPA's Eugene district or naming a Willamette powerhouse, copied by `scripts/fetch-bpa-outages.js` into `data/bpa-outages.json` (in `update-bpa.yml`). Outages of ≥ 2 customers (or with a cause/notes) are drawn on the Basin map as crossed-bolt markers with a hover/tap tooltip (customers, area, cause, notes, since, estimated restore); single-customer outages stay off the map. Bolt icon when clear, crossed-out bolt when outages exceed the thresholds (amber ≥ 10 in one outage or ≥ 25 total; red ≥ 250 / ≥ 500 or an unplanned BPA line trip still out). Pacific Power, SUB and Consumers Power publish no readable data (linked). All endpoints were verified from GitHub Actions on 2026-11-28.

Both live sources are fetched by the browser every poll (cached 10 min). Not verified from this repo's sandbox; `node check.js --live` will exercise them.

## Live event feed (`js/events.js`, `js/notify.js`)

"Tell me when something happens": after each data source lands, `trackEvents()` in `js/app.js` compares a snapshot of the page's state (`{ at, wx, hz, pw, nwps, snap }`) with the previous one through the pure `H.events.detect(prev, next, now)`, which returns `{ id, time, kind, level, title, detail, entityId }` events:

- **Rain** (weather model, `H.weather.summarize` per basin; Lookout Point and Dexter share one basin): rain started (last hour, next-24-h forecast, forecast end), rain stopped (event total), past 6 h crossing 0.5 in and 1 in, next-24-h forecast newly ≥ 1 in. **Wind:** gusts reaching NWS advisory or warning level (`H.weather.windLevel`).
- **Fire:** a new WFIGS incident (wildfire or prescribed, acres, containment, distance and direction from the nearest project), size doubling, containment up ≥ 25 points. **Alerts:** an NWS alert issued or ended (by event + area), fire-weather alerts flagged.
- **Power:** a new outage of ≥ 10 customers (utility, customers, area, cause, estimated restore), one restored, a utility's total crossing 100 / 500, a new unplanned BPA line trip still out.
- **Forecasts:** a new NWS/NWRFC river forecast issued for a gauge (issued time, 7-day peak stage, when, category). **Releases:** the gage below a dam moving ≥ 20 % and ≥ 50 cfs against its reading ~30 min earlier (once per change).

No events on the first load (each source's first arrival only seeds), ids are stable (incident id, rain-event start, reading time, forecast issue time) and the seen ids plus the last 200 events are kept in `localStorage` (`wvhd:events`), so a reload does not re-announce anything. Changes that happened while the page was closed are not reported. `js/notify.js` shows the events: toasts bottom-right (top on phones; alerts stay until dismissed, others go after 12 s; click selects the project or gauge, or opens the matching status card), the bell next to the clock with the unread count and a feed panel (filters by kind, mark all read), and opt-in desktop notifications (browser Notification API; permission is asked only when the box is ticked; only while the tab is open and in the background). Thresholds are this site's choices, not agency criteria.

## Derivation & Sources (`#/sources`)

A plain-language FAQ (`js/views/sources.js`): is anything made up, how to check a number (the ↗ links), how fresh data is, and one entry per value on the site (pool, inflow, outflow, storage, rule curve, vs rule and status lights, % full, totals, levels/targets/30-yr bands, TDG, river values, NWS flood, basin rain and the weather icon, SNOTEL, ratings, calculator, BPA). Each entry is tagged Reported, Agency-computed, Derived here, Weather model, Published reference or Site rule, with source links.

## No flicker on refresh

Background updates (every 3 min, and the 1-minute age refresh) redraw quietly: the chart's draw-in animation plays only when you pick a point or range; long-range history refreshes in the background every 30 min and keeps the old chart on screen until the new data lands; strips keep their lines while refreshing; and the list, header, "More", totals, feed badges, map, snowpack, strips, chart stats and the chart itself are updated **in place** (`setHTML` in `js/app.js` patches only the text and attributes that changed), so boxes are never rebuilt and animations never restart.

The header has one time box: Pacific time, plus "● LIVE · data checked hh:mm · next m:ss" (the old second box showed the last fetch time, which looked like a second, wrong clock).

## Popovers instead of expanding cells

Secondary notes (formulas, "derived"/"model", reading counts) on the totals tiles and the Overview header numbers float as a small popover on hover, keyboard focus or tap; a small dot marks cells that have one. Nothing changes size.

## Pages (hash routes)

`#/overview` is the live dashboard (default; `#/teacup` also lands here). `#/sources` is Derivation & Sources. `#/tables` has the published rating tables, `#/calc` the storage / drawdown calculator and `#/docs` the documents and data sources.
Plain anchors (`#workspace`, `#trends`, `#snow`) stay on Overview and scroll.

## Teacup (folded into Overview)

The separate Teacup page is gone (`#/teacup` now opens Overview). What it showed lives on Overview:
- **Mini teacups** in the Reservoirs list: water level within the conservation pool by elevation, coloured by rule-curve status (amber below, green near, blue above), the rule curve as a dashed amber line, a small arrow when the pool is below the conservation pool. Dexter (no conservation pool) is a tube for its power-pool band. The status light sits at the cup's corner.
- **More about … → Levels and targets:** the published injunction / interim elevation target today with its next changes and the pool's distance from it, Hills Creek's storage targets, today's 30-yr p05 / mean / p95, and the structural levels (top of dam, flood, conservation, spillway crest, …) with the pool's distance from each.
- Level lines, targets and the 30-yr bands are on the Trend Recorder chart.

## TDG, ODEQ temperature targets and snowpack

- **TDG chips (Dexter, Cougar):**
  - **Data:** CWMS hourly total-dissolved-gas % saturation in the tailwater, labelled "CWMS reported, provisional". It is fetched with the 15-min poll (3 tries; the `%` in the id is URL-encoded), and if a later request fails the last good data is kept and ages into STALE.
  - **Display:** the latest value with its time, a 7-day sparkline, and a dashed **"110% - Oregon/EPA TDG standard (reference)"** line. The chip turns amber when the latest value is above 110 %.
  - **Coverage:** no other project publishes a public TDG series, so no chip is shown there.
- **ODEQ 2006 TMDL temperature targets:**
  - **Data:** all 8 projects publish the seasonal level `<P>.Temp-Water.Inst.0.ODEQ-2006TMDL-Target`. It is in °C, with monthly step values and no target in winter. The latest version is 2012-01-01.
  - **Jasper only:** the river trend chart has a **Temp** option (USGS °C shown in °F). Only Middle Fork at Jasper gets the DEX/LOP target line, labelled as defined at the dam tailwater with the nearest gauge shown for context.
  - **Goshen:** not drawn, because Cottage Grove is far upstream. The chart says why.
- **Snowpack (SNOTEL):**
  - **What's shown:** a section on Overview (jump link "Snow") with 8 Willamette-basin stations, each with SWE, snow depth, a 7-day SWE sparkline, last report date, elevation and sub-basin (from the station HUC).
  - **Data:** daily values, refetched at most hourly. 0 is shown as 0, and median normals are not shown because the API returned none.

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
| Elevation–storage | `<P>.Elev-Forebay;Stor.Standard.CENWP` | all 10 (FAL, BLU not yet verified live) | — |
| Elevation–area | `<P>.Elev-Forebay;Area.Standard.CENWP` | 9 (FAL, BLU not yet verified live) | DEX (CWMS returns HTTP 500) |
| Spillway, free flow | `<P>-Spillway.Elev-Forebay;Flow-Free.Standard.CENWP` | all 8 | — |
| Spillway gates (2-D) | `<P>-Spillway.Opening,Elev-Forebay;Flow.Standard.CENWP` | LOP, HCR, DEX, GPR, CGR, FRN | COT, DOR (HTTP 500) |
| Regulating outlets (2-D) | `<P>-RegulatingOutlets.Opening,Elev-Forebay;Flow…`, CGR `-RegOutlets`, `-1Gate`, `-2Gates`, FRN `-SluiceGate` | LOP, HCR, GPR, FRN, COT, DOR, CGR (variants), FRN sluice | DEX, CGR base id (HTTP 500) |
| USGS stage–discharge | `get_ratings?site_no=<site>&file_type=exsa` (nwis host) | all 6 | — |

Notes:
- **2-D gate ratings** parse cleanly as opening × elevation grids, so they are implemented. You choose a gate opening and an elevation; openings between published curves are interpolated. CGR's gated-spillway rating publishes its axes swapped (elevations in the opening slot). It is detected, transposed, and flagged on the page.
- **USGS stage–flow gauges (15):** the seven river gauges (Eugene, Harrisburg, Vida, McKenzie below Leaburg Dam 14163150, Coburg, Jasper, Goshen) plus the gages immediately below the dams: HCRO 14145500, DEXO 14150000, FALO 14151000, CGRO 14159500, BLUO 14162200, FOSO 14187200 (below Foster, for Green Peter), COTO 14153500, DORO 14155500. The drawdown planner's gage-height ramp limits use these same tables and link to them ("table ▸"). Fern Ridge's FRNO has no public USGS table here.
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

- **USGS and USACE** are fetched directly by the browser, since both send `Access-Control-Allow-Origin: *`. The page fetches the full 7 days on load and then hourly; in between it polls every **5 minutes** for only the last 3 hours and splices that onto what it has (agency revisions to those hours win). It also refreshes as soon as the tab is shown again, the window regains focus or the phone wakes, if the data is more than 2 minutes old (browsers throttle timers in background tabs). The **Refresh** button fetches immediately. Agency publishing lag still applies: CWMS values usually appear 15–35 minutes after their timestamp, USGS 5–15 minutes.
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
js/events.js                    live event feed: pure detect(prev, next, now) + remembered feed (localStorage)
js/notify.js                    event toasts, header bell + feed panel, desktop notifications
js/router.js                    hash router (#/overview, #/teacup, #/tables, #/docs)
js/teacup-core.js               pure Teacup helpers (percent full, rule delta, next target changes, ruler scale)
js/views/*.js                   non-overview views (teacup, tables, docs)
js/tdg.js                       CWMS TDG series (DEX/CGR tailwater) + chip renderer
js/snotel.js                    NRCS SNOTEL snowpack loader/parser
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
node check.js --live   # + real USGS / CWMS / NWPS / CWMS levels / ratings / TDG / SNOTEL / BPA requests, prints live/missing tables (Node 20+)
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
