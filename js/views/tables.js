/*
 * Reports & Tables view (#/tables): published rating tables with lookup, curve chart,
 * paged table and CSV download. Ratings come from js/ratings.js (lazy, cached 7 days).
 * PUBLISHED RATINGS, not live data; current values (LIVE) come from HYDRO.live.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO, R = H.ratings, LV = H.levels;
  H.views = H.views || {};

  var PAGE = 50;
  var byCode = {};
  H.projects.forEach(function (p) { byCode[p.code] = p; });
  var stationBySite = {};
  H.stations.forEach(function (s) { stationBySite[s.site] = s; });

  var st = {
    el: null, group: 'storage', code: 'LOP', site: '14166000', structure: null,
    entry: null, err: null, loading: false, token: 0,
    page: 0, x: null, yIn: null, opening: null, geom: null
  };

  // ---- Formatting -------------------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmt(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  // Dependent values span 0.06 to 476,000: pick decimals by magnitude.
  function fmtDep(v) { var a = Math.abs(v); return fmt(v, a < 10 ? 3 : a < 1000 ? 1 : 0); }
  var fDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' });
  // Rating effective/create dates are calendar dates stamped near 00:00 UTC: format in UTC so
  // "2014-01-01T02:00Z" reads Jan 1, 2014 (not Dec 31 in Pacific time).
  var fDayUTC = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  function dayUTC(t) { return t ? fDayUTC.format(new Date(t)) : '—'; }
  function day(t) { return t ? fDay.format(new Date(t)) : '—'; }

  // ---- Current definition + live value ---------------------------------------------

  function defs() {
    if (st.group === 'usgs') return [R.usgsDef(st.site)];
    return R.cwmsDefs(st.group, st.code);
  }

  function currentDef() {
    var d = defs();
    if (!d.length) return null;
    if (st.group === 'outlet') {
      var m = d.filter(function (x) { return x.key === st.structure; })[0];
      return m || d[0];
    }
    return d[0];
  }

  // LIVE independent value for "use current": pool elevation or gage height.
  function liveX() {
    var snap = H.live && H.live.snap;
    if (!snap) return null;
    if (st.group === 'usgs') {
      var s = stationBySite[st.site], d = s && snap.stations[s.id], l = d && H.latest(d.stage);
      return l ? { v: l.v, t: l.t, label: 'gage height' } : null;
    }
    var p = byCode[st.code], pd = snap.projects[p.id], e = pd && H.latest(pd.elev);
    return e ? { v: e.v, t: e.t, label: 'pool elevation' } : null;
  }

  // The 1-D curve currently in view (for 2-D: the selected opening).
  function curve() {
    var d = st.entry && st.entry.data;
    if (!d) return null;
    if (d.kind === '1d') return d;
    var i = d.others.indexOf(st.opening);
    if (i < 0) i = Math.floor(d.others.length / 2);
    return d.curves[i];
  }

  // ---- Loading -------------------------------------------------------------------------

  function load(force) {
    var def = currentDef();
    st.entry = null; st.err = null; st.page = 0; st.opening = null;
    if (!def) { renderBody(); return; }
    var token = ++st.token;
    st.loading = true;
    renderBody();
    R.load(def, { force: !!force }).then(function (entry) {
      if (token !== st.token) return;
      st.entry = entry;
      if (entry.data.kind === '2d') st.opening = entry.data.others[Math.floor(entry.data.others.length / 2)];
      var lx = liveX();
      st.x = lx ? +lx.v.toFixed(2) : null;
      st.yIn = null;
      var c = curve();
      if (st.x != null && c) st.page = Math.max(0, Math.floor(R.nearestIndex(c.xs, st.x) / PAGE));
    }, function (err) {
      if (token !== st.token) return;
      st.err = err.message || 'failed';
    }).then(function () {
      if (token !== st.token) return;
      st.loading = false;
      renderBody();
    });
  }

  // ---- Controls ------------------------------------------------------------------------

  function renderControls() {
    var c = st.el.querySelector('#rt-controls');
    var h = '<div class="seg rt-groups" role="group" aria-label="Rating type">' + R.GROUPS.map(function (g) {
      return '<button type="button" data-group="' + g.id + '" aria-pressed="' + (g.id === st.group) + '">' + esc(g.label) + '</button>';
    }).join('') + '</div>';
    if (st.group === 'usgs') {
      h += '<div class="tc-chips" role="group" aria-label="USGS gauge">' + R.SITES.map(function (s) {
        return '<button type="button" class="chip" data-site="' + s.site + '" aria-pressed="' + (s.site === st.site) + '">' + esc(s.name.replace(' Willamette', '')) + '</button>';
      }).join('') + '</div>';
    } else {
      h += '<div class="tc-chips" role="group" aria-label="Project">' + R.CODES.map(function (code) {
        var avail = R.cwmsDefs(st.group, code).length > 0;
        var why = st.group === 'area' && R.UNAVAILABLE.area[code] ? R.UNAVAILABLE.area[code] : 'No rating of this type is catalogued on this site for ' + code + '.';
        return '<button type="button" class="chip" data-code="' + code + '" aria-pressed="' + (code === st.code) + '"' +
          (avail ? '' : ' disabled title="' + esc(why) + '" aria-label="' + esc(byCode[code].name + ': ' + why) + '"') + '>' + esc(byCode[code].name) + '</button>';
      }).join('') + '</div>';
      if (st.group === 'outlet') {
        var d = defs(), cur = currentDef();
        h += '<div class="tc-chips rt-structs" role="group" aria-label="Structure">' + d.map(function (x) {
          return '<button type="button" class="chip small" data-structure="' + x.key + '" aria-pressed="' + (cur && cur.key === x.key) + '">' + esc(x.label) + '</button>';
        }).join('') + '</div>';
      }
    }
    c.innerHTML = h;
  }

  // ---- Body ------------------------------------------------------------------------------

  function provenance(def, e) {
    var d = e.data, src = def.source === 'usgs' ? 'USGS' : 'CWMS';
    var h = '<div class="rt-prov"><span class="badge plain">PUBLISHED RATING (' + src + '), not live</span> ';
    if (def.source === 'usgs') {
      h += '<span>USGS rating ' + esc(d.ratingId || '—') + (d.shifted ? ' · shifts last updated ' + esc(d.shifted) : '') + '</span>';
    } else {
      h += '<span>Rating effective ' + dayUTC(d.effective) + ' · created ' + dayUTC(d.created) + (d.versions > 1 ? ' · latest of ' + d.versions + ' published versions' : '') + '</span>';
    }
    h += '<p class="hint">' + esc(def.source === 'usgs' ? 'USGS ' + def.site + ' ' + (def.name || '') : def.id) +
      ' · <a href="' + esc(e.url) + '" target="_blank" rel="noopener">source API ↗</a>' + (e.fromCache ? ' · cached copy from ' + day(e.fetchedAt) : '') +
      '. Use for reference only; not an official source.</p>';
    if (def.source === 'usgs') {
      h += '<p class="hint">USGS rating (provisional; includes the current shift). Look-ups use gage height directly: the discharge column already has the shift applied, so the SHIFT column is shown for information only.</p>';
      if (d.baseOnly) h += '<p class="hint warntext">This file is a base rating: USGS states it does not include shifts applied to recent data.</p>';
      if (def.note) h += '<p class="hint warntext">' + esc(def.note) + '</p>';
    }
    if (d.kind === '2d') {
      h += '<p class="hint">2-D rating: flow by gate opening and forebay elevation (' + d.others.length + ' opening curves). Openings between published curves are interpolated linearly.' +
        (d.transposed ? ' The published data lists elevation and opening in swapped positions; it is shown here as opening × elevation.' : '') + '</p>';
    }
    return h + '</div>';
  }

  function lookupHTML(def, d) {
    var lx = liveX(), c = curve();
    var h = '<div class="rt-lookup">';
    if (d.kind === '2d') {
      h += '<label class="field"><span class="field-label">Gate opening (ft)</span><select id="rt-op">' + d.others.map(function (o) {
        return '<option value="' + o + '"' + (o === st.opening ? ' selected' : '') + '>' + o + '</option>';
      }).join('') + '</select></label>';
    }
    h += '<div class="rt-row"><label class="field"><span class="field-label">' + esc(def.x) + ' (' + def.xu + ')</span>' +
      '<input id="rt-x" type="number" inputmode="decimal" step="any" value="' + (st.x != null ? st.x : '') + '"></label>' +
      '<div class="rt-out"><span class="field-label">' + esc(def.y) + ' (' + def.yu + ')</span><output id="rt-y" class="mono"></output></div></div>';
    if (c && R.isMonotonic(c.ys)) {
      h += '<div class="rt-row"><label class="field"><span class="field-label">Reverse: ' + esc(def.y) + ' (' + def.yu + ')</span>' +
        '<input id="rt-yin" type="number" inputmode="decimal" step="any" value="' + (st.yIn != null ? st.yIn : '') + '"></label>' +
        '<div class="rt-out"><span class="field-label">' + esc(def.x) + ' (' + def.xu + ')</span><output id="rt-xout" class="mono"></output></div></div>';
    } else if (c) {
      h += '<p class="hint">Reverse lookup unavailable: this curve is not monotonic.</p>';
    }
    h += '<div class="rt-row rt-live">' + (lx
      ? '<button type="button" class="btn" id="rt-use">Use current</button><span class="mono">current: ' + fmt(lx.v, 2) + ' ' + def.xu + ' <span class="lbl">LIVE</span> ' + esc(lx.label) + '</span>'
      : '<span class="na">No live ' + (st.group === 'usgs' ? 'gage height' : 'pool elevation') + ' available yet.</span>') + '</div>';
    return h + '</div>';
  }

  function updateOutputs() {
    var def = currentDef(), d = st.entry && st.entry.data, c = curve();
    if (!d || !c) return;
    var out = st.el.querySelector('#rt-y');
    if (out) {
      var r = d.kind === '2d' ? R.interp2d(d, st.opening, st.x) : R.interp(c.xs, c.ys, st.x);
      out.innerHTML = st.x == null ? '—' : r.y != null ? fmtDep(r.y) : '<span class="warntext">outside rating range (' + fmt(c.xs[0], 2) + '–' + fmt(c.xs[c.xs.length - 1], 2) + ' ' + def.xu + ')</span>';
    }
    var xo = st.el.querySelector('#rt-xout');
    if (xo) {
      var ri = R.inverse(c.xs, c.ys, st.yIn);
      xo.innerHTML = st.yIn == null ? '—' : ri.x != null ? fmt(ri.x, 2) : '<span class="warntext">outside rating range (' + fmtDep(c.ys[0]) + '–' + fmtDep(c.ys[c.ys.length - 1]) + ' ' + def.yu + ')</span>';
    }
    drawChart();
  }

  function tableHTML(def, d) {
    var c = curve(), n = c.xs.length, pages = Math.max(1, Math.ceil(n / PAGE));
    st.page = Math.max(0, Math.min(pages - 1, st.page));
    var i0 = st.page * PAGE, i1 = Math.min(n, i0 + PAGE), near = R.nearestIndex(c.xs, st.x);
    var usgs = def.source === 'usgs';
    var rows = '';
    for (var i = i0; i < i1; i++) {
      rows += '<tr' + (i === near ? ' class="hl-row"' : '') + '><td>' + fmt(c.xs[i], 2) + '</td>' + (usgs ? '<td>' + fmt(d.shift[i], 2) + '</td>' : '') + '<td>' + fmtDep(c.ys[i]) + '</td></tr>';
    }
    return '<div class="rt-table-head"><h4 class="tc-h4">Table' + (d.kind === '2d' ? ' · opening ' + st.opening + ' ft' : '') + ' <span class="hint">' + fmt(n) + ' rows</span></h4>' +
      '<div class="rt-pager"><button type="button" class="btn" data-page="-1"' + (st.page === 0 ? ' disabled' : '') + '>◂ Prev</button>' +
      '<span class="mono">' + (st.page + 1) + ' / ' + pages + '</span>' +
      '<button type="button" class="btn" data-page="1"' + (st.page >= pages - 1 ? ' disabled' : '') + '>Next ▸</button>' +
      '<button type="button" class="btn" id="rt-jump"' + (near < 0 ? ' disabled' : '') + '>Jump to lookup</button>' +
      '<button type="button" class="btn" id="rt-csv">⇩ CSV</button></div></div>' +
      '<div class="table-scroll rt-table"><table><thead><tr><th>' + esc(def.x) + ' (' + def.xu + ')</th>' + (usgs ? '<th>Shift (ft)</th>' : '') +
      '<th>' + esc(def.y) + ' (' + def.yu + ')</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderBody() {
    var b = st.el.querySelector('#rt-body'), def = currentDef();
    if (!def) {
      var why = st.group === 'area' && R.UNAVAILABLE.area[st.code] ? R.UNAVAILABLE.area[st.code] : 'No rating of this type is published for this project.';
      b.innerHTML = '<p class="na">' + esc(why) + '</p>';
      return;
    }
    if (st.loading) {
      b.innerHTML = '<div class="tc-skel"><p class="na loading">Loading rating… (CWMS ratings are slow, 2–5 s)</p><div class="skel-bar"></div></div>';
      return;
    }
    if (st.err) {
      b.innerHTML = '<div class="tc-skel"><p class="warntext">Rating unavailable (' + esc(st.err) + ').</p><button type="button" class="btn" id="rt-retry">↻ Retry</button></div>';
      return;
    }
    if (!st.entry) { b.innerHTML = ''; return; }
    var d = st.entry.data;
    if (!d.xs && d.kind === '1d' || (d.kind === '1d' && !d.xs.length)) {
      b.innerHTML = provenance(def, st.entry) + '<p class="na">No rating published (the file has no rating rows).</p>';
      return;
    }
    b.innerHTML = provenance(def, st.entry) +
      '<div class="rt-grid"><div class="rt-left">' + lookupHTML(def, d) + '</div>' +
      '<div class="rt-chart-wrap" id="rt-chart-wrap"><svg id="rt-chart" aria-hidden="true"></svg><div class="tooltip mono" id="rt-tip" hidden></div></div></div>' +
      '<div class="rt-legend" id="rt-legend"></div>' +
      '<div id="rt-table">' + tableHTML(def, d) + '</div>';
    updateOutputs();
  }

  // ---- Chart -------------------------------------------------------------------------------

  function levelMarks() {
    if (st.group === 'usgs' || !LV) return [];
    var lv = LV.peekProjectLevels(st.code);
    if (!lv) return [];
    return [['bottomCons', 'Bottom of conservation'], ['topCons', 'Top of conservation'], ['spillwayCrest', 'Spillway crest']]
      .map(function (k) { return { v: LV.constantAt(lv, LV.IDS[k[0]]), label: k[1] }; })
      .filter(function (m) { return m.v != null; });
  }

  function drawChart() {
    var wrap = st.el.querySelector('#rt-chart-wrap'), svg = st.el.querySelector('#rt-chart');
    var def = currentDef(), d = st.entry && st.entry.data, c = curve();
    if (!wrap || !svg || !c) return;
    var W = Math.max(260, Math.floor(wrap.clientWidth)), Ht = W < 480 ? 280 : 320;
    var xs = c.xs, ys = c.ys;
    var yLo = xs[0], yHi = xs[xs.length - 1];                 // independent on the vertical axis
    var xLo = Math.min(0, Math.min.apply(null, ys)), xHi = Math.max.apply(null, ys);
    if (d.kind === '2d') d.curves.forEach(function (cv) { xHi = Math.max(xHi, Math.max.apply(null, cv.ys)); });
    var marks = levelMarks().filter(function (m) { return m.v >= yLo && m.v <= yHi; });
    var padY = (yHi - yLo) * 0.04 || 1;
    yLo -= padY; yHi += padY;
    var ml = 54, mr = 12, mt = 12, mb = 30, pw = W - ml - mr, ph = Ht - mt - mb;
    var X = function (v) { return ml + ((v - xLo) / (xHi - xLo || 1)) * pw; };
    var Y = function (v) { return mt + (1 - (v - yLo) / (yHi - yLo)) * ph; };
    var s = '';
    var ticks = function (lo, hi, n) {
      var span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
      var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag, out = [];
      for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
      return out;
    };
    ticks(yLo, yHi, 5).forEach(function (v) {
      s += '<line class="an-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/>' +
        '<text class="an-lab" x="' + (ml - 6) + '" y="' + (Y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, (yHi - yLo) < 8 ? 1 : 0) + '</text>';
    });
    ticks(xLo, xHi, W < 480 ? 3 : 5).forEach(function (v) {
      s += '<line class="an-grid" x1="' + X(v).toFixed(1) + '" x2="' + X(v).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '"/>' +
        '<text class="an-lab" x="' + X(v).toFixed(1) + '" y="' + (Ht - 16) + '" text-anchor="middle">' + (v >= 10000 ? fmt(v / 1000) + 'k' : fmt(v, v < 10 && v !== 0 ? 1 : 0)) + '</text>';
    });
    s += '<text class="an-lab" x="' + (ml + pw / 2) + '" y="' + (Ht - 3) + '" text-anchor="middle">' + esc(def.y) + ' (' + def.yu + ')</text>';
    s += '<text class="an-lab" transform="translate(11 ' + (mt + ph / 2) + ') rotate(-90)" text-anchor="middle">' + esc(def.x) + ' (' + def.xu + ')</text>';
    marks.forEach(function (m) {
      var yy = Y(m.v).toFixed(1);
      s += '<line class="rt-level" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"/><text class="rt-level-lab" x="' + (W - mr - 4) + '" y="' + (+yy - 4) + '" text-anchor="end">' + esc(m.label) + ' ' + fmt(m.v, 1) + '</text>';
    });
    var path = function (cv) {
      var p = '';
      for (var i = 0; i < cv.xs.length; i++) p += (i ? 'L' : 'M') + X(cv.ys[i]).toFixed(1) + ' ' + Y(cv.xs[i]).toFixed(1);
      return p;
    };
    if (d.kind === '2d') {
      var every = Math.max(1, Math.ceil(d.curves.length / 10));
      d.curves.forEach(function (cv, i) { if (i % every === 0 && cv !== c) s += '<path class="rt-curve faint" d="' + path(cv) + '"/>'; });
    }
    s += '<path class="rt-curve" d="' + path(c) + '"/>';
    // lookup marker
    var r = st.x == null ? null : d.kind === '2d' ? R.interp2d(d, st.opening, st.x) : R.interp(xs, ys, st.x);
    if (r && r.y != null) {
      s += '<line class="rt-guide" x1="' + ml + '" x2="' + X(r.y).toFixed(1) + '" y1="' + Y(st.x).toFixed(1) + '" y2="' + Y(st.x).toFixed(1) + '"/>' +
        '<line class="rt-guide" x1="' + X(r.y).toFixed(1) + '" x2="' + X(r.y).toFixed(1) + '" y1="' + Y(st.x).toFixed(1) + '" y2="' + (mt + ph) + '"/>' +
        '<circle class="rt-pt" cx="' + X(r.y).toFixed(1) + '" cy="' + Y(st.x).toFixed(1) + '" r="5.5"/>';
    }
    var lx = liveX();
    if (lx) {
      var rl = d.kind === '2d' ? R.interp2d(d, st.opening, lx.v) : R.interp(xs, ys, lx.v);
      if (rl.y != null) s += '<circle class="rt-livept" cx="' + X(rl.y).toFixed(1) + '" cy="' + Y(lx.v).toFixed(1) + '" r="4.5"/>';
      else if (lx.v >= yLo && lx.v <= yHi) s += '<line class="rt-live-line" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(lx.v).toFixed(1) + '" y2="' + Y(lx.v).toFixed(1) + '"/>';
    }
    s += '<rect x="' + ml + '" y="' + mt + '" width="' + pw + '" height="' + ph + '" fill="transparent"/>';
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Ht);
    svg.setAttribute('height', Ht);
    svg.innerHTML = s;
    st.geom = { Y: Y, X: X, yLo: yLo, yHi: yHi, mt: mt, ph: ph, W: W, def: def };
    var leg = '<span><i class="lg-curve"></i>' + esc(def.label) + (d.kind === '2d' ? ', opening ' + st.opening + ' ft (faint: other openings)' : '') + '</span>' +
      '<span><i class="lg-pt"></i>Lookup</span>' + (lx ? '<span><i class="lg-livept"></i>Current (LIVE)</span>' : '') +
      (marks.length ? '<span><i class="lg-level"></i>Published levels (CWMS)</span>' : '');
    var lg = st.el.querySelector('#rt-legend');
    if (lg) lg.innerHTML = leg;
  }

  function onPointer(ev) {
    var g = st.geom, c = curve(), d = st.entry && st.entry.data, svg = st.el.querySelector('#rt-chart'), tip = st.el.querySelector('#rt-tip');
    if (!g || !c || !svg) return;
    var rect = svg.getBoundingClientRect(), sc = g.W / rect.width;
    var py = (ev.clientY - rect.top) * sc;
    if (py < g.mt || py > g.mt + g.ph) { tip.hidden = true; return; }
    var v = g.yLo + (1 - (py - g.mt) / g.ph) * (g.yHi - g.yLo);
    var r = d.kind === '2d' ? R.interp2d(d, st.opening, v) : R.interp(c.xs, c.ys, v);
    if (r.y == null) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.innerHTML = fmt(v, 2) + ' ' + g.def.xu + '<br><b>' + fmtDep(r.y) + ' ' + g.def.yu + '</b>';
    var left = g.X(r.y) / sc + 12;
    if (left + tip.offsetWidth > rect.width - 4) left = g.X(r.y) / sc - tip.offsetWidth - 12;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, py / sc - 20) + 'px';
  }

  function downloadCSV() {
    var def = currentDef(), d = st.entry && st.entry.data;
    if (!d) return;
    var headers, rows = [];
    if (d.kind === '2d') {
      headers = ['Opening (ft)', def.x + ' (' + def.xu + ')', def.y + ' (' + def.yu + ')'];
      d.curves.forEach(function (cv, i) { cv.xs.forEach(function (x, k) { rows.push([d.others[i], x, cv.ys[k]]); }); });
    } else if (def.source === 'usgs') {
      headers = ['Gage height (ft)', 'Shift (ft)', 'Discharge (cfs)'];
      d.xs.forEach(function (x, i) { rows.push([x, d.shift[i], d.ys[i]]); });
    } else {
      headers = [def.x + ' (' + def.xu + ')', def.y + ' (' + def.yu + ')'];
      d.xs.forEach(function (x, i) { rows.push([x, d.ys[i]]); });
    }
    var blob = new Blob([R.toCSV(headers, rows)], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (def.source === 'usgs' ? 'usgs-' + def.site + '-exsa' : def.id.replace(/[^A-Za-z0-9._-]+/g, '_')) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ---- Events ----------------------------------------------------------------------------

  function bind(el) {
    el.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t || t.disabled) return;
      if (t.dataset.group) { st.group = t.dataset.group; st.structure = null; renderControls(); load(); return; }
      if (t.dataset.code) { st.code = t.dataset.code; st.structure = null; renderControls(); load(); return; }
      if (t.dataset.site) { st.site = t.dataset.site; renderControls(); load(); return; }
      if (t.dataset.structure) { st.structure = t.dataset.structure; renderControls(); load(); return; }
      if (t.dataset.page) { st.page += +t.dataset.page; refreshTable(); return; }
      if (t.id === 'rt-retry') { load(true); return; }
      if (t.id === 'rt-use') { var lx = liveX(); if (lx) { st.x = +lx.v.toFixed(2); el.querySelector('#rt-x').value = st.x; updateOutputs(); jump(); } return; }
      if (t.id === 'rt-jump') { jump(); return; }
      if (t.id === 'rt-csv') downloadCSV();
    });
    el.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t.id === 'rt-x') { st.x = t.value === '' ? null : +t.value; updateOutputs(); }
      if (t.id === 'rt-yin') { st.yIn = t.value === '' ? null : +t.value; updateOutputs(); }
    });
    el.addEventListener('change', function (ev) {
      if (ev.target.id === 'rt-op') { st.opening = +ev.target.value; st.page = 0; refreshTable(); updateOutputs(); }
    });
    el.addEventListener('pointermove', function (ev) { if (ev.target.closest('#rt-chart')) onPointer(ev); });
    el.addEventListener('pointerdown', function (ev) { if (ev.target.closest('#rt-chart')) onPointer(ev); });
    el.addEventListener('pointerleave', function () { var tip = el.querySelector('#rt-tip'); if (tip) tip.hidden = true; }, true);
  }

  function jump() {
    var c = curve(), i = c ? R.nearestIndex(c.xs, st.x) : -1;
    if (i >= 0) { st.page = Math.floor(i / PAGE); refreshTable(); }
  }

  function refreshTable() {
    var def = currentDef(), box = st.el.querySelector('#rt-table');
    if (box && st.entry) box.innerHTML = tableHTML(def, st.entry.data);
  }

  // Opens the USGS stage–discharge table for a gage (used by the drawdown planner's rating link).
  H.tables = {
    openUsgs: function (site) {
      st.group = 'usgs'; st.site = site; st.page = 0; st.x = null; st.yIn = null;
      if (st.el) { renderControls(); load(); }
      location.hash = '#/tables';
    }
  };

  H.views.tables = {
    title: 'Reports & Tables',
    render: function (el) {
      st.el = el;
      el.querySelector('.view-body').innerHTML =
        '<p class="hint rt-intro">Published rating tables from USACE CWMS and USGS. <b>PUBLISHED RATING, not live</b>: these are reference curves, not measurements. ' +
        'Current values marked LIVE come from the Overview feed. Not an official source.</p>' +
        '<div id="rt-controls" class="rt-controls"></div><div id="rt-body" class="rt-body"></div>';
      bind(el);
      renderControls();
      load();
      // Live values may arrive after the rating: fill the lookup with the current value once.
      document.addEventListener('hydro:data', function () {
        if (!st.entry) return;
        if (st.x == null) {
          var lx = liveX();
          if (lx) { st.x = +lx.v.toFixed(2); var c = curve(); if (c) st.page = Math.max(0, Math.floor(R.nearestIndex(c.xs, st.x) / PAGE)); }
        }
        renderBody();
      });
      if (root.ResizeObserver) {
        var lastW = 0;
        new ResizeObserver(function () {
          var w = el.querySelector('#rt-chart-wrap');
          var cw = w ? w.clientWidth : 0;
          if (cw && Math.abs(cw - lastW) > 4) { lastW = cw; drawChart(); }
        }).observe(el);
      }
    }
  };
})(typeof self !== 'undefined' ? self : this);
