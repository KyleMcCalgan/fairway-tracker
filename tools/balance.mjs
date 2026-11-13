// Balance tool (docs/game.md 8). A heuristic bot plays N seeded holes with
// simulated human timing jitter and reports scoring for three profiles.
//
//   node tools/balance.mjs                 2000 holes, all profiles
//   node tools/balance.mjs --holes 5000 --seed other --json
//
// The jitter is tool-only randomness (seeded, so runs are repeatable). The
// game itself has none: the bot goes through the same meter maths, quantised
// inputs and resolver as a real player.

import { CLUBS, CLUB_ORDER, FIRMNESS, METER, PLAY } from '../js/game/constants.js';
import { generateHole } from '../js/game/generate.js';
import { resolveShot, surfaceAt, maxCarry } from '../js/game/physics.js';
import { newHoleState, applyShot, puttsFor, aimCentre, headingTenths } from '../js/game/rules.js';
import { aimSweepMs, powerSweepMs, lockAim, lockPower } from '../js/game/meter.js';
import { makeRng } from '../js/game/rng.js';

export const PROFILES = { casual: 60, decent: 35, expert: 20 }; // tap timing jitter, ms (standard deviation)

const UNITS = 360 * PLAY.angleUnitsPerDeg;
const wrap = (a) => ((a % UNITS) + UNITS) % UNITS;

// Rough strokes-to-hole-out from a distance and lie: how the bot values a position.
function estimate(d, lie) {
  let e = 2.45 + 0.55 * Math.min(d, 160) / 160 + Math.max(0, d - 160) / 225;
  if (d < 25) e -= 0.25;
  if (lie === 'rough') e += 0.15;
  else if (lie === 'bunker') e += 0.5;
  return e;
}

function distPin(hole, p) {
  return Math.hypot(p[0] - hole.cup[0], p[1] - hole.cup[1]);
}

// Find the quantised input whose calm-headed result rests on `target`:
// aim off for wind and allow for roll, iterating on the real resolver.
function solve(hole, pos, lie, club, target) {
  const c = CLUBS[club];
  const max = maxCarry(club, lie);
  const ts = surfaceAt(hole, target[0], target[1]);
  const firm = FIRMNESS[ts] != null ? FIRMNESS[ts] : 0.4;
  let ax = target[0], ay = target[1], input = null;
  for (let it = 0; it < 4; it++) {
    const d = Math.hypot(ax - pos[0], ay - pos[1]);
    let power = Math.round((d / (1 + c.rollK * firm) / max) * PLAY.powerUnits);
    if (power >= METER.powerSnap * PLAY.powerUnits) power = PLAY.powerUnits;
    if (power < 1) power = 1;
    input = { club, angle: headingTenths(pos[0], pos[1], ax, ay), power };
    const r = resolveShot(hole, pos, lie, input);
    const ex = r.rest[0] - target[0], ey = r.rest[1] - target[1];
    if (r.result === 'holed' || Math.hypot(ex, ey) < 0.6) break;
    ax -= ex; ay -= ey;
  }
  return input;
}

function valueOf(hole, state, input) {
  const r = resolveShot(hole, state.pos, state.lie, input);
  if (r.result === 'holed') return 1;
  if (r.result === 'ob' || r.result === 'water') return 2 + estimate(distPin(hole, state.pos), state.lie);
  if (r.lie === 'green') return 1 + puttsFor(hole, r.rest);
  return 1 + estimate(distPin(hole, r.rest), r.lie);
}

