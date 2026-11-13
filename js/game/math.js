// Deterministic maths for generation and shot resolution.
// Only + - * / Math.sqrt Math.floor Math.abs are used, all of which IEEE 754
// (and so every JS engine) defines exactly. Math.sin/cos/atan2 are NOT used:
// they can differ in the last bit between browsers.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const DEG = PI / 180;

function sinPoly(r) {
  const z = r * r;
  return r * (1 + z * (-1 / 6 + z * (1 / 120 + z * (-1 / 5040 + z * (1 / 362880
    + z * (-1 / 39916800 + z * (1 / 6227020800)))))));
}

function cosPoly(r) {
  const z = r * r;
  return 1 + z * (-1 / 2 + z * (1 / 24 + z * (-1 / 720 + z * (1 / 40320
    + z * (-1 / 3628800 + z * (1 / 479001600 + z * (-1 / 87178291200)))))));
}

// sin(x), x in radians. Accurate to about 1e-15 for |x| < 1000.
export function dsin(x) {
  const k = Math.floor(x / HALF_PI + 0.5);
  const r = x - k * HALF_PI;
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return sinPoly(r);
  if (q === 1) return cosPoly(r);
  if (q === 2) return -sinPoly(r);
  return -cosPoly(r);
}

export function dcos(x) {
  const k = Math.floor(x / HALF_PI + 0.5);
  const r = x - k * HALF_PI;
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return cosPoly(r);
  if (q === 1) return -sinPoly(r);
  if (q === 2) return -cosPoly(r);
  return sinPoly(r);
}

// atan(z) for 0 <= z <= 1: two half-angle reductions, then a Taylor series.
function atanUnit(z) {
  let t = z / (1 + Math.sqrt(1 + z * z));
  t = t / (1 + Math.sqrt(1 + t * t));
  const w = t * t;
  const p = t * (1 - w * (1 / 3 - w * (1 / 5 - w * (1 / 7 - w * (1 / 9 - w * (1 / 11
    - w * (1 / 13 - w * (1 / 15 - w / 17))))))));
  return 4 * p;
}

// atan2(y, x) in radians, (-PI, PI].
export function datan2(y, x) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  let a = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

// Headings: 0 is +y (up the hole), positive clockwise toward +x.
export function headingOf(dx, dy) {
  return datan2(dx, dy);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// u^1.625 from square roots only (u^1 * u^(1/2) * u^(1/8)); stands in for u^1.6.
export function pow1625(u) {
  const r = Math.sqrt(u);
  return u * r * Math.sqrt(Math.sqrt(r));
}

export function dist(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}
