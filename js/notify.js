/*
 * Live event feed UI (events come from js/events.js detect()):
 *   - toasts, bottom-left, stacked newest at the bottom, at most 5; each fades away by itself
 *     (12 s, alerts 25 s; hovering pauses). Opening the bell clears them all and marks every event read;
 *     clicking a toast opens its project without clearing anything;
 *   - the bell in the header with the unread count, opening the feed panel (newest first, filter
 *     chips by kind, "mark all read");
 *   - opt-in desktop notifications (browser Notification API; permission asked on the click that
 *     turns them on, with a test notification); shown whenever the page is open, at most 5 per batch,
 *     closed when the bell is opened.
 * The feed, seen ids, read time and choices are remembered in localStorage (js/events.js store).
 * Browser only: window.HYDRO.notify.
 */
(function () {
  'use strict';
  var H = window.HYDRO;
  if (!H || !H.events) return;
  var E = H.events;

  var TOAST_MS = 12000, ALERT_MS = 25000, MAX_TOASTS = 5;
  // Fewer toasts at once on a phone (they sit over the top of the page there).
  function narrow() { return window.matchMedia && window.matchMedia('(max-width: 640px)').matches; }
  function maxBatch() { return narrow() ? 3 : MAX_TOASTS; }
  function maxToasts() { return narrow() ? 3 : MAX_TOASTS; }
  var TZ = 'America/Los_Angeles';
  var ICON = {
    rain: '<path d="M12 3c3.5 4.6 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.4 6-11z"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
    fire: '<path d="M12 22c4 0 7-2.7 7-6.6 0-3.2-2-5.4-3.5-7-.3 1.8-1.2 3-2.4 3.6.4-3.4-1.2-6.6-4.1-9 .2 3.4-1.5 5.4-3 7.2C4.6 11.9 5 13.6 5 15.4 5 19.3 8 22 12 22z"/>',
    alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.5"/>',
    power: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    forecast: '<path d="M3 18l5-6 4 3 4-7 5 5"/><path d="M3 21h18" stroke-dasharray="2 2"/>',
    release: '<path d="M4 4v16M4 8h6l3 3h7M4 16h6l3-3"/><path d="M17 8l3 3-3 3"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0"/>'
  };
  function icon(k, cls) { return '<svg class="' + (cls || 'ev-ic') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICON[k] || ICON.bell) + '</svg>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var fT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  var fD = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  function when(t) {
    var today = fD.format(new Date()) === fD.format(new Date(t));
    return (today ? '' : fD.format(new Date(t)) + ', ') + fT.format(new Date(t));
  }
  function ago(t) {
    var m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  function kindLabel(k) { var x = E.KINDS.filter(function (y) { return y.key === k; })[0]; return x ? x.label : k; }

  var st = E.loadStore();
  var opts = { open: function () {} };
  var els = {};

  function $(id) { return document.getElementById(id); }

  // ---- Toasts --------------------------------------------------------------------------
  function toast(e, summary) {
    var box = els.toasts;
    var el = document.createElement('div');
    el.className = 'toast lv-' + (e.level || 'info') + (summary ? ' toast-sum' : '');
    el.setAttribute('role', e.level === 'alert' ? 'alert' : 'status');
    el.tabIndex = 0;
    el.innerHTML = icon(summary ? 'bell' : e.kind) + '<div class="toast-b"><div class="toast-t">' + esc(e.title) + '</div>' +
      (e.detail ? '<div class="toast-d">' + esc(e.detail) + '</div>' : '') +
      '<div class="toast-m mono">' + esc(summary ? 'Live feed' : kindLabel(e.kind)) + ' · ' + esc(fT.format(new Date(e.time || Date.now()))) + '</div></div>' +
      '<button type="button" class="toast-x" aria-label="Dismiss">×</button>';
    var timer = 0, left = e.level === 'alert' && !summary ? ALERT_MS : TOAST_MS, t0 = 0;
    function close() { clearTimeout(timer); el.classList.add('out'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 520); }
    function arm() { t0 = Date.now(); timer = setTimeout(close, left); }
    el.addEventListener('mouseenter', function () { if (timer) { clearTimeout(timer); timer = 0; left = Math.max(2000, left - (Date.now() - t0)); } });
    el.addEventListener('mouseleave', function () { if (!timer) arm(); });
    el.querySelector('.toast-x').addEventListener('click', function (ev) { ev.stopPropagation(); close(); });
    // Opens the related project; the toast stays (it fades on its own; opening the bell clears all).
    var act = function () { if (summary) openPanel(); else { try { opts.open(e); } catch (err) { /* ignore */ } } };
    el.addEventListener('click', act);
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(); } else if (ev.key === 'Escape') close(); });
    box.appendChild(el);
    // Over the limit: the oldest goes first.
    while (box.children.length > maxToasts()) box.removeChild(box.firstChild);
    arm();
  }

  function activate(e) {
    markRead([e.id]);
    try { opts.open(e); } catch (err) { /* ignore */ }
  }

  // ---- Desktop notifications ---------------------------------------------------------------
  function canDesktop() { return typeof window.Notification === 'function'; }
  var shown = [];   // open desktop notifications, closed when the bell is opened
  function note(title, body, tag, onclick) {
    try {
      var n = new Notification(title, { body: body || '', tag: tag, silent: false });
      n.onclick = function () { try { window.focus(); } catch (e) { /* ignore */ } if (onclick) onclick(); };
      n.onclose = function () { shown = shown.filter(function (x) { return x !== n; }); };
      shown.push(n);
      while (shown.length > MAX_TOASTS) { var old = shown.shift(); try { old.close(); } catch (e) { /* ignore */ } }
      return n;
    } catch (err) { return null; }   // some browsers (Android Chrome) only allow service-worker notifications
  }
  function desktop(list) {
    if (!st.desktop || !canDesktop() || Notification.permission !== 'granted') return;
    list.slice(0, MAX_TOASTS).forEach(function (e) { note(e.title, e.detail, e.id, function () { try { opts.open(e); } catch (err) { /* ignore */ } }); });
    if (list.length > MAX_TOASTS) note('Hydro Dispatch: ' + (list.length - MAX_TOASTS) + ' more events', 'Open the live feed (bell) for the rest.', 'wvhd-more', function () { openPanel(); });
  }
  function closeDesktop() { shown.slice().forEach(function (n) { try { n.close(); } catch (e) { /* ignore */ } }); shown = []; }

  // ---- Bell + panel -----------------------------------------------------------------------
  function unread() { return st.events.filter(function (e) { return e.time > st.readAt && !(st.read && st.read[e.id]); }).length; }
  function markRead(ids) {
    if (!ids) { st.readAt = Date.now(); st.read = {}; }
    else { st.read = st.read || {}; ids.forEach(function (id) { st.read[id] = 1; }); }
    E.saveStore(st);
    renderBell(); if (isOpen()) renderPanel();
  }
  function renderBell() {
    var n = unread(), c = els.count;
    c.hidden = !n;
    c.textContent = n > 99 ? '99+' : String(n);
    els.bell.setAttribute('aria-label', 'Live event feed' + (n ? ', ' + n + ' unread' : ''));
    els.bell.classList.toggle('has-unread', !!n);
  }
  function isOpen() { return !els.panel.hidden; }
  function renderPanel() {
    var off = {};
    st.off.forEach(function (k) { off[k] = true; });
    var counts = {};
    st.events.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
    els.chips.innerHTML = E.KINDS.map(function (k) {
      return '<button type="button" class="ev-chip' + (off[k.key] ? '' : ' on') + '" data-kind="' + k.key + '" aria-pressed="' + (off[k.key] ? 'false' : 'true') + '">' +
        icon(k.key, 'ev-chip-ic') + k.label + (counts[k.key] ? ' <span class="mono">' + counts[k.key] + '</span>' : '') + '</button>';
    }).join('');
    var list = st.events.filter(function (e) { return !off[e.kind]; });
    els.list.innerHTML = !st.events.length ? '<li class="ev-empty">Nothing yet. Rain starting or stopping, wind, new fires, NWS alerts, power outages, new NWS river forecasts and release changes below the dams appear here as they happen (checked every 3 min while this page is open).</li>'
      : !list.length ? '<li class="ev-empty">No events of the selected kinds.</li>'
        : list.map(function (e) {
          var isNew = e.time > st.readAt && !(st.read && st.read[e.id]);
          return '<li><button type="button" class="ev-item lv-' + esc(e.level) + (isNew ? ' unread' : '') + '" data-id="' + esc(e.id) + '">' + icon(e.kind) +
            '<span class="ev-b"><span class="ev-t">' + esc(e.title) + '</span>' + (e.detail ? '<span class="ev-d">' + esc(e.detail) + '</span>' : '') +
            '<span class="ev-m mono">' + esc(when(e.time)) + ' · ' + esc(ago(e.time)) + ' · ' + esc(kindLabel(e.kind)) + '</span></span></button></li>';
        }).join('');
    var perm = canDesktop() ? Notification.permission : 'unsupported';
    els.desk.checked = !!st.desktop && perm === 'granted';
    els.desk.disabled = perm === 'unsupported' || perm === 'denied';
    els.deskNote.textContent = perm === 'unsupported' ? 'Not supported by this browser.'
      : perm === 'denied' ? 'Blocked for this site. Allow notifications in the browser’s site settings (padlock icon left of the address), then reload.'
        : st.deskErr ? st.deskErr
          : st.desktop && perm === 'granted' ? 'On: events also pop up on your desktop while this page is open (any tab or window).' : 'Pop up events on your desktop while this page is open.';
    els.readAll.disabled = !unread();
  }
  // Opening the bell acknowledges everything: toasts and desktop notifications close, all events read.
  function openPanel() {
    Array.prototype.slice.call(els.toasts.children).forEach(function (t) { t.parentNode.removeChild(t); });
    closeDesktop();
    renderPanel();   // drawn first so the unread rows are highlighted this time
    st.readAt = Date.now(); st.read = {}; E.saveStore(st); renderBell();
    els.panel.hidden = false;
    els.bell.setAttribute('aria-expanded', 'true');
    var f = els.panel.querySelector('.ev-close');
    if (f) f.focus({ preventScroll: true });
  }
  function closePanel(focusBell) {
    if (!isOpen()) return;
    els.panel.hidden = true;
    els.bell.setAttribute('aria-expanded', 'false');
    if (focusBell) els.bell.focus();
  }

  function bind() {
    els.bell.addEventListener('click', function (ev) { ev.stopPropagation(); if (isOpen()) closePanel(); else openPanel(); });
    els.panel.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var chip = ev.target.closest('.ev-chip');
      if (chip) {
        var k = chip.getAttribute('data-kind'), i = st.off.indexOf(k);
        if (i >= 0) st.off.splice(i, 1); else st.off.push(k);
        E.saveStore(st); renderPanel();
        var again = els.chips.querySelector('[data-kind="' + k + '"]'); if (again) again.focus();
        return;
      }
      var it = ev.target.closest('.ev-item');
      if (it) {
        var id = it.getAttribute('data-id'), e = st.events.filter(function (x) { return x.id === id; })[0];
        if (e) { closePanel(); activate(e); }
        return;
      }
      if (ev.target.closest('.ev-close')) closePanel(true);
      if (ev.target.closest('.ev-readall')) markRead();
    });
    els.desk.addEventListener('change', function () {
      if (!els.desk.checked) { st.desktop = false; E.saveStore(st); renderPanel(); return; }
      if (!canDesktop()) { els.desk.checked = false; return; }
      var called = false;
      var done = function (p) {
        if (called) return; called = true;
        st.desktop = p === 'granted'; st.deskErr = null;
        if (st.desktop && !note('Desktop notifications are on', 'Rain, wind, fires, alerts, outages, forecasts and release changes will pop up here while Hydro Dispatch is open.', 'wvhd-test'))
          { st.desktop = false; st.deskErr = 'This browser would not show a notification from the page (on Android Chrome it needs an installed app). Toasts in the page still work.'; }
        E.saveStore(st); renderPanel();
      };
      if (Notification.permission === 'granted') done('granted');
      else {
        try { var r = Notification.requestPermission(done); if (r && r.then) r.then(done, function () { done(Notification.permission); }); }
        catch (err) { Notification.requestPermission().then(done); }   // promise-only browsers
      }
    });
    document.addEventListener('click', function (ev) { if (isOpen() && !els.panel.contains(ev.target) && ev.target !== els.bell) closePanel(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && isOpen()) closePanel(true); });
    // Other tabs of this site update the same store.
    window.addEventListener('storage', function (ev) { if (ev.key === E.KEY) { st = E.loadStore(); renderBell(); if (isOpen()) renderPanel(); } });
    setInterval(function () { if (isOpen()) renderPanel(); }, 60000);   // keep "n min ago" honest
  }

  // New events from detect(): keep the ones not seen before, toast and notify them.
  function push(events) {
    if (!els.bell || !events || !events.length) return [];
    var fresh = E.remember(st, events);
    if (!fresh.length) return fresh;
    E.saveStore(st);
    var rank = { alert: 0, watch: 1, info: 2 };
    var show = fresh.slice().sort(function (a, b) { return rank[a.level] - rank[b.level]; });
    var mb = maxBatch(), more = show.length - mb;
    if (!isOpen()) {   // with the feed open, the new rows appear there instead
      show.slice(0, mb).forEach(function (e) { toast(e); });
      if (more > 0) toast({ title: more + ' more event' + (more > 1 ? 's' : ''), detail: 'Open the live feed to see them all.', level: 'info', time: Date.now() }, true);
    }
    desktop(show);
    renderBell();
    if (isOpen()) renderPanel();
    return fresh;
  }

  function init(o) {
    opts = Object.assign(opts, o || {});
    els = { bell: $('ev-bell'), count: $('ev-count'), panel: $('ev-panel'), toasts: $('toasts') };
    if (!els.bell || !els.panel || !els.toasts) return;
    els.chips = els.panel.querySelector('.ev-chips');
    els.list = els.panel.querySelector('.ev-list');
    els.desk = els.panel.querySelector('#ev-desktop');
    els.deskNote = els.panel.querySelector('.ev-desk-note');
    els.readAll = els.panel.querySelector('.ev-readall');
    bind();
    renderBell();
  }

  H.notify = { init: init, push: push, open: openPanel, close: closePanel, _store: function () { return st; } };
})();
