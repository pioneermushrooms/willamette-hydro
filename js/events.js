/*
 * Live event feed: what changed between two snapshots of the page's data ("tell me when something
 * happens"). Pure: detect(prev, next, now) compares two snapshots and returns new events; the UI
 * (toasts, the bell and its feed panel, desktop notifications) is js/notify.js.
 *
 *   snapshot = { at: ms (when it was taken), wx: state.wx, hz: state.hz, pw: state.pw, nwps: state.nwps, snap: state.snap }
 *   event    = { id, time, kind, level: 'info'|'watch'|'alert', title, detail, entityId? }
 *   kinds    : rain, wind, fire, alert (NWS), power, forecast (NWS river), release (below-dam gage)
 *
 * A source that is missing (not loaded yet) or failed in either snapshot yields no events, so the
 * first load of each source is seeded silently. Ids are stable (same incident, same rain event,
 * same reading), so the caller de-duplicates across polls and reloads with a remembered id set.
 * All thresholds below are this site's choices for "worth telling you", not agency criteria.
 *
 * Browser: window.HYDRO.events. Node: module.exports (for check.js).
 */
(function (root, factory) {
  var H = typeof module === 'object' && module.exports ? Object.assign({}, require('./data.js'), { weather: require('./weather.js'), nwps: require('./nwps.js') }) : root.HYDRO;
  var api = factory(H);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.events = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  var HOUR = 3600000, MIN = 60000;
  var TZ = 'America/Los_Angeles';
  var KINDS = [
    { key: 'rain', label: 'Rain' }, { key: 'wind', label: 'Wind' }, { key: 'fire', label: 'Fire' }, { key: 'alert', label: 'Alerts' },
    { key: 'power', label: 'Power' }, { key: 'forecast', label: 'Forecasts' }, { key: 'release', label: 'Releases' }
  ];
  var T = {
    rainP6: [0.5, 1],          // in: past-6-h milestones
    rainNext24: 1,             // in: forecast next 24 h
    outageMin: 10,             // customers: a new / restored outage worth a line
    utilTotals: [100, 500],    // customers out at one utility
    releasePct: 0.2, releaseCfs: 50, releaseLag: 30 * MIN, // below-dam gage change vs ~30 min earlier
    fireGrow: 2, fireGrowMinAcres: 10, containStep: 25
  };

  var fT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  var fDH = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric' });
  var fDT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  function hm(t) { return fT.format(new Date(t)); }
  function dayHour(t) { return fDH.format(new Date(t)).replace(',', ''); }
  function dayTime(t) { return fDT.format(new Date(t)).replace(',', ''); }
  function n0(v) { return Math.round(v).toLocaleString('en-US'); }
  function inch(v) { return v < 0.005 ? '0' : v.toFixed(2); }
  function plural(n, w) { return n0(n) + ' ' + w + (Math.round(n) === 1 ? '' : 's'); }
  function bucket(t, h) { return Math.floor(t / (h * HOUR)); }

  // ---- Rain + wind, per basin ----------------------------------------------------------------
  // Projects sharing the same basin points (Lookout Point / Dexter) are one basin here.
  function basins() {
    var W = H.weather, seen = {}, out = [];
    (H.projects || []).forEach(function (p) {
      var b = W && W.BASINS[p.code];
      if (!b) return;
      var k = JSON.stringify(b.pts);
      if (seen[k]) { seen[k].names.push(p.name); return; }
      seen[k] = { code: p.code, id: p.id, names: [p.name], area: b.area };
      out.push(seen[k]);
    });
    return out;
  }
  function wxOk(wx) { return wx && !wx.error && wx.basins; }

  function rainEvents(prev, next, now, out) {
    if (!wxOk(prev.wx) || !wxOk(next.wx) || !H.weather) return;
    var W = H.weather, tp = prev.at || now;
    basins().forEach(function (b) {
      var a = W.summarize(prev.wx.basins[b.code], tp, b.area), z = W.summarize(next.wx.basins[b.code], now, b.area);
      if (!a || !z) return;
      var where = b.names.join(' / ');
      var onA = a.event && !a.event.end, onZ = z.event && !z.event.end;
      if (onZ && !onA) {
        out.push({ id: 'rain:start:' + b.code + ':' + z.event.start, kind: 'rain', level: z.next24 >= T.rainNext24 ? 'watch' : 'info', entityId: b.id,
          title: 'Rain started above ' + where,
          detail: inch(z.rateNow) + ' in last hour · forecast ' + inch(z.next24) + ' in next 24 h' + (z.ends ? ' · ends ~' + dayHour(z.ends) : '') });
      } else if (onA && !onZ && a.event) {
        var tot = z.event ? z.event.total : a.event.total;
        out.push({ id: 'rain:stop:' + b.code + ':' + a.event.start, kind: 'rain', level: 'info', entityId: b.id,
          title: 'Rain stopped above ' + where,
          detail: inch(tot) + ' in this event (since ' + dayHour(a.event.start) + ')' + (z.nextStart ? ' · next rain ~' + dayHour(z.nextStart) : ' · no rain in the forecast') });
      }
      T.rainP6.forEach(function (x) {
        if (a.past6 < x && z.past6 >= x) out.push({ id: 'rain:p6:' + x + ':' + b.code + ':' + (z.event ? z.event.start : bucket(now, 6)), kind: 'rain', level: x >= 1 ? 'alert' : 'watch', entityId: b.id,
          title: 'Heavy rain above ' + where + ': ' + inch(z.past6) + ' in 6 h',
          detail: 'Past 6 h crossed ' + x + ' in · ' + inch(z.past24) + ' in 24 h · forecast ' + inch(z.next24) + ' in next 24 h' });
      });
      // (not when rain just started here: that event already gives the forecast)
      if (a.next24 < T.rainNext24 && z.next24 >= T.rainNext24 && !(onZ && !onA)) out.push({ id: 'rain:f24:' + b.code + ':' + bucket(now, 12), kind: 'rain', level: 'watch', entityId: b.id,
        title: 'Forecast ' + inch(z.next24) + ' in of rain above ' + where,
        detail: 'Next 24 h, weather model basin mean · ' + inch(z.next6) + ' in next 6 h' + (z.raining ? ' · raining now' : z.nextStart ? ' · starting ~' + dayHour(z.nextStart) : '') });
      // Wind: gusts reach advisory / warning level now.
      var RANK = { calm: 0, breezy: 1, advisory: 2, warning: 3 };
      var wa = a.wind, wz = z.wind;
      if (wz && RANK[wz.level] >= 2 && (!wa || RANK[wa.level] < RANK[wz.level])) {
        out.push({ id: 'wind:' + b.code + ':' + wz.level + ':' + bucket(now, 6), kind: 'wind', level: wz.level === 'warning' ? 'alert' : 'watch', entityId: b.id,
          title: 'Wind ' + (wz.level === 'warning' ? 'warning' : 'advisory') + '-level gusts at ' + where,
          detail: 'Gusts ' + n0(wz.gust) + ' mph, sustained ' + n0(wz.speed) + ' mph' + (wz.from ? ' from ' + wz.from : '') +
            (wz.next24 && wz.next24.gust > wz.gust ? ' · peak ' + n0(wz.next24.gust) + ' mph ' + dayHour(wz.next24.t) : '') });
      }
    });
  }

  // ---- Fires + NWS alerts ----------------------------------------------------------------
  function projId(code) { var p = (H.projects || []).filter(function (x) { return x.code === code; })[0]; return p ? p.id : null; }
  function fireKey(f) { return String(f.id != null ? f.id : f.name + '@' + f.lat.toFixed(2) + ',' + f.lon.toFixed(2)); }

  function fireEvents(prev, next, now, out) {
    var a = prev.hz, z = next.hz;
    if (!a || !z || a.firesError || z.firesError || !a.fetchedAt || !z.fetchedAt) return;
    var old = {};
    (a.fires || []).forEach(function (f) { old[fireKey(f)] = f; });
    (z.fires || []).forEach(function (f) {
      var k = fireKey(f), o = old[k], rx = f.type === 'prescribed';
      var where = f.near ? Math.round(f.near.mi) + ' mi ' + f.near.dir + ' of ' + f.near.name : '';
      var size = f.acres != null ? n0(f.acres) + ' ac' : 'size not reported';
      if (!o) {
        out.push({ id: 'fire:new:' + k, kind: 'fire', level: rx ? 'info' : f.near && f.near.mi <= 25 ? 'alert' : 'watch', entityId: f.near ? projId(f.near.code) : null,
          title: (rx ? 'Prescribed burn: ' : 'New wildfire: ') + f.name,
          detail: size + (f.contained != null ? ' · ' + n0(f.contained) + '% contained' : '') + (where ? ' · ' + where : '') + (f.cause ? ' · ' + f.cause : '') });
        return;
      }
      if (!rx && f.acres != null && o.acres != null && f.acres >= T.fireGrowMinAcres && f.acres >= T.fireGrow * Math.max(o.acres, 1)) {
        out.push({ id: 'fire:grow:' + k + ':' + Math.floor(Math.log(f.acres) / Math.log(2)), kind: 'fire', level: f.near && f.near.mi <= 25 ? 'alert' : 'watch', entityId: f.near ? projId(f.near.code) : null,
          title: f.name + ' grew to ' + n0(f.acres) + ' ac', detail: 'Was ' + n0(o.acres) + ' ac' + (f.contained != null ? ' · ' + n0(f.contained) + '% contained' : '') + (where ? ' · ' + where : '') });
      }
      if (f.contained != null && o.contained != null && (f.contained - o.contained >= T.containStep || (f.contained >= 100 && o.contained < 100))) {
        out.push({ id: 'fire:cont:' + k + ':' + Math.round(f.contained), kind: 'fire', level: 'info', entityId: f.near ? projId(f.near.code) : null,
          title: f.name + ' ' + n0(f.contained) + '% contained', detail: 'Was ' + n0(o.contained) + '% · ' + size + (where ? ' · ' + where : '') });
      }
    });
  }

  function alertKey(x) { return (x.event || '') + '|' + (x.area || ''); }
  function alertEvents(prev, next, now, out) {
    var a = prev.hz, z = next.hz;
    if (!a || !z || a.alertsError || z.alertsError || !a.fetchedAt || !z.fetchedAt) return;
    var ka = {}, kz = {};
    (a.alerts || []).forEach(function (x) { ka[alertKey(x)] = x; });
    (z.alerts || []).forEach(function (x) { kz[alertKey(x)] = x; });
    Object.keys(kz).forEach(function (k) {
      if (ka[k]) return;
      var x = kz[k];
      out.push({ id: 'nws:on:' + k + ':' + (x.onset || bucket(now, 12)), kind: 'alert', level: /warning/i.test(x.event) ? 'alert' : 'watch', fire: !!x.fire,
        title: x.event + ' issued' + (x.fire ? ' (fire weather)' : ''),
        detail: (x.ends ? 'Until ' + dayTime(x.ends) + ' · ' : '') + shortArea(x.area) });
    });
    Object.keys(ka).forEach(function (k) {
      if (kz[k]) return;
      var x = ka[k];
      out.push({ id: 'nws:off:' + k + ':' + (x.onset || bucket(now, 12)), kind: 'alert', level: 'info', fire: !!x.fire,
        title: x.event + ' ended', detail: 'No longer active · ' + shortArea(x.area) });
    });
  }
  function shortArea(s) { s = String(s || ''); var p = s.split(/;\s*/); return p.length > 3 ? p.slice(0, 3).join('; ') + ' +' + (p.length - 3) + ' more' : s; }

  // ---- Power -----------------------------------------------------------------------------
  function powerEvents(prev, next, now, out) {
    var a = prev.pw, z = next.pw;
    if (!a || !z || !a.utilities || !z.utilities) return;
    var ua = {};
    a.utilities.forEach(function (u) { if (u && !u.error) ua[u.key] = u; });
    z.utilities.forEach(function (u) {
      var o = u && !u.error && ua[u.key];
      if (!o) return;
      var oi = {}, zi = {};
      o.incidents.forEach(function (x) { oi[String(x.id)] = x; });
      u.incidents.forEach(function (x) { zi[String(x.id)] = x; });
      var bigNew = 0;
      u.incidents.forEach(function (x) {
        if (oi[String(x.id)] || x.n < T.outageMin) return;
        bigNew = Math.max(bigNew, x.n);
        var where = x.area || (x.comment && x.comment.length < 50 ? x.comment : '');
        out.push({ id: 'pw:new:' + u.key + ':' + x.id, kind: 'power', level: x.planned ? 'info' : x.n >= 250 ? 'alert' : 'watch',
          title: (x.planned ? 'Planned outage: ' : 'Power outage: ') + u.name + ', ' + plural(x.n, 'customer'),
          detail: [where, x.cause, x.etr ? 'est. restore ' + dayTime(x.etr) : x.etrText ? 'est. restore ' + x.etrText : ''].filter(Boolean).join(' · ') || 'Location not given' });
      });
      o.incidents.forEach(function (x) {
        if (zi[String(x.id)] || x.n < T.outageMin) return;
        var where = x.area || (x.comment && x.comment.length < 50 ? x.comment : '');
        out.push({ id: 'pw:restored:' + u.key + ':' + x.id, kind: 'power', level: 'info',
          title: 'Power restored: ' + u.name + ', ' + plural(x.n, 'customer'),
          detail: (where ? where + ' · ' : '') + (x.start ? 'out since ' + dayTime(x.start) : 'outage cleared') });
      });
      T.utilTotals.forEach(function (lim) {
        // (not when one new outage alone crosses it: that outage's own event says so)
        if (o.out < lim && u.out >= lim && bigNew < lim) out.push({ id: 'pw:total:' + u.key + ':' + lim + ':' + bucket(now, 6), kind: 'power', level: lim >= 500 ? 'alert' : 'watch',
          title: u.name + ': ' + n0(u.out) + ' customers out', detail: 'Crossed ' + lim + ' · ' + plural(u.incidents.length, 'outage') + (u.served ? ' · of ' + n0(u.served) + ' served' : '') });
      });
    });
    // BPA: new unplanned line trip still out.
    if (a.bpa && z.bpa && a.bpa.items && z.bpa.items) {
      var had = {};
      a.bpa.items.forEach(function (b) { had[b.id || b.name + b.out] = true; });
      z.bpa.items.forEach(function (b) {
        var k = b.id || b.name + b.out;
        if (had[k] || !b.stillOut || !/auto/i.test(b.type || '') || !/line/i.test(b.table || '')) return;
        out.push({ id: 'bpa:trip:' + k, kind: 'power', level: 'alert', title: 'BPA line tripped: ' + b.name,
          detail: 'Unplanned (auto)' + (b.kv ? ' · ' + b.kv + ' kV' : '') + (b.cause ? ' · ' + b.cause : '') + (b.out ? ' · out since ' + dayTime(Date.parse(b.out)) : '') + ' · still out' });
      });
    }
  }

  // ---- NWS river forecasts ---------------------------------------------------------------
  function forecastEvents(prev, next, now, out) {
    var a = prev.nwps, z = next.nwps;
    if (!a || !z) return;
    Object.keys(z).forEach(function (id) {
      var gz = z[id] && z[id].gauge, ga = a[id] && a[id].gauge;
      if (!gz || !ga || !gz.forecast || z[id].stale) return;
      var iz = gz.forecast.issued, ia = ga.forecast ? ga.forecast.issued : null;
      if (!iz || iz === ia || (ia && iz < ia)) return;
      var st = (H.stations || []).filter(function (s) { return s.id === id; })[0];
      var pk = H.nwps && H.nwps.forecastPeak ? H.nwps.forecastPeak(gz, now) : gz.peak;
      var cat = pk && pk.category, LBL = { action: 'action stage', minor: 'minor flood', moderate: 'moderate flood', major: 'major flood' };
      out.push({ id: 'fc:' + (gz.lid || id) + ':' + iz, kind: 'forecast', level: cat === 'minor' || cat === 'moderate' || cat === 'major' ? 'alert' : cat === 'action' ? 'watch' : 'info', entityId: id,
        title: 'New NWS forecast for ' + (st ? st.name : gz.name || id),
        detail: 'Issued ' + hm(iz) + (pk ? ' · peak ' + pk.stage.toFixed(1) + ' ft ' + dayHour(pk.t) + (pk.flow != null ? ' (' + n0(pk.flow) + ' cfs)' : '') + (LBL[cat] ? ' · ' + LBL[cat] : '') : '') });
    });
  }

  // ---- Release changes (below-dam USGS gage) ---------------------------------------------
  // Latest reading vs the reading ~30 min before it. Fires once at the start of a change: only on a
  // new reading, and not when the previous snapshot's latest reading had already moved the same way.
  function change(s) {
    if (!s || !s.t || s.t.length < 2) return null;
    var i = s.t.length - 1, tEnd = s.t[i], j = -1;
    for (var k = i - 1; k >= 0; k--) if (s.t[k] <= tEnd - T.releaseLag + 2 * MIN) { j = k; break; }
    if (j < 0 || tEnd - s.t[j] > T.releaseLag + 45 * MIN) return null;
    var v0 = s.v[j], v1 = s.v[i];
    if (v0 == null || v1 == null) return null;
    var d = v1 - v0, big = Math.abs(d) >= T.releaseCfs && Math.abs(d) >= T.releasePct * Math.max(Math.abs(v0), 1);
    return { t: tEnd, v0: v0, v1: v1, d: d, dir: big ? (d > 0 ? 1 : -1) : 0 };
  }
  function releaseEvents(prev, next, now, out) {
    var a = prev.snap, z = next.snap;
    if (!a || !z || !a.projects || !z.projects) return;
    (H.projects || []).forEach(function (p) {
      if (!p.gage) return;
      var ca = change(a.projects[p.id] && a.projects[p.id].gage), cz = change(z.projects[p.id] && z.projects[p.id].gage);
      if (!ca || !cz || !cz.dir || cz.t <= ca.t || ca.dir === cz.dir) return;
      var ratio = cz.v1 / Math.max(cz.v0, 1);
      out.push({ id: 'rel:' + p.code + ':' + cz.t, kind: 'release', level: ratio >= 2 || ratio <= 0.5 || Math.abs(cz.d) >= 1000 ? 'watch' : 'info', entityId: p.id,
        title: p.gage.short + ' ' + (cz.dir > 0 ? 'up' : 'down') + ' ' + n0(cz.v0) + ' → ' + n0(cz.v1) + ' cfs (' + p.name + ' release)',
        detail: (cz.d > 0 ? '+' : '−') + n0(Math.abs(cz.d)) + ' cfs (' + (cz.d > 0 ? '+' : '−') + Math.round(Math.abs(cz.d) / Math.max(cz.v0, 1) * 100) + '%) in ~30 min · USGS ' + p.gage.site + ', reading ' + hm(cz.t) });
    });
  }

  /*
   * New events between two snapshots, newest-first order not implied. prev null -> [] (first load).
   */
  function detect(prev, next, now) {
    var out = [];
    if (!prev || !next) return out;
    now = now || Date.now();
    [rainEvents, fireEvents, alertEvents, powerEvents, forecastEvents, releaseEvents].forEach(function (f) {
      try { f(prev, next, now, out); } catch (e) { /* one bad source never stops the others */ }
    });
    var ids = {};
    return out.filter(function (e) { if (ids[e.id]) return false; ids[e.id] = true; e.time = now; return true; });
  }

  // ---- Remembered feed (localStorage; the page works without it) ---------------------------
  var KEY = 'wvhd:events';
  function storage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function loadStore() {
    var st = { seen: [], events: [], readAt: 0, read: {}, desktop: false, off: [] };
    try { var j = JSON.parse(storage().getItem(KEY)); if (j && typeof j === 'object') Object.keys(st).forEach(function (k) { if (j[k] != null) st[k] = j[k]; }); } catch (e) { /* defaults */ }
    return st;
  }
  function saveStore(st) {
    var keep = {}, read = {};
    st.events.slice(0, 200).forEach(function (e) { keep[e.id] = 1; });
    Object.keys(st.read || {}).forEach(function (id) { if (keep[id]) read[id] = 1; });
    try { storage().setItem(KEY, JSON.stringify({ seen: st.seen.slice(-1000), events: st.events.slice(0, 200), readAt: st.readAt, read: read, desktop: st.desktop, off: st.off })); } catch (e) { /* memory only */ }
  }
  // Events not seen before (by id); records them. -> fresh events
  function remember(st, events) {
    var seen = {};
    st.seen.forEach(function (id) { seen[id] = true; });
    var fresh = events.filter(function (e) { if (seen[e.id]) return false; seen[e.id] = true; st.seen.push(e.id); return true; });
    st.events = fresh.slice().reverse().concat(st.events).slice(0, 200);
    if (st.seen.length > 1000) st.seen = st.seen.slice(-1000);
    return fresh;
  }

  return { KINDS: KINDS, T: T, detect: detect, basins: basins, releaseChange: change, loadStore: loadStore, saveStore: saveStore, remember: remember, KEY: KEY };
});
