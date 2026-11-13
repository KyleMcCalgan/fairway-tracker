// Water generators: crossing stream, side river, greenside pond
// (docs/game.md 5.7). Pure. Every shape is checked on placement and dropped
// if it breaks a rule, so a bad roll costs a feature, not the whole hole.

import { GEN } from './constants.js';
import { dsin, dcos, PI, TAU, DEG, lerp } from './math.js';
import { makeNoise } from './rng.js';
import { clPos, clHeading, toWorld } from './centerline.js';
import { driverLanding } from './corridor.js';
import { chaikin, roundPoly, isSimple, polyDist, polyInside, pointInPoly, distPointPoly } from './geometry.js';

// Irregular closed blob around (cx, cy): a circle with a few lobes.
export function blob(rng, cx, cy, r0, lobes, amp, n) {
  const ph = rng.range(0, TAU);
  const ph2 = rng.range(0, TAU);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = r0 * (1 + amp * dcos(lobes * a + ph) + 0.4 * amp * dcos((lobes + 1) * a + ph2));
    pts.push([cx + r * dsin(a), cy + r * dcos(a)]);
  }
  return roundPoly(chaikin(pts, 2));
}

function makeStream(rng, ctx) {
  const W = GEN.water.stream;
  const { cl, corr, green, len, par } = ctx;
  const nearGreen = par === 3 || rng.chance(0.5);
  const back = rng.range(W.shortOfGreen[0], W.shortOfGreen[1]);
  let sc = driverLanding() + rng.range(-8, 12);
  if (nearGreen || sc > len - green.R - W.shortOfGreen[0]) sc = len - green.R - back;
  if (sc < W.teeMin) return null;

  const p = clPos(cl, sc);
  const h = clHeading(cl, sc);
  const tx = dsin(h), ty = dcos(h); // along the hole
  const nx = dcos(h), ny = -dsin(h); // across, to the right
  const uL = corr.obHalf(0, sc) + W.overhang;
  const uR = corr.obHalf(1, sc) + W.overhang;
  const meander = makeNoise(rng, 45);
  const amp = rng.range(W.meander[0], W.meander[1]);
  const slant = rng.range(-0.2, 0.2);
  const wNoise = makeNoise(rng, 35);
  const wMax = rng.range(5.5, W.width[1]);
  const upper = [], lower = [];
  const n = Math.ceil((uL + uR) / 5);
  for (let i = 0; i <= n; i++) {
    const u = -uL + ((uL + uR) * i) / n;
    const m = amp * meander(u) + slant * u;
    const w = lerp(W.width[0], wMax, 0.5 + 0.5 * wNoise(u));
    upper.push([p[0] + nx * u + tx * (m + w / 2), p[1] + ny * u + ty * (m + w / 2)]);
    lower.push([p[0] + nx * u + tx * (m - w / 2), p[1] + ny * u + ty * (m - w / 2)]);
  }
  const poly = roundPoly([...upper, ...lower.reverse()]);
  // Must span the corridor: both ends beyond the OB line.
  const pl = ctx.playable;
  const a = upper[0], b = upper[upper.length - 1];
  if (pointInPoly(pl, a[0], a[1]) || pointInPoly(pl, b[0], b[1])) return null;
  // A dry lay-up spot must exist short of it.
  const lay = clPos(cl, sc - GEN.check.layupBack - amp);
  if (pointInPoly(poly, lay[0], lay[1]) || !pointInPoly(pl, lay[0], lay[1])) return null;
  return poly;
}

