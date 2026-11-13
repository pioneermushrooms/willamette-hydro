/*
 * PAST YEARS view of the Trend Recorder: up to six calendar years of pool elevation on one
 * Jan–Dec axis (each with its own rule curve, dashed), the 30-yr statistics bands, optional
 * level lines, a hover readout, zoom (drag, month names, buttons, presets) and a year summary
 * table. Data: js/history.js loadYear (USGS daily lake elevation, else CWMS 6-hour means).
 *
 *   HYDRO.pastYears.render(box, { p, code, lv, levels, stats }, rerender)
 *     box: container element; p: project; lv: its CWMS levels (or null);
 *     levels: [{ key, label, v }] lines to draw; stats: false hides the 30-yr bands;
 *     rerender(): called when data arrives or the user changes years / zoom.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO, T = H.teacupCore, LV = H.levels;
  var byCode = {};
  H.projects.forEach(function (p) { byCode[p.code] = p; });
  var MNAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var ps = { years: null, yearData: {}, zoom: null, code: null, rerender: null };
  function rerender() { if (ps.rerender) ps.rerender(); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }

  // ---- Past years overlaid on one Jan–Dec axis -------------------------------------

  var MAX_YEARS = 6;          // six validated colours; each year keeps the colour (year mod 6)
  var YEARS_BACK = 20;        // year chips offered: this year and the 19 before
  var fShort = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

  var fYear = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' });
  function thisYear() { return +fYear.format(new Date()); }
  function selectedYears() {
    if (!ps.years) { var y = thisYear(); ps.years = [y, y - 1, y - 2]; }
    return ps.years.slice().sort(function (a, b) { return b - a; });
  }
  function toggleYear(y) {
    var cur = selectedYears(), i = cur.indexOf(y);
    if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); }
    else if (cur.length < MAX_YEARS) cur.push(y);
    ps.years = cur;
    rerender();
  }
  function yearSlot(y) { return ((y % MAX_YEARS) + MAX_YEARS) % MAX_YEARS; }

  function yearFor(code, y) {
    var key = code + ':' + y, v = ps.yearData[key];
    if (v) return v;
    ps.yearData[key] = { loading: true };
    H.history.loadYear(byCode[code], y).then(function (r) {
      ps.yearData[key] = r;
      if (code === ps.code) rerender();
    });
    return ps.yearData[key];
  }

  // Value of series s at year-fraction f of year y (nearest reading within 2 days), or null.
  function valueAtFrac(s, y, f) {
    if (!s || !s.t || !s.t.length) return null;
    var a = H.history.pacificMidnight(y, 1, 1), b = H.history.pacificMidnight(y + 1, 1, 1), t = a + f * (b - a);
    var lo = 0, hi = s.t.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s.t[mid] <= t) lo = mid; else hi = mid; }
    var k = Math.abs(s.t[lo] - t) <= Math.abs(s.t[hi] - t) ? lo : hi;
    return Math.abs(s.t[k] - t) <= 2 * 24 * 3600 * 1000 ? s.v[k] : null;
  }

  // Zoom presets (Pacific calendar months of the reference year; month 13 = next Jan 1).
  var ZOOM_PRESETS = [['all', 'Full year', 1, 13], ['fall', 'Fall drawdown · Oct–Dec', 10, 13], ['refill', 'Refill · Jan–May', 1, 6], ['summer', 'Summer · Jun–Sep', 6, 10]];
  function monthFrac(cy, mo) { return mo >= 13 ? 1 : H.history.yearFrac(H.history.pacificMidnight(cy, mo, 1), cy); }
  function zoomWindow() { if (!ps.zoom) ps.zoom = [0, 1]; return ps.zoom; }
  function setZoom(z) { ps.zoom = T.clampZoom(z[0], z[1]); rerender(); }
  function zoomAction(a) {
    var z = zoomWindow(), cy = thisYear();
    var pre = ZOOM_PRESETS.filter(function (p) { return p[0] === a; })[0];
    if (pre) return setZoom([monthFrac(cy, pre[2]), monthFrac(cy, pre[3])]);
    if (a === 'in') return setZoom(T.zoomBy(z, 0.5));
    if (a === 'out') return setZoom(T.zoomBy(z, 2));
    if (a === 'left') return setZoom(T.panBy(z, -1));
    if (a === 'right') return setZoom(T.panBy(z, 1));
  }
  // "Oct 1 – Dec 31" for a window of the reference year.
  function windowLabel(z, cy) {
    var a = H.history.pacificMidnight(cy, 1, 1), b = H.history.pacificMidnight(cy + 1, 1, 1);
    var d = function (f) { var t = a + f * (b - a); return fShort.format(new Date(t + H.history.pacificOffset(t))); };
    return z[0] <= 0 && z[1] >= 1 ? 'Jan 1 – Dec 31' : d(z[0]) + ' – ' + d(Math.max(z[0], z[1] - 1e-6));
  }

  function renderYears(box, m) {
    var years = selectedYears(), cy = thisYear(), now = Date.now(), z = zoomWindow(), z0 = z[0], z1 = z[1];
    var spanDays = (z1 - z0) * 365, zoomed = z0 > 0 || z1 < 1;
    var W = Math.max(280, Math.floor(box.clientWidth || 600)), Ht = W < 520 ? 260 : 320;
    var chips = '';
    for (var y = cy; y > cy - YEARS_BACK; y--) {
      var on = years.indexOf(y) >= 0, full = !on && years.length >= MAX_YEARS;
      chips += '<button type="button" class="chip small yr-chip" data-tcyear="' + y + '" aria-pressed="' + on + '"' +
        (full ? ' disabled title="Up to ' + MAX_YEARS + ' years at once; deselect one first"' : '') + '>' +
        (on ? '<i class="yr-sw yr-c' + yearSlot(y) + '" aria-hidden="true"></i>' : '') + y + '</button>';
    }
    var head = '<h4 class="tc-h4 py-title">Past years, ' + esc(m.p.name) + ' <span class="hint">pool elevation by calendar year; pick up to ' + MAX_YEARS + '</span></h4>' +
      '<div class="tc-chips yr-chips" role="group" aria-label="Years to compare (up to ' + MAX_YEARS + ')">' + chips + '</div>';
    var zbtn = function (a, label, title, dis) { return '<button type="button" class="btn yr-zb" data-tczoom="' + a + '" title="' + title + '" aria-label="' + title + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>'; };
    var zoomBar = '<div class="yr-zoom" role="group" aria-label="Zoom the chart">' +
      zbtn('out', '−', 'Zoom out', !zoomed) + zbtn('in', '+', 'Zoom in', z1 - z0 <= T.MIN_SPAN + 1e-9) + zbtn('left', '◀', 'Earlier', z0 <= 0) + zbtn('right', '▶', 'Later', z1 >= 1) +
      '<span class="yr-presets">' + ZOOM_PRESETS.map(function (p) {
        var pz = [monthFrac(cy, p[2]), monthFrac(cy, p[3])], cur = Math.abs(pz[0] - z0) < 1e-6 && Math.abs(pz[1] - z1) < 1e-6;
        return '<button type="button" class="chip small" data-tczoom="' + p[0] + '" aria-pressed="' + cur + '">' + p[1] + '</button>';
      }).join('') + '</span>' +
      '<span class="yr-window mono">' + windowLabel(z, cy) + '</span></div>';

    var data = years.map(function (y) { return { y: y, r: yearFor(m.code, y) }; });
    var loading = data.filter(function (d) { return d.r.loading; }).map(function (d) { return d.y; });
    var shown = data.filter(function (d) { return !d.r.loading && d.r.pool && d.r.pool.t.length; });
    if (!shown.length) {
      box.innerHTML = head + '<p class="na' + (loading.length ? ' loading' : '') + '">' + (loading.length ? 'Loading ' + loading.join(', ') + '…' : 'No pool history returned for the selected years.') + '</p>' + yearErrors(data);
      return;
    }

    var frac = H.history.yearFrac, margin = 3 / 365;
    var inWin = function (f) { return f >= z0 - margin && f <= z1 + margin; };
    // Reference context: the 30-yr statistics bands for this calendar year (DERIVED, published CWMS levels).
    var lv = m.lv, ser = {};
    ['statsP05', 'statsP25', 'statsAve', 'statsP75', 'statsP95'].forEach(function (k) {
      ser[k] = (lv ? T.annualSeries(LV.pick(lv, LV.IDS[k], now), cy) : []).filter(function (p) { return p[1] != null; }).map(function (p) { return [frac(p[0], cy), p[1]]; });
    });
    var hasStats = ser.statsAve.length > 0 && m.stats !== false;
    // Check: where the selected years' daily readings fall against the published 30-yr band.
    var checks = {}, allPts = [];
    if (ser.statsP05.length && ser.statsP95.length) shown.forEach(function (d) {
      var pts = d.r.pool.t.map(function (t, i) { return [frac(t, d.y), d.r.pool.v[i]]; }).filter(function (p) { return p[0] >= 0 && p[0] <= 1; });
      checks[d.y] = T.bandCheck(pts, ser.statsP05, ser.statsP95, ser.statsAve);
      allPts = allPts.concat(pts);
    });
    var allCheck = allPts.length ? T.bandCheck(allPts, ser.statsP05, ser.statsP95, ser.statsAve) : null;
    var pct = function (x) { return x == null ? '—' : Math.round(x * 100) + '%'; };

    // Elevation axis fits only what is inside the zoom window.
    var vals = [];
    shown.forEach(function (d) {
      d.r.pool.t.forEach(function (t, i) { var f = frac(t, d.y); if (f >= z0 && f <= z1) vals.push(d.r.pool.v[i]); });
      if (d.r.rule) d.r.rule.t.forEach(function (t, i) { var f = frac(t, d.y); if (f >= z0 && f < 1 && f <= z1) vals.push(d.r.rule.v[i]); });
    });
    var poolVals = vals.length;
    if (hasStats) ['statsP05', 'statsP95'].forEach(function (k) { ser[k].forEach(function (p) { if (p[0] >= z0 && p[0] <= z1) vals.push(p[1]); }); });
    var lvls = m.levels || [];
    lvls.forEach(function (l) { vals.push(l.v); });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.08 || 0.5;
    lo -= pad; hi += pad;
    var ml = 54, mr = W < 520 ? 40 : 52, mt = 10, mb = 24, pw = W - ml - mr, ph = Ht - mt - mb;
    var x = function (f) { return ml + ((f - z0) / (z1 - z0)) * pw; }, yv = function (v) { return mt + (1 - (v - lo) / (hi - lo)) * ph; };
    // Pool readings at 24:00 Dec 31 sit at f = 1 and belong to that year; a rule-curve value stamped
    // at the next Jan 1 midnight does not, so rule curves stop before f = 1.
    var path = function (s, yr, isRule) {
      var d = '', pen = false, prev = null;
      s.t.forEach(function (t, i) {
        var f = frac(t, yr);
        if (f < 0 || f > 1 || (isRule && f >= 1) || !inWin(f)) { pen = false; return; }
        if (prev != null && t - prev > 3 * 24 * 3600 * 1000) pen = false;   // gap in record
        d += (pen ? 'L' : 'M') + x(f).toFixed(1) + ' ' + yv(s.v[i]).toFixed(1); pen = true; prev = t;
      });
      return d;
    };
    var band = function (a, b) {
      var top = a.filter(function (p) { return inWin(p[0]); }), bot = b.filter(function (p) { return inWin(p[0]); }).reverse();
      if (!top.length || !bot.length) return '';
      return 'M' + top.map(function (p) { return x(p[0]).toFixed(1) + ' ' + yv(p[1]).toFixed(1); }).join('L') + 'L' + bot.map(function (p) { return x(p[0]).toFixed(1) + ' ' + yv(p[1]).toFixed(1); }).join('L') + 'Z';
    };

    var s = '<svg class="annual yr-svg" viewBox="0 0 ' + W + ' ' + Ht + '" width="100%" height="' + Ht + '" role="img" aria-label="' + esc(m.p.name + ' pool elevation for ' + years.join(', ') + ', ' + windowLabel(z, cy)) + '">';
    s += '<defs><clipPath id="yr-clip"><rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>';
    var step = T.niceStep(hi - lo), dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      s += '<line class="an-grid" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + yv(v).toFixed(1) + '" y2="' + yv(v).toFixed(1) + '"/>' +
        '<text class="an-lab" x="' + (ml - 6) + '" y="' + (yv(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, dec) + '</text>';
    }
    if (spanDays > 120) {
      // Month columns; each month name zooms to that month.
      for (var mo = 1; mo <= 12; mo++) {
        var f0 = monthFrac(cy, mo), f1 = monthFrac(cy, mo + 1);
        if (f1 <= z0 || f0 >= z1) continue;
        if (f0 >= z0) s += '<line class="an-grid" x1="' + x(f0).toFixed(1) + '" x2="' + x(f0).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>';
        var cx = x((Math.max(f0, z0) + Math.min(f1, z1)) / 2);
        s += '<text class="an-lab yr-mlab" data-tcmonth="' + mo + '" x="' + cx.toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="middle"><title>Zoom to ' + MNAMES[mo - 1] + '</title>' + (W < 520 && spanDays > 250 ? 'JFMAMJJASOND'[mo - 1] : MNAMES[mo - 1]) + '</text>';
      }
    } else {
      var dstep = T.dayTickStep(spanDays, pw, W < 520 ? 52 : 46);
      for (var k = 0; k < 367; k++) {
        var tk = H.history.pacificMidnight(cy, 1, 1 + k), fk = frac(tk, cy);
        if (fk > z1) break;
        if (fk < z0) continue;
        var dt = new Date(Date.UTC(cy, 0, 1 + k, 12)), dom = dt.getUTCDate(), first = dom === 1;
        if (!first && (dstep >= 7 ? (dom - 1) % dstep !== 0 || dom > 29 : (dom - 1) % dstep !== 0)) continue;
        s += '<line class="an-grid" x1="' + x(fk).toFixed(1) + '" x2="' + x(fk).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"' + (first ? '' : ' style="opacity:.45"') + '/>' +
          '<text class="an-lab' + (first ? ' yr-mlab' : '') + '"' + (first ? ' data-tcmonth="' + (dt.getUTCMonth() + 1) + '"' : '') + ' x="' + x(fk).toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="middle">' + fShort.format(dt) + '</text>';
      }
    }
    s += '<g clip-path="url(#yr-clip)">';
    if (hasStats) s += '<path class="an-p95" d="' + band(ser.statsP95, ser.statsP05) + '"/><path class="an-p75" d="' + band(ser.statsP75, ser.statsP25) + '"/>';
    lvls.forEach(function (l) { s += '<line class="lvl-line lvl-' + l.key + '" x1="' + ml + '" x2="' + (ml + pw) + '" y1="' + yv(l.v).toFixed(1) + '" y2="' + yv(l.v).toFixed(1) + '"/><text class="lvl-lab" x="' + (ml + 4) + '" y="' + (yv(l.v) - 3).toFixed(1) + '">' + esc(l.label) + ' ' + fmt(l.v, 1) + '</text>'; });
    shown.forEach(function (d) { if (d.r.rule && d.r.rule.t.length) s += '<path class="yr-rule yr-c' + yearSlot(d.y) + '" d="' + path(d.r.rule, d.y, true) + '"/>'; });
    shown.forEach(function (d) { s += '<path class="yr-pool yr-c' + yearSlot(d.y) + '" d="' + path(d.r.pool, d.y) + '"/>'; });
    if (spanDays <= 60) {
      // Zoomed in: mark each reading so individual daily values are visible.
      shown.forEach(function (d) {
        var dots = '';
        d.r.pool.t.forEach(function (t, i) { var f = frac(t, d.y); if (f >= z0 && f <= z1) dots += '<circle cx="' + x(f).toFixed(1) + '" cy="' + yv(d.r.pool.v[i]).toFixed(1) + '" r="3"/>'; });
        s += '<g class="yr-dots yr-c' + yearSlot(d.y) + '">' + dots + '</g>';
      });
    }
    s += '</g>';
    // Direct labels at each line's last reading inside the window, spread so they never overlap.
    var items = [];
    shown.forEach(function (d) {
      for (var n = d.r.pool.t.length - 1; n >= 0; n--) {
        var f = frac(d.r.pool.t[n], d.y);
        if (f <= z1 && f >= z0) { items.push({ y: yv(d.r.pool.v[n]), xe: x(Math.min(1, f)), yr: d.y }); break; }
      }
    });
    T.spreadLabels(items, 12, mt + 6, mt + ph - 2).forEach(function (it) {
      var lx = Math.min(it.xe + 4, ml + pw + 4);
      s += '<line class="yr-lead yr-c' + yearSlot(it.yr) + '" x1="' + it.xe.toFixed(1) + '" x2="' + (lx + 2).toFixed(1) + '" y1="' + it.y.toFixed(1) + '" y2="' + it.ly.toFixed(1) + '"/>' +
        '<text class="yr-lab" x="' + (lx + 4).toFixed(1) + '" y="' + (it.ly + 3.5).toFixed(1) + '">' + it.yr + '</text>';
    });
    if (!poolVals) s += '<text class="an-lab" x="' + (ml + pw / 2) + '" y="' + (mt + ph / 2) + '" text-anchor="middle">No readings in this window for the selected years</text>';
    s += '<g class="yr-cross" style="display:none"><line class="yr-cross-line" y1="' + mt + '" y2="' + (mt + ph) + '"/></g>';
    s += '<rect class="yr-sel" x="0" y="' + mt + '" width="0" height="' + ph + '" style="display:none"/>';
    s += '<rect class="yr-hit" x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '" fill="transparent"/>';
    s += '</svg>';

    var leg = shown.map(function (d) { return '<span><i class="yr-key yr-c' + yearSlot(d.y) + '"></i>' + d.y + '</span>'; });
    leg.push('<span><i class="yr-key-rule"></i>dashed: that year’s rule curve</span>');
    if (hasStats) leg.push('<span><i class="lg-p95"></i>30-yr p05–p95</span><span><i class="lg-p75"></i>p25–p75</span>');
    if (lvls.length) leg.push('<span><i class="lg-lvl"></i>level lines (CWMS)</span>');
    if (loading.length) leg.push('<span class="na loading">loading ' + loading.join(', ') + '…</span>');

    var rows = data.map(function (d) {
      if (d.r.loading) return '<tr><td>' + d.y + '</td><td colspan="4" class="na">loading…</td></tr>';
      var sm = H.history.yearSummary(d.r.pool, d.y);
      if (!sm) return '<tr><td>' + d.y + '</td><td colspan="4" class="na">' + esc(d.r.error || 'no pool data') + '</td></tr>';
      var day = function (t) { return fShort.format(new Date(t - 12 * 3600 * 1000 + (H.history.pacificOffset(t)))); };
      return '<tr><td><i class="yr-key yr-c' + yearSlot(d.y) + '"></i> ' + d.y + (d.y === cy ? ' (to date)' : '') + '</td><td>' + fmt(sm.min, 2) + ' · ' + day(sm.minT) + '</td><td>' + fmt(sm.max, 2) + ' · ' + day(sm.maxT) + '</td>' +
        '<td>' + (sm.fallMean == null ? '—' : fmt(sm.fallMean, 2)) + '</td>' +
        '<td>' + (checks[d.y] && checks[d.y].n ? pct(checks[d.y].inside) + ' · ' + pct(checks[d.y].below) + ' · ' + pct(checks[d.y].above) + (checks[d.y].medianVsMean == null ? '' : ' · ' + (checks[d.y].medianVsMean >= 0 ? '+' : '−') + fmt(Math.abs(checks[d.y].medianVsMean), 1) + ' ft') : '—') + '</td>' +
        '<td class="yr-src">' + esc(d.r.src || '') + '</td></tr>';
    }).join('');
    var checkLine = allCheck && allCheck.n ? '<p class="py-check"><b>Check against the 30-yr band</b> (selected years, ' + fmt(allCheck.n) + ' daily readings): ' +
      '<b>' + pct(allCheck.inside) + '</b> inside p05–p95 · ' + pct(allCheck.below) + ' below · ' + pct(allCheck.above) + ' above' +
      (allCheck.medianVsMean == null ? '' : ' · median ' + (allCheck.medianVsMean >= 0 ? '+' : '−') + fmt(Math.abs(allCheck.medianVsMean), 1) + ' ft vs the 30-yr mean') +
      '. <span class="hint">For years run like the 30 years behind the band (thru 2023), about 90% should be inside. A similar offset in every year and season would suggest the band and the lake record use different datums; misses concentrated in recent years or in Oct–Dec reflect changed operations (e.g. deep fall drawdowns since 2021). Per-year figures are in the table.</span></p>' : '';
    var table = '<details class="table-view"><summary>Year summary table</summary><div class="table-scroll"><table><thead><tr><th>Year</th><th>Lowest pool (ft) · date</th><th>Highest pool (ft) · date</th><th>Mean Nov 15–Dec 15 (ft)</th><th title="Share of that year’s daily readings inside / below / above the USACE 30-yr p05–p95 band, and the median difference from the 30-yr mean">vs 30-yr band: inside · below · above · median vs mean</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';

    box.innerHTML = head + zoomBar + '<div class="yr-wrap">' + s + '<div class="tooltip mono yr-tip" hidden></div></div>' +
      '<p class="hint yr-howto">Drag across the chart to zoom in · tap a month name to zoom to that month · double-click to zoom out.</p>' +
      '<div class="an-legend">' + leg.join('') + '</div>' + checkLine + table +
      '<p class="hint">Each year is drawn on the same calendar axis. Pool: USGS daily lake elevation (24:00) at the project’s lake gage where one exists, otherwise USACE CWMS as 6-hour means. Rule curve: CWMS ' + esc(m.p.series.rule.name) + ' for that year, where published. Bands: 30-yr statistics thru 2023 (DERIVED from published CWMS levels). Provisional data. Hover or tap the chart for values.</p>' + yearErrors(data);
    bindYearChart(box, shown, { ml: ml, pw: pw, W: W, cy: cy, z0: z0, z1: z1 });
  }

  function yearErrors(data) {
    var notes = data.filter(function (d) { return !d.r.loading && (d.r.note || d.r.ruleError || d.r.error); }).map(function (d) {
      return d.y + ': ' + [d.r.error, d.r.note, d.r.ruleError ? 'rule curve unavailable (' + d.r.ruleError + ')' : null].filter(Boolean).join(' ');
    });
    return notes.length ? '<p class="hint yr-notes">' + esc(notes.join(' · ')) + '</p>' : '';
  }

  // Hover/tap readout, drag-to-zoom (horizontal drags; vertical swipes still scroll the page), double-click to zoom out.
  function bindYearChart(box, shown, g) {
    var svg = box.querySelector('.yr-svg'), tip = box.querySelector('.yr-tip'), cross = box.querySelector('.yr-cross'), line = box.querySelector('.yr-cross-line'), sel = box.querySelector('.yr-sel');
    if (!svg) return;
    var a = H.history.pacificMidnight(g.cy, 1, 1), b = H.history.pacificMidnight(g.cy + 1, 1, 1);
    var pxOf = function (ev) { var r = svg.getBoundingClientRect(); return (ev.clientX - r.left) * (g.W / r.width); };
    var fOf = function (px) { return g.z0 + ((px - g.ml) / g.pw) * (g.z1 - g.z0); };
    var drag = null;
    var hide = function () { cross.style.display = 'none'; tip.hidden = true; };
    var show = function (ev) {
      var px = pxOf(ev), f = fOf(px);
      if (px < g.ml || px > g.ml + g.pw) { hide(); return; }
      line.setAttribute('x1', px.toFixed(1)); line.setAttribute('x2', px.toFixed(1)); cross.style.display = '';
      var refT = a + f * (b - a);
      var lines = shown.map(function (d) {
        var v = valueAtFrac(d.r.pool, d.y, f), rv = valueAtFrac(d.r.rule, d.y, f);
        return '<span><i class="yr-key yr-c' + yearSlot(d.y) + '"></i>' + d.y + ': <b>' + (v == null ? '—' : fmt(v, 2) + ' ft') + '</b>' + (rv == null ? '' : ' · rule ' + fmt(rv, 2)) + '</span>';
      });
      tip.innerHTML = '<b>' + fShort.format(new Date(refT + H.history.pacificOffset(refT))) + '</b><br>' + lines.join('<br>');
      tip.hidden = false;
      var bx = box.querySelector('.yr-wrap').getBoundingClientRect(), left = ev.clientX - bx.left + 12;
      if (left + tip.offsetWidth > bx.width) left = ev.clientX - bx.left - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px'; tip.style.top = '8px';
    };
    svg.addEventListener('pointerdown', function (ev) {
      var px = pxOf(ev);
      if (px < g.ml || px > g.ml + g.pw) return;
      drag = { x0: px, id: ev.pointerId, moved: false };
      show(ev);
    });
    svg.addEventListener('pointermove', function (ev) {
      show(ev);
      if (!drag || ev.pointerId !== drag.id) return;
      var px = Math.max(g.ml, Math.min(g.ml + g.pw, pxOf(ev)));
      if (!drag.moved && Math.abs(px - drag.x0) > 8) { drag.moved = true; try { svg.setPointerCapture(drag.id); } catch (e) { /* ignore */ } }
      if (drag.moved) { sel.setAttribute('x', Math.min(px, drag.x0).toFixed(1)); sel.setAttribute('width', Math.abs(px - drag.x0).toFixed(1)); sel.style.display = ''; }
    });
    var end = function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag; drag = null; sel.style.display = 'none';
      if (!d.moved) return;
      var px = Math.max(g.ml, Math.min(g.ml + g.pw, pxOf(ev)));
      setZoom([fOf(Math.min(px, d.x0)), fOf(Math.max(px, d.x0))]);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', function () { drag = null; sel.style.display = 'none'; hide(); });
    svg.addEventListener('pointerleave', function () { if (!drag) hide(); });
    svg.addEventListener('dblclick', function (ev) { ev.preventDefault(); setZoom(T.zoomBy([g.z0, g.z1], 2.5, fOf(pxOf(ev)))); });
  }

  function bind(box) {
    if (box._pyBound) return;
    box._pyBound = true;
    box.addEventListener('click', function (ev) {
      var zb = ev.target.closest('[data-tczoom]');
      if (zb && !zb.disabled) { zoomAction(zb.getAttribute('data-tczoom')); return; }
      var mb = ev.target.closest('[data-tcmonth]');
      if (mb) { var mo = +mb.getAttribute('data-tcmonth'), cyy = thisYear(); setZoom([monthFrac(cyy, mo), monthFrac(cyy, mo + 1)]); return; }
      var yb = ev.target.closest('[data-tcyear]');
      if (yb && !yb.disabled) toggleYear(+yb.getAttribute('data-tcyear'));
    });
  }

  H.pastYears = {
    MAX_YEARS: MAX_YEARS,
    render: function (box, m, again) { ps.code = m.code; ps.rerender = again; bind(box); renderYears(box, m); }
  };
})(typeof self !== 'undefined' ? self : this);
