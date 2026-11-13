import test from 'node:test';
import assert from 'node:assert/strict';
import { CLUB_ORDER, PLAY, METER, CLUBS } from '../js/game/constants.js';
import { generateHole } from '../js/game/generate.js';
import { resolveShot, surfaceAt, maxCarry } from '../js/game/physics.js';
import { newHoleState, applyShot, replay, puttsFor, aimCentre, headingTenths, isValidInput, suggestClub, scoreName } from '../js/game/rules.js';
import { triangle, aimOffsetDeg, powerFrac, lockAim, lockPower, quantisePower, aimSweepMs, powerSweepMs } from '../js/game/meter.js';
import { makeRng } from '../js/game/rng.js';
import { addToLifetime, emptyLifetime, endlessHoleSeed } from '../js/game/modes/endless.js';

test('an Endless run seed reproduces the same sequence independently of scores or replays', () => {
  const seeds = (seed) => Array.from({ length: 5 }, (_, i) => endlessHoleSeed(seed, i));
  const first = seeds('friends-2026');
  assert.equal(first[0], 'friends-2026'); // Existing single-hole seeds keep their original first hole.
  assert.deepEqual(first, seeds('friends-2026'));
  assert.equal(new Set(first).size, first.length);
  assert.notDeepEqual(first, seeds('friends-2027'));
  assert.deepEqual(generateHole(first[1]), generateHole(endlessHoleSeed('friends-2026', 1)));
  assert.notEqual(endlessHoleSeed('friends-2026', 1), endlessHoleSeed('friends-2026', 2));
  assert.throws(() => endlessHoleSeed('friends-2026', -1), RangeError);
});

// Play a hole with seeded-random (but always valid, quantised) inputs.
function randomRound(hole, rng) {
  let state = newHoleState();
  const outcomes = [];
  while (!state.done) {
    const club = CLUB_ORDER[rng.int(0, 2)];
    const centre = aimCentre(hole, state.pos, club, state.lie);
    const angle = (centre + rng.int(-250, 250) + 3600) % 3600;
    const power = rng.int(60, 200);
    const r = applyShot(hole, state, { club, angle, power });
    outcomes.push(r.outcome);
    state = r.state;
  }
  return { state, outcomes };
}

test('resolveShot is deterministic for identical inputs', () => {
  const rng = makeRng('resolve');
  for (let i = 0; i < 150; i++) {
    const hole = generateHole('res-' + i);
    const copy = JSON.parse(JSON.stringify(hole));
    for (let k = 0; k < 20; k++) {
      const input = { club: CLUB_ORDER[rng.int(0, 2)], angle: rng.int(0, 3599), power: rng.int(0, 200) };
      const from = [rng.range(-20, 20), rng.range(0, hole.lengthYds)];
      const lie = ['tee', 'fairway', 'rough', 'bunker'][rng.int(0, 3)];
      const a = resolveShot(hole, from, lie, input);
      const b = resolveShot(hole, from, lie, { ...input });
      const c = resolveShot(copy, from.slice(), lie, input); // a JSON copy of the hole behaves identically
      assert.deepEqual(a, b);
      assert.deepEqual(a, c);
      assert.equal(JSON.stringify(a), JSON.stringify(c));
    }
  }
});

test('replaying a logged, quantised shot sequence reproduces the identical result', () => {
  const rng = makeRng('replay');
  let pens = 0, holed = 0, pickups = 0, greens = 0;
  for (let i = 0; i < 400; i++) {
    const hole = generateHole('rep-' + i);
    const { state } = randomRound(hole, rng);
    // The log is plain integers and strings: it survives JSON.
    const log = JSON.parse(JSON.stringify(state.shots));
    for (const s of log) assert.ok(isValidInput(s));
    const again = replay(JSON.parse(JSON.stringify(hole)), log);
    assert.deepEqual(again, state);
    assert.ok(state.done && state.strokes >= 1 && state.strokes <= PLAY.strokeCap);
    pens += state.penalties; if (state.holed) holed++; if (state.pickedUp) pickups++; if (state.putts) greens++;
  }
  // The random rounds exercise every branch of the rules.
  assert.ok(pens > 20 && pickups > 0 && greens > 50, JSON.stringify({ pens, holed, pickups, greens }));
});

test('replay rejects a log that does not match', () => {
  const hole = generateHole('rep-1');
  const { state } = randomRound(hole, makeRng('x'));
  const bad = state.shots.map((s) => ({ ...s }));
  bad[0].result = bad[0].result === 'ok' ? 'ob' : 'ok';
  assert.throws(() => replay(hole, bad));
  assert.throws(() => replay(hole, state.shots.concat([{ club: 'wedge', angle: 0, power: 100 }])));
  assert.throws(() => applyShot(hole, newHoleState(), { club: 'putter', angle: 0, power: 100 }));
  assert.throws(() => applyShot(hole, newHoleState(), { club: 'iron', angle: 12.5, power: 100 }));
});

