// Meter maths (docs/game.md 6, "Timing"). Pure. Positions are computed
// analytically from elapsed milliseconds, never from frame counts, so 60 Hz
// and 120 Hz devices behave the same. Locks are quantised to the integers the
// resolver consumes.

import { CLUBS, LIE_AIM_SPEED, METER, PLAY } from './constants.js';

// Triangle wave 0 -> 1 -> 0 with `oneWayMs` per leg.
export function triangle(tMs, oneWayMs) {
  if (tMs <= 0) return 0;
  const phase = (tMs / oneWayMs) % 2;
  return phase <= 1 ? phase : 2 - phase;
}

// Time for the aim arrow to cross from one extreme to the other.
export function aimSweepMs(club, lie, assist) {
  return (CLUBS[club].aimSweepMs / LIE_AIM_SPEED[lie][club]) * (assist ? METER.assistFactor : 1);
}

export function powerSweepMs(assist) {
  return METER.powerSweepMs * (assist ? METER.assistFactor : 1);
}

// Aim offset from the sweep centre in degrees. Starts at the left extreme.
export function aimOffsetDeg(tMs, oneWayMs) {
  return -METER.aimHalfDeg + 2 * METER.aimHalfDeg * triangle(tMs, oneWayMs);
}

// Power fraction 0..1. Starts at 0.
export function powerFrac(tMs, oneWayMs) {
  return triangle(tMs, oneWayMs);
}

// Lock the aim: absolute heading in 0.1 degree steps, 0..3599.
export function lockAim(centreTenths, tMs, oneWayMs) {
  const units = 360 * PLAY.angleUnitsPerDeg;
  const a = centreTenths + Math.round(aimOffsetDeg(tMs, oneWayMs) * PLAY.angleUnitsPerDeg);
  return ((a % units) + units) % units;
}

// Quantise a power fraction to 0.5% steps; at or above the snap point it is 100%.
export function quantisePower(frac) {
  if (frac >= METER.powerSnap) return PLAY.powerUnits;
  return Math.round(frac * PLAY.powerUnits);
}

export function lockPower(tMs, oneWayMs) {
  return quantisePower(powerFrac(tMs, oneWayMs));
}
