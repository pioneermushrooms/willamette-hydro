/*
 * Storage / Drawdown Calculator view (#/calc). Math in js/drawdown.js; elevation–storage
 * from the published CWMS rating (js/ratings.js, cached 7 days); current pool, outflow and
 * computed inflow from HYDRO.live; rule curve from CWMS for the planning window.
 * PLANNING AID — verify against the water control manual and current operating orders.
 */
(function (root) {
  'use strict';
  var H = root.HYDRO, R = H.ratings, D = H.drawdown;
  H.views = H.views || {};

  var TZ = 'America/Los_Angeles';
  var HOUR = 3600 * 1000, DAY = 24 * HOUR;
  var byCode = {};
  H.projects.forEach(function (p) { byCode[p.code] = p; });

  var st = { el: null, code: 'LOP', rating: null, ratingInfo: null, ratingErr: null, token: 0, rule: null, plan: null };

  // ---- Formatting ------------------------------------------------------------

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n, d) { return n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  var fStamp = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function stamp(t) { return t == null ? '—' : fStamp.format(new Date(t)); }
  var fParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function wall(t) { var o = {}; fParts.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; }); return o.year + '-' + o.month + '-' + o.day + 'T' + (o.hour === '24' ? '00' : o.hour) + ':' + o.minute; }
  // "YYYY-MM-DDTHH:MM" read as Pacific wall-clock time -> epoch ms (null if invalid).
  function pacific(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(str || '');
    if (!m) return null;
    for (var off = 7; off <= 8; off++) {
      var t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4] + off, +m[5]);
      if (wall(t) === m[0].slice(0, 16)) return t;
    }
    return null;
  }
  function val(id) { var el = st.el.querySelector('#' + id); return el ? el.value.trim() : ''; }
  function numv(id) { var v = val(id).replace(/,/g, ''); return v === '' || !isFinite(+v) ? null : +v; }

  // ---- Live values -----------------------------------------------------------

  function live(code) {
    var p = byCode[code], snap = H.live && H.live.snap, d = snap && snap.projects[p.id];
    var L = function (k) { return d && H.latest(d[k]); };
    return { elev: L('elev'), out: L('out'), inflow: L('inflow'), rule: d && d.rule };
  }

  // ---- Rating ------------------------------------------------------------------

  function loadRating() {
    var tok = ++st.token, def = R.cwmsDefs('storage', st.code)[0];
    st.rating = null; st.ratingErr = null; st.ratingInfo = null;
    renderRating();
    R.load(def).then(function (e) {
      if (tok !== st.token) return;
      var d = e.data;
      if (d.kind !== '1d') throw new Error('unexpected rating shape');
      if (d.units && !/^ft;ac-ft$/i.test(d.units)) throw new Error('rating units are ' + d.units + ', expected ft;ac-ft');
      st.rating = D.makeRating(d.xs, d.ys);
      st.ratingInfo = { id: def.id, effective: d.effective, n: d.xs.length, url: e.url };
      renderRating();
    }).catch(function (err) {
      if (tok !== st.token) return;
      st.ratingErr = err.message || 'failed';
      renderRating();
    });
  }

  function renderRating() {
    var el = st.el.querySelector('#dd-rating');
    if (!el) return;
    if (st.ratingErr) { el.innerHTML = '<span class="badge err">Elevation–storage table unavailable</span> <span class="na">' + esc(st.ratingErr) + '</span>'; return; }
    if (!st.rating) { el.innerHTML = '<span class="na loading">Loading elevation–storage table…</span>'; return; }
    var r = st.rating, i = st.ratingInfo;
    el.innerHTML = '<span class="badge plain">PUBLISHED RATING (CWMS)</span> <span class="mono">' + esc(i.id) + '</span> · ' + i.n + ' points · ' +
      fmt(r.elevMin, 2) + '–' + fmt(r.elevMax, 2) + ' ft ↔ ' + fmt(r.storMin) + '–' + fmt(r.storMax) + ' ac-ft · linear interpolation';
  }

  // ---- Layout ------------------------------------------------------------------

  function field(id, label, attrs, hint) {
    return '<label class="field dd-f"><span class="field-label">' + label + '</span><input id="' + id + '" ' + (attrs || 'inputmode="decimal"') + '>' +
      (hint ? '<span class="dd-hint">' + hint + '</span>' : '') + '</label>';
  }

  function render() {
    var lv = live(st.code), p = byCode[st.code];
    var now = Date.now(), start = Math.ceil(now / HOUR) * HOUR;
    st.el.querySelector('.view-body').innerHTML =
      '<div class="dd-label" role="note"><span class="notice-icon" aria-hidden="true">!</span>' + esc(D.LABEL) + '</div>' +
      '<div class="tc-chips" role="group" aria-label="Project">' + H.projects.map(function (x) {
        return '<button type="button" class="chip" data-code="' + x.code + '" aria-pressed="' + (x.code === st.code) + '">' + esc(x.name) + '</button>';
      }).join('') + '</div>' +
      '<p class="dd-rating" id="dd-rating"></p>' +
      '<p class="dd-live mono">' + esc(p.name) + ' now: pool ' + (lv.elev ? fmt(lv.elev.v, 2) + ' ft' : '—') + ' · outflow ' + (lv.out ? fmt(lv.out.v) + ' cfs' : '—') +
      ' · computed inflow ' + (lv.inflow ? fmt(lv.inflow.v) + ' cfs' : '—') + (lv.elev ? ' · ' + esc(stamp(lv.elev.t)) : H.live ? '' : ' · loading live data…') + '</p>' +

      // Calculator 1
      '<section class="panel dd-panel"><div class="panel-head"><h2>1 · Volume / Flow / Time</h2><span class="panel-tag mono">ENTER ANY TWO</span></div>' +
      '<div class="dd-grid">' +
      field('c1-vol', 'Volume change (ac-ft)', 'inputmode="decimal" placeholder="e.g. 1000"', '+ = net release') +
      field('c1-net', 'Net flow (cfs)', 'inputmode="decimal" placeholder="outflow − inflow"', 'or enter outflow and inflow') +
      field('c1-out', 'Outflow (cfs)', 'inputmode="decimal"') +
      field('c1-in', 'Inflow (cfs)', 'inputmode="decimal"') +
      field('c1-hr', 'Duration (hr)', 'inputmode="decimal"') +
      field('c1-e0', 'Starting elevation (ft, optional)', 'inputmode="decimal" value="' + (lv.elev ? lv.elev.v.toFixed(2) : '') + '"', 'gives the elevation change') +
      '</div><div class="dd-actions"><button type="button" class="btn" id="c1-go">Calculate</button></div>' +
      '<div class="dd-out" id="c1-out-box" aria-live="polite"></div></section>' +

      // Calculator 2
      '<section class="panel dd-panel"><div class="panel-head"><h2>2 · Target Drawdown Planner</h2><span class="panel-tag mono">RAMP-LIMITED</span></div>' +
      '<div class="dd-grid">' +
      field('c2-e0', 'Current elevation (ft)', 'inputmode="decimal" value="' + (lv.elev ? lv.elev.v.toFixed(2) : '') + '"') +
      field('c2-t0', 'Start (Pacific)', 'type="datetime-local" step="900" value="' + wall(start) + '"') +
      '<label class="field dd-f"><span class="field-label">Target as</span><select id="c2-tk"><option value="elev">Elevation (ft)</option><option value="stor">Storage (ac-ft)</option></select></label>' +
      field('c2-tv', 'Target value', 'inputmode="decimal"') +
      field('c2-t1', 'Target time (Pacific)', 'type="datetime-local" step="900" value="' + wall(start + 2 * DAY) + '"') +
      '<div class="field dd-f"><span class="field-label">&nbsp;</span><button type="button" class="btn" id="c2-rule">Target = rule curve at target time</button><span class="dd-hint" id="c2-rule-msg"></span></div>' +
      field('c2-q0', 'Current outflow Q0 (cfs)', 'inputmode="decimal" value="' + (lv.out ? Math.round(lv.out.v) : '') + '"') +
      '<label class="field dd-f"><span class="field-label">Inflow</span><select id="c2-im"><option value="const">Constant</option><option value="series">Hourly series (paste)</option></select></label>' +
      field('c2-ic', 'Inflow (cfs, constant)', 'inputmode="decimal" value="' + (lv.inflow ? Math.max(0, Math.round(lv.inflow.v)) : '') + '"', lv.inflow ? 'default: latest USACE computed inflow' : '') +
      '<label class="field dd-f dd-wide" id="c2-is-wrap" hidden><span class="field-label">Hourly inflow (cfs), one value per line from the start time</span><textarea id="c2-is" rows="4" placeholder="900&#10;920&#10;950"></textarea></label>' +
      field('c2-ru', 'Max ramp-up (cfs/hr)', 'inputmode="decimal" value="100"') +
      field('c2-rd', 'Max ramp-down (cfs/hr)', 'inputmode="decimal" value="100"') +
      field('c2-qmin', 'Min outflow (cfs)', 'inputmode="decimal"', 'minimum flow requirement') +
      field('c2-qmax', 'Max outflow (cfs)', 'inputmode="decimal"', 'powerhouse + allowed spill') +
      field('c2-qe', 'Ending outflow Q_end (cfs)', 'inputmode="decimal" placeholder="= inflow at target time"', 'blank: inflow at the target time, so the pool holds') +
      '<label class="field dd-f"><span class="field-label">Time step</span><select id="c2-dt"><option value="1">1 hr</option><option value="0.5">30 min</option><option value="0.25">15 min</option></select></label>' +
      '<label class="field dd-f"><span class="field-label">Round plateau to</span><select id="c2-rt"><option value="">No rounding</option><option value="25">25 cfs</option><option value="50">50 cfs</option><option value="100">100 cfs</option></select></label>' +
      '</div><div class="dd-actions"><button type="button" class="btn" id="c2-go">Plan drawdown</button></div>' +
      '<div class="dd-out" id="c2-out-box" aria-live="polite"></div></section>';
    renderRating();
  }

  // ---- Calculator 1 --------------------------------------------------------------

  function runC1() {
    var box = st.el.querySelector('#c1-out-box');
    try {
      var e0 = numv('c1-e0');
      if (e0 != null && !st.rating) throw new Error(st.ratingErr ? 'Elevation–storage table unavailable: ' + st.ratingErr : 'Elevation–storage table still loading.');
      var r = D.convert({ volume: numv('c1-vol'), netFlow: numv('c1-net'), outflow: numv('c1-out'), inflow: numv('c1-in'), hours: numv('c1-hr'), startElev: e0, rating: st.rating });
      box.innerHTML = '<dl class="dd-sum mono">' +
        '<div><dt>Volume</dt><dd>' + fmt(r.volume, 1) + ' ac-ft</dd></div>' +
        '<div><dt>Net flow</dt><dd>' + fmt(r.netFlow, 1) + ' cfs</dd></div>' +
        '<div><dt>Duration</dt><dd>' + fmt(r.hours, 2) + ' hr</dd></div>' +
        (r.elev ? '<div><dt>Elevation</dt><dd>' + fmt(r.elev.start, 2) + ' → ' + fmt(r.elev.end, 2) + ' ft (' + (r.elev.change >= 0 ? '+' : '−') + fmt(Math.abs(r.elev.change), 2) + ')</dd></div>' : '') +
        '</dl><ol class="dd-steps mono">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' + labelLine();
    } catch (err) {
      box.innerHTML = '<p class="dd-err">' + esc(err.message) + '</p>';
    }
  }

  function labelLine() { return '<p class="dd-plabel">' + esc(D.LABEL) + '</p>'; }

  // ---- Calculator 2 --------------------------------------------------------------

  // Rule curve for [t0, t1] from CWMS (daily values, linearly joined like the rest of the site).
  function ruleFor(t0, t1) {
    var p = byCode[st.code], key = st.code + ':' + t0 + ':' + t1;
    if (st.rule && st.rule.key === key) return Promise.resolve(st.rule.s);
    return H.fetchCwms(p.series.rule, t0 - 2 * DAY, t1 + 2 * DAY).then(function (s) { st.rule = { key: key, s: s }; return s; });
  }

  function useRule() {
    var msg = st.el.querySelector('#c2-rule-msg'), t1 = pacific(val('c2-t1')), t0 = pacific(val('c2-t0'));
    if (t1 == null) { msg.textContent = 'Set the target time first.'; return; }
    msg.textContent = 'Loading rule curve…';
    ruleFor(t0 || t1, t1).then(function (s) {
      var v = H.interpolate(s, t1);
      if (v == null) { msg.textContent = 'No rule-curve value published for that time.'; return; }
      st.el.querySelector('#c2-tk').value = 'elev';
      st.el.querySelector('#c2-tv').value = v.toFixed(2);
      msg.textContent = 'Rule curve ' + fmt(v, 2) + ' ft at ' + stamp(t1) + ' (' + byCode[st.code].series.rule.name + ')';
    }, function (e) { msg.textContent = 'Rule curve unavailable: ' + e.message; });
  }

  function runC2() {
    var box = st.el.querySelector('#c2-out-box');
    var fail = function (m) { box.innerHTML = '<p class="dd-err">' + esc(m) + '</p>'; };
    if (!st.rating) return fail(st.ratingErr ? 'Elevation–storage table unavailable: ' + st.ratingErr : 'Elevation–storage table still loading.');
    var t0 = pacific(val('c2-t0')), t1 = pacific(val('c2-t1'));
    if (t0 == null || t1 == null) return fail('Enter the start and target times.');
    var opts;
    try {
      var e0 = numv('c2-e0'), tv = numv('c2-tv');
      if (e0 == null) throw new Error('Enter the current elevation.');
      if (tv == null) throw new Error('Enter a target elevation or storage.');
      var inflow;
      if (val('c2-im') === 'series') {
        inflow = D.parseSeries(val('c2-is'));
        if (!inflow.length) throw new Error('Paste at least one hourly inflow value.');
      } else {
        inflow = numv('c2-ic');
        if (inflow == null) throw new Error('Enter the inflow.');
      }
      var St = val('c2-tk') === 'stor' ? tv : st.rating.stor(tv);
      if (val('c2-tk') === 'stor') st.rating.elev(St); // range check
      opts = {
        rating: st.rating, S0: st.rating.stor(e0), St: St, t0: t0, tEnd: t1, Q0: numv('c2-q0'), inflow: inflow,
        ru: numv('c2-ru'), rd: numv('c2-rd'), Qmin: numv('c2-qmin'), Qmax: numv('c2-qmax'), Qend: numv('c2-qe'),
        dtHr: +val('c2-dt'), roundTo: numv('c2-rt')
      };
      if (opts.Qmin == null) throw new Error('Enter the minimum outflow.');
      st.plan = D.plan(opts);
    } catch (err) { return fail(err.message); }
    box.innerHTML = '<p class="na loading">Loading rule curve…</p>';
    var r = st.plan;
    ruleFor(t0, t1).then(function (s) { return s; }, function () { return null; }).then(function (rule) {
      if (st.plan !== r) return;
      r.schedule.forEach(function (row) { row.rule = rule ? H.interpolate(rule, row.t) : null; });
      renderPlan(r, !!(rule && rule.t.length));
    });
  }

  var STATUS = {
    ok: ['ok', 'FEASIBLE'], 'infeasible-max': ['err', 'NOT REACHABLE BY DEADLINE'],
    'infeasible-min': ['warn', 'OVERSHOOTS BELOW TARGET'], 'ramp-window': ['err', 'RAMPS EXCEED WINDOW']
  };

  function renderPlan(r, hasRule) {
    var box = st.el.querySelector('#c2-out-box'), s = STATUS[r.status];
    var kv = function (k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; };
    var h = '<p class="dd-status"><span class="badge ' + s[0] + '">' + s[1] + '</span>' + (r.belowMin.length ? ' <span class="badge warn">BELOW MIN OUTFLOW</span>' : '') + '</p>';
    h += '<p class="dd-plain">' + esc(r.plain) + '</p>';
    if (r.messages.length) h += '<ul class="dd-msgs">' + r.messages.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
    h += '<dl class="dd-sum mono">' +
      kv('Plateau flow', r.Qp == null ? '—' : fmt(r.Qp, r.Qp % 1 ? 1 : 0) + ' cfs') +
      kv('Plateau reached', stamp(r.tPlateau)) +
      kv('Begin ramp-down', stamp(r.tRampDown)) +
      kv('Ending outflow', fmt(r.Qend) + ' cfs' + (r.QendDefault ? ' (inflow at target)' : '')) +
      kv('Final elevation', fmt(r.Efinal, 2) + ' ft') +
      kv('Final storage', fmt(r.Sfinal) + ' ac-ft (target ' + fmt(r.St) + ')') +
      kv('Total released', fmt(r.released) + ' ac-ft') +
      kv('Net drawdown', fmt(r.netReleased) + ' ac-ft') +
      (r.status === 'infeasible-max' ? kv('Elevation at deadline', fmt(r.Efinal, 2) + ' ft') + kv('Earliest time for target', r.earliest ? stamp(r.earliest) : 'not within 90 days') : '') +
      '</dl>';
    h += '<h3 class="dd-ch">Elevation' + (hasRule ? ' vs rule curve' : '') + ' (ft)</h3>' + chart(r, 'elev', hasRule);
    h += '<h3 class="dd-ch">Outflow / inflow (cfs)</h3>' + chart(r, 'flow');
    var below = {};
    r.belowMin.forEach(function (i) { below[i] = true; });
    var rows = r.schedule.map(function (x, i) {
      return '<tr' + (below[i] ? ' class="dd-below"' : '') + '><td>' + stamp(x.t) + '</td><td>' + fmt(x.O) + '</td><td>' + fmt(x.I) + '</td><td>' + fmt(x.net) + '</td><td>' + fmt(x.S) + '</td><td>' + fmt(x.E, 2) + '</td>' +
        (hasRule ? '<td>' + fmt(x.rule, 2) + '</td>' : '') + '</tr>';
    }).join('');
    h += '<div class="rt-table-head"><h3 class="dd-ch">Schedule (' + (r.dtHr === 1 ? 'hourly' : r.dtHr * 60 + '-min') + ')</h3><button type="button" class="btn" id="c2-csv">Download CSV</button></div>' +
      '<div class="table-scroll dd-table"><table><thead><tr><th>Time (PT)</th><th>Outflow cfs</th><th>Inflow cfs</th><th>Net cfs</th><th>Storage ac-ft</th><th>Elev ft</th>' + (hasRule ? '<th>Rule curve ft</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    h += '<p class="hint">Outflow is held for each step from its start time; storage S[i+1] = S[i] + (I − O) × 0.082645 × Δt hr. Elevations from the CWMS elevation–storage table.' + (hasRule ? ' Rule curve: ' + esc(byCode[st.code].series.rule.name) + ', daily, linearly joined.' : ' Rule curve not available for this window.') + '</p>' + labelLine();
    box.innerHTML = h;
  }

  function csv() {
    var r = st.plan;
    if (!r) return;
    var rows = r.schedule.map(function (x) { return [wall(x.t).replace('T', ' '), Math.round(x.O), Math.round(x.I), Math.round(x.net), Math.round(x.S), x.E == null ? '' : x.E.toFixed(2), x.rule == null ? '' : x.rule.toFixed(2)]; });
    rows.push([D.LABEL]);
    var text = R.toCSV(['time_pt', 'outflow_cfs', 'inflow_cfs', 'net_cfs', 'storage_acft', 'elev_ft', 'rule_curve_ft'], rows);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = st.code + '-drawdown-plan.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- Charts (inline SVG, same palette as the Trend Recorder) ----------------------

  function niceStep(span, n) { var raw = span / n, m = Math.pow(10, Math.floor(Math.log10(raw))), x = raw / m; return (x < 1.5 ? 1 : x < 3 ? 2 : x < 7 ? 5 : 10) * m; }

  function chart(r, kind, hasRule) {
    var rows = r.schedule, W = Math.max(300, Math.min(1100, (st.el.querySelector('#c2-out-box').clientWidth || 700) - 4)), Hh = 220;
    var lines = kind === 'elev'
      ? [{ v: rows.map(function (x) { return x.E; }), cls: 'dd-l-elev' }].concat(hasRule ? [{ v: rows.map(function (x) { return x.rule; }), cls: 'dd-l-rule' }] : [])
        .concat([{ v: rows.map(function () { return st.rating.elev(r.St); }), cls: 'dd-l-target' }])
      : [{ v: rows.map(function (x) { return x.O; }), cls: 'dd-l-out' }, { v: rows.map(function (x) { return x.I; }), cls: 'dd-l-in' }];
    var all = [].concat.apply([], lines.map(function (l) { return l.v; })).filter(function (v) { return v != null && isFinite(v); });
    if (!all.length) return '<p class="na">No values to chart.</p>';
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.1;
    lo -= pad; hi += pad;
    var step = niceStep(hi - lo, 4), dec = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
    var ml = 12 + 7 * fmt(hi, dec).length, mr = 12, mt = 10, mb = 24, pw = W - ml - mr, ph = Hh - mt - mb;
    var t0 = rows[0].t, t1 = rows[rows.length - 1].t;
    var x = function (t) { return ml + ((t - t0) / (t1 - t0 || 1)) * pw; }, y = function (v) { return mt + (1 - (v - lo) / (hi - lo)) * ph; };
    var s = '<g class="axis">';
    for (var v = Math.ceil(lo / step) * step; v <= hi; v += step) s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text x="' + (ml - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, dec) + '</text>';
    var spanH = (t1 - t0) / HOUR, every = spanH <= 36 ? 6 : spanH <= 96 ? 12 : 24 * Math.ceil(spanH / 24 / 8);
    for (var tt = Math.ceil(t0 / HOUR) * HOUR; tt <= t1; tt += HOUR) {
      var w = wall(tt), hr = +w.slice(11, 13);
      if (hr % Math.min(every, 24) || (every > 24 && Math.round((tt - t0) / DAY) % (every / 24))) continue;
      var lab = hr === 0 ? w.slice(5, 10).replace('-', '/') : w.slice(11, 16);
      s += '<line x1="' + x(tt).toFixed(1) + '" x2="' + x(tt).toFixed(1) + '" y1="' + mt + '" y2="' + (mt + ph) + '" style="opacity:.5"/><text x="' + x(tt).toFixed(1) + '" y="' + (Hh - 7) + '" text-anchor="middle">' + lab + '</text>';
    }
    s += '</g>';
    lines.forEach(function (l) {
      var d = '', pen = false;
      l.v.forEach(function (v, i) { if (v == null || !isFinite(v)) { pen = false; return; } d += (pen ? 'L' : 'M') + x(rows[i].t).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
      s += '<path class="' + l.cls + '" d="' + d + '"/>';
    });
    var legend = kind === 'elev'
      ? '<span><i class="dd-k-elev"></i>Planned elevation</span>' + (hasRule ? '<span><i class="dd-k-rule"></i>USACE rule curve</span>' : '') + '<span><i class="dd-k-target"></i>Target</span>'
      : '<span><i class="dd-k-out"></i>Planned outflow</span><span><i class="dd-k-in"></i>Inflow</span>';
    return '<div class="dd-chart"><svg viewBox="0 0 ' + W + ' ' + Hh + '" width="100%" role="img" aria-label="' + (kind === 'elev' ? 'Planned elevation' : 'Planned outflow and inflow') + ' over time">' + s + '</svg></div><div class="rt-legend">' + legend + '</div>';
  }

  // ---- Wiring --------------------------------------------------------------------

  function bind() {
    st.el.addEventListener('click', function (e) {
      var c = e.target.closest('[data-code]');
      if (c) { st.code = c.getAttribute('data-code'); st.plan = null; st.rule = null; render(); loadRating(); return; }
      if (e.target.id === 'c1-go') runC1();
      else if (e.target.id === 'c2-go') runC2();
      else if (e.target.id === 'c2-rule') useRule();
      else if (e.target.id === 'c2-csv') csv();
    });
    st.el.addEventListener('change', function (e) {
      if (e.target.id === 'c2-im') {
        var series = e.target.value === 'series';
        st.el.querySelector('#c2-is-wrap').hidden = !series;
        st.el.querySelector('#c2-ic').closest('label').hidden = series;
      }
    });
    // Fill live defaults once the first poll lands (only into fields still empty).
    document.addEventListener('hydro:data', function () {
      if (!st.el) return;
      var lv = live(st.code);
      [['c1-e0', lv.elev && lv.elev.v.toFixed(2)], ['c2-e0', lv.elev && lv.elev.v.toFixed(2)], ['c2-q0', lv.out && Math.round(lv.out.v)],
        ['c2-ic', lv.inflow && Math.max(0, Math.round(lv.inflow.v))]].forEach(function (f) {
        var el = st.el.querySelector('#' + f[0]);
        if (el && el.value === '' && f[1] != null) el.value = f[1];
      });
      var lb = st.el.querySelector('.dd-live');
      if (lb && lv.elev) lb.textContent = byCode[st.code].name + ' now: pool ' + fmt(lv.elev.v, 2) + ' ft · outflow ' + (lv.out ? fmt(lv.out.v) + ' cfs' : '—') + ' · computed inflow ' + (lv.inflow ? fmt(lv.inflow.v) + ' cfs' : '—') + ' · ' + stamp(lv.elev.t);
    });
  }

  H.views.calc = {
    title: 'Calculator',
    render: function (el) {
      st.el = el;
      render();
      bind();
      loadRating();
    },
    _pacific: pacific
  };
})(typeof self !== 'undefined' ? self : this);
