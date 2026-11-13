// Centerline by heading integration (docs/game.md 5.2). Pure.
// Headings: 0 is +y, positive turns clockwise (toward +x, the player's right).

import { GEN } from './constants.js';
import { dsin, dcos, DEG, clamp, smoothstep } from './math.js';
import { makeNoise } from './rng.js';

export function buildCenterline(rng, par, length, archetype) {
  const C = GEN.centerline;
  const step = C.step;
  const n = Math.round(length / step);
  const len = n * step;
  const bends = [];

  // A dogleg: turn through `turnDeg` with a smoothstep ramp centred near `centre`.
  // The ramp is long enough that the tightest radius stays above C.minRadius
  // (peak curvature of a smoothstep ramp is 1.5 * turn / length).
  const addBend = (turnDeg, centre, stretch) => {
    const turn = turnDeg * DEG;
    const mag = turn < 0 ? -turn : turn;
    const L = clamp(1.5 * C.minRadius * mag * stretch, C.rampMin, C.rampMax);
    const c = Math.min(centre, len - C.bendEndMargin - L / 2);
    bends.push({ a: c - L / 2, L, turn });
  };

  const r1 = rng.next(), r2 = rng.next(), r3 = rng.next(), r4 = rng.next(), r5 = rng.next(), r6 = rng.next();
  const pickIn = (band, r) => band[0] + (band[1] - band[0]) * r;

  if (archetype === 'gentle') {
    const turn = (r1 < 0.5 ? -1 : 1) * pickIn(C.gentleTurn, r2) * DEG;
    const L = Math.min(pickIn(C.gentleRamp, r3), len * 0.6);
    const c = len * (0.4 + 0.2 * r4);
    bends.push({ a: c - L / 2, L, turn });
  } else if (archetype === 'dogleg-left' || archetype === 'dogleg-right') {
    const dir = archetype === 'dogleg-left' ? -1 : 1;
    let centre = pickIn(C.cornerAt, r2);
    if (par === 5 && r3 < 0.4) centre = len - pickIn(C.secondCornerBack, r4);
    addBend(dir * pickIn(C.doglegTurn, r1), centre, 1 + 0.25 * r5);
  } else if (archetype === 's-curve') {
    const dir = r1 < 0.5 ? -1 : 1;
    addBend(dir * pickIn(C.sTurn, r2), pickIn(C.cornerAt, r3), 1 + 0.25 * r5);
    addBend(-dir * pickIn(C.sTurn, r4), len - pickIn(C.secondCornerBack, r6), 1 + 0.25 * r5);
  }

  // Start heading chosen so the tee-to-green chord points roughly along +y.
  let h0 = 0;
  for (const b of bends) h0 -= b.turn * (1 - (b.a + b.L / 2) / len);

  const drift = makeNoise(rng, C.driftWavelength);
  const driftAmp = rng.range(C.driftDeg[0], C.driftDeg[1]) * DEG;
  const drift0 = drift(0);
  const heading = (s) => {
    let h = h0 + driftAmp * (drift(s) - drift0);
    for (const b of bends) h += b.turn * smoothstep((s - b.a) / b.L);
    return h;
  };

  const xs = new Array(n + 1), ys = new Array(n + 1), hs = new Array(n + 1);
  xs[0] = 0; ys[0] = 0;
  for (let i = 0; i <= n; i++) hs[i] = heading(i * step);
  for (let i = 0; i < n; i++) {
    const h = heading((i + 0.5) * step);
    xs[i + 1] = xs[i] + step * dsin(h);
    ys[i + 1] = ys[i] + step * dcos(h);
  }
  return { step, n, len, xs, ys, hs };
}

export function clHeading(cl, s) {
  if (s <= 0) return cl.hs[0];
  if (s >= cl.len) return cl.hs[cl.n];
  const t = s / cl.step;
  const i = Math.floor(t);
  return cl.hs[i] + (cl.hs[i + 1] - cl.hs[i]) * (t - i);
}

// Position at distance s along the centerline; extends straight beyond both ends.
export function clPos(cl, s) {
  if (s <= 0) {
    const h = cl.hs[0];
    return [s * dsin(h), s * dcos(h)];
  }
  if (s >= cl.len) {
    const h = cl.hs[cl.n];
    return [cl.xs[cl.n] + (s - cl.len) * dsin(h), cl.ys[cl.n] + (s - cl.len) * dcos(h)];
  }
  const t = s / cl.step;
  const i = Math.floor(t);
  const f = t - i;
  return [cl.xs[i] + (cl.xs[i + 1] - cl.xs[i]) * f, cl.ys[i] + (cl.ys[i + 1] - cl.ys[i]) * f];
}

// World position of (s, lat): lat is the sideways offset, positive to the right.
export function toWorld(cl, s, lat) {
  const p = clPos(cl, s);
  const h = clHeading(cl, s);
  return [p[0] + lat * dcos(h), p[1] - lat * dsin(h)];
}

// Curvature (1/yards) at node i; positive turns right. Zero beyond the ends.
export function clCurvatureAt(cl, s) {
  if (s <= 0 || s >= cl.len) return 0;
  const i = Math.round(s / cl.step);
  const a = cl.hs[Math.max(0, i - 1)];
  const b = cl.hs[Math.min(cl.n, i + 1)];
  return (b - a) / (2 * cl.step);
}
