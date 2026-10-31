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
js/app.js                       rendering: clock, feed status, totals, SVG map, gauges, cards, trend chart, polling
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
node check.js          # config shape, helpers, DST parsing, page wiring (offline)
node check.js --live   # + real USGS / CWMS / BPA requests, prints a live/missing table (Node 20+)
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
