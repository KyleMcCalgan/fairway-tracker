// Shot resolution (docs/game.md 6). Pure and deterministic: a shot is a
// function of the hole, where the ball lies, and three integers
// (club, angle in 0.1 degree steps, power in 0.5% steps).

import { CLUBS, LIE_DIST, FIRMNESS, PLAY } from './constants.js';
import { dsin, dcos, PI, DEG } from './math.js';
import { pointInPoly } from './geometry.js';

// Surface priority: OB, tee, green, water, bunker, fairway, rough.
export function surfaceAt(hole, x, y) {
  if (!pointInPoly(hole.playable, x, y)) return 'ob';
  if (pointInPoly(hole.tee, x, y)) return 'tee';
  if (pointInPoly(hole.green, x, y)) return 'green';
  for (let i = 0; i < hole.water.length; i++) if (pointInPoly(hole.water[i].poly, x, y)) return 'water';
  for (let i = 0; i < hole.bunkers.length; i++) if (pointInPoly(hole.bunkers[i].poly, x, y)) return 'bunker';
  if (hole.fairway.length && pointInPoly(hole.fairway, x, y)) return 'fairway';
  return 'rough';
}

// Carry at 100% power for this club from this lie.
export function maxCarry(club, lie) {
  return CLUBS[club].maxCarry * LIE_DIST[lie][club];
}

// Carry (no wind) for a quantised power value.
export function carryFor(club, lie, power) {
  return maxCarry(club, lie) * (power / PLAY.powerUnits);
}

// from: [x, y]; lie: 'tee' | 'fairway' | 'rough' | 'bunker';
// input: { club, angle, power } with angle an integer heading in 0.1 degree
// steps (0 = +y, clockwise) and power an integer 0..200.
// Returns { result: 'ok' | 'ob' | 'water' | 'holed', landing, rest, lie, landSurface, carry, roll }.
// For 'ob' and 'water', `rest` is where the ball was lost; the ball itself is
// replayed from `from` (stroke and distance), which the rules module handles.
export function resolveShot(hole, from, lie, input) {
  const c = CLUBS[input.club];
  const carry0 = carryFor(input.club, lie, input.power);
  const a = input.angle * (PI / (180 * PLAY.angleUnitsPerDeg));
  const dx = dsin(a), dy = dcos(a);

  // Wind blows toward wind.dirDeg. Split into along-shot and cross-shot parts.
  const wa = hole.wind.dirDeg * DEG;
  const wx = hole.wind.mph * dsin(wa), wy = hole.wind.mph * dcos(wa);
  const along = wx * dx + wy * dy;
  const cross = wx * dy - wy * dx; // positive pushes the ball to the right
  const k = c.windSens / PLAY.windRefMph;
  const carry = carry0 * (1 + along * k * PLAY.windAlongMax);
  const drift = carry0 * cross * k * PLAY.windCrossMax;

  const lx = from[0] + dx * carry + dy * drift;
  const ly = from[1] + dy * carry - dx * drift;
  const landing = [lx, ly];
  const cup = hole.cup;
  const cap2 = PLAY.captureRadius * PLAY.captureRadius;
  const out = (result, rest, restLie, landSurface, roll) => ({ result, landing, rest, lie: restLie, landSurface, carry, roll });

  const landSurface = surfaceAt(hole, lx, ly);
  if (landSurface === 'ob') return out('ob', landing, lie, landSurface, 0);
  if (landSurface === 'water') return out('water', landing, lie, landSurface, 0);
  if ((lx - cup[0]) * (lx - cup[0]) + (ly - cup[1]) * (ly - cup[1]) <= cap2) return out('holed', [cup[0], cup[1]], 'green', landSurface, 0);
  if (landSurface === 'bunker') return out('ok', landing, 'bunker', landSurface, 0);

  // Roll out in the direction of travel.
  let ux = lx - from[0], uy = ly - from[1];
  const ul = Math.sqrt(ux * ux + uy * uy);
  if (ul > 0) { ux /= ul; uy /= ul; } else { ux = dx; uy = dy; }
  const rollLen = carry * c.rollK * FIRMNESS[landSurface];
  const steps = Math.ceil(rollLen / PLAY.rollStep);
  let rx = lx, ry = ly, surface = landSurface, rolled = 0;
  for (let i = 1; i <= steps; i++) {
    const t = Math.min(i * PLAY.rollStep, rollLen);
    const x = lx + ux * t, y = ly + uy * t;
    if ((x - cup[0]) * (x - cup[0]) + (y - cup[1]) * (y - cup[1]) <= cap2) return out('holed', [cup[0], cup[1]], 'green', landSurface, t);
    const s = surfaceAt(hole, x, y);
    if (s === 'ob') return out('ob', [x, y], lie, landSurface, t);
    if (s === 'water') return out('water', [x, y], lie, landSurface, t);
    rx = x; ry = y; surface = s; rolled = t;
    if (s === 'bunker') break; // stops at the first bunker the roll enters
  }
  return out('ok', [rx, ry], surface, landSurface, rolled);
}
