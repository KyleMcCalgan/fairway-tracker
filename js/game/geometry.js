// Polygon geometry with exact operations only. A polygon is an array of
// [x, y] points, implicitly closed. Polygons are never mutated after creation.

import { GEN } from './constants.js';

const boxes = new WeakMap();

export function bbox(poly) {
  let b = boxes.get(poly);
  if (b) return b;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const x = poly[i][0], y = poly[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  b = { minX, minY, maxX, maxY };
  boxes.set(poly, b);
  return b;
}

export function pointInPoly(poly, x, y) {
  const b = bbox(poly);
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function within(ax, ay, bx, by, px, py) {
  return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

// True if segment a-b touches or crosses segment c-d.
export function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)) return false;
  if (Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) return false;
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && within(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && within(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && within(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && within(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

// Simple = at least 3 vertices, no zero-length edges, no two non-adjacent edges touching.
export function isSimple(poly) {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (a[0] === b[0] && a[1] === b[1]) return false;
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j], d = poly[(j + 1) % n];
      if (segsIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return false;
    }
  }
  return true;
}

export function distPointSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

// Distance from a point to the polygon's boundary (not 0 inside).
export function distPointPoly(poly, px, py) {
  let m = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distPointSeg(px, py, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
    if (d < m) m = d;
  }
  return m;
}

export function polysIntersect(A, B) {
  const ba = bbox(A), bb = bbox(B);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) return false;
  for (let i = 0, j = A.length - 1; i < A.length; j = i++) {
    const ax = A[j][0], ay = A[j][1], bx = A[i][0], by = A[i][1];
    if (Math.max(ax, bx) < bb.minX || Math.min(ax, bx) > bb.maxX) continue;
    if (Math.max(ay, by) < bb.minY || Math.min(ay, by) > bb.maxY) continue;
    for (let k = 0, l = B.length - 1; k < B.length; l = k++) {
      if (segsIntersect(ax, ay, bx, by, B[l][0], B[l][1], B[k][0], B[k][1])) return true;
    }
  }
  return pointInPoly(B, A[0][0], A[0][1]) || pointInPoly(A, B[0][0], B[0][1]);
}

// Distance between two polygons (0 if they overlap). Returns `cutoff` early
// when the bounding boxes prove the gap is at least that large.
export function polyDist(A, B, cutoff = Infinity) {
  const ba = bbox(A), bb = bbox(B);
  const gx = Math.max(0, ba.minX - bb.maxX, bb.minX - ba.maxX);
  const gy = Math.max(0, ba.minY - bb.maxY, bb.minY - ba.maxY);
  if (gx * gx + gy * gy >= cutoff * cutoff) return cutoff;
  if (polysIntersect(A, B)) return 0;
  let m = cutoff;
  for (let i = 0; i < A.length; i++) {
    const d = distPointPoly(B, A[i][0], A[i][1]);
    if (d < m) m = d;
  }
  for (let i = 0; i < B.length; i++) {
    const d = distPointPoly(A, B[i][0], B[i][1]);
    if (d < m) m = d;
  }
  return m;
}

// Every vertex of `inner` is inside `outer` and at least `margin` from its edge.
export function polyInside(inner, outer, margin) {
  for (let i = 0; i < inner.length; i++) {
    const x = inner[i][0], y = inner[i][1];
    if (!pointInPoly(outer, x, y)) return false;
    if (margin > 0 && distPointPoly(outer, x, y) < margin) return false;
  }
  return true;
}

// Chaikin corner cutting on a closed polygon.
export function chaikin(poly, passes) {
  let p = poly;
  for (let k = 0; k < passes; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = q;
  }
  return p;
}

export function roundCoord(v) {
  return Math.round(v * GEN.quantum) / GEN.quantum + 0; // + 0 turns -0 into 0 so JSON round-trips
}

// Round to the coordinate quantum and drop consecutive duplicates. The result
// is the canonical shape used by both the rules and the renderer.
export function roundPoly(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const x = roundCoord(poly[i][0]), y = roundCoord(poly[i][1]);
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

// Cut self-intersection loops out of an open polyline: where a segment crosses
// a later one, everything between is replaced by the crossing point.
export function removeLoops(pts) {
  const out = pts.slice();
  for (let i = 0; i < out.length - 3; i++) {
    for (let j = Math.min(out.length - 2, i + 80); j >= i + 2; j--) {
      const a = out[i], b = out[i + 1], c = out[j], d = out[j + 1];
      if (!segsIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) continue;
      const rx = b[0] - a[0], ry = b[1] - a[1], qx = d[0] - c[0], qy = d[1] - c[1];
      const den = rx * qy - ry * qx;
      if (den === 0) continue;
      const t = ((c[0] - a[0]) * qy - (c[1] - a[1]) * qx) / den;
      out.splice(i + 1, j - i, [a[0] + rx * t, a[1] + ry * t]);
      break;
    }
  }
  return out;
}
