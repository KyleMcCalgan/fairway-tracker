// Corridor: fairway, rough band and the OB boundary, built in the (s, lat)
// frame of the centerline (docs/game.md 5.3), plus the tee box (5.4). Pure.
// Side index 0 is left (lat < 0), 1 is right (lat > 0).

import { GEN, CLUBS } from './constants.js';
import { dsin, dcos, clamp, lerp, smoothstep } from './math.js';
import { makeNoise } from './rng.js';
import { toWorld } from './centerline.js';
import { roundPoly, removeLoops } from './geometry.js';

function bump(t) {
  if (t <= -1 || t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

// Blunt end cap: 1 at t = 0 falling to 0 at t = 1 (superellipse, exponent 4).
function blunt(t) {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  const t2 = t * t;
  return Math.sqrt(Math.sqrt(1 - t2 * t2));
}

// Round end cap: 0 at t = 0 rising to 1 at t = 1 (quarter circle).
function roundCap(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = 1 - t;
  return Math.sqrt(1 - u * u);
}

export function driverLanding() {
  return CLUBS.driver.maxCarry * (GEN.bunkers.landing[0] + GEN.bunkers.landing[1]) / 2;
}

export function buildCorridor(rng, cl, spec, green) {
  const C = GEN.corridor;
  const len = cl.len;
  const d = spec.difficulty;
  const Rg = green.R;
  const par = spec.par;

  const sMin = -C.behindTee;
  const sMax = 2 * Math.ceil((len + Rg + rng.range(C.behindGreen[0], C.behindGreen[1])) / 2);
  const N = (sMax - sMin) / 2 + 1;

  const total = clamp(lerp(C.fwWidth[1], C.fwWidth[0], d) + rng.range(-3, 3), C.fwWidth[0], C.fwWidth[1]);
  const split = rng.range(C.fwSplit[0], C.fwSplit[1]);
  const base = [total * split, total * (1 - split)];
  const roughBase = lerp(C.rough[1], C.rough[0], d);
  const rough = [
    clamp(roughBase * rng.range(0.8, 1.2), C.rough[0], C.rough[1]),
    clamp(roughBase * rng.range(0.8, 1.2), C.rough[0], C.rough[1]),
  ];
  const nLow = [makeNoise(rng, C.lowWavelength), makeNoise(rng, C.lowWavelength)];
  const nHigh = [makeNoise(rng, C.highWavelength), makeNoise(rng, C.highWavelength)];
  const nOb = [makeNoise(rng, C.obWavelength), makeNoise(rng, C.obWavelength)];

  // Fairway extent.
  const rA = rng.next(), rB = rng.next(), rC = rng.next(), rD = rng.next();
  let hasFairway = true;
  let fwStart = lerp(C.fwStart[0], C.fwStart[1], rA);
  if (par === 3) {
    hasFairway = !spec.safe && rB < C.par3FairwayChance;
    fwStart = len * lerp(C.par3FwStart[0], C.par3FwStart[1], rA);
  }
  const gap = !spec.safe && rC < C.gapChance;
  const fwEnd = gap ? len - Rg - lerp(C.gap[0], C.gap[1], rD) : len - 0.2 * Rg;
  if (fwEnd - fwStart < 3 * C.capLen) hasFairway = false;

  const swellAt = driverLanding();
  const nominal = par === 3 && !hasFairway;

  // Per-side arrays at 2-yard resolution: fairway half-width and OB half-width.
  const fw = [new Array(N), new Array(N)];
  const ob = [new Array(N), new Array(N)];
  const sCap = len + 0.3 * Rg; // the cap behind the green starts here
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < N; i++) {
      const s = sMin + 2 * i;
      let f = nominal
        ? C.par3NominalHalf
        : base[side] * (1 + C.lowNoise * nLow[side](s)) + (par > 3 ? (C.swell / 2) * bump((s - swellAt) / C.swellSpan) : 0);
      let o = f + rough[side] * (1 + C.obNoise * nOb[side](s));
      const g = smoothstep((s - (len - C.greenFlare)) / (C.greenFlare - 25));
      o = Math.max(o, g * (Rg * 1.25 + C.greenSideMargin));
      f = Math.min(f, o - C.minRough);
      if (s < 0) o *= blunt(-s / C.behindTee);
      if (s > sCap) o *= blunt((s - sCap) / (sMax - sCap));
      fw[side][i] = f;
      ob[side][i] = o;
    }
  }

  const sample = (arr, s) => {
    const t = clamp((s - sMin) / 2, 0, N - 1);
    const i = Math.min(N - 2, Math.floor(t));
    return arr[i] + (arr[i + 1] - arr[i]) * (t - i);
  };

  // Nominal fairway half-width (no end caps): where the fairway edge is or would be.
  const fwNom = (side, s) => sample(fw[side], s);
  const obHalf = (side, s) => sample(ob[side], s);

  // Actual fairway half-width including the rounded ends and the neck into the green.
  const fwEdge = (side, s) => {
    if (!hasFairway || s <= fwStart || s >= fwEnd) return 0;
    let f = fwNom(side, s);
    if (!gap) f = lerp(f, Math.min(f, C.greenNeck * Rg), smoothstep((s - (len - 50)) / 40));
    return f * roundCap(Math.min(s - fwStart, fwEnd - s) / C.capLen);
  };

  // Fairway polygon.
  let fairway = [];
  if (hasFairway) {
    const stp = Math.max(4, (fwEnd - fwStart) / 44);
    const caps = [0.8, 2.5, 5, 8, C.capLen];
    const S = [];
    for (const c of caps) S.push(fwStart + c);
    for (let s = fwStart + C.capLen + stp; s < fwEnd - C.capLen - stp / 2; s += stp) S.push(s);
    for (let i = caps.length - 1; i >= 0; i--) S.push(fwEnd - caps[i]);
    const left = [], right = [];
    for (const s of S) {
      const cf = roundCap(Math.min(s - fwStart, fwEnd - s) / C.capLen);
      const wl = fwEdge(0, s) + cf * C.highNoise * nHigh[0](s);
      const wr = fwEdge(1, s) + cf * C.highNoise * nHigh[1](s);
      left.push(toWorld(cl, s, -wl));
      right.push(toWorld(cl, s, wr));
    }
    fairway = roundPoly([toWorld(cl, fwStart, 0), ...left, toWorld(cl, fwEnd, 0), ...right.reverse()]);
  }

  // Playable polygon (the OB line).
  const stepIdx = Math.max(3, Math.ceil(N / 52));
  const pl = [], pr = [];
  for (let i = 1; i < N - 1; i++) {
    if (i % stepIdx !== 0 && i > 3 && i < N - 4) continue;
    const s = sMin + 2 * i;
    pl.push(toWorld(cl, s, -ob[0][i]));
    pr.push(toWorld(cl, s, ob[1][i]));
  }
  // On the inside of a dogleg the offset line folds over itself wherever the
  // offset exceeds the turning radius; cutting the loop out leaves the natural
  // inside corner where the two straight runs of the OB line meet.
  const playable = roundPoly([toWorld(cl, sMin, 0), ...removeLoops(pl), toWorld(cl, sMax, 0), ...removeLoops(pr).reverse()]);

  return { fairway, playable, hasFairway, fwStart, fwEnd, gap, fwNom, fwEdge, obHalf, sMin, sMax };
}

// Small rounded rectangle at the origin, aligned to the initial heading.
export function buildTee(heading) {
  const T = GEN.tee;
  const w = T.halfWidth, l = T.halfLength, r = T.corner;
  const k = 0.7071067811865476; // cos 45 degrees
  const corner = (cx, cy, ax, ay, bx, by) => [
    [cx + r * ax, cy + r * ay],
    [cx + r * k * (ax + bx), cy + r * k * (ay + by)],
    [cx + r * bx, cy + r * by],
  ];
  // Local frame: u across (right), v along the hole.
  const local = [
    ...corner(w - r, l - r, 0, 1, 1, 0),
    ...corner(w - r, -l + r, 1, 0, 0, -1),
    ...corner(-w + r, -l + r, 0, -1, -1, 0),
    ...corner(-w + r, l - r, -1, 0, 0, 1),
  ];
  const c = dcos(heading), s = dsin(heading);
  return roundPoly(local.map(([u, v]) => [u * c + v * s, -u * s + v * c]));
}
