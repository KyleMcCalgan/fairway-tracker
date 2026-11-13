// Hole rules: strokes, penalties, putting rings, the stroke cap, and replay of
// a logged shot sequence (docs/game.md 6). Pure.

import { CLUB_ORDER, PLAY } from './constants.js';
import { DEG, datan2 } from './math.js';
import { pointInPoly } from './geometry.js';
import { resolveShot, maxCarry } from './physics.js';

// State of one hole in play. `strokes` is the running total (shots + penalties,
// plus putts once the ball is on the green).
export function newHoleState() {
  return {
    pos: [0, 0],
    lie: 'tee',
    shots: [],        // [{ club, angle, power, result }]
    penalties: 0,
    putts: 0,
    strokes: 0,
    done: false,
    holed: false,     // holed out from off the green
    pickedUp: false,  // hit the stroke cap
    ob: 0,
    water: 0,
  };
}

// Putts from a resting point on the green: inside r1 is 1, inside r2 is 2, else 3.
export function puttsFor(hole, pos) {
  const dx = pos[0] - hole.cup[0], dy = pos[1] - hole.cup[1];
  const d2 = dx * dx + dy * dy;
  if (d2 <= hole.rings[0] * hole.rings[0]) return 1;
  if (d2 <= hole.rings[1] * hole.rings[1]) return 2;
  return 3;
}

export function isValidInput(input) {
  return !!input && CLUB_ORDER.indexOf(input.club) >= 0
    && Number.isInteger(input.angle) && input.angle >= 0 && input.angle < 360 * PLAY.angleUnitsPerDeg
    && Number.isInteger(input.power) && input.power >= 0 && input.power <= PLAY.powerUnits;
}

// Apply one shot. Returns { state, outcome } without mutating the old state.
// outcome is the resolveShot result plus { putts, from, fromLie }.
export function applyShot(hole, state, input) {
  if (state.done) throw new Error('hole is already finished');
  if (!isValidInput(input)) throw new Error('invalid shot input');
  const r = resolveShot(hole, state.pos, state.lie, input);
  const next = {
    ...state,
    pos: state.pos,
    shots: state.shots.concat([{ club: input.club, angle: input.angle, power: input.power, result: r.result }]),
  };
  let putts = 0;
  if (r.result === 'ob' || r.result === 'water') {
    // Stroke and distance: +1 penalty, replay from the same spot and lie.
    next.penalties = state.penalties + 1;
    if (r.result === 'ob') next.ob = state.ob + 1; else next.water = state.water + 1;
  } else if (r.result === 'holed') {
    next.pos = r.rest;
    next.lie = 'green';
    next.done = true;
    next.holed = true;
  } else {
    next.pos = r.rest;
    next.lie = r.lie;
    if (r.lie === 'green') {
      putts = puttsFor(hole, r.rest);
      next.putts = putts;
      next.done = true;
    }
  }
  next.strokes = next.shots.length + next.penalties + next.putts;
  // Auto pick-up at the cap. Penalties and putts count toward it.
  if (next.strokes >= PLAY.strokeCap) {
    next.pickedUp = !next.done || next.strokes > PLAY.strokeCap;
    next.strokes = PLAY.strokeCap;
    next.done = true;
  }
  return { state: next, outcome: { ...r, putts, from: state.pos, fromLie: state.lie } };
}

// Replay a logged shot sequence from the tee. Deterministic: the same hole and
// the same quantised inputs always give the same state.
export function replay(hole, shots) {
  let state = newHoleState();
  for (const s of shots) {
    if (state.done) throw new Error('shot log continues past the end of the hole');
    const r = applyShot(hole, state, s);
    if (s.result && s.result !== r.outcome.result) throw new Error('shot log does not match replay');
    state = r.state;
  }
  return state;
}

// Integer heading (0.1 degree steps, 0..3599) from a to b.
export function headingTenths(ax, ay, bx, by) {
  const units = 360 * PLAY.angleUnitsPerDeg;
  const t = Math.round((datan2(bx - ax, by - ay) / DEG) * PLAY.angleUnitsPerDeg);
  return ((t % units) + units) % units;
}

// Centre of the aim sweep: the pin if it is within range, otherwise the
// farthest centerline point within the club's range (which makes doglegs work).
export function aimCentre(hole, pos, club, lie) {
  const range = maxCarry(club, lie);
  const r2 = range * range;
  const d2 = (x, y) => (x - pos[0]) * (x - pos[0]) + (y - pos[1]) * (y - pos[1]);
  let tx = hole.cup[0], ty = hole.cup[1];
  if (d2(tx, ty) > r2) {
    const cl = hole.centerline;
    for (let i = cl.length - 1; i >= 0; i--) {
      if (d2(cl[i][0], cl[i][1]) <= r2) {
        // Never aim backwards: only accept points further up the hole than the ball.
        if (cl[i][1] > pos[1]) { tx = cl[i][0]; ty = cl[i][1]; }
        break;
      }
    }
  }
  return headingTenths(pos[0], pos[1], tx, ty);
}

export function distToPin(hole, pos) {
  const dx = pos[0] - hole.cup[0], dy = pos[1] - hole.cup[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// A sensible default club: the shortest one that reaches the pin, else the longest hitter.
export function suggestClub(hole, pos, lie) {
  const d = distToPin(hole, pos);
  let best = null;
  for (let i = CLUB_ORDER.length - 1; i >= 0; i--) {
    if (maxCarry(CLUB_ORDER[i], lie) >= d) { best = CLUB_ORDER[i]; break; }
  }
  if (best) return best;
  best = CLUB_ORDER[0];
  for (const c of CLUB_ORDER) if (maxCarry(c, lie) > maxCarry(best, lie)) best = c;
  return best;
}

// Score name relative to par.
export function scoreName(strokes, par, state) {
  if (state && state.pickedUp) return 'Picked up';
  if (strokes === 1) return 'Hole in one';
  const d = strokes - par;
  if (d <= -3) return 'Albatross';
  if (d === -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double bogey';
  if (d === 3) return 'Triple bogey';
  return '+' + d;
}

export function onGreen(hole, pos) {
  return pointInPoly(hole.green, pos[0], pos[1]);
}