// Choose the shot: best expected value over the ideal result and four
// "typical miss" variations sized by the profile's jitter.
function chooseShot(hole, state, jitterMs) {
  const { pos, lie } = state;
  const cl = hole.centerline;
  const dPin = distPin(hole, pos);
  let best = null, bestV = Infinity;
  for (const club of CLUB_ORDER) {
    const c = CLUBS[club];
    const reach = maxCarry(club, lie) * (1 + c.rollK);
    const targets = [];
    if (dPin <= reach * 1.02) targets.push(hole.cup);
    // Lay-ups: the farthest centerline point within a share of the club's reach.
    for (const f of [1, 0.9, 0.8, 0.7, 0.6]) {
      const lim = reach * f;
      for (let i = cl.length - 1; i >= 0; i--) {
        if (Math.hypot(cl[i][0] - pos[0], cl[i][1] - pos[1]) <= lim) {
          if (cl[i][1] > pos[1] + 5) targets.push(cl[i]);
          break;
        }
      }
    }
    const da = Math.round(jitterMs * (2 * METER.aimHalfDeg / aimSweepMs(club, lie, false)) * PLAY.angleUnitsPerDeg);
    const dp = Math.round((jitterMs / powerSweepMs(false)) * PLAY.powerUnits);
    for (const t of targets) {
      const input = solve(hole, pos, lie, club, t);
      let v = 0.4 * valueOf(hole, state, input);
      v += 0.15 * valueOf(hole, state, { ...input, angle: wrap(input.angle + da) });
      v += 0.15 * valueOf(hole, state, { ...input, angle: wrap(input.angle - da) });
      v += 0.15 * valueOf(hole, state, { ...input, power: Math.min(PLAY.powerUnits, input.power + dp) });
      v += 0.15 * valueOf(hole, state, { ...input, power: Math.max(1, input.power - dp) });
      if (v < bestV) { bestV = v; best = input; }
    }
  }
  if (!best) best = solve(hole, pos, lie, 'wedge', hole.cup);
  return best;
}

// Turn the intended input into what a human with timing jitter actually locks:
// find the moment the meter shows the wanted value, add the timing error,
// and read the meter at that moment (so reflections and the snap zone apply).
function execute(hole, state, want, jitterMs, gauss) {
  const sweep = aimSweepMs(want.club, state.lie, false);
  const centre = aimCentre(hole, state.pos, want.club, state.lie);
  let off = ((want.angle - centre + UNITS * 1.5) % UNITS) - UNITS / 2; // tenths of a degree
  const half = METER.aimHalfDeg * PLAY.angleUnitsPerDeg;
  off = Math.max(-half, Math.min(half, off));
  let tAim = ((off + half) / (2 * half)) * sweep;
  if (tAim < 250) tAim = 2 * sweep - tAim; // too soon after the start: take the return pass
  const angle = lockAim(centre, Math.max(0, tAim + gauss() * jitterMs), sweep);
  const pMs = powerSweepMs(false);
  const tPow = (want.power / PLAY.powerUnits) * pMs;
  const power = lockPower(Math.max(0, tPow + gauss() * jitterMs), pMs);
  return { club: want.club, angle, power };
}

export function playHole(hole, jitterMs, gauss) {
  let state = newHoleState();
  const log = { driverTee: 0, driverTeeOb: 0, shots: 0, gir: false, holedOut: false };
  while (!state.done) {
    const want = chooseShot(hole, state, jitterMs);
    const input = execute(hole, state, want, jitterMs, gauss);
    const fullDriver = input.club === 'driver' && state.lie === 'tee' && want.power >= 0.9 * PLAY.powerUnits;
    const before = state;
    const r = applyShot(hole, state, input);
    state = r.state;
    log.shots++;
    if (fullDriver) { log.driverTee++; if (r.outcome.result === 'ob') log.driverTeeOb++; }
    // Green in regulation: on the green (or holed) with par - 2 strokes or fewer.
    if ((state.lie === 'green') && before.shots.length + before.penalties + 1 <= hole.par - 2) log.gir = true;
    if (state.holed) log.holedOut = true;
  }
  return { state, log };
}