function makeRiver(rng, ctx) {
  const W = GEN.water.river;
  const { cl, corr, green, len } = ctx;
  const side = rng.int(0, 1);
  const sgn = side === 0 ? -1 : 1;
  const off = rng.range(W.off[0], W.off[1]);
  const wMax = rng.range(W.width[0], W.width[1]);
  let L = rng.range(W.length[0], W.length[1]);
  const sLo = W.teeMin, sHi = len - green.R - W.greenGap;
  if (sHi - sLo < W.length[0]) return null;
  if (L > sHi - sLo) L = sHi - sLo;
  const s0 = rng.range(sLo, sHi - L);
  const meander = makeNoise(rng, 60);
  const wNoise = makeNoise(rng, 50);
  const inner = [], outer = [];
  const n = Math.ceil(L / 6);
  for (let i = 1; i < n; i++) {
    const s = s0 + (L * i) / n;
    const dEnd = Math.min(s - s0, s0 + L - s);
    const tt = dEnd >= W.taper ? 1 : dEnd / W.taper;
    const taper = Math.sqrt(1 - (1 - tt) * (1 - tt));
    const lin = corr.fwNom(side, s) + off + 3 * meander(s);
    let w = wMax * taper * (1 + 0.15 * wNoise(s));
    const room = corr.obHalf(side, s) - W.obMargin - lin;
    if (w > room) w = room;
    if (tt >= 1 && w < W.width[0]) return null; // would swallow the rough band
    if (w < 0.6) return null;
    inner.push(toWorld(cl, s, sgn * lin));
    outer.push(toWorld(cl, s, sgn * (lin + w)));
  }
  const e0 = toWorld(cl, s0, sgn * (corr.fwNom(side, s0) + off + 3 * meander(s0)));
  const e1 = toWorld(cl, s0 + L, sgn * (corr.fwNom(side, s0 + L) + off + 3 * meander(s0 + L)));
  return roundPoly(chaikin([e0, ...inner, e1, ...outer.reverse()], 1));
}

function makePond(rng, ctx) {
  const W = GEN.water.pond;
  const { green, hEnd } = ctx;
  // Front or side of the green, never behind: within +/-spread of the tee-ward direction.
  const ang = hEnd + PI + rng.range(-W.spread, W.spread) * DEG;
  const r0 = rng.range(W.radius[0], W.radius[1]);
  const off = rng.range(W.off[0], W.off[1]);
  const dc = green.radiusAt(ang) + off + r0 * 1.12;
  const cx = green.cx + dc * dsin(ang), cy = green.cy + dc * dcos(ang);
  if (!pointInPoly(ctx.playable, cx, cy)) return null;
  return blob(rng, cx, cy, r0, rng.int(2, 3), 0.12, 12);
}

function okWater(poly, kind, ctx, placed) {
  const W = GEN.water;
  if (!isSimple(poly)) return false;
  const teeGap = kind === 'stream' ? W.stream.teeMin - 20 : W.teeGap;
  if (polyDist(poly, ctx.tee, teeGap) < teeGap) return false;
  const greenGap = kind === 'stream' ? W.stream.greenGap : W.greenGap;
  if (polyDist(poly, ctx.green.poly, greenGap) < greenGap) return false;
  const cup = ctx.green.cup;
  if (pointInPoly(poly, cup[0], cup[1]) || distPointPoly(poly, cup[0], cup[1]) < GEN.green.cupHazardMin) return false;
  for (const w of placed) if (polyDist(poly, w.poly, W.waterGap) < W.waterGap) return false;
  if (kind !== 'stream' && !polyInside(poly, ctx.playable, 2)) return false;
  return true;
}

export function buildWater(rng, ctx) {
  const W = GEN.water;
  const out = [];
  if (!rng.chance(W.anyChance)) return out;
  const count = rng.chance(W.secondChance) ? 2 : 1;
  let kinds = W.kindWeights.slice();
  const makers = { stream: makeStream, river: makeRiver, pond: makePond };
  for (let c = 0; c < count; c++) {
    const kind = rng.weighted(kinds);
    kinds = kinds.filter((k) => k[0] !== kind);
    for (let attempt = 0; attempt < 6; attempt++) {
      const poly = makers[kind](rng, ctx);
      if (poly && okWater(poly, kind, ctx, out)) {
        out.push({ kind, poly });
        break;
      }
    }
  }
  return out;
}
