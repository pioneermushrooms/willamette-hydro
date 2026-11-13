/*
 * Shared zoom controls for the time-series charts (Trend Recorder, Teacup lake chart).
 * A zoom window is [a, b] as fractions (0..1) of the chart's full time span.
 *
 *   H.zoom.bar(z, attr, label)   toolbar HTML: − + ◀ ▶ Reset buttons as data-<attr>="out|in|left|right|reset"
 *   H.zoom.apply(z, action, min) new window for one of those actions
 *   H.zoom.attach(svg, geom, onSelect, onDouble)
 *       drag across the plot to select a span (horizontal drags work on touch; vertical swipes
 *       still scroll the page), double-click to zoom out. geom() returns the plot box
 *       { ml, mt, pw, ph, W } in viewBox units; onSelect(fa, fb) and onDouble(fc) get
 *       fractions of the plot width.
 * Browser: window.HYDRO.zoom. Node: module.exports (for check.js).
 */
(function (root) {
  'use strict';
  var H = root.HYDRO || (root.HYDRO = {});
  function bar(z, attr, label) {
    var zoomed = z[0] > 0 || z[1] < 1;
    var b = function (a, txt, title, dis) {
      return '<button type="button" class="btn zm-b" data-' + attr + '="' + a + '" title="' + title + '" aria-label="' + title + '"' + (dis ? ' disabled' : '') + '>' + txt + '</button>';
    };
    return '<div class="zm-bar" role="group" aria-label="Zoom the chart">' +
      b('out', '−', 'Zoom out', !zoomed) + b('in', '+', 'Zoom in', false) + b('left', '◀', 'Earlier', z[0] <= 0) + b('right', '▶', 'Later', z[1] >= 1) +
      b('reset', 'Reset', 'Show the whole range', !zoomed) +
      '<span class="zm-label mono">' + (label || '') + '</span>' +
      '<span class="zm-hint">drag across the chart to zoom · double-click to zoom out</span></div>';
  }

  // New window for a toolbar action; min = smallest window as a fraction of the full span.
  function apply(z, action, min, centre) {
    var w = z[1] - z[0], c = centre == null ? (z[0] + z[1]) / 2 : centre;
    if (action === 'reset') return [0, 1];
    if (action === 'in') return clamp([c - w / 4, c + w / 4], min);
    if (action === 'out') return clamp([c - w, c + w], min);
    if (action === 'left') return clamp([z[0] - w / 2, z[1] - w / 2], min);
    if (action === 'right') return clamp([z[0] + w / 2, z[1] + w / 2], min);
    return z;
  }

  // Clamp into [0, 1], at least `min` wide (keeps the centre where possible; orders reversed drags).
  function clamp(z, min) {
    var a = Math.min(z[0], z[1]), b = Math.max(z[0], z[1]), m = min || 0.001;
    if (b - a < m) { var c = (a + b) / 2; a = c - m / 2; b = c + m / 2; }
    if (a < 0) { b -= a; a = 0; }
    if (b > 1) { a -= b - 1; b = 1; }
    return [Math.max(0, a), Math.min(1, b)];
  }

  function attach(svg, geom, onSelect, onDouble) {
    var drag = null, sel = null;
    var px = function (ev) { var r = svg.getBoundingClientRect(), g = geom(); return (ev.clientX - r.left) * (g.W / r.width); };
    var stop = function () { drag = null; if (sel) { sel.remove(); sel = null; } };
    svg.addEventListener('pointerdown', function (ev) {
      var g = geom(), x = px(ev);
      if (!g || x < g.ml || x > g.ml + g.pw) return;
      drag = { x0: x, id: ev.pointerId, moved: false };
    });
    svg.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var g = geom(), x = Math.max(g.ml, Math.min(g.ml + g.pw, px(ev)));
      if (!drag.moved && Math.abs(x - drag.x0) > 8) {
        drag.moved = true;
        try { svg.setPointerCapture(drag.id); } catch (e) { /* ignore */ }
        sel = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        sel.setAttribute('class', 'zm-sel'); sel.setAttribute('y', g.mt); sel.setAttribute('height', g.ph);
        svg.appendChild(sel);
      }
      if (drag.moved) { sel.setAttribute('x', Math.min(x, drag.x0).toFixed(1)); sel.setAttribute('width', Math.abs(x - drag.x0).toFixed(1)); }
    });
    svg.addEventListener('pointerup', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag, g = geom(), x = Math.max(g.ml, Math.min(g.ml + g.pw, px(ev)));
      stop();
      if (d.moved) onSelect((Math.min(x, d.x0) - g.ml) / g.pw, (Math.max(x, d.x0) - g.ml) / g.pw);
    });
    svg.addEventListener('pointercancel', stop);
    svg.addEventListener('dblclick', function (ev) {
      var g = geom();
      if (!g) return;
      ev.preventDefault();
      onDouble(Math.max(0, Math.min(1, (px(ev) - g.ml) / g.pw)));
    });
  }

  var api = { bar: bar, apply: apply, clamp: clamp, attach: attach };
  H.zoom = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