export function runProfile(name, jitterMs, holes, seed) {
  const rng = makeRng('balance|' + seed + '|' + name);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
  const t = {
    holes: 0, vsPar: 0, birdie: 0, par: 0, bogey: 0, double: 0, shots: 0, ob: 0, water: 0, putts: 0,
    driverTee: 0, driverTeeOb: 0, gir: 0, holedOut: 0, pickups: 0, onePutt: 0, threePutt: 0, greens: 0,
    byPar: { 3: [0, 0], 4: [0, 0], 5: [0, 0] },
  };
  for (const hole of holes) {
    const { state, log } = playHole(hole, jitterMs, gauss);
    const d = state.strokes - hole.par;
    t.holes++; t.vsPar += d;
    if (d < 0) t.birdie++; else if (d === 0) t.par++; else if (d === 1) t.bogey++; else t.double++;
    t.shots += log.shots; t.ob += state.ob; t.water += state.water; t.putts += state.putts;
    t.driverTee += log.driverTee; t.driverTeeOb += log.driverTeeOb;
    if (log.gir) t.gir++;
    if (log.holedOut) t.holedOut++;
    if (state.pickedUp) t.pickups++;
    if (state.putts) { t.greens++; if (state.putts === 1) t.onePutt++; if (state.putts === 3) t.threePutt++; }
    t.byPar[hole.par][0]++; t.byPar[hole.par][1] += d;
  }
  const pct = (a, b) => (b ? (100 * a) / b : 0);
  return {
    profile: name, jitterMs, holes: t.holes,
    avgVsPar: t.vsPar / t.holes,
    birdiePct: pct(t.birdie, t.holes), parPct: pct(t.par, t.holes), bogeyPct: pct(t.bogey, t.holes), doublePct: pct(t.double, t.holes),
    obPerFullDriverPct: pct(t.driverTeeOb, t.driverTee), obPerShotPct: pct(t.ob, t.shots), waterPerShotPct: pct(t.water, t.shots),
    girPct: pct(t.gir, t.holes), holeOutPct: pct(t.holedOut, t.holes), pickupPct: pct(t.pickups, t.holes),
    puttsPerGreen: t.greens ? t.putts / t.greens : 0, onePuttPct: pct(t.onePutt, t.greens), threePuttPct: pct(t.threePutt, t.greens),
    par3: t.byPar[3][0] ? t.byPar[3][1] / t.byPar[3][0] : 0,
    par4: t.byPar[4][0] ? t.byPar[4][1] / t.byPar[4][0] : 0,
    par5: t.byPar[5][0] ? t.byPar[5][1] / t.byPar[5][0] : 0,
  };
}

export const TARGETS = {
  // Decent profile (docs/game.md 8): about par + 0.5, birdies about 15%,
  // double or worse under 10%, OB about 3% per full driver.
  avgVsPar: [0.3, 0.7],
  birdiePct: [12, 18],
  doublePct: [0, 10],
  obPerFullDriverPct: [1.5, 4.5],
};

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const n = Number(opt('holes', 2000));
  const seed = opt('seed', 'bal');
  const only = opt('profile', '');
  const holes = [];
  for (let i = 0; i < n; i++) holes.push(generateHole(seed + '-' + i));
  const results = [];
  for (const name of Object.keys(PROFILES)) {
    if (only && only !== name) continue;
    results.push(runProfile(name, PROFILES[name], holes, seed));
  }
  if (args.includes('--json')) { console.log(JSON.stringify(results, null, 2)); return; }
  const f = (v, d = 1) => v.toFixed(d).padStart(7);
  console.log('Handi Golf balance: ' + n + ' holes, seed "' + seed + '"\n');
  console.log('profile  jitter   avg/par  birdie%    par%  bogey%  dbl+%   GIR%  OB/drv%  OB/shot% water/shot% holeout% pickup% putts/green 1-putt% 3-putt%   par3   par4   par5');
  for (const r of results) {
    console.log(r.profile.padEnd(8) + String(r.jitterMs + 'ms').padStart(6) + '  ' + (r.avgVsPar >= 0 ? '+' : '') + r.avgVsPar.toFixed(2).padStart(6)
      + f(r.birdiePct) + ' ' + f(r.parPct) + ' ' + f(r.bogeyPct) + f(r.doublePct) + f(r.girPct) + '  ' + f(r.obPerFullDriverPct, 2) + '   ' + f(r.obPerShotPct, 2)
      + '     ' + f(r.waterPerShotPct, 2) + '  ' + f(r.holeOutPct, 2) + ' ' + f(r.pickupPct, 2) + '     ' + f(r.puttsPerGreen, 2) + ' ' + f(r.onePuttPct) + ' ' + f(r.threePuttPct)
      + f(r.par3, 2) + f(r.par4, 2) + f(r.par5, 2));
  }
  const decent = results.find((r) => r.profile === 'decent');
  if (decent) {
    console.log('\nTargets (decent profile):');
    let ok = true;
    for (const k of Object.keys(TARGETS)) {
      const [lo, hi] = TARGETS[k];
      const pass = decent[k] >= lo && decent[k] <= hi;
      if (!pass) ok = false;
      console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + k.padEnd(20) + decent[k].toFixed(2).padStart(7) + '   target ' + lo + ' to ' + hi);
    }
    console.log(ok ? '\nAll targets met.' : '\nTargets NOT met.');
    if (!ok) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
