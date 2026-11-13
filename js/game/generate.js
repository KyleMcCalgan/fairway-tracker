// Hole generation pipeline (docs/game.md 5). Pure: the hole is a function of
// (GEN_VERSION, seed, options) and nothing else.

import { GEN, GEN_VERSION } from './constants.js';
import { makeRng } from './rng.js';
import { pow1625 } from './math.js';
import { buildCenterline, clHeading } from './centerline.js';
import { buildCorridor, buildTee } from './corridor.js';
import { buildGreen, shortSideCup } from './green.js';
import { buildWater } from './water.js';
import { buildBunkers } from './bunkers.js';
import { roundCoord, polyDist } from './geometry.js';
import { validateHole } from './validate.js';

function buildWind(rng, flavour) {
  const W = GEN.wind;
  const u = rng.next(), v = rng.next(), side = rng.next();
  const steps = 360 / W.dirStepDeg;
  let mph, dir;
  if (flavour === 'calm') {
    mph = Math.round(W.calm[0] + (W.calm[1] - W.calm[0]) * u);
    dir = Math.floor(v * steps) * W.dirStepDeg;
  } else if (flavour === 'cross') {
    mph = Math.round(W.cross[0] + (W.cross[1] - W.cross[0]) * u);
    const off = (v * 2 - 1) * W.crossSpread;
    dir = Math.round(((side < 0.5 ? 90 : 270) + off) / W.dirStepDeg) * W.dirStepDeg;
  } else if (flavour === 'strong') {
    mph = Math.round(W.strong[0] + (W.strong[1] - W.strong[0]) * u);
    dir = Math.floor(v * steps) * W.dirStepDeg;
  } else {
    mph = Math.round(W.maxMph * pow1625(u));
    dir = Math.floor(v * steps) * W.dirStepDeg;
  }
  return { mph, dirDeg: ((dir % 360) + 360) % 360 };
}

// One generation attempt. `safe` builds the known-safe straight hole with no hazards.
function buildHole(seed, attempt, opts, safe) {
  const base = GEN_VERSION + '|' + seed + '|' + attempt;
  const stage = (name) => makeRng(base + '|' + name);

  // 1. Spec
  const rs = stage('spec');
  const parRoll = rs.weighted(GEN.parWeights);
  const par = opts.par === 3 || opts.par === 4 || opts.par === 5 ? opts.par : parRoll;
  const lenRoll = rs.next();
  const band = GEN.lengthBands[par];
  const length = 2 * Math.round((band[0] + (band[1] - band[0]) * lenRoll) / 2);
  const archRoll = rs.weighted(GEN.archetypeWeights[par]);
  const archetype = safe ? 'straight' : archRoll;
  const difficulty = safe ? 0.3 : Math.round(rs.next() * 100) / 100;
  const spec = { par, length, archetype, difficulty, safe };

  // 2. Centerline
  const cl = buildCenterline(stage('centerline'), par, length, archetype);
  const hEnd = cl.hs[cl.n];

  // 5. Green (built before the corridor, which needs its radius)
  const G = GEN.green;
  const approach = par === 3 ? length : Math.max(40, length - G.driveLen - (par === 5 ? G.secondLen : 0));
  const green = buildGreen(stage('green'), cl.xs[cl.n], cl.ys[cl.n], hEnd, approach);

  // 3. Corridor and 4. tee
  const corr = buildCorridor(stage('corridor'), cl, spec, green);
  const tee = buildTee(cl.hs[0]);

  const ctx = {
    cl, corr, green, tee, par, difficulty,
    len: cl.len, hEnd, playable: corr.playable,
    hAt: (s) => clHeading(cl, s),
  };

  // 7. Water, then 6. bunkers. Water runs first because it is the more
  // constrained of the two; each has its own sub-stream so the order is free.
  const water = safe ? [] : buildWater(stage('water'), ctx);
  const bunkers = safe ? [] : buildBunkers(stage('bunkers'), ctx, water);

  // Short-sided pin on about a quarter of holes with greenside hazards.
  let shortSided = false;
  const rp = stage('pin');
  const near = [];
  const reach = G.shortSide[1] - G.pinEdgeMin; // a cup 3 inside the edge can be 6 from a hazard this close
  for (const b of bunkers) if (polyDist(b.poly, green.poly, reach) < reach) near.push(b.poly);
  for (const w of water) if (polyDist(w.poly, green.poly, reach) < reach) near.push(w.poly);
  if (near.length && rp.chance(G.shortSideChance)) {
    const all = bunkers.map((b) => b.poly).concat(water.map((w) => w.poly));
    const target = near[rp.int(0, near.length - 1)];
    const cup = shortSideCup(green, target, all);
    if (cup) { green.cup = cup; shortSided = true; }
  }

  // 8. Wind
  const wind = buildWind(stage('wind'), opts.wind);

  const centerline = [];
  for (let i = 0; i <= cl.n; i++) centerline.push([roundCoord(cl.xs[i]), roundCoord(cl.ys[i])]);

  return {
    version: GEN_VERSION,
    seed,
    par,
    lengthYds: cl.len,
    wind,
    centerline,
    fairway: corr.fairway,
    playable: corr.playable,
    tee,
    green: green.poly,
    cup: green.cup,
    rings: green.rings,
    bunkers,
    water,
    meta: { archetype, difficulty, shortSided, attempt, fallback: !!safe },
  };
}

// generateHole(seed, opts): opts.par forces the par (3, 4 or 5), opts.wind
// forces a wind flavour ('calm' | 'cross' | 'strong'). Always returns a hole
// that passes validateHole.
export function generateHole(seed, opts = {}) {
  seed = String(seed);
  for (let attempt = 0; attempt < GEN.maxAttempts; attempt++) {
    const hole = buildHole(seed, attempt, opts, false);
    if (validateHole(hole).ok) return hole;
  }
  const hole = buildHole(seed, 0, opts, true);
  const v = validateHole(hole);
  if (!v.ok) throw new Error('fallback hole failed validation: ' + v.errors.join(','));
  return hole;
}

// For diagnostics (gallery, tests): the validation errors of each failed attempt.
export function generationReport(seed, opts = {}) {
  seed = String(seed);
  const failures = [];
  for (let attempt = 0; attempt < GEN.maxAttempts; attempt++) {
    const v = validateHole(buildHole(seed, attempt, opts, false));
    if (v.ok) return { attempt, failures };
    failures.push(v.errors);
  }
  return { attempt: -1, failures };
}

// The three daily holes for a UTC date string 'YYYY-MM-DD': one par 3, one
// par 4, one par 5 in a date-seeded order, with calm / cross / strong wind
// dealt out in a date-seeded order.
export function dailySeed(date, n) {
  return 'handi-daily-' + GEN_VERSION + '-' + date + '-' + n;
}

export function dailyHoles(date) {
  const rng = makeRng('handi-daily-' + GEN_VERSION + '-' + date);
  const pars = rng.shuffle([3, 4, 5]);
  const winds = rng.shuffle(['calm', 'cross', 'strong']);
  return pars.map((par, i) => generateHole(dailySeed(date, i + 1), { par, wind: winds[i] }));
}

export function holeSummary(hole) {
  return {
    par: hole.par,
    lengthYds: hole.lengthYds,
    archetype: hole.meta.archetype,
    bunkers: hole.bunkers.length,
    water: hole.water.length,
    wind: hole.wind,
  };
}
