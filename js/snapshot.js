/*
 * Hourly Snapshot strip, shown at the top of every page: the values Chris records each hour.
 *
 *   Hills Creek    Elev (forebay)   HCR.Elev-Forebay.Inst.0.0.MIXED-REV          USACE CWMS
 *                  Tailwater        HCR.Elev-Tailwater.Inst.0.0.MIXED-REV        CWMS lists it, returns no public values
 *                  HCRO             USGS 14145500 MF Willamette abv Salt Crk (00060 cfs, 00065 ft)
 *   Lookout Point  Elev (forebay)   LOP.Elev-Forebay.Inst.0.0.MIXED-REV          USACE CWMS
 *   Dexter         Forebay          DEX.Elev-Forebay.Inst.0.0.MIXED-REV          USACE CWMS
 *                  Tailwater        DEX.Elev-Tailwater.Inst.0.0.MIXED-REV        USACE CWMS
 *                  DEXO             USGS 14150000 MF Willamette nr Dexter (00060, 00065)
 *   Cougar         Forebay          CGR.Elev-Forebay.Inst.0.0.MIXED-REV          USACE CWMS
 *                  Tailwater        CGR.Elev-Tailwater.Inst.0.0.MIXED-REV        CWMS lists it, returns no public values
 *                  CGRO             USGS 14159500 SF McKenzie nr Rainbow (00060, 00065)
 *
 * CWMS's own HCRO/DEXO/CGRO flow series are catalogued but return no public values; the
 * same USGS gages feed them, so USGS IV is used directly (and it is ~10 min fresher).
 * Forebays also show the USGS lake gage (62614) as a cross-check: same datum, usually one
 * 15-min reading newer than CWMS.
 *
 * Refresh: every 5 minutes on the clock (:00:40, :05:40, …), on tab focus/resume, and on demand.
 * Provisional data; not an official source.
 *
 * Browser: window.HYDRO.snapshot. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? require('./data.js') : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.snapshot = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var MIN = 60 * 1000, HOUR = 60 * MIN;
  var TZ = 'America/Los_Angeles';
  var USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
  var CWMS_TS = 'https://cwms-data.usace.army.mil/cwms-data/timeseries';
  var LOOKBACK = 3 * HOUR;
  var POLL_EVERY = 5 * MIN, POLL_OFFSET = 40 * 1000;
  var AGE_OK = 45, AGE_LAG = 90;   // minutes: ≤45 OK, ≤90 LAG, beyond STALE
  var DIFF_FLAG = 0.1;             // ft: flag CWMS forebay vs USGS lake gage differences this large

  function cw(name) { return { src: 'cwms', name: name }; }
  function us(site, param) { return { src: 'usgs', site: site, param: param }; }

  var GROUPS = [
    { code: 'HCR', name: 'Hills Creek', items: [
      { key: 'HCR.elev', label: 'Elev', unit: 'ft', dec: 2, main: cw('HCR.Elev-Forebay.Inst.0.0.MIXED-REV'), check: us('14145100', '62614') },
      { key: 'HCR.tw', label: 'TW', unit: 'ft', dec: 2, main: cw('HCR.Elev-Tailwater.Inst.0.0.MIXED-REV'),
        none: 'not published publicly (CWMS lists the id, returns no values)' },
      { key: 'HCRO', label: 'HCRO', unit: 'cfs', dec: 0, main: us('14145500', '00060'), sub: us('14145500', '00065'), subUnit: 'ft' }
    ] },
    { code: 'LOP', name: 'Lookout Point', items: [
      { key: 'LOP.elev', label: 'Elev', unit: 'ft', dec: 2, main: cw('LOP.Elev-Forebay.Inst.0.0.MIXED-REV'), check: us('14149000', '62614') }
    ] },
    { code: 'DEX', name: 'Dexter', items: [
      { key: 'DEX.fb', label: 'FB', unit: 'ft', dec: 2, main: cw('DEX.Elev-Forebay.Inst.0.0.MIXED-REV'), check: us('14149500', '62614') },
      { key: 'DEX.tw', label: 'TW', unit: 'ft', dec: 2, main: cw('DEX.Elev-Tailwater.Inst.0.0.MIXED-REV') },
      { key: 'DEXO', label: 'DEXO', unit: 'cfs', dec: 0, main: us('14150000', '00060'), sub: us('14150000', '00065'), subUnit: 'ft' }
    ] },
    { code: 'CGR', name: 'Cougar', items: [
      { key: 'CGR.fb', label: 'FB', unit: 'ft', dec: 2, main: cw('CGR.Elev-Forebay.Inst.0.0.MIXED-REV'), check: us('14159400', '62614') },
      { key: 'CGR.tw', label: 'TW', unit: 'ft', dec: 2, main: cw('CGR.Elev-Tailwater.Inst.0.0.MIXED-REV'),
        none: 'not published publicly (CWMS lists the id, returns no values)' },
      { key: 'CGRO', label: 'CGRO', unit: 'cfs', dec: 0, main: us('14159500', '00060'), sub: us('14159500', '00065'), subUnit: 'ft' }
    ] }
  ];

  function allItems() { return [].concat.apply([], GROUPS.map(function (g) { return g.items; })); }
  function specs() {
    var out = [];
    allItems().forEach(function (it) { ['main', 'sub', 'check'].forEach(function (k) { if (it[k]) out.push(it[k]); }); });
    return out;
  }
  function specKey(s) { return s.src === 'cwms' ? 'cwms:' + s.name : 'usgs:' + s.site + ':' + s.param; }

  // ---- Pure helpers (tested in check.js) ------------------------------------------

  // Most recent top of the hour at or before `now` (Pacific offsets are whole hours).
  function topOfHour(now) { return Math.floor(now / HOUR) * HOUR; }

  // Next poll time: the next 5-minute mark on the clock plus a 40 s offset.
  function nextPollAt(now) {
    var n = Math.floor((now - POLL_OFFSET) / POLL_EVERY) * POLL_EVERY + POLL_EVERY + POLL_OFFSET;
    return n <= now ? n + POLL_EVERY : n;
  }

  function latest(s) { return s && s.t.length ? { t: s.t[s.t.length - 1], v: s.v[s.v.length - 1] } : null; }

  // Exact reading stamped at time t, or null.
  function exactAt(s, t) {
    if (!s) return null;
    for (var i = s.t.length - 1; i >= 0; i--) {
      if (s.t[i] === t) return { t: t, v: s.v[i] };
      if (s.t[i] < t) break;
    }
    return null;
  }

  // The ":00 value": this hour's top-of-hour reading if published, else the previous hour's (pending: true).
  function hourValue(s, now) {
    var h = topOfHour(now), a = exactAt(s, h);
    if (a) return { t: h, v: a.v, pending: false };
    var b = exactAt(s, h - HOUR);
    return { t: h, prevT: h - HOUR, v: b ? b.v : null, pending: true };
  }

  function ageClass(t, now) {
    if (t == null) return 'none';
    var m = (now - t) / MIN;
    return m <= AGE_OK ? 'ok' : m <= AGE_LAG ? 'lag' : 'stale';
  }

  function parseCwms(j) {
    var rows = ((j && j.values) || []).filter(function (r) { return r && r[1] != null && isFinite(r[1]); });
    rows.sort(function (a, b) { return a[0] - b[0]; });
    return { t: rows.map(function (r) { return r[0]; }), v: rows.map(function (r) { return +r[1]; }) };
  }

  // USGS IV JSON -> { 'usgs:<site>:<param>': {t, v} }
  function parseUsgs(j) {
    var out = {};
    ((j && j.value && j.value.timeSeries) || []).forEach(function (ts) {
      var site = ts.sourceInfo.siteCode[0].value, code = ts.variable.variableCode[0].value, nd = ts.variable.noDataValue;
      var s = { t: [], v: [] };
      (ts.values || []).forEach(function (b) {
        (b.value || []).forEach(function (p) {
          var v = parseFloat(p.value), t = Date.parse(p.dateTime);
          if (isFinite(v) && isFinite(t) && v !== nd && v > -999999) { s.t.push(t); s.v.push(v); }
        });
      });
      s.t.length && (out['usgs:' + site + ':' + code] = s);
    });
    return out;
  }

  function cwmsUrl(name, begin, end) {
    return CWMS_TS + '?office=NWDP&unit=EN&name=' + encodeURIComponent(name) + '&begin=' + new Date(begin).toISOString() +
      '&end=' + new Date(end).toISOString() + '&page-size=500';
  }
  function usgsUrl() {
    var sites = {}, params = {};
    specs().forEach(function (s) { if (s.src === 'usgs') { sites[s.site] = 1; params[s.param] = 1; } });
    return USGS_IV + '?format=json&sites=' + Object.keys(sites).join(',') + '&parameterCd=' + Object.keys(params).join(',') + '&period=PT3H&siteStatus=all';
  }

  // ---- Loading ----------------------------------------------------------------------

  var state = { series: {}, errors: {}, fetchedAt: null, fetching: false, nextAt: null, timer: 0, el: null, copied: null };

  // Never rejects. Keeps the last good series when one request fails (it then ages honestly).
  function load(now) {
    now = now || Date.now();
    var fj = H.http.fetchJson, jobs = [];
    var cwNames = {};
    specs().forEach(function (s) { if (s.src === 'cwms') cwNames[s.name] = 1; });
    Object.keys(cwNames).forEach(function (n) {
      jobs.push(fj(cwmsUrl(n, now - LOOKBACK, now + 5 * MIN), { headers: { Accept: H.http.cwmsAccept } }, 20000, 3).then(function (j) {
        state.series['cwms:' + n] = parseCwms(j); delete state.errors['cwms:' + n];
      }, function (e) { state.errors['cwms:' + n] = e.message || 'failed'; }));
    });
    jobs.push(fj(usgsUrl(), {}, 20000, 3).then(function (j) {
      var p = parseUsgs(j);
      specs().forEach(function (s) {
        if (s.src !== 'usgs') return;
        var k = specKey(s);
        if (p[k]) { state.series[k] = p[k]; delete state.errors[k]; } else if (!state.series[k]) state.errors[k] = 'no data';
      });
    }, function (e) { state.errors.usgs = e.message || 'failed'; }));
    return Promise.all(jobs).then(function () { state.fetchedAt = Date.now(); return state; });
  }

  // Row model for one item at `now`.
  function itemModel(it, now) {
    var s = state.series[specKey(it.main)], L = latest(s);
    var m = { it: it, latest: L, hour: s ? hourValue(s, now) : null, age: ageClass(L && L.t, now), err: state.errors[specKey(it.main)] };
    if (it.sub) { var ss = state.series[specKey(it.sub)]; m.sub = latest(ss); m.subHour = ss ? hourValue(ss, now) : null; }
    if (it.check) m.check = latest(state.series[specKey(it.check)]);
    return m;
  }

  // ---- Rendering --------------------------------------------------------------------

  var fHM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var fHMS = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  var fZone = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' });
  function hm(t) { return fHM.format(new Date(t)).replace(/^24/, '00'); }
  function zone(t) { var p = fZone.formatToParts(new Date(t)).filter(function (x) { return x.type === 'timeZoneName'; })[0]; return p ? p.value : 'PT'; }
  function fmt(v, d) { return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function srcText(s) { return s.src === 'cwms' ? 'USACE CWMS ' + s.name : 'USGS ' + s.site + ' (' + s.param + ')'; }

  var AGE_TXT = { ok: '', lag: 'LAG', stale: 'STALE', none: '' };

  function cellHTML(m, now) {
    var it = m.it, h = '<div class="snap-cell ' + m.age + '" title="' + esc(srcText(it.main) + (it.sub ? ' · stage ' + srcText(it.sub) : '')) + '">';
    h += '<span class="snap-lab">' + esc(it.label) + '</span>';
    if (!m.latest) {
      var why = it.none || (m.err ? 'unavailable (' + m.err + ')' : state.fetchedAt ? 'no data in last 3 h' : 'loading…');
      return h + '<span class="snap-na">' + (it.none ? 'n/a' : state.fetchedAt ? 'no data' : '…') + '</span><span class="snap-why">' + esc(why) + '</span></div>';
    }
    var age = Math.max(0, Math.round((now - m.latest.t) / MIN));
    h += '<span class="snap-val mono">' + fmt(m.latest.v, it.dec) + '<span class="unit">' + it.unit + '</span></span>';
    if (m.sub) h += '<span class="snap-subval mono">' + fmt(m.sub.v, 2) + ' ' + it.subUnit + ' stage</span>';
    h += '<span class="snap-time mono">latest ' + hm(m.latest.t) + ' · ' + age + 'm' + (AGE_TXT[m.age] ? ' <b class="snap-age">' + AGE_TXT[m.age] + '</b>' : '') + '</span>';
    var hv = m.hour;
    if (hv) {
      h += '<span class="snap-hour mono">' + (hv.pending
        ? '<span class="snap-pend">' + hm(hv.t) + ' pending</span>' + (hv.v != null ? ' · ' + hm(hv.prevT) + ' → ' + fmt(hv.v, it.dec) : '')
        : '<b>' + hm(hv.t) + ' → ' + fmt(hv.v, it.dec) + '</b>' + (m.subHour && !m.subHour.pending && m.subHour.v != null ? ' · ' + fmt(m.subHour.v, 2) + ' ft' : '')) + '</span>';
    }
    if (m.check) {
      var dv = m.latest.v - m.check.v, big = Math.abs(dv) >= DIFF_FLAG;
      h += '<span class="snap-check mono' + (big ? ' diff' : '') + '" title="USGS lake gage ' + esc(it.check.site) + ', parameter 62614 (same datum). ' +
        (big ? 'CWMS and USGS differ by ' + fmt(Math.abs(dv), 2) + ' ft: CWMS MIXED-REV can switch sensors; check both.' : '') + '">USGS ' + hm(m.check.t) + ' ' + fmt(m.check.v, 2) +
        (big ? ' · Δ' + (dv > 0 ? '+' : '−') + fmt(Math.abs(dv), 2) : '') + '</span>';
    }
    return h + '</div>';
  }

  // Text copied for one group: the :00 values when published, otherwise latest (labelled).
  function groupText(g, now) {
    var h = topOfHour(now), parts = [];
    g.items.forEach(function (it) {
      var m = itemModel(it, now);
      if (!m.latest) { parts.push(it.label + ' n/a'); return; }
      var useHour = m.hour && !m.hour.pending && m.hour.v != null;
      var v = useHour ? m.hour.v : m.latest.v, t = useHour ? m.hour.t : m.latest.t;
      var s = it.label + ' ' + fmt(v, it.dec) + ' ' + it.unit;
      if (it.sub) {
        var sv = useHour && m.subHour && !m.subHour.pending ? m.subHour.v : m.sub && m.sub.v;
        if (sv != null) s += ' (' + fmt(sv, 2) + ' ft)';
      }
      if (!useHour) s += ' [latest ' + hm(t) + ']';
      parts.push(s);
    });
    return g.name + ' ' + hm(h) + ' ' + zone(h) + ': ' + parts.join(', ');
  }

  function render() {
    var el = state.el;
    if (!el) return;
    var now = Date.now();
    var head = '<div class="snap-head"><h2>Hourly Snapshot</h2>' +
      '<span class="snap-meta mono">' + (state.fetching ? 'updating…' : state.fetchedAt ? 'updated ' + fHMS.format(new Date(state.fetchedAt)).replace(/^24/, '00') : 'loading…') +
      (state.nextAt && !state.fetching ? ' · next ' + hm(state.nextAt) : '') + ' · every 5 min</span>' +
      '<span class="snap-btns"><button type="button" class="btn snap-btn" data-snap="copy-all">Copy all</button>' +
      '<button type="button" class="btn snap-btn" data-snap="refresh"' + (state.fetching ? ' disabled' : '') + '>↻</button></span></div>';
    var body = GROUPS.map(function (g) {
      return '<div class="snap-group" data-group="' + g.code + '"><div class="snap-gh"><span class="snap-gname">' + esc(g.name) + '</span>' +
        '<button type="button" class="snap-copy" data-snap="copy" data-code="' + g.code + '" aria-label="Copy ' + esc(g.name) + ' values">' +
        (state.copied === g.code ? 'copied ✓' : 'copy') + '</button></div>' +
        '<div class="snap-cells">' + g.items.map(function (it) { return cellHTML(itemModel(it, now), now); }).join('') + '</div></div>';
    }).join('');
    el.innerHTML = head + '<div class="snap-grid">' + body + '</div>' +
      '<p class="snap-foot">LIVE · provisional. <b>latest</b> = newest published reading. <b class="snap-hl">hh:00 → value</b> = the reading stamped exactly at the top of the hour (CWMS usually posts it 15–35 min later, USGS 5–15 min); “pending” until it is published. ' +
      'Elevations ft, flows cfs (USGS gages 14145500 / 14150000 / 14159500). “USGS” under a forebay is the USGS lake gage, same datum, as a cross-check (Δ shown when they differ by ≥ ' + DIFF_FLAG + ' ft). ' +
      'Copy puts the :00 values (or latest, labelled) on the clipboard. HCR and CGR tailwater are not published publicly by CWMS.</p>';
  }

  function schedule() {
    clearTimeout(state.timer);
    state.nextAt = nextPollAt(Date.now());
    state.timer = setTimeout(refresh, state.nextAt - Date.now());
  }

  function refresh() {
    if (state.fetching) return Promise.resolve(state);
    state.fetching = true;
    render();
    return load().then(function () {
      state.fetching = false;
      schedule();
      render();
      if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('hydro:snapshot'));
      return state;
    });
  }

  function copy(text, code) {
    var done = function () { state.copied = code; render(); setTimeout(function () { state.copied = null; render(); }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function init(el) {
    state.el = el;
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-snap]');
      if (!b) return;
      var a = b.getAttribute('data-snap'), now = Date.now();
      if (a === 'refresh') refresh();
      else if (a === 'copy') { var g = GROUPS.filter(function (x) { return x.code === b.getAttribute('data-code'); })[0]; if (g) copy(groupText(g, now), g.code); }
      else if (a === 'copy-all') copy(GROUPS.map(function (g) { return groupText(g, now); }).join('\n'), 'ALL');
    });
    // Phones suspend timers in background tabs: refresh on return when the data is older than 2 min.
    var wake = function () {
      if (document.visibilityState === 'visible' && (!state.fetchedAt || Date.now() - state.fetchedAt > 2 * MIN)) refresh();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    // Age counters tick every 30 s; a missed timer is caught here too.
    setInterval(function () {
      if (state.nextAt && Date.now() > state.nextAt + 30 * 1000 && !state.fetching) refresh(); else render();
    }, 30 * 1000);
    render();
    return refresh();
  }

  if (typeof document !== 'undefined') {
    var boot = function () { var el = document.getElementById('snapshot'); if (el) init(el); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }

  return {
    GROUPS: GROUPS, POLL_EVERY: POLL_EVERY, AGE_OK: AGE_OK, AGE_LAG: AGE_LAG,
    topOfHour: topOfHour, nextPollAt: nextPollAt, exactAt: exactAt, hourValue: hourValue, ageClass: ageClass,
    parseCwms: parseCwms, parseUsgs: parseUsgs, usgsUrl: usgsUrl, cwmsUrl: cwmsUrl, specKey: specKey,
    load: load, itemModel: itemModel, groupText: groupText, state: state, init: init, refresh: refresh
  };
});
