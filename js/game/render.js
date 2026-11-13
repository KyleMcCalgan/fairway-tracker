// Canvas renderer. Draws the same polygons the rules use, flat colours and
// thin outlines only. Touches a 2D context but nothing else in the DOM.
// A view is { cx, cy, scale, w, h }: world point (cx, cy) sits at the centre
// of a w x h (CSS pixel) canvas, +y is up the screen.

import { COLORS, MARKERS } from './constants.js';
import { bbox } from './geometry.js';

export function fitView(b, w, h, pad = 12) {
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale, w, h };
}

export function holeView(hole, w, h, pad = 12) {
  return fitView(bbox(hole.playable), w, h, pad);
}

export function sx(view, x) { return view.w / 2 + (x - view.cx) * view.scale; }
export function sy(view, y) { return view.h / 2 - (y - view.cy) * view.scale; }

export function lerpView(a, b, t) {
  // Interpolate scale geometrically so zooms feel even.
  const scale = a.scale * Math.pow(b.scale / a.scale, t);
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, scale, w: b.w, h: b.h };
}

function trace(ctx, view, poly) {
  ctx.moveTo(sx(view, poly[0][0]), sy(view, poly[0][1]));
  for (let i = 1; i < poly.length; i++) ctx.lineTo(sx(view, poly[i][0]), sy(view, poly[i][1]));
  ctx.closePath();
}

// Outline first, fill on top: only the outer half of the line shows, and
// overlapping shapes of one kind (bunker clusters) read as a single shape.
function shapes(ctx, view, polys, fill, line) {
  if (!polys.length) return;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = line;
  for (const p of polys) { ctx.beginPath(); trace(ctx, view, p); ctx.stroke(); }
  ctx.fillStyle = fill;
  for (const p of polys) { ctx.beginPath(); trace(ctx, view, p); ctx.fill(); }
}

export function drawHole(ctx, hole, view, opts = {}) {
  const { w, h } = view;
  ctx.fillStyle = COLORS.rough;
  ctx.fillRect(0, 0, w, h);

  if (hole.fairway.length) shapes(ctx, view, [hole.fairway], COLORS.fairway, COLORS.fairwayLine);
  shapes(ctx, view, hole.bunkers.map((b) => b.poly), COLORS.bunker, COLORS.bunkerLine);
  shapes(ctx, view, hole.water.map((b) => b.poly), COLORS.water, COLORS.waterLine);
  shapes(ctx, view, [hole.green], COLORS.green, COLORS.greenLine);
  shapes(ctx, view, [hole.tee], COLORS.tee, COLORS.teeLine);

  // Out of bounds: flat dark fill outside the playable polygon, white dashed line.
  ctx.beginPath();
  ctx.rect(-1, -1, w + 2, h + 2);
  trace(ctx, view, hole.playable);
  ctx.fillStyle = COLORS.ob;
  ctx.fill('evenodd');
  ctx.beginPath();
  trace(ctx, view, hole.playable);
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.obLine;
  ctx.stroke();
  ctx.setLineDash([]);

  if (opts.markers !== false) drawMarkers(ctx, hole, view);
  if (opts.rings) drawRings(ctx, hole, view);
  drawFlag(ctx, hole, view, opts.flagScale || 1);
}

// Yardage markers: small dots on the centerline 100/150/200 yards from the green centre.
function drawMarkers(ctx, hole, view) {
  const cl = hole.centerline;
  const n = cl.length - 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const m of MARKERS) {
    const i = n - m / 2; // centerline points are 2 yards apart
    if (i < 15) continue;
    const x = sx(view, cl[i][0]), y = sy(view, cl[i][1]);
    ctx.fillStyle = COLORS.marker;
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    if (view.scale > 0.9) ctx.fillText(String(m), x + 5, y);
  }
}

// Putting rings, clipped to the green.
export function drawRings(ctx, hole, view) {
  ctx.save();
  ctx.beginPath();
  trace(ctx, view, hole.green);
  ctx.clip();
  ctx.strokeStyle = COLORS.ring;
  ctx.lineWidth = 1;
  for (const r of hole.rings) {
    ctx.beginPath();
    ctx.arc(sx(view, hole.cup[0]), sy(view, hole.cup[1]), r * view.scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFlag(ctx, hole, view, k = 1) {
  const x = sx(view, hole.cup[0]), y = sy(view, hole.cup[1]);
  ctx.fillStyle = COLORS.cup;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1.5, Math.min(4, 0.35 * view.scale)), 0, Math.PI * 2);
  ctx.fill();
  const hgt = 13 * k;
  ctx.strokeStyle = COLORS.cup;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - hgt);
  ctx.stroke();
  ctx.fillStyle = COLORS.flag;
  ctx.beginPath();
  ctx.moveTo(x, y - hgt);
  ctx.lineTo(x + 7 * k, y - hgt + 3 * k);
  ctx.lineTo(x, y - hgt + 6 * k);
  ctx.closePath();
  ctx.fill();
}

