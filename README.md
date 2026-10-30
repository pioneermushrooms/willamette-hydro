# Willamette Valley Hydro Dispatch

A static, dark control-room style dashboard showing **illustrative** water-level
data for reservoirs and rivers in the South Willamette Valley, Oregon.

> **Illustrative data, not live.** Every number here is made up for demonstration.
> This project is not affiliated with, endorsed by, or operated by the U.S. Army
> Corps of Engineers, USGS, Bonneville Power Administration, or any government
> agency or utility. Don't use it for safety, recreation, navigation or
> operational decisions. For real conditions, check official sources.

## What it shows

- **Totals bar**: total generation (MW), generating units online, active alarms,
  weighted basin storage (% of conservation pool), total reservoir release.
- **Basin schematic**: a hand-drawn SVG (not to scale) with rivers as animated
  flowing lines. Dams are squares and river stations are circles, each with a
  pulsing status light. Tap or click a node to highlight it and open its details panel.
- **Reservoirs**: Lookout Point, Hills Creek, Dexter, Green Peter and Cougar
  (hydropower, with MW and units online), plus Fern Ridge, Cottage Grove and Dorena
  (flood control only, no generation). Each card shows pool elevation, a
  conservation-pool gauge with a rule-curve marker, inflow/outflow, and a status light.
- **River stations**: Willamette at Eugene and Harrisburg, McKenzie at Vida and
  Coburg, Middle Fork Willamette at Jasper, and Coast Fork Willamette at Goshen.
  Each shows flow (cfs), stage (ft), water temperature (°F), a 24 h sparkline and a status light.
- **Trend recorder**: a 24 h or 7 day chart of reservoir pool elevation or river
  flow, with a crosshair tooltip, a reference line (rule curve / minimum flow
  target), summary stats, and a data-table view.

Status logic (in `js/data.js`):

| Point | Normal | Watch | Low |
|---|---|---|---|
| Reservoir | within ±3 ft of rule curve | more than 3 ft off | more than 8 ft below, or below min pool |
| River | otherwise | flow < 110 % of min target, temp > 60 °F, or stage > 80 % of flood stage | flow below min target |

## Structure

```
index.html      single-page dashboard
css/style.css   theme, layout, animations (honours prefers-reduced-motion)
js/data.js      illustrative data + seeded trend generator (browser + Node)
js/app.js       rendering: clock, totals, SVG map, gauges, cards, trend chart
check.js        Node validation script for the data shape
.nojekyll       tells GitHub Pages to serve files as-is
```

There's no build step and no dependencies. Gauges, sparklines, the map and the
chart are all hand-rolled SVG.

### Data generation

`js/data.js` holds the current values for each point. It builds 7 days of
15-minute history (673 samples) with a seeded `mulberry32` PRNG keyed by
point id, so every load gives the same numbers. Reservoir series combine a
drawdown rate, a small diurnal swing (large at Dexter, the re-regulating pool)
and a damped random walk. River series add a diurnal cycle and one autumn rain
event with a fast rise and slow recession. Every series ends exactly on the
current value. Clock times are attached in the browser, counting back from the
most recent 15-minute boundary in Pacific time.

## Run locally

Any static server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Check

```sh
node check.js                                   # validate data shape & page wiring
for f in js/*.js check.js; do node --check "$f"; done   # syntax check
```

## Deploy to GitHub Pages

1. Push this directory to a GitHub repository, with the files at the repo root.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, then
   pick `main` and `/ (root)`. Save.
4. After a minute the site is live at `https://<user>.github.io/<repo>/`.

All paths are relative, so the site works from a project subpath.

## License

MIT. See [LICENSE](LICENSE).
