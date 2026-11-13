// Green, cup and putting rings (docs/game.md 5.5). Pure.

import { GEN } from './constants.js';
import { dsin, dcos, PI, TAU, DEG, clamp, lerp } from './math.js';
import { roundPoly, roundCoord, pointInPoly, distPointPoly } from './geometry.js';

// approach: expected approach-shot distance; heading: hole heading at the green.
export function buildGreen(rng, cx, cy, heading, approach) {
  const G = GEN.green;
  const t = clamp((approach - G.approachNear) / (G.approachFar - G.approachNear), 0, 1);
  const R = lerp(rng.range(G.radiusNear[0], G.radiusNear[1]), rng.range(G.radiusFar[0], G.radiusFar[1]), t);
  const aspect = Math.sqrt(rng.range(1, G.maxAspect));
  const a = R * aspect, b = R / aspect;
  const rot = rng.range(0, PI);
  const h2 = rng.range(0, G.harm2), p2 = rng.range(0, TAU);
  const h3 = rng.range(0.03, G.harm3), p3 = rng.range(0, TAU);

  // Edge radius in world direction phi (0 = +y, clockwise). An ellipse whose
  // radius is modulated by two harmonics: always positive, so star-shaped.
  const radiusAt = (phi) => {
    const c = dcos(phi - rot), s = dsin(phi - rot);
    const e = (a * b) / Math.sqrt(b * b * c * c + a * a * s * s);
    return e * (1 + h2 * dcos(2 * phi + p2) + h3 * dcos(3 * phi + p3));
  };

  const pts = [];
  for (let i = 0; i < G.vertices; i++) {
    const phi = (i / G.vertices) * TAU;
    const r = radiusAt(phi);
    pts.push([cx + r * dsin(phi), cy + r * dcos(phi)]);
  }
  const poly = roundPoly(pts);

  // Pin zone: one of 8 directions around the green (front, back, sides, corners).
  const zone = rng.int(0, 7);
  const phi = heading + zone * 45 * DEG + rng.range(-15, 15) * DEG;
  let frac = rng.range(G.pinFrac[0], G.pinFrac[1]);
  let cup = [cx, cy];
  for (let i = 0; i < 12; i++) {
    const r = radiusAt(phi) * frac;
    cup = [roundCoord(cx + r * dsin(phi)), roundCoord(cy + r * dcos(phi))];
    if (pointInPoly(poly, cup[0], cup[1]) && distPointPoly(poly, cup[0], cup[1]) >= G.pinEdgeMin) break;
    frac -= 0.06;
  }

  const rings = [roundCoord(G.ring1 * R), roundCoord(G.ring2 * R)];
  return { cx, cy, R, radiusAt, poly, cup, rings };
}

// Short-sided pin: move the cup to 4-6 yards from one greenside hazard.
// `target` and `hazards` are polygons; returns the new cup or null if no spot qualifies.
export function shortSideCup(green, target, hazards) {
  const G = GEN.green;
  const mid = (G.shortSide[0] + G.shortSide[1]) / 2;
  let best = null, bestErr = Infinity;
  for (let ai = 0; ai < 48; ai++) {
    const phi = (ai / 48) * TAU;
    const edge = green.radiusAt(phi);
    for (let fi = 0; fi < 8; fi++) {
      const r = edge * (0.4 + 0.07 * fi);
      const x = roundCoord(green.cx + r * dsin(phi)), y = roundCoord(green.cy + r * dcos(phi));
      if (!pointInPoly(green.poly, x, y) || distPointPoly(green.poly, x, y) < G.pinEdgeMin) continue;
      const dt = distPointPoly(target, x, y);
      if (dt < G.shortSide[0] || dt > G.shortSide[1]) continue;
      let ok = true;
      for (const h of hazards) {
        if (h !== target && distPointPoly(h, x, y) < G.shortSide[0]) { ok = false; break; }
      }
      if (!ok) continue;
      const err = dt > mid ? dt - mid : mid - dt;
      if (err < bestErr) { bestErr = err; best = [x, y]; }
    }
  }
  return best;
}
