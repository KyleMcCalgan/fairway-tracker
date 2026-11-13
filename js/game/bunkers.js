// Bunker generators (docs/game.md 5.6). Pure. All shapes are polygons rounded
// with 2 Chaikin passes, checked against the placement rules as they are made.

import { GEN, CLUBS } from './constants.js';
import { dsin, dcos, PI, DEG } from './math.js';
import { makeNoise } from './rng.js';
import { toWorld } from './centerline.js';
import { chaikin, roundPoly, isSimple, polyDist, polyInside, pointInPoly, distPointPoly } from './geometry.js';
import { blob } from './water.js';

export function buildBunkers(rng, ctx, water) {
  const B = GEN.bunkers;
  const { cl, corr, green, len, par, hEnd } = ctx;
  const d = ctx.difficulty;
  const out = [];
  let groupId = 0;

  const ok = (poly, group) => {
    if (!isSimple(poly)) return false;
    if (!polyInside(poly, ctx.playable, B.obMargin)) return false;
    if (polyDist(poly, ctx.tee, B.teeMin) < B.teeMin) return false;
    if (polyDist(poly, green.poly, B.greenGap) < B.greenGap) return false;
    const cup = green.cup;
    if (distPointPoly(poly, cup[0], cup[1]) < GEN.green.cupHazardMin) return false;
    for (const w of water) if (polyDist(poly, w.poly, B.waterGap) < B.waterGap) return false;
    for (const b of out) {
      if (group && b.group === group) continue;
      if (polyDist(poly, b.poly, B.spacing) < B.spacing) return false;
    }
    return true;
  };

  const place = (kind, maker, tries = 4) => {
    for (let t = 0; t < tries; t++) {
      const poly = maker();
      if (poly && ok(poly, 0)) {
        out.push({ kind, poly });
        return true;
      }
    }
    return false;
  };

  // Strip between two rows of points with single-point ends.
  const strip = (inner, outer) => {
    const n = inner.length - 1;
    const pts = [inner[0]];
    for (let j = 1; j < n; j++) pts.push(outer[j]);
    pts.push(inner[n]);
    for (let j = n - 1; j >= 1; j--) pts.push(inner[j]);
    return roundPoly(chaikin(pts, 2));
  };
  // 0 at the ends, 1 in the middle (half circle): blunt, rounded tips.
  const profile = (u) => Math.sqrt(4 * u * (1 - u));

  const polar = (phi, r) => [green.cx + r * dsin(phi), green.cy + r * dcos(phi)];

  const crescent = (ac) => () => {
    const K = B.crescent;
    const off = rng.range(K.off[0], K.off[1]);
    const depth = rng.range(K.depth[0], K.depth[1]);
    const length = rng.range(K.length[0], K.length[1]);
    const span = length / (green.radiusAt(ac) + off + depth / 2);
    const noise = makeNoise(rng, 0.3);
    const n = 8;
    const inner = [], outer = [];
    for (let j = 0; j <= n; j++) {
      const u = j / n;
      const phi = ac + (u - 0.5) * span;
      const rin = green.radiusAt(phi) + off;
      inner.push(polar(phi, rin));
      outer.push(polar(phi, rin + depth * profile(u) * (1 + 0.2 * noise(u))));
    }
    return strip(inner, outer);
  };

  const pot = (ac) => () => {
    const K = B.pot;
    const r0 = rng.range(K.radius[0], K.radius[1]);
    const c = polar(ac, green.radiusAt(ac) + rng.range(K.off[0], K.off[1]) + r0 * 1.2);
    return blob(rng, c[0], c[1], r0, rng.int(2, 3), 0.14, 10);
  };

  // 2-3 overlapping small blobs around (x, y). All of them must pass.
  const cluster = (x, y, dirPhi) => {
    const K = B.cluster;
    const count = rng.int(K.count[0], K.count[1]);
    const group = ++groupId;
    const polys = [];
    let px = x, py = y;
    for (let i = 0; i < count; i++) {
      const r0 = rng.range(K.radius[0], K.radius[1]);
      const poly = blob(rng, px, py, r0, rng.int(2, 3), 0.12, 10);
      if (!ok(poly, group)) break;
      polys.push(poly);
      const a = dirPhi + rng.range(-0.6, 0.6);
      px += r0 * 1.25 * dsin(a);
      py += r0 * 1.25 * dcos(a);
    }
    if (polys.length < 2) return false;
    for (const poly of polys) out.push({ kind: 'cluster', poly, group });
    return true;
  };

  const sideSign = (side) => (side === 0 ? -1 : 1);

  const guard = (lz, side) => () => {
    const K = B.guard;
    const sc = lz + rng.range(-12, 12);
    const L = rng.range(K.length[0], K.length[1]);
    const depth = rng.range(K.depth[0], K.depth[1]);
    const shift = rng.range(-0.3, 0.45) * depth; // positive is outward, into the rough
    if (!corr.hasFairway || sc - L / 2 < corr.fwStart + 10 || sc + L / 2 > corr.fwEnd - 20) return null;
    const noise = makeNoise(rng, 0.3);
    const n = 8;
    const inner = [], outer = [];
    for (let j = 0; j <= n; j++) {
      const u = j / n;
      const s = sc + (u - 0.5) * L;
      const latC = corr.fwEdge(side, s) + shift;
      const hd = (depth / 2) * profile(u) * (1 + 0.15 * noise(u));
      inner.push(toWorld(cl, s, sideSign(side) * (latC - hd)));
      outer.push(toWorld(cl, s, sideSign(side) * (latC + hd)));
    }
    return strip(inner, outer);
  };

  const cross = () => {
    const K = B.cross;
    const sc = rng.range(265, Math.max(266, Math.min(len - 130, 340)));
    const fl = corr.fwEdge(0, sc), fr = corr.fwEdge(1, sc);
    const width = fl + fr;
    const span = rng.range(K.span[0], K.span[1]) * width;
    const thick = rng.range(K.thick[0], K.thick[1]);
    const mode = rng.next();
    const free = rng.next();
    if (width < 20) return null;
    let a;
    if (mode < 0.3) a = -fl - 1.5; // anchored on the left edge
    else if (mode < 0.6) a = fr + 1.5 - span; // anchored on the right edge
    else a = -fl + free * (width - span);
    const noise = makeNoise(rng, 0.3);
    const n = 8;
    const lo = [], hi = [];
    for (let j = 0; j <= n; j++) {
      const u = j / n;
      const lat = a + u * span;
      const hd = (thick / 2) * profile(u) * (1 + 0.15 * noise(u));
      lo.push(toWorld(cl, sc - hd, lat));
      hi.push(toWorld(cl, sc + hd, lat));
    }
    return strip(lo, hi);
  };

  const scatter = () => {
    const K = B.scatter;
    const r0 = rng.range(K.radius[0], K.radius[1]);
    const s = rng.range(70, Math.max(71, len - green.R - 25));
    const side = rng.int(0, 1);
    const u = rng.next();
    const f = corr.fwNom(side, s);
    const band = corr.obHalf(side, s) - f;
    if (band < 2 * r0 + 9) return null;
    const lat = f + r0 + 3 + u * (band - 2 * r0 - 8);
    const c = toWorld(cl, s, sideSign(side) * lat);
    return blob(rng, c[0], c[1], r0, rng.int(2, 3), 0.14, 10);
  };

  // --- Greenside ---------------------------------------------------------
  const front = hEnd + PI;
  const slots = rng.shuffle([-50, 50, -95, 95, 0, 180]);
  const nGreen = Math.min(3, Math.floor(rng.next() * (1.6 + 2.4 * d) + 0.3));
  for (let i = 0; i < nGreen; i++) {
    const slot = slots[i];
    const ac = front + (slot + rng.range(-15, 15)) * DEG;
    const roll = rng.next();
    if (slot === 180 || roll < 0.25) {
      place('pot', pot(ac));
    } else if (roll < 0.45) {
      const c = polar(ac, green.radiusAt(ac) + 5);
      if (!cluster(c[0], c[1], ac + PI / 2)) place('pot', pot(ac));
    } else {
      place('crescent', crescent(ac));
    }
  }

  // --- Fairway -----------------------------------------------------------
  if (par > 3) {
    const lzFrac = () => rng.range(B.landing[0], B.landing[1]);
    const lz1 = CLUBS.driver.maxCarry * lzFrac();
    const zones = [lz1];
    if (rng.chance(0.25)) zones.push(CLUBS.iron.maxCarry * lzFrac());
    if (par === 5) zones.push(lz1 + rng.range(B.secondShot[0], B.secondShot[1]));
    const nGuard = Math.min(par === 5 ? 3 : 2, Math.floor(rng.next() * (1.2 + 1.6 * d) + 0.2));
    for (let i = 0; i < nGuard; i++) {
      const lz = zones[rng.int(0, zones.length - 1)];
      const side = rng.int(0, 1);
      if (rng.chance(0.2)) {
        const s = lz + rng.range(-10, 10);
        const c = toWorld(cl, s, sideSign(side) * (corr.fwEdge(side, s) + rng.range(0, 4)));
        if (corr.fwEdge(side, s) > 0) cluster(c[0], c[1], ctx.hAt(s));
      } else {
        place('guard', guard(lz, side));
      }
    }
    if (par === 5 && rng.chance(B.cross.chance * (0.5 + d))) place('cross', cross, 3);
  }

  // --- Rough -------------------------------------------------------------
  const nScatter = Math.floor(rng.next() * (1 + 1.5 * d));
  for (let i = 0; i < nScatter; i++) place('scatter', scatter, 3);

  return out;
}

export function isGreenside(b) {
  return b.kind === 'crescent' || b.kind === 'pot';
}

// Share of the fairway width blocked by bunkers on the cross-section through
// centerline point i. `pts` is the hole's centerline array.
export function fairwayBlockAt(hole, i) {
  const pts = hole.centerline;
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.sqrt(dx * dx + dy * dy);
  const nx = dy / l, ny = -dx / l;
  let fw = 0, blocked = 0;
  for (let lat = -60; lat <= 60; lat += 1) {
    const x = pts[i][0] + nx * lat, y = pts[i][1] + ny * lat;
    if (!pointInPoly(hole.fairway, x, y)) continue;
    fw++;
    for (const bk of hole.bunkers) {
      if (pointInPoly(bk.poly, x, y)) { blocked++; break; }
    }
  }
  return fw > 0 ? { fw, blocked } : null;
}