test('OB and water: +1 penalty, ball returns to where it was struck from, same lie', () => {
  let sawOb = false, sawWater = false;
  for (let i = 0; i < 300 && !(sawOb && sawWater); i++) {
    const hole = generateHole('pen-' + i);
    let state = newHoleState();
    // Sideways with a driver is always out of bounds.
    const r = applyShot(hole, state, { club: 'driver', angle: 900, power: 200 });
    assert.equal(r.outcome.result, 'ob');
    assert.equal(surfaceAt(hole, r.outcome.rest[0], r.outcome.rest[1]), 'ob');
    assert.deepEqual(r.state.pos, [0, 0]);
    assert.equal(r.state.lie, 'tee');
    assert.equal(r.state.penalties, 1);
    assert.equal(r.state.strokes, 2);
    assert.equal(r.state.done, false);
    sawOb = true;
    // Look for a shot that finds water on holes that have some.
    if (!hole.water.length) continue;
    for (const club of CLUB_ORDER) {
      for (let a = -300; a <= 300 && !sawWater; a += 10) {
        for (let p = 60; p <= 200; p += 5) {
          const input = { club, angle: (a + 3600) % 3600, power: p };
          const o = resolveShot(hole, [0, 0], 'tee', input);
          if (o.result !== 'water') continue;
          const w = applyShot(hole, state, input);
          assert.equal(surfaceAt(hole, o.rest[0], o.rest[1]), 'water');
          assert.deepEqual(w.state.pos, [0, 0]);
          assert.equal(w.state.penalties, 1);
          assert.equal(w.state.water, 1);
          assert.equal(w.state.strokes, 2);
          sawWater = true;
          break;
        }
      }
    }
  }
  assert.ok(sawOb && sawWater);
});

test('auto pick-up at 12 strokes; penalties count toward the cap', () => {
  const hole = generateHole('cap');
  let state = newHoleState();
  let n = 0;
  while (!state.done) {
    state = applyShot(hole, state, { club: 'driver', angle: 900, power: 200 }).state;
    n++;
  }
  assert.equal(n, 6); // 6 shots + 6 penalties
  assert.equal(state.strokes, PLAY.strokeCap);
  assert.equal(state.pickedUp, true);
  assert.throws(() => applyShot(hole, state, { club: 'driver', angle: 0, power: 200 }));
});

test('putting rings: 1 putt inside r1, 2 inside r2, else 3; cup capture is a hole-out', () => {
  for (let i = 0; i < 100; i++) {
    const hole = generateHole('putt-' + i);
    const [cx, cy] = hole.cup;
    assert.equal(puttsFor(hole, [cx + hole.rings[0] * 0.9, cy]), 1);
    assert.equal(puttsFor(hole, [cx, cy - hole.rings[1] * 0.9]), 2);
    assert.equal(puttsFor(hole, [cx + hole.rings[1] * 1.05, cy]), 3);
    // A wedge that lands on the cup is holed: 0 putts.
    const from = [cx, cy - 45];
    if (surfaceAt(hole, from[0], from[1]) === 'ob') continue;
    const calm = { ...hole, wind: { mph: 0, dirDeg: 0 } };
    const o = resolveShot(calm, from, 'fairway', { club: 'wedge', angle: 0, power: 100 });
    assert.equal(o.result, 'holed');
    assert.deepEqual(o.rest, [cx, cy]);
  }
});

test('a finished hole scores shots + penalties + putts', () => {
  const rng = makeRng('score');
  for (let i = 0; i < 200; i++) {
    const hole = generateHole('score-' + i);
    const { state } = randomRound(hole, rng);
    const raw = state.shots.length + state.penalties + state.putts;
    assert.equal(state.strokes, Math.min(PLAY.strokeCap, raw));
    if (state.holed) assert.equal(state.putts, 0);
    assert.equal(state.penalties, state.ob + state.water);
    assert.equal(state.shots.filter((s) => s.result === 'ob' || s.result === 'water').length, state.penalties);
  }
});

test('lies change distance; wind moves the ball the right way', () => {
  assert.equal(maxCarry('driver', 'tee'), 250);
  assert.equal(maxCarry('iron', 'fairway'), 160);
  assert.equal(maxCarry('wedge', 'tee'), 90);
  assert.ok(maxCarry('driver', 'rough') < maxCarry('driver', 'fairway'));
  assert.ok(maxCarry('driver', 'bunker') < maxCarry('wedge', 'bunker') + 30);
  const base = generateHole('wind', { par: 5 });
  const shot = { club: 'driver', angle: 0, power: 200 };
  const land = (mph, dirDeg) => resolveShot({ ...base, wind: { mph, dirDeg } }, [0, 0], 'tee', shot).landing;
  const calm = land(0, 0);
  assert.ok(Math.abs(calm[1] - 250) < 1e-9 && Math.abs(calm[0]) < 1e-9);
  assert.ok(land(20, 0)[1] > calm[1] + 20);     // tailwind carries further
  assert.ok(land(20, 180)[1] < calm[1] - 20);   // headwind falls short
  assert.ok(land(20, 90)[0] > 20);              // wind toward +x pushes right
  assert.ok(land(20, 270)[0] < -20);
  // Maximum effect is about 10-15% of carry at 20 mph.
  assert.ok(land(20, 0)[1] - 250 <= 0.15 * 250 + 1e-9);
  // Less sensitive clubs move less.
  const wedge = resolveShot({ ...base, wind: { mph: 20, dirDeg: 90 } }, [0, 0], 'tee', { club: 'wedge', angle: 0, power: 200 }).landing;
  assert.ok(wedge[0] / 90 < land(20, 90)[0] / 250);
});