// lift 0..1 draws the ball larger with a shadow below, to suggest height.
export function drawBall(ctx, view, x, y, lift = 0, k = 1) {
  const px = sx(view, x), py = sy(view, y);
  const r = 3.4 * k * (1 + 0.9 * lift);
  if (lift > 0.02) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(px + 5 * lift, py + 9 * lift, 3 * k, 0, Math.PI * 2);
    ctx.fill();
  }
  if (r < 0.3) return;
  ctx.fillStyle = COLORS.ball;
  ctx.strokeStyle = COLORS.ballLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(px, py - 6 * lift, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawRangeRing(ctx, view, x, y, r) {
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.arc(sx(view, x), sy(view, y), r * view.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

// Aim: faint sweep limits plus the arrow. Angles in degrees, 0 = up, clockwise.
export function drawAim(ctx, view, x, y, r, centreDeg, halfDeg, arrowDeg, carry, locked) {
  const px = sx(view, x), py = sy(view, y);
  const end = (deg, len) => {
    const a = (deg * Math.PI) / 180;
    return [px + Math.sin(a) * len * view.scale, py - Math.cos(a) * len * view.scale];
  };
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  for (const d of [centreDeg - halfDeg, centreDeg + halfDeg]) {
    const e = end(d, r);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(e[0], e[1]); ctx.stroke();
  }
  if (arrowDeg == null) return;
  const tip = end(arrowDeg, r);
  ctx.strokeStyle = locked ? COLORS.aim : 'rgba(255,255,255,0.95)';
  ctx.lineWidth = locked ? 2.5 : 2;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
  const a = (arrowDeg * Math.PI) / 180;
  const hx = Math.sin(a), hy = -Math.cos(a);
  ctx.fillStyle = COLORS.aim;
  ctx.beginPath();
  ctx.moveTo(tip[0] + hx * 9, tip[1] + hy * 9);
  ctx.lineTo(tip[0] - hy * 5, tip[1] + hx * 5);
  ctx.lineTo(tip[0] + hy * 5, tip[1] - hx * 5);
  ctx.closePath();
  ctx.fill();
  if (carry != null) {
    const c = end(arrowDeg, carry);
    ctx.fillStyle = COLORS.ball;
    ctx.strokeStyle = COLORS.ballLine;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c[0], c[1], 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

// Vertical power bar on the right edge of the canvas. frac 0..1, or null when idle.
export function drawPowerBar(ctx, view, frac, snap, label, active) {
  const { w, h } = view;
  const bw = 18, bh = Math.min(260, h * 0.5);
  const x = w - bw - 12, y = (h - bh) / 2 + 10;
  ctx.fillStyle = 'rgba(20,26,22,0.72)';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x - 0.5, y - 0.5, bw + 1, bh + 1);
  ctx.fill();
  ctx.stroke();
  // Snap zone at the top: anything in it counts as 100%.
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillRect(x, y, bw, bh * (1 - snap));
  if (frac != null) {
    ctx.fillStyle = active ? '#ffd24a' : '#ffffff';
    ctx.fillRect(x, y + bh * (1 - frac), bw, bh * frac);
    ctx.fillStyle = '#1b1f1c';
    ctx.fillRect(x - 3, y + bh * (1 - frac) - 1, bw + 6, 2);
  }
  if (label) {
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,26,22,0.8)';
    ctx.strokeText(label, x + bw, y - 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + bw, y - 6);
  }
}

// Expanding ring: landing ripple (white), OB (red) and the holed burst.
export function drawRipple(ctx, view, x, y, p, color, maxR = 14) {
  if (p <= 0 || p >= 1) return;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 1 - p;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(sx(view, x), sy(view, y), 2 + maxR * p, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Water plop: two rings and a few droplet dots.
export function drawPlop(ctx, view, x, y, p) {
  if (p <= 0 || p >= 1) return;
  drawRipple(ctx, view, x, y, p, '#ffffff', 16);
  drawRipple(ctx, view, x, y, Math.max(0, p * 1.4 - 0.4), '#ffffff', 10);
  const px = sx(view, x), py = sy(view, y);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 1 - p;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.5;
    const d = 6 + 16 * p;
    ctx.beginPath();
    ctx.arc(px + Math.cos(a) * d, py + Math.sin(a) * d + 14 * p * p, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Short text label over the map ("OB +1", "2 putts").
export function drawLabel(ctx, view, x, y, text, color = '#ffffff') {
  const px = Math.max(50, Math.min(view.w - 50, sx(view, x)));
  const py = Math.max(24, sy(view, y) - 18);
  ctx.font = '700 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width + 14;
  ctx.fillStyle = 'rgba(20,26,22,0.85)';
  ctx.beginPath();
  ctx.rect(px - tw / 2, py - 12, tw, 24);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, px, py);
}

// Size a canvas for the device pixel ratio; returns a context scaled to CSS pixels.
export function setupCanvas(canvas, w, h) {
  const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
