// Hole validation (docs/game.md 5.9). Pure. Works on the plain hole JSON only,
// so the same checks can run on a stored hole. Returns { ok, errors }.

import { GEN, GEN_VERSION } from './constants.js';
import { isSimple, pointInPoly, distPointPoly, polyDist, polyInside, polysIntersect, bbox } from './geometry.js';
import { surfaceAt } from './physics.js';
import { fairwayBlockAt } from './bunkers.js';

export function validateHole(hole) {
  const K = GEN.check;
  const errors = [];
  const fail = (code) => { errors.push(code); };
  const pl = hole.playable;

  // --- Spec ----------------------------------------------------------------
  if (hole.version !== GEN_VERSION) fail('version');
  const band = GEN.lengthBands[hole.par];
  if (!band || hole.lengthYds < band[0] || hole.lengthYds > band[1]) fail('length-band');
  if (hole.water.length > 2) fail('water-budget');

  // --- Polygons are simple -------------------------------------------------
  if (!isSimple(pl)) fail('playable-not-simple');
  if (!isSimple(hole.tee)) fail('tee-not-simple');
  if (!isSimple(hole.green)) fail('green-not-simple');
  if (hole.fairway.length && !isSimple(hole.fairway)) fail('fairway-not-simple');
  for (const b of hole.bunkers) if (!isSimple(b.poly)) fail('bunker-not-simple');
  for (const w of hole.water) if (!isSimple(w.poly)) fail('water-not-simple');
  if (errors.length) return { ok: false, errors };

  // --- Centerline: always advancing, curvature within limits -----------------
  const cl = hole.centerline;
  for (let i = 1; i < cl.length; i++) {
    if (!(cl[i][1] > cl[i - 1][1])) { fail('centerline-not-advancing'); break; }
  }
  const span = 5; // 10 yards either side
  const kMax = 1 / (GEN.centerline.minRadius * K.radiusSlack);
  for (let i = span; i < cl.length - span; i++) {
    const ax = cl[i][0] - cl[i - span][0], ay = cl[i][1] - cl[i - span][1];
    const bx = cl[i + span][0] - cl[i][0], by = cl[i + span][1] - cl[i][1];
    const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
    const sinTurn = (ax * by - ay * bx) / (la * lb);
    const kappa = Math.abs(sinTurn) / ((la + lb) / 2);
    if (kappa > kMax) { fail('curvature'); break; }
  }

  // --- Tee, cup, green, fairway well inside the OB line ----------------------
  const cup = hole.cup;
  if (surfaceAt(hole, 0, 0) !== 'tee') fail('tee-surface');
  if (!polyInside(hole.tee, pl, K.teeOb)) fail('tee-near-ob');
  if (!pointInPoly(hole.green, cup[0], cup[1]) || distPointPoly(hole.green, cup[0], cup[1]) < K.cupEdge) fail('cup-edge');
  if (surfaceAt(hole, cup[0], cup[1]) !== 'green') fail('cup-surface');
  if (!pointInPoly(pl, cup[0], cup[1]) || distPointPoly(pl, cup[0], cup[1]) < K.cupOb) fail('cup-near-ob');
  if (!polyInside(hole.green, pl, K.greenOb)) fail('green-near-ob');
  if (hole.fairway.length && !polyInside(hole.fairway, pl, K.fairwayOb)) fail('fairway-near-ob');
  if (polyDist(hole.tee, hole.green, 40) < 40) fail('tee-green');
  if (!(hole.rings[0] > 0 && hole.rings[1] > hole.rings[0])) fail('rings');

  // --- Bunkers -------------------------------------------------------------
  const cupMin = hole.meta.shortSided ? K.cupHazardShort : K.cupHazard;
  for (let i = 0; i < hole.bunkers.length; i++) {
    const b = hole.bunkers[i];
    if (!polyInside(b.poly, pl, K.bunkerOb)) fail('bunker-ob');
    if (polyDist(b.poly, hole.tee, K.bunkerTee) < K.bunkerTee) fail('bunker-tee');
    if (polyDist(b.poly, hole.green, K.bunkerGreen) < K.bunkerGreen) fail('bunker-green');
    if (distPointPoly(b.poly, cup[0], cup[1]) < cupMin) fail('bunker-cup');
    for (const w of hole.water) if (polyDist(b.poly, w.poly, K.bunkerWater) < K.bunkerWater) fail('bunker-water');
    for (let j = i + 1; j < hole.bunkers.length; j++) {
      const o = hole.bunkers[j];
      if (b.group && b.group === o.group) continue;
      if (polyDist(b.poly, o.poly, K.bunkerGap) < K.bunkerGap) fail('bunker-spacing');
    }
  }

  // Never block more than half the fairway width at any s.
  if (hole.fairway.length) {
    const near = [];
    for (const b of hole.bunkers) if (polysIntersect(b.poly, hole.fairway)) near.push(bbox(b.poly));
    if (near.length) {
      for (let i = 0; i < cl.length; i++) {
        const x = cl[i][0], y = cl[i][1];
        let close = false;
        for (const bb of near) {
          if (x > bb.minX - 70 && x < bb.maxX + 70 && y > bb.minY - 70 && y < bb.maxY + 70) { close = true; break; }
        }
        if (!close) continue;
        const r = fairwayBlockAt(hole, i);
        if (r && r.fw >= 8 && r.blocked > GEN.bunkers.maxFairwayBlock * r.fw + 1) { fail('fairway-blocked'); break; }
      }
    }
  }

  // --- Water ---------------------------------------------------------------
  for (const w of hole.water) {
    if (polyDist(w.poly, hole.tee, K.waterTee) < K.waterTee) fail('water-tee');
    if (polyDist(w.poly, hole.green, K.waterGreen) < K.waterGreen) fail('water-green');
    if (pointInPoly(w.poly, cup[0], cup[1]) || distPointPoly(w.poly, cup[0], cup[1]) < cupMin) fail('water-cup');
    if (w.kind === 'stream') {
      // It must cross the centerline, reach beyond OB on both sides, and
      // leave a dry lay-up spot short of it.
      let first = -1;
      for (let i = 0; i < cl.length; i++) {
        if (pointInPoly(w.poly, cl[i][0], cl[i][1])) { first = i; break; }
      }
      if (first < 0) { fail('stream-misses-centerline'); continue; }
      const a = cl[Math.max(0, first - 3)], b = cl[Math.min(cl.length - 1, first + 3)];
      let left = false, right = false;
      for (const p of w.poly) {
        if (pointInPoly(pl, p[0], p[1])) continue;
        const side = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if (side > 0) left = true; else right = true;
      }
      if (!left || !right) fail('stream-does-not-span');
      const li = first - Math.round(K.layupBack / 2);
      if (li < 10) fail('stream-no-layup');
      else {
        const s = surfaceAt(hole, cl[li][0], cl[li][1]);
        if (s !== 'fairway' && s !== 'rough') fail('stream-no-layup');
      }
    } else if (!polyInside(w.poly, pl, 1)) {
      fail('water-ob');
    }
  }

  return { ok: errors.length === 0, errors };
}