test('meters: analytic triangle waves, quantised locks, power snap', () => {
  assert.equal(triangle(0, 1000), 0);
  assert.equal(triangle(500, 1000), 0.5);
  assert.equal(triangle(1000, 1000), 1);
  assert.equal(triangle(1500, 1000), 0.5);
  assert.equal(triangle(2000, 1000), 0);
  assert.equal(aimOffsetDeg(0, 900), -METER.aimHalfDeg);
  assert.equal(aimOffsetDeg(450, 900), 0);
  assert.equal(aimOffsetDeg(900, 900), METER.aimHalfDeg);
  assert.equal(powerFrac(250, 1000), 0.25);
  assert.equal(quantisePower(0.5), 100);
  assert.equal(quantisePower(0.969), 194);
  assert.equal(quantisePower(0.97), 200);
  assert.equal(quantisePower(1), 200);
  assert.equal(lockPower(980, 1000), 200);
  assert.equal(lockAim(0, 0, 900), 3200);       // 40 degrees left of straight up
  assert.equal(lockAim(100, 450, 900), 100);
  for (let t = 0; t < 5000; t += 7) {
    const a = lockAim(1234, t, 1100);
    assert.ok(Number.isInteger(a) && a >= 0 && a < 3600);
    const p = lockPower(t, 1000);
    assert.ok(Number.isInteger(p) && p >= 0 && p <= 200);
  }
  // Lies speed the aim meter up; assist slows both meters, same factor.
  assert.equal(aimSweepMs('driver', 'tee', false), CLUBS.driver.aimSweepMs);
  assert.ok(aimSweepMs('driver', 'rough', false) < aimSweepMs('driver', 'fairway', false));
  assert.ok(aimSweepMs('iron', 'bunker', false) < aimSweepMs('iron', 'rough', false));
  assert.equal(aimSweepMs('iron', 'tee', true), CLUBS.iron.aimSweepMs * METER.assistFactor);
  assert.equal(powerSweepMs(true), METER.powerSweepMs * METER.assistFactor);
});

test('aim centre: the pin when in range, otherwise up the centerline', () => {
  for (let i = 0; i < 200; i++) {
    const hole = generateHole('aim-' + i);
    for (const club of CLUB_ORDER) {
      const c = aimCentre(hole, [0, 0], club, 'tee');
      assert.ok(Number.isInteger(c) && c >= 0 && c < 3600);
      const off = Math.min(c, 3600 - c);
      assert.ok(off < 700, 'aims up the hole from the tee: ' + c);
    }
    const near = [hole.cup[0] - 20, hole.cup[1] - 40];
    assert.equal(aimCentre(hole, near, 'wedge', 'fairway'), headingTenths(near[0], near[1], hole.cup[0], hole.cup[1]));
    assert.ok(CLUB_ORDER.includes(suggestClub(hole, [0, 0], 'tee')));
  }
  assert.equal(headingTenths(0, 0, 0, 10), 0);
  assert.equal(headingTenths(0, 0, 10, 0), 900);
  assert.equal(headingTenths(0, 0, 0, -10), 1800);
  assert.equal(headingTenths(0, 0, -10, 0), 2700);
});

test('score names and lifetime stats', () => {
  assert.equal(scoreName(1, 3), 'Hole in one');
  assert.equal(scoreName(3, 4), 'Birdie');
  assert.equal(scoreName(3, 5), 'Eagle');
  assert.equal(scoreName(4, 4), 'Par');
  assert.equal(scoreName(6, 4), 'Double bogey');
  let s = emptyLifetime();
  const st = (strokes, extra = {}) => ({ strokes, ob: 0, water: 0, pickedUp: false, ...extra });
  s = addToLifetime(s, 4, st(3));
  s = addToLifetime(s, 4, st(4, { ob: 1 }));
  s = addToLifetime(s, 5, st(3, { water: 2 }));
  s = addToLifetime(s, 3, st(1));
  s = addToLifetime(s, 4, st(12, { pickedUp: true }));
  s = addToLifetime(s, 4, st(4));
  assert.deepEqual(s, {
    holes: 6, strokes: 27, par: 24, streak: 1, bestStreak: 4,
    birdies: 1, eagles: 2, holesInOne: 1, ob: 1, water: 2, pickups: 1,
  });
});
