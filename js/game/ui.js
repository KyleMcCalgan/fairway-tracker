// Play view: canvas, HUD, club buttons, the two-tap swing and the shot
// animations for one hole at a time. DOM-touching; all rules and maths come
// from the pure modules.

import { CLUBS, CLUB_ORDER, METER, ANIM, COLORS, PLAY } from './constants.js';
import { bbox } from './geometry.js';
import { maxCarry, carryFor } from './physics.js';
import { newHoleState, applyShot, aimCentre, distToPin, suggestClub } from './rules.js';
import { aimSweepMs, powerSweepMs, aimOffsetDeg, powerFrac, lockAim, lockPower, quantisePower } from './meter.js';
import {
  fitView, lerpView, drawHole, drawBall, drawRangeRing, drawAim, drawPowerBar,
  drawRipple, drawPlop, drawLabel, setupCanvas, sx, sy,
} from './render.js';

// Tiny DOM helper: h('div', { class: 'x', onclick: fn }, child, 'text').
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function reducedMotion() {
  return !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Modal dialog with a title and a Close button. Removed from the DOM on close.
export function openDialog(root, title, content, onClose) {
  const close = h('button', { class: 'hg-btn', type: 'button', text: 'Close' });
  const dlg = h('dialog', { class: 'hg-dialog', 'aria-label': title },
    h('div', { class: 'hg-dialog-head' }, h('h2', { text: title }), close),
    h('div', { class: 'hg-dialog-body' }, content));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  root.append(dlg);
  dlg.showModal();
  return dlg;
}

export function formatVsPar(d) {
  return d === 0 ? 'E' : d > 0 ? '+' + d : '−' + -d;
}

const LIE_NAMES = { tee: 'Tee', fairway: 'Fairway', rough: 'Rough', bunker: 'Bunker', green: 'Green' };
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

// cfg: {
//   settings(): { assist, latencyMs },
//   onAimLocked({ club, angle }),          first tap locked (no redo)
//   onShot(shot, state),                   both taps locked, before the animation
//   onDone(state),                         hole finished, after the animation
// }
export function createPlay(root, cfg) {
  // --- DOM -----------------------------------------------------------------
  const hud = h('div', { class: 'hg-hud', role: 'group', 'aria-label': 'Hole status' });
  const chip = (label) => {
    const v = h('span', { class: 'hg-chip-v' });
    hud.append(h('div', { class: 'hg-chip' }, h('span', { class: 'hg-chip-k', text: label }), v));
    return v;
  };
  const elHole = chip('Hole'), elPar = chip('Par'), elStrokes = chip('Strokes');
  const elPin = chip('To pin'), elWind = chip('Wind'), elLie = chip('Lie');

  const canvas = h('canvas', { class: 'hg-canvas', role: 'img', 'aria-label': 'Course map' });
  const mapBtn = h('button', { class: 'hg-btn hg-mapbtn', type: 'button', 'aria-pressed': 'false', text: 'Whole hole' });
  const cardBox = h('div', { class: 'hg-cardbox', hidden: true });
  const zoomOutBtn = h('button', { class: 'hg-btn hg-zoombtn', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', text: '−' });
  const zoomInBtn = h('button', { class: 'hg-btn hg-zoombtn', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', text: '+' });
  const tools = h('div', { class: 'hg-tools' }, mapBtn, zoomOutBtn, zoomInBtn);
  const stage = h('div', { class: 'hg-stage' }, canvas, tools, cardBox);

  const clubBtns = {};
  const clubRow = h('div', { class: 'hg-clubs', role: 'group', 'aria-label': 'Club' });
  for (const c of CLUB_ORDER) {
    const b = h('button', { class: 'hg-btn hg-club', type: 'button', 'aria-pressed': 'false' },
      h('span', { class: 'hg-club-name', text: CLUBS[c].name }), h('span', { class: 'hg-club-yds' }));
    b.addEventListener('click', () => selectClub(c));
    clubBtns[c] = b;
    clubRow.append(b);
  }
  const swingBtn = h('button', { class: 'hg-btn hg-swing', type: 'button', text: 'Swing' });
  const hint = h('p', { class: 'hg-hint' });
  const controls = h('div', { class: 'hg-controls' }, clubRow, swingBtn, hint);
  const live = h('div', { class: 'hg-sr', 'aria-live': 'polite' });
  const el = h('div', { class: 'hg-play' }, hud, stage, controls, live);
  root.append(el);

  // --- State ---------------------------------------------------------------
  let hole = null, hs = null, holeNo = '', club = 'driver';
  let phase = 'idle'; // idle | intro | ready | aim | power | anim | done
  let gen = 0;        // bumped on load/destroy to cancel running animations
  let armed = null;   // { club, angle }: aim already locked (resumed draft)
  let meter = null;
  let lastLock = -1e9;
  let ctx = null, cw = 0, ch = 0;
  let view = null, viewFrom = null, viewTo = null, viewT0 = 0;
  let bounds = null, boundsMax = 8, overview = false;
  let zoomLvl = 0;    // extra zoom-out steps on the aiming view (display only)
  const ZOOM_STEP = 1.5, ZOOM_MAX = 3;
  let raf = 0, busy = false, destroyed = false;
  const fx = { ball: { x: 0, y: 0, lift: 0, k: 1, show: true }, effects: [], label: null, rings: false };

  const settings = () => (cfg.settings ? cfg.settings() : { assist: false, latencyMs: 0 });
  const stamp = (e) => {
    const now = performance.now();
    const t = e && e.timeStamp;
    return t > 0 && Math.abs(now - t) < 1000 ? t : now;
  };

  // --- Camera --------------------------------------------------------------
  function fit(b) {
    const v = fitView(b, cw, ch, 26);
    if (v.scale > boundsMax) v.scale = boundsMax;
    return v;
  }
  function setBounds(b, animate, maxScale = 8) {
    bounds = b; boundsMax = maxScale;
    if (!cw) return;
    const target = fit(b);
    if (!animate || !view || reducedMotion()) { view = target; viewTo = null; }
    else { viewFrom = view; viewTo = target; viewT0 = performance.now(); }
    kick();
  }
  const holeBounds = () => bbox(hole.playable);
  function greenBounds() {
    const b = bbox(hole.green);
    return { minX: b.minX - 7, minY: b.minY - 7, maxX: b.maxX + 7, maxY: b.maxY + 7 };
  }
  // Frame the ball, the club's range ring ahead of it and the sweep extents.
  function aimBounds() {
    const r = maxCarry(club, hs.lie) * 1.08;
    const c = (armed ? armed.angle : aimCentre(hole, hs.pos, club, hs.lie)) / PLAY.angleUnitsPerDeg;
    const pts = [[hs.pos[0], hs.pos[1]]];
    for (const d of [-METER.aimHalfDeg, -20, 0, 20, METER.aimHalfDeg]) {
      const a = ((c + d) * Math.PI) / 180;
      const k = d === 0 ? r : r * 0.8; // the full ring ahead, most of it out to the sides
      pts.push([hs.pos[0] + k * Math.sin(a), hs.pos[1] + k * Math.cos(a)]);
    }
    const back = (c * Math.PI) / 180;
    pts.push([hs.pos[0] - 0.1 * r * Math.sin(back), hs.pos[1] - 0.1 * r * Math.cos(back)]);
    if (distToPin(hole, hs.pos) < r * 1.25) pts.push([hole.cup[0], hole.cup[1]]);
    const b = bbox(pts);
    if (!zoomLvl) return b;
    // Zoomed out: grow the frame about the ball so more of the hole shows.
    const f = Math.pow(ZOOM_STEP, zoomLvl);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const hw = ((b.maxX - b.minX) / 2) * f, hh = ((b.maxY - b.minY) / 2) * f;
    return { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
  }
  function inView(p, margin) {
    const x = sx(view, p[0]), y = sy(view, p[1]);
    return x > margin && x < cw - margin && y > margin && y < ch - margin;
  }

  // --- Drawing -------------------------------------------------------------
  function draw() {
    if (!hole || !ctx || !view) return;
    const now = performance.now();
    if (viewTo) {
      const t = (now - viewT0) / ANIM.cameraMs;
      if (t >= 1) { view = viewTo; viewTo = null; }
      else view = lerpView(viewFrom, viewTo, t * t * (3 - 2 * t));
    }
    drawHole(ctx, hole, view, { rings: fx.rings });
    const aiming = phase === 'ready' || phase === 'aim' || phase === 'power';
    if (aiming) {
      const range = maxCarry(club, hs.lie);
      drawRangeRing(ctx, view, hs.pos[0], hs.pos[1], range);
      let centre = aimCentre(hole, hs.pos, club, hs.lie) / PLAY.angleUnitsPerDeg;
      let arrow = null, carry = null, locked = false;
      if (phase === 'aim') {
        centre = meter.centre / PLAY.angleUnitsPerDeg;
        arrow = centre + aimOffsetDeg(now - meter.t0, meter.sweepMs);
      } else if (phase === 'power' || armed) {
        const m = phase === 'power' ? meter : armed;
        centre = m.centre != null ? m.centre / PLAY.angleUnitsPerDeg : centre;
        arrow = m.angle / PLAY.angleUnitsPerDeg;
        locked = true;
      }
      let frac = null;
      if (phase === 'power') {
        frac = powerFrac(now - meter.p0, meter.powerMs);
      }
      drawAim(ctx, view, hs.pos[0], hs.pos[1], range, centre, METER.aimHalfDeg, arrow, null, locked);
      if (phase !== 'ready' || armed) {
        drawPowerBar(ctx, view, frac, METER.powerSnap, '', phase === 'power');
      }
    }
    if (fx.ball.show) drawBall(ctx, view, fx.ball.x, fx.ball.y, fx.ball.lift, fx.ball.k);
    for (let i = fx.effects.length - 1; i >= 0; i--) {
      const e = fx.effects[i];
      const p = (now - e.t0) / e.dur;
      if (p >= 1) { fx.effects.splice(i, 1); continue; }
      if (e.type === 'plop') drawPlop(ctx, view, e.x, e.y, p);
      else drawRipple(ctx, view, e.x, e.y, p, e.color, e.size);
    }
    if (fx.label) drawLabel(ctx, view, fx.label.x, fx.label.y, fx.label.text, fx.label.color);
  }
  function kick() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
      if (phase === 'aim' || phase === 'power' || viewTo || busy || fx.effects.length) kick();
    });
  }
  function resize() {
    const r = stage.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    cw = r.width; ch = r.height;
    ctx = setupCanvas(canvas, cw, ch);
    if (bounds) { view = fit(bounds); viewTo = null; }
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  // --- Animation helpers ---------------------------------------------------
  function tween(dur, fn) {
    if (reducedMotion() || dur <= 0) { fn(1); kick(); return Promise.resolve(); }
    const my = gen;
    return new Promise((res) => {
      const t0 = performance.now();
      const step = () => {
        if (my !== gen) return res();
        const p = Math.min(1, (performance.now() - t0) / dur);
        fn(p);
        if (p < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  function effect(type, p, color, dur = ANIM.rippleMs, size = 14) {
    if (reducedMotion()) return; // jump to the end state
    fx.effects.push({ type, x: p[0], y: p[1], t0: performance.now(), dur, color, size });
  }
  const ease = (p) => 1 - (1 - p) * (1 - p);
  const mix = (a, b, p) => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p];
  function setBall(p, lift = 0, k = 1) {
    fx.ball.x = p[0]; fx.ball.y = p[1]; fx.ball.lift = lift; fx.ball.k = k; fx.ball.show = true;
  }
  function say(text) { live.textContent = text; }

  // --- HUD and controls ----------------------------------------------------
  function updateHud() {
    if (!hole) return;
    elHole.textContent = holeNo;
    elPar.textContent = String(hole.par);
    elStrokes.textContent = String(hs.strokes);
    elPin.textContent = hs.done ? '–' : Math.round(distToPin(hole, hs.pos)) + ' yds';
    elLie.textContent = LIE_NAMES[hs.lie] || hs.lie;
    const w = hole.wind;
    elWind.textContent = '';
    if (w.mph > 0) {
      elWind.append(h('span', { class: 'hg-windarrow', style: 'transform: rotate(' + w.dirDeg + 'deg)', 'aria-hidden': 'true', text: '↑' }));
      elWind.append(' ' + w.mph + ' mph');
      elWind.setAttribute('aria-label', w.mph + ' miles per hour, blowing toward the ' + COMPASS[Math.round(w.dirDeg / 45) % 8] + ' of the map');
    } else {
      elWind.textContent = 'Calm';
      elWind.removeAttribute('aria-label');
    }
  }
  function updateControls() {
    const ready = phase === 'ready';
    for (const c of CLUB_ORDER) {
      const b = clubBtns[c];
      b.disabled = !ready || !!armed;
      b.setAttribute('aria-pressed', String(c === club));
      b.querySelector('.hg-club-yds').textContent = hole && !hs.done ? Math.round(maxCarry(c, hs.lie)) + ' yds' : '–';
    }
    mapBtn.disabled = !ready;
    const zoomable = ready || phase === 'aim' || phase === 'power';
    zoomOutBtn.disabled = !zoomable || overview || zoomLvl >= ZOOM_MAX;
    zoomInBtn.disabled = !zoomable || overview || zoomLvl <= 0;
    mapBtn.setAttribute('aria-pressed', String(overview));
    let label = 'Swing', text = '';
    if (phase === 'aim') { label = 'Lock aim'; text = 'Tap anywhere, or press Space, to lock the direction.'; }
    else if (phase === 'power') { label = 'Lock power'; text = 'Tap again to lock the power.'; }
    else if (ready && armed) { label = 'Set power'; text = 'Your aim is already locked. Start the power bar when ready.'; }
    else if (ready) text = 'Pick a club, then Swing. Two taps: direction, then power.';
    swingBtn.textContent = label;
    swingBtn.setAttribute('aria-disabled', String(!(ready || phase === 'aim' || phase === 'power')));
    hint.textContent = text;
  }

  // --- Flow ----------------------------------------------------------------
  function toReady(animate) {
    phase = 'ready';
    overview = false;
    if (!armed) club = suggestClub(hole, hs.pos, hs.lie);
    setBall(hs.pos);
    fx.rings = false;
    fx.label = null;
    setBounds(aimBounds(), animate);
    updateHud();
    updateControls();
    kick();
  }

  function selectClub(c) {
    if (phase !== 'ready' || armed) return;
    club = c;
    overview = false;
    setBounds(aimBounds(), true);
    updateControls();
  }

  function toggleOverview() {
    if (phase !== 'ready') return;
    overview = !overview;
    setBounds(overview ? holeBounds() : aimBounds(), true);
    updateControls();
  }

  function zoomBy(d) {
    if (!(phase === 'ready' || phase === 'aim' || phase === 'power') || overview) return;
    zoomLvl = Math.max(0, Math.min(ZOOM_MAX, zoomLvl + d));
    setBounds(aimBounds(), true);
    updateControls();
  }

  function beginPower(ts) {
    meter.p0 = ts + METER.powerDelayMs;
    meter.powerMs = powerSweepMs(settings().assist);
    phase = 'power';
    updateControls();
    kick();
  }

  function startSwing(ts) {
    if (phase !== 'ready' || ts - lastLock < 400) return;
    if (overview) { overview = false; setBounds(aimBounds(), false); }
    if (armed) {
      meter = { centre: null, angle: armed.angle };
      club = armed.club;
      armed = null;
      beginPower(ts);
    } else {
      meter = {
        centre: aimCentre(hole, hs.pos, club, hs.lie),
        sweepMs: aimSweepMs(club, hs.lie, settings().assist),
        t0: ts,
      };
      phase = 'aim';
      updateControls();
      kick();
    }
    swingBtn.focus({ preventScroll: true });
  }

  // One of the two taps. Uses the input event's timestamp, never a frame count.
  function lock(ts) {
    const latency = settings().latencyMs || 0;
    if (phase === 'aim') {
      if (ts - meter.t0 < METER.minTapGapMs) return;
      meter.angle = lockAim(meter.centre, Math.max(0, ts - meter.t0 - latency), meter.sweepMs);
      lastLock = ts;
      if (cfg.onAimLocked) cfg.onAimLocked({ club, angle: meter.angle });
      beginPower(ts);
    } else if (phase === 'power') {
      if (ts - meter.p0 < METER.minTapGapMs) return; // also ignores taps during the start delay
      const power = lockPower(Math.max(0, ts - meter.p0 - latency), meter.powerMs);
      lastLock = ts;
      shoot({ club, angle: meter.angle, power });
    }
  }

  async function shoot(input) {
    const my = gen;
    const r = applyShot(hole, hs, input);
    const o = r.outcome;
    hs = r.state;
    phase = 'anim';
    meter = null;
    busy = true;
    updateControls();
    if (cfg.onShot) cfg.onShot(hs.shots[hs.shots.length - 1], hs);
    try {
      await animate(o, my);
    } finally {
      if (my === gen) busy = false;
    }
    if (my !== gen) return;
    updateHud();
    if (hs.done) {
      phase = 'done';
      updateControls();
      if (cfg.onDone) cfg.onDone(hs);
    } else {
      toReady(true);
      say(describe(o));
    }
  }

  function describe(o) {
    const where = Math.round(distToPin(hole, hs.pos)) + ' yards to the pin';
    if (o.result === 'ob') return 'Out of bounds. One stroke penalty. Hit again from the same spot, ' + where + '.';
    if (o.result === 'water') return 'In the water. One stroke penalty. Hit again from the same spot, ' + where + '.';
    return (LIE_NAMES[hs.lie] || hs.lie) + ', ' + where + '.';
  }

  async function animate(o, my) {
    const alive = () => my === gen;
    // Keep the landing point on screen.
    if (!inView(o.landing, 30) || !inView(o.rest, 30)) {
      const b = bbox([o.from, o.landing, o.rest]);
      setBounds({ minX: b.minX - 25, minY: b.minY - 25, maxX: b.maxX + 25, maxY: b.maxY + 25 }, true, view.scale);
    }
    kick();
    const flight = Math.min(ANIM.flightMaxMs, ANIM.flightBaseMs + ANIM.flightPerYardMs * o.carry);
    await tween(flight, (p) => setBall(mix(o.from, o.landing, p), Math.sin(Math.PI * p)));
    if (!alive()) return;
    const lostAtLanding = o.roll === 0 && (o.result === 'ob' || o.result === 'water');
    if (!lostAtLanding) {
      effect('ripple', o.landing, '#ffffff');
      const d = Math.hypot(o.rest[0] - o.landing[0], o.rest[1] - o.landing[1]);
      if (d > 0.3) await tween(Math.max(180, Math.min(ANIM.rollMs, d * 40)), (p) => setBall(mix(o.landing, o.rest, ease(p))));
      else setBall(o.rest);
      if (!alive()) return;
    }
    const hold = (ms) => wait(reducedMotion() ? Math.min(ms, 700) : ms);

    if (o.result === 'ob' || o.result === 'water') {
      const water = o.result === 'water';
      if (water) { fx.ball.show = false; effect('plop', o.rest, '#fff', ANIM.rippleMs * 1.6); }
      else effect('ripple', o.rest, COLORS.penalty, ANIM.rippleMs * 1.4, 20);
      fx.label = { x: o.rest[0], y: o.rest[1], text: water ? 'Water +1' : 'OB +1', color: water ? '#bfe3ff' : '#ffb3b5' };
      say(water ? 'Water. Plus one.' : 'Out of bounds. Plus one.');
      kick();
      await hold(ANIM.penaltyMs);
      if (!alive()) return;
      fx.label = null;
      // Pop back to where it was hit from.
      if (!inView(o.from, 30)) setBounds(aimBounds(), true);
      await tween(220, (p) => setBall(o.from, 0, 0.3 + 0.7 * p));
    } else if (o.result === 'holed') {
      effect('ripple', hole.cup, '#ffffff', ANIM.holedMs, 26);
      fx.label = { x: hole.cup[0], y: hole.cup[1], text: hs.shots.length === 1 && !hs.penalties ? 'Hole in one!' : 'Holed out!' };
      say('Holed out.');
      await tween(260, (p) => setBall(mix(o.rest, hole.cup, p), 0, 1 - p));
      fx.ball.show = false;
      kick();
      await hold(ANIM.holedMs);
    } else if (hs.lie === 'green') {
      fx.rings = true;
      setBounds(greenBounds(), true, 16);
      await hold(reducedMotion() ? 0 : ANIM.cameraMs);
      if (!alive()) return;
      fx.label = { x: o.rest[0], y: o.rest[1], text: o.putts === 1 ? '1 putt' : o.putts + ' putts' };
      say('On the green. ' + (o.putts === 1 ? 'One putt.' : o.putts + ' putts.'));
      kick();
      await hold(ANIM.labelMs);
      if (!alive()) return;
      await tween(ANIM.puttMs, (p) => setBall(mix(o.rest, hole.cup, ease(p)), 0, p > 0.92 ? Math.max(0, (1 - p) / 0.08) : 1));
      fx.ball.show = false;
      effect('ripple', hole.cup, '#ffffff', ANIM.rippleMs, 16);
      kick();
      await hold(350);
    } else {
      await hold(200);
    }
    if (!alive()) return;
    if (hs.pickedUp) {
      fx.label = { x: hs.pos[0], y: hs.pos[1], text: 'Picked up at ' + PLAY.strokeCap, color: '#ffb3b5' };
      say('Stroke limit reached. Picked up at ' + PLAY.strokeCap + '.');
      kick();
      await hold(ANIM.labelMs);
    }
    fx.label = null;
    kick();
  }

  // --- Input ---------------------------------------------------------------
  const live2 = () => phase === 'aim' || phase === 'power';
  canvas.addEventListener('pointerdown', (e) => {
    if (!live2()) return;
    e.preventDefault();
    lock(stamp(e));
  });
  swingBtn.addEventListener('pointerdown', (e) => {
    if (!live2()) return;
    e.preventDefault();
    lock(stamp(e));
  });
  swingBtn.addEventListener('click', (e) => { if (phase === 'ready') startSwing(stamp(e)); });
  mapBtn.addEventListener('click', toggleOverview);
  zoomOutBtn.addEventListener('click', () => zoomBy(1));
  zoomInBtn.addEventListener('click', () => zoomBy(-1));

  function onKey(e) {
    if (destroyed || e.repeat || !el.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    const tap = k === ' ' || k === 'Enter' || k === 'Spacebar';
    if (live2()) {
      if (tap) { e.preventDefault(); lock(stamp(e)); }
      return;
    }
    if (phase !== 'ready') return;
    const t = e.target;
    const onControl = t && t.closest && t.closest('button, a, input, select, textarea, summary');
    if (tap && !onControl) { e.preventDefault(); startSwing(stamp(e)); }
    else if ((!onControl || el.contains(t)) && (k === '1' || k === '2' || k === '3')) selectClub(CLUB_ORDER[Number(k) - 1]);
  }
  document.addEventListener('keydown', onKey);

  // --- Public API ----------------------------------------------------------
  function load(newHole, opts = {}) {
    gen++;
    hole = newHole;
    hs = opts.state || newHoleState();
    holeNo = String(opts.holeNo || '');
    armed = opts.pendingAim ? { club: opts.pendingAim.club, angle: opts.pendingAim.angle } : null;
    if (armed) club = armed.club;
    meter = null; busy = false; overview = false; zoomLvl = 0;
    fx.effects.length = 0; fx.label = null; fx.rings = false;
    hideCard();
    setBall(hs.pos);
    canvas.setAttribute('aria-label', 'Course map: par ' + hole.par + ', ' + hole.lengthYds + ' yards');
    phase = 'intro';
    view = null;
    resize();
    setBounds(holeBounds(), false);
    updateHud();
    updateControls();
    say('Hole ' + holeNo + '. Par ' + hole.par + ', ' + hole.lengthYds + ' yards.');
    const my = gen;
    const fresh = hs.shots.length === 0 && !armed;
    setTimeout(() => { if (my === gen && phase === 'intro') toReady(true); }, fresh && !reducedMotion() ? ANIM.introMs : 0);
  }

  function showCard(node) {
    cardBox.textContent = '';
    cardBox.append(node);
    cardBox.hidden = false;
    const b = cardBox.querySelector('[data-primary]');
    if (b) b.focus({ preventScroll: true });
  }
  function hideCard() {
    cardBox.hidden = true;
    cardBox.textContent = '';
  }

  function destroy() {
    destroyed = true;
    gen++;
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    if (raf) cancelAnimationFrame(raf);
    el.remove();
  }

  return {
    load, showCard, hideCard, destroy,
    get phase() { return phase; },
    get state() { return hs; },
    // Test hooks: let an automated check drive the two taps at chosen meter times.
    debug: { startSwing, lock, selectClub, meter: () => meter },
  };
}

// Colour family for a hole result: eagle, birdie, par, bogey, double or bad.
export function toneFor(strokes, par, state) {
  if (state && state.pickedUp) return 'bad';
  if (strokes === 1) return 'eagle';
  const d = strokes - par;
  return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : d === 2 ? 'double' : 'bad';
}

// Result card shown over the map when a hole ends. A coloured header says how
// it went, tiles give the numbers, then any notes and the actions.
//   { title, tone, subtitle, tiles: [[label, value], ...], lines, extra, actions }
export function resultCard({ title, tone, subtitle, tiles, lines, extra, actions }) {
  const btns = (actions || []).map((a) => {
    const b = h('button', { class: 'hg-btn' + (a.primary ? ' hg-primary' : ''), type: 'button', text: a.label });
    if (a.primary) b.setAttribute('data-primary', '');
    b.addEventListener('click', a.onClick);
    return b;
  });
  return h('div', { class: 'hg-card hg-tone-' + (tone || 'par'), role: 'group', 'aria-label': 'Hole result' },
    h('div', { class: 'hg-card-head' },
      h('h2', { text: title }),
      subtitle ? h('p', { text: subtitle }) : null),
    h('div', { class: 'hg-card-body' },
      tiles && tiles.length ? h('div', { class: 'hg-tiles' }, tiles.map(([k, v]) =>
        h('div', { class: 'hg-tile' }, h('b', { text: String(v) }), h('span', { text: k })))) : null,
      (lines || []).map((l) => h('p', { class: 'hg-note', text: l })),
      extra || null,
      h('div', { class: 'hg-actions' }, btns)));
}
