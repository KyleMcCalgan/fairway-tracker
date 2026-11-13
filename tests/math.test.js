import test from 'node:test';
import assert from 'node:assert/strict';
import { dsin, dcos, datan2, pow1625, PI } from '../js/game/math.js';
import { makeRng, hashHex, makeNoise } from '../js/game/rng.js';

test('deterministic sin/cos/atan2 agree with Math.* to 1e-12', () => {
  for (let i = -4000; i <= 4000; i++) {
    const x = i * 0.0137;
    assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 1e-12, 'sin ' + x);
    assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 1e-12, 'cos ' + x);
  }
  for (let i = 0; i < 2000; i++) {
    const a = (i / 2000) * 2 * PI - PI + 0.0001;
    const r = 0.01 + i * 0.37;
    const x = r * Math.cos(a), y = r * Math.sin(a);
    assert.ok(Math.abs(datan2(y, x) - Math.atan2(y, x)) < 1e-12, 'atan2 ' + a);
  }
  assert.equal(datan2(0, 0), 0);
  assert.equal(dsin(0), 0);
  assert.equal(dcos(0), 1);
});

test('pow1625 is close to u^1.6', () => {
  for (let u = 0; u <= 1; u += 0.05) assert.ok(Math.abs(pow1625(u) - Math.pow(u, 1.6)) < 0.02);
});

test('rng is seeded and repeatable, and its output is pinned', () => {
  const a = makeRng('seed-a'), b = makeRng('seed-a'), c = makeRng('seed-b');
  const va = [], vb = [], vc = [];
  for (let i = 0; i < 50; i++) { va.push(a.next()); vb.push(b.next()); vc.push(c.next()); }
  assert.deepEqual(va, vb);
  assert.notDeepEqual(va, vc);
  for (const v of va) assert.ok(v >= 0 && v < 1);
  // Pinned values: integer maths only, so these must be the same in every engine, forever.
  assert.equal(hashHex('handi'), PINNED_HASH);
  const p = makeRng('pinned');
  assert.deepEqual([p.int(0, 9999), p.int(0, 9999), p.int(0, 9999)], PINNED_INTS);
  const n = makeNoise(makeRng('n'), 10);
  for (let s = -50; s < 50; s += 0.7) assert.ok(n(s) >= -1 && n(s) <= 1);
});

const PINNED_HASH = '9fbd2713';
const PINNED_INTS = [9307, 704, 5430];
