// Artwork for the sign-in screen: a real Handi Golf hole, drawn as SVG from the
// same generator the game uses. The hole is fixed (a constant seed), so the page
// always looks the same, and it quietly shows what the Play section is about.
// Flat colours only, the same as the game.

import { generateHole } from './game/generate.js';
import { COLORS } from './game/constants.js';
import { bbox } from './game/geometry.js';

export const HERO_SEED = 'handi-signin-6';

export function holeArt(seed = HERO_SEED) {
  const hole = generateHole(seed);
  const b = bbox(hole.playable);
  const pad = 10;
  const w = b.maxX - b.minX + pad * 2;
  const h = b.maxY - b.minY + pad * 2;
  const X = (x) => (x - b.minX + pad).toFixed(1);
  const Y = (y) => (b.maxY - y + pad).toFixed(1);
  const points = (poly) => poly.map(([x, y]) => X(x) + ',' + Y(y)).join(' ');
  const shape = (poly, fill, line, extra = '') =>
    `<polygon points="${points(poly)}" fill="${fill}" stroke="${line}" stroke-width="1.1" stroke-linejoin="round" ${extra}/>`;

  const line = hole.centerline.filter((_, i) => i % 6 === 0 || i === hole.centerline.length - 1);
  const [cx, cy] = hole.cup;
  const flagX = X(cx), flagY = Y(cy);
  const parts = [
    `<rect width="${w}" height="${h}" fill="${COLORS.ob}"/>`,
    shape(hole.playable, COLORS.rough, COLORS.obLine, 'stroke-dasharray="3 3" stroke-width="1"'),
    hole.fairway.length ? shape(hole.fairway, COLORS.fairway, COLORS.fairwayLine) : '',
    ...hole.bunkers.map((p) => shape(p.poly, COLORS.bunker, COLORS.bunkerLine)),
    ...hole.water.map((p) => shape(p.poly, COLORS.water, COLORS.waterLine)),
    shape(hole.green, COLORS.green, COLORS.greenLine),
    shape(hole.tee, COLORS.tee, COLORS.teeLine),
    `<polyline points="${points(line)}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="1 4" stroke-linecap="round"/>`,
    `<circle cx="${flagX}" cy="${flagY}" r="1.3" fill="${COLORS.cup}"/>`,
    `<path d="M${flagX} ${flagY}V${(flagY - 9).toFixed(1)}" stroke="#fff" stroke-width="1"/>`,
    `<path d="M${flagX} ${(flagY - 9).toFixed(1)}l7 2.6l-7 2.6z" fill="${COLORS.flag}"/>`,
    `<circle cx="${X(0)}" cy="${Y(0)}" r="2.1" fill="#fff" stroke="${COLORS.ballLine}" stroke-width=".6"/>`,
  ];
  return `<svg class="auth-art" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="A golf hole from Handi Golf">${parts.join('')}</svg>`;
}
