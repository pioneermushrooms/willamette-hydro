/*
 * Storage / drawdown calculator core (pure; no DOM). Used by js/views/calc.js and check.js.
 * PLANNING AID — verify against the water control manual and current operating orders.
 *
 * Units: flow cfs, storage ac-ft, elevation ft (project datum), time hours.
 *   1 ac-ft  = 43,560 ft³
 *   1 cfs·hr = 3600 / 43,560 = 0.082645 ac-ft
 * Elevation <-> storage: linear interpolation on the published CWMS elevation–storage rating
 * (js/ratings.js), both directions; a value outside the table is an error.
 *
 * Calculator 1 (convert): any two of {volume, net flow, duration} -> the third.
 * Calculator 2 (plan): ramp-limited trapezoid release Q0 -> Qp (hold) -> Qend arriving at
 * the target time; Qp found by bisection so the ending storage hits the target. Simulation:
 *   S[i+1] = S[i] + (I[i] - O[i]) * 0.082645 * dt_hr     (O[i] = profile at the step start)
 *
 * Browser: window.HYDRO.drawdown. Node: module.exports.
 */
(function (root, factory) {
  var R = typeof module === 'object' && module.exports ? require('./ratings.js') : root.HYDRO.ratings;
  var api = factory(R);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HYDRO.drawdown = api;
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var FT3_PER_AF = 43560;
  var AF_PER_CFS_HR = 3600 / FT3_PER_AF;   // 0.0826446...
  var HOUR = 3600 * 1000;
  var LABEL = 'Planning aid — verify against the water control manual and current operating orders.';

  function fmt(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function num(v) { return v == null || v === '' || !isFinite(+v) ? null : +v; }

  // ---- Elevation <-> storage ---------------------------------------------------

  /*
   * rating = { xs: elevations (ft, ascending), ys: storage (ac-ft) } from the CWMS
   * elevation–storage table. Throws RangeError outside the table.
   */
  function makeRating(xs, ys) {
    var e0 = xs[0], e1 = xs[xs.length - 1], s0 = Math.min.apply(null, ys), s1 = Math.max.apply(null, ys);
    return {
      elevMin: e0, elevMax: e1, storMin: s0, storMax: s1,
      stor: function (elev) {
        var r = R.interp(xs, ys, elev);
        if (r.y == null) throw new RangeError('Elevation ' + fmt(elev, 2) + ' ft is outside the elevation–storage table (' + fmt(e0, 2) + '–' + fmt(e1, 2) + ' ft).');
        return r.y;
      },
      elev: function (stor) {
        var r = R.inverse(xs, ys, stor);
        if (r.notMonotonic) throw new RangeError('The elevation–storage table is not monotonic; storage cannot be converted to elevation.');
        if (r.x == null) throw new RangeError('Storage ' + fmt(stor, 0) + ' ac-ft is outside the elevation–storage table (' + fmt(s0, 0) + '–' + fmt(s1, 0) + ' ac-ft).');
        return r.x;
      }
    };
  }

  // ---- Calculator 1: volume / flow / time --------------------------------------

  /*
   * o = { volume (ac-ft, + = net release), netFlow (cfs) | outflow + inflow, hours,
   *       startElev (optional), rating (optional) }
   * Exactly two of volume / net flow / hours. Returns { volume, netFlow, hours, steps[], elev? }.
   * Throws Error with a readable message on bad input.
   */
  function convert(o) {
    var v = num(o.volume), q = num(o.netFlow), h = num(o.hours), out = num(o.outflow), inn = num(o.inflow);
    var steps = [];
    if (q == null && out != null && inn != null) {
      q = out - inn;
      steps.push('Net flow = ' + fmt(out) + ' cfs outflow − ' + fmt(inn) + ' cfs inflow = ' + fmt(q) + ' cfs');
    }
    var given = (v != null) + (q != null) + (h != null);
    if (given !== 2) throw new Error('Enter exactly two of: volume change, net flow (or outflow and inflow), duration.');
    if (h == null) {
      if (!q) throw new Error('Net flow must not be zero.');
      var ft3 = v * FT3_PER_AF, sec = ft3 / q;
      h = sec / 3600;
      if (h <= 0) throw new Error('Volume and net flow must have the same sign (positive = net release, negative = net fill).');
      steps.push(fmt(v, 2).replace(/\.00$/, '') + ' ac-ft × 43,560 = ' + fmt(ft3) + ' ft³ ÷ ' + fmt(q) + ' cfs = ' + fmt(sec) + ' s = ' + fmt(h, 2) + ' hr');
    } else if (v == null) {
      if (h <= 0) throw new Error('Duration must be greater than zero.');
      var ft3b = q * h * 3600;
      v = ft3b / FT3_PER_AF;
      steps.push(fmt(q) + ' cfs × ' + fmt(h, 2) + ' hr × 3,600 = ' + fmt(ft3b) + ' ft³ ÷ 43,560 = ' + fmt(v, 2) + ' ac-ft');
    } else {
      if (h <= 0) throw new Error('Duration must be greater than zero.');
      var ft3c = v * FT3_PER_AF, secc = h * 3600;
      q = ft3c / secc;
      steps.push(fmt(v, 2).replace(/\.00$/, '') + ' ac-ft × 43,560 = ' + fmt(ft3c) + ' ft³ ÷ (' + fmt(h, 2) + ' hr × 3,600 = ' + fmt(secc) + ' s) = ' + fmt(q, 1) + ' cfs');
    }
    var res = { volume: v, netFlow: q, hours: h, steps: steps };
    var e0 = num(o.startElev);
    if (e0 != null && o.rating) {
      var s0 = o.rating.stor(e0), s1 = s0 - v, e1 = o.rating.elev(s1);
      res.elev = { start: e0, end: e1, change: e1 - e0, storStart: s0, storEnd: s1 };
      steps.push('Storage at ' + fmt(e0, 2) + ' ft = ' + fmt(s0) + ' ac-ft; ' + fmt(s0) + (v >= 0 ? ' − ' : ' + ') + fmt(Math.abs(v)) + ' = ' + fmt(s1) + ' ac-ft → ' + fmt(e1, 2) + ' ft (' + (e1 - e0 >= 0 ? '+' : '−') + fmt(Math.abs(e1 - e0), 2) + ' ft)');
    }
    return res;
  }

  // ---- Calculator 2: ramp-limited drawdown planner ------------------------------

  /*
   * Ramp model: how fast the release may change. Linear in flow (ru / rd in cfs/hr), or, with
   * `stage` = { stage(q) -> ft, flow(h) -> cfs, qMin, qMax } from a downstream gage's
   * stage–discharge rating, linear in gage height (ru / rd in ft/hr).
   *   time(from, to)        hours to ramp between two flows
   *   along(from, to, tau)  flow tau hours into that ramp (holds at `to` once reached)
   */
  function rampModel(ru, rd, stage) {
    if (!stage) return {
      linear: true, ru: ru, rd: rd,
      time: function (f, t) { return t >= f ? (t - f) / ru : (f - t) / rd; },
      along: function (f, t, tau) { return t >= f ? Math.min(t, f + ru * tau) : Math.max(t, f - rd * tau); }
    };
    return {
      linear: false, ru: ru, rd: rd, stage: stage,
      time: function (f, t) { var hf = stage.stage(f), ht = stage.stage(t); return ht >= hf ? (ht - hf) / ru : (hf - ht) / rd; },
      along: function (f, t, tau) {
        var hf = stage.stage(f), ht = stage.stage(t), h = ht >= hf ? Math.min(ht, hf + ru * tau) : Math.max(ht, hf - rd * tau);
        return h === ht ? t : stage.flow(h);
      }
    };
  }

  /*
   * Trapezoid release over H hours: Q0 -> Qp, hold, Qp -> Qend arriving at H, ramping as rm allows.
   * Returns { a, c, b (segment hours), ok (hold >= 0), at(tau) }.
   */
  function profile(Q0, Qp, Qend, rm, H) {
    var a = rm.time(Q0, Qp), b = rm.time(Qp, Qend), c = H - a - b;
    return {
      a: a, b: b, c: c, ok: c >= -1e-9,
      at: function (tau) {
        if (tau <= a) return a ? rm.along(Q0, Qp, tau) : Qp;
        if (tau <= a + c) return Qp;
        return rm.along(Qp, Qend, tau - a - c);
      }
    };
  }

  // Ramp from Q0 toward Qend for the whole window at the allowed rate (used when ramps alone exceed it).
  function bestRampProfile(Q0, Qend, rm) {
    return { a: null, b: null, c: null, ok: false, at: function (tau) { return rm.along(Q0, Qend, tau); } };
  }

  /*
   * Release <-> gage height through a stage–discharge rating { xs: gage height ft, ys: flow cfs }
   * (USGS exsa, js/ratings.js). other = flow at the gage that is not the release (tributaries
   * between dam and gage), so gage flow = release + other. Travel time is not modelled.
   */
  function stageFromRating(xs, ys, other, label, src) {
    var o = num(other) || 0, qs = ys.filter(function (v) { return isFinite(v); });
    if (!R.isMonotonic(ys)) throw new RangeError('The stage–discharge rating at ' + label + ' is not monotonic.');
    return {
      label: label, src: src, other: o,
      qMin: Math.max(0, Math.min.apply(null, qs) - o), qMax: Math.max.apply(null, qs) - o,
      stage: function (q) { return R.inverse(xs, ys, q + o).x; },
      flow: function (h) { var r = R.interp(xs, ys, h); return r.y == null ? null : r.y - o; }
    };
  }

  // Inflow at hour offset tau: constant, or hourly series (last value held).
  function inflowFn(inflow) {
    if (Array.isArray(inflow)) {
      if (!inflow.length) throw new Error('Inflow series is empty.');
      return function (tau) { return inflow[Math.min(inflow.length - 1, Math.max(0, Math.floor(tau + 1e-9)))]; };
    }
    var c = +inflow;
    return function () { return c; };
  }

  function simulate(S0, prof, inflowAt, n, dt) {
    var S = [S0], O = [], I = [];
    for (var i = 0; i < n; i++) {
      var tau = i * dt;
      O.push(prof.at(tau)); I.push(inflowAt(tau));
      S.push(S[i] + (I[i] - O[i]) * AF_PER_CFS_HR * dt);
    }
    return { S: S, O: O, I: I };
  }

  // Feasible plateau range where the hold segment is >= 0 (null if the ramps alone exceed H).
  // Gage-height ramps: found by bisection inside the rating's flow range.
  function plateauRange(Q0, Qend, rm, H) {
    if (rm.time(Q0, Qend) > H + 1e-9) return null;
    if (rm.linear) {
      var ru = rm.ru, rd = rm.rd;
      return { lo: (Q0 / rd + Qend / ru - H) / (1 / rd + 1 / ru), hi: (H + Q0 / ru + Qend / rd) / (1 / ru + 1 / rd) };
    }
    var span = function (q) { return rm.time(Q0, q) + rm.time(q, Qend); };
    var solve = function (a, b, up) {   // span(a) <= H; find the limit toward b
      if (span(b) <= H) return b;
      for (var i = 0; i < 60; i++) { var m = (a + b) / 2; if (span(m) <= H) a = m; else b = m; }
      return a;
    };
    return { lo: solve(Math.min(Q0, Qend), rm.stage.qMin), hi: solve(Math.max(Q0, Qend), rm.stage.qMax) };
  }

  function parseSeries(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var nums = line.match(/-?\d[\d,]*(?:\.\d+)?/g);
      if (!nums || !line.trim()) return;
      // one value per line; with "time, value" lines the last number is the flow
      var v = parseFloat(nums[nums.length - 1].replace(/,/g, ''));
      if (isFinite(v)) out.push(v);
    });
    return out;
  }

  /*
   * opts = { rating, S0, St, t0 (ms), tEnd (ms), Q0, inflow (number | hourly array),
   *          ru, rd (cfs/hr, > 0; ft/hr with `stage`), Qmin, Qmax, Qend (optional; default inflow at tEnd),
   *          stage (optional: { stage(q), flow(h), qMin, qMax, label, src } — ramp limits in gage
   *          height per hour at a downstream gage, from its stage–discharge rating; see stageFromRating),
   *          dtHr (1, 0.5 or 0.25), roundTo (optional cfs), tol (ac-ft, default 1) }
   * Returns { status, messages[], Qp, ... schedule[] } — see README "Storage / Drawdown Calculator".
   */
  function plan(opts) {
    var dt = num(opts.dtHr) || 1, tol = num(opts.tol) || 1;
    var Q0 = num(opts.Q0), ru = num(opts.ru), rd = num(opts.rd), Qmin = num(opts.Qmin), Qmax = num(opts.Qmax);
    var S0 = num(opts.S0), St = num(opts.St), t0 = num(opts.t0), tEnd = num(opts.tEnd);
    [['current outflow', Q0], ['ramp-up rate', ru], ['ramp-down rate', rd], ['max outflow', Qmax], ['start storage', S0], ['target storage', St], ['start time', t0], ['target time', tEnd]]
      .forEach(function (p) { if (p[1] == null) throw new Error('Missing ' + p[0] + '.'); });
    if (Qmin == null) Qmin = 0;
    if (ru <= 0 || rd <= 0) throw new Error('Ramp rates must be greater than zero.');
    if (Qmax <= Qmin) throw new Error('Max outflow must be greater than min outflow.');
    if ([1, 0.5, 0.25].indexOf(dt) < 0) throw new Error('Time step must be 1 hr, 30 min or 15 min.');
    var n = Math.round((tEnd - t0) / (dt * HOUR));
    if (n < 1) throw new Error('Target time must be at least one time step after the start.');
    var Hh = n * dt, inflowAt = inflowFn(opts.inflow);
    var Qend = num(opts.Qend);
    var QendDefault = Qend == null;
    if (Qend == null) Qend = inflowAt(Hh);
    var rating = opts.rating, messages = [], sg = opts.stage || null;
    if (sg) {
      [['Current outflow', Q0], ['Ending outflow', Qend]].forEach(function (p) {
        if (p[1] < sg.qMin || p[1] > sg.qMax) throw new RangeError(p[0] + ' ' + fmt(p[1]) + ' cfs is outside the stage–discharge rating at ' + sg.label + ' (' + fmt(sg.qMin) + '–' + fmt(sg.qMax) + ' cfs at the gage).');
      });
      if (Qmax > sg.qMax) { messages.push('Max outflow limited to ' + fmt(sg.qMax) + ' cfs, the top of the stage–discharge rating at ' + sg.label + '.'); Qmax = sg.qMax; }
      if (Qmin < sg.qMin) Qmin = Math.max(Qmin, sg.qMin);
    }
    var rm = rampModel(ru, rd, sg);

    var endFor = function (prof) { var s = simulate(S0, prof, inflowAt, n, dt); return { sim: s, Send: s.S[n] }; };
    var range = plateauRange(Q0, Qend, rm, Hh);
    var status, Qp = null, prof, earliest = null;

    if (!range) {
      status = 'ramp-window';
      prof = bestRampProfile(Q0, Qend, rm);
      var need = rm.time(Q0, Qend);
      messages.push('Ramping from ' + fmt(Q0) + ' to ' + fmt(Qend) + ' cfs alone takes ' + fmt(need, 2) + ' hr, longer than the ' + fmt(Hh, 2) + ' hr window. Showing the best achievable profile: ramp toward ' + fmt(Qend) + ' cfs for the whole window.');
    } else {
      var lo = Math.max(Qmin, range.lo), hi = Math.min(Qmax, range.hi);
      if (lo > hi) { lo = hi = Math.min(Math.max(Qmin, range.lo), Qmax); }
      var fHi = endFor(profile(Q0, hi, Qend, rm, Hh)).Send, fLo = endFor(profile(Q0, lo, Qend, rm, Hh)).Send;
      if (fHi > St + tol) {
        status = 'infeasible-max';
        Qp = hi;
        earliest = earliestTime(opts, St, tol, dt, n, Qend, QendDefault, inflowAt, rm, Qmax);
        messages.push('Target not reachable by the deadline: even a ' + fmt(hi) + ' cfs plateau' + (hi < Qmax ? ' (the most the ramp limits allow in this window)' : ' (max outflow)') + ' leaves storage ' + fmt(fHi - St) + ' ac-ft above target.');
      } else if (fLo < St - tol) {
        status = 'infeasible-min';
        Qp = lo;
        messages.push('Even the lowest allowed plateau (' + fmt(lo) + ' cfs) takes storage ' + fmt(St - fLo) + ' ac-ft below the target by the deadline.');
      } else {
        status = 'ok';
        var a = lo, b = hi;
        for (var k = 0; k < 100; k++) {
          var mid = (a + b) / 2, f = endFor(profile(Q0, mid, Qend, rm, Hh)).Send;
          if (Math.abs(f - St) <= tol / 4 || b - a < 1e-6) { a = b = mid; break; }
          if (f > St) a = mid; else b = mid;
        }
        Qp = (a + b) / 2;
      }
      var rTo = num(opts.roundTo);
      if (rTo && Qp != null && status === 'ok') {
        var Qr = Math.round(Qp / rTo) * rTo;
        if (Qr > hi) Qr -= rTo;
        if (Qr < lo) Qr += rTo;
        if (Qr >= lo && Qr <= hi) { messages.push('Plateau rounded from ' + fmt(Qp, 1) + ' to ' + fmt(Qr) + ' cfs (' + fmt(rTo) + ' cfs steps).'); Qp = Qr; }
      }
      prof = profile(Q0, Qp, Qend, rm, Hh);
    }

    var run = endFor(prof), sim = run.sim;
    var schedule = [], belowMin = [], aboveMax = [], outOfTable = false, released = 0, netReleased = 0;
    for (var i = 0; i <= n; i++) {
      var row = { t: t0 + i * dt * HOUR, S: sim.S[i], E: null };
      if (i < n) {
        row.O = sim.O[i]; row.I = sim.I[i]; row.net = sim.O[i] - sim.I[i];
        released += sim.O[i] * AF_PER_CFS_HR * dt; netReleased += row.net * AF_PER_CFS_HR * dt;
        if (row.O < Qmin - 1e-6) belowMin.push(i);
        if (row.O > Qmax + 1e-6) aboveMax.push(i);
      } else { row.O = prof.at(Hh); row.I = inflowAt(Hh); row.net = row.O - row.I; }
      if (rating) { try { row.E = rating.elev(row.S); } catch (e) { outOfTable = true; } }
      if (sg) row.h = sg.stage(row.O);
      schedule.push(row);
    }
    if (belowMin.length) messages.push(belowMin.length + ' step' + (belowMin.length > 1 ? 's' : '') + ' below the ' + fmt(Qmin) + ' cfs minimum outflow (first at ' + fmtClock(t0 + belowMin[0] * dt * HOUR, t0) + ').');
    if (aboveMax.length) messages.push(aboveMax.length + ' step' + (aboveMax.length > 1 ? 's' : '') + ' above the ' + fmt(Qmax) + ' cfs maximum outflow.');
    if (outOfTable) messages.push('Some storages fall outside the elevation–storage table; their elevations are not shown.');

    var Sfinal = sim.S[n];
    var res = {
      status: status, ok: status === 'ok', messages: messages, label: LABEL,
      Qp: Qp, Q0: Q0, Qend: Qend, QendDefault: QendDefault, ru: ru, rd: rd, dtHr: dt, steps: n, hours: Hh,
      rampUnit: sg ? 'ft/hr at ' + sg.label : 'cfs/hr', stage: sg ? { label: sg.label, src: sg.src } : null,
      tStart: t0, tEnd: t0 + Hh * HOUR,
      tPlateau: prof.a != null ? t0 + prof.a * HOUR : null,
      tRampDown: prof.a != null ? t0 + (prof.a + prof.c) * HOUR : null,
      Sfinal: Sfinal, Efinal: schedule[n].E, St: St,
      released: released, netReleased: netReleased,
      belowMin: belowMin, aboveMax: aboveMax, earliest: earliest,
      schedule: schedule
    };
    res.plain = plainLine(res);
    return res;
  }

  // Earliest deadline (ms) at which the max ramp-limited plateau reaches the target; null within 90 days.
  function earliestTime(opts, St, tol, dt, n0, QendUser, QendDefault, inflowAt, rm, Qmax) {
    var Q0 = +opts.Q0, Qmin = num(opts.Qmin) || 0, S0 = +opts.S0, sg = rm.stage;
    var reaches = function (n) {
      var Hh = n * dt, Qend = QendDefault ? inflowAt(Hh) : QendUser;
      if (sg && (Qend < sg.qMin || Qend > sg.qMax)) return false;
      var r = plateauRange(Q0, Qend, rm, Hh);
      if (!r) return false;
      var hi = Math.min(Qmax, r.hi);
      if (hi < Qmin) return false;
      return simulate(S0, profile(Q0, hi, Qend, rm, Hh), inflowAt, n, dt).S[n] <= St + tol;
    };
    var maxN = Math.round(90 * 24 / dt), lo = n0, hi = n0 + 1;
    while (hi <= maxN && !reaches(hi)) { lo = hi; hi = Math.min(maxN + 1, n0 + (hi - n0) * 2); }
    if (hi > maxN) return null;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (reaches(mid)) hi = mid; else lo = mid; }
    return +opts.t0 + hi * dt * HOUR;
  }

  // ---- Plain-language summary ---------------------------------------------------

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var TZ = 'America/Los_Angeles';
  var fmtParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  function pt(t) { var o = {}; fmtParts.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; }); return o; }
  // "14:00", or "06:00 Tue" when on a different Pacific day than ref.
  function fmtClock(t, ref) {
    var a = pt(t), b = pt(ref == null ? t : ref);
    var hm = (a.hour === '24' ? '00' : a.hour) + ':' + a.minute;
    return a.year + a.month + a.day === b.year + b.month + b.day ? hm : hm + ' ' + a.weekday;
  }

  // "100 cfs/hr" or "0.20 ft/hr at <gage>".
  function rateTxt(r, up) { var v = up ? r.ru : r.rd; return r.stage ? fmt(v, 2) + ' ft/hr at ' + r.stage.label : fmt(v) + ' cfs/hr'; }

  function plainLine(r) {
    var s = [], t0 = r.tStart, end = fmtClock(r.tEnd, t0);
    if (r.status === 'ramp-window') {
      return 'Ramp from ' + fmt(r.Q0) + ' toward ' + fmt(r.Qend) + ' cfs at ' + rateTxt(r, r.Q0 <= r.Qend) + ' for the whole window; reaches ' + fmt(r.schedule[r.steps].O) + ' cfs by ' + end + '.';
    }
    var Qp = Math.round(r.Qp), up = Qp >= r.Q0;
    if (Math.abs(Qp - r.Q0) >= 0.5) s.push('Ramp ' + (up ? 'up' : 'down') + ' from ' + fmt(r.Q0) + ' to ' + fmt(Qp) + ' cfs at ' + rateTxt(r, up) + ' by ' + fmtClock(r.tPlateau, t0));
    else s.push('Start at ' + fmt(Qp) + ' cfs');
    var hasEnd = Math.abs(Qp - r.Qend) >= 0.5;
    if (r.tRampDown > r.tPlateau + 1000) s.push('hold until ' + (hasEnd ? fmtClock(r.tRampDown, t0) : end));
    if (hasEnd) s.push('ramp ' + (Qp > r.Qend ? 'down' : 'up') + ' to ' + fmt(r.Qend) + ' cfs by ' + end);
    return s.join(', ') + '.';
  }

  // ---- Gate openings (2-D outlet ratings: opening × elevation -> flow) -----------------

  /*
   * Opening needed for flow q (cfs) at pool elevation elev, from a published 2-D rating
   * { others: openings ascending, curves: [{ xs: elevations, ys: flows }] } (js/ratings.js).
   * Flow is assumed to increase with opening at a fixed elevation; solved by bisection.
   * Returns { opening, status, qMax } with status:
   *   'ok' | 'closed' (q <= 0) | 'max' (q above the rating at full opening; opening = max) |
   *   'low' (q below the smallest tabulated opening's flow; opening scaled linearly from 0) |
   *   'elev' (elevation outside the rating).
   */
  function gateOpening(rt, elev, q) {
    if (elev == null || !rt || !rt.others || !rt.others.length) return { opening: null, status: 'elev' };
    if (q <= 0) return { opening: 0, status: 'closed' };
    var o = rt.others, f = function (op) { return R.interp2d(rt, op, elev).y; };
    var lo = o[0], hi = o[o.length - 1], fLo = f(lo), fHi = f(hi);
    if (fHi == null) return { opening: null, status: 'elev' };
    if (q > fHi + 1e-6) return { opening: hi, status: 'max', qMax: fHi };
    if (fLo != null && q < fLo) {
      return lo > 0 && fLo > 0 ? { opening: lo * q / fLo, status: 'low' } : { opening: lo, status: 'ok' };
    }
    if (fLo == null) {
      // Smallest openings not rated at this elevation: start from the first one that is.
      var k = 0;
      while (k < o.length && f(o[k]) == null) k++;
      lo = o[k]; fLo = f(lo);
      if (q < fLo) return { opening: lo, status: 'low' };
    }
    for (var i = 0; i < 60 && hi - lo > 1e-4; i++) {
      var mid = (lo + hi) / 2, fm = f(mid);
      if (fm == null || fm < q) lo = mid; else hi = mid;
    }
    return { opening: (lo + hi) / 2, status: 'ok' };
  }

  /*
   * Gate setting for every schedule row. opts = { powerhouse: cfs not through these gates,
   * gates: number of gates opened equally (the rating's flow is per gate), step: opening
   * increment to round to (ft) }. Returns rows [{ q, opening, change, status }] and the list of
   * changes [{ i, opening, change }] (rows where the rounded opening differs from the previous).
   */
  function gateSchedule(schedule, rt, opts) {
    var ph = num(opts && opts.powerhouse) || 0, n = Math.max(1, Math.round(num(opts && opts.gates) || 1)), st = num(opts && opts.step) || 0;
    var round = function (v) { return v == null || !st ? v : +(Math.round(v / st) * st).toFixed(4); };
    var prev = null, changes = [];
    var rows = schedule.map(function (row, i) {
      var q = (row.O - ph) / n, g = gateOpening(rt, row.E, q), op = round(g.opening);
      var change = op != null && prev != null ? op - prev : null;
      if (op != null && (prev == null || Math.abs(op - prev) > 1e-9)) changes.push({ i: i, opening: op, change: change });
      if (op != null) prev = op;
      return { q: q, opening: op, change: change, status: g.status, qMax: g.qMax };
    });
    return { rows: rows, changes: changes, gates: n, powerhouse: ph, step: st };
  }

  return {
    FT3_PER_AF: FT3_PER_AF, AF_PER_CFS_HR: AF_PER_CFS_HR, LABEL: LABEL,
    makeRating: makeRating, convert: convert, profile: profile, plateauRange: plateauRange,
    parseSeries: parseSeries, plan: plan, fmtClock: fmtClock, rampModel: rampModel, stageFromRating: stageFromRating,
    gateOpening: gateOpening, gateSchedule: gateSchedule
  };
});
