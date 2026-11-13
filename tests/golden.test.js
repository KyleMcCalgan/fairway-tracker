import test from 'node:test';
import assert from 'node:assert/strict';
import { GEN_VERSION } from '../js/game/constants.js';
import { generateHole, dailyHoles } from '../js/game/generate.js';
import { replay } from '../js/game/rules.js';
import { hashHex } from '../js/game/rng.js';
import { runProfile, PROFILES } from '../tools/balance.mjs';

// Pinned outputs for GEN_VERSION 1. If one of these changes, generator or
// shot behaviour changed: bump GEN_VERSION (at a UTC midnight) and re-pin.
// Running this same file in another JS engine is the cross-browser check.
const GOLDEN = {
  'version': 1,
  'holes': {
    'golden-1': '63e90a98',
    'golden-2': '7f5d97d9',
    'golden-3': 'b779e33a',
    'golden-4': 'f73db945',
    'golden-5': '61ac77f0',
    'golden-6': 'ccdca5fb'
  },
  'daily': '9e1d7c5c',
  'round': '601e9fff',
  'shotsUsed': 9
};

function snapshot() {
  const holes = {};
  for (const seed of ['golden-1', 'golden-2', 'golden-3', 'golden-4', 'golden-5', 'golden-6']) {
    holes[seed] = hashHex(JSON.stringify(generateHole(seed)));
  }
  const daily = hashHex(JSON.stringify(dailyHoles('2026-11-13')));
  const hole = generateHole('golden-1');
  const shots = [
    { club: 'driver', angle: 3570, power: 200 },
    { club: 'iron', angle: 40, power: 163 },
    { club: 'wedge', angle: 3500, power: 97 },
    { club: 'wedge', angle: 150, power: 61 },
    { club: 'iron', angle: 900, power: 200 },
    { club: 'wedge', angle: 3333, power: 120 },
    { club: 'driver', angle: 1800, power: 88 },
    { club: 'wedge', angle: 12, power: 45 },
    { club: 'iron', angle: 3588, power: 150 },
    { club: 'wedge', angle: 77, power: 33 },
    { club: 'wedge', angle: 3000, power: 10 },
    { club: 'wedge', angle: 100, power: 5 },
  ];
  let n = shots.length, state = null;
  for (; n > 0; n--) {
    try { state = replay(hole, shots.slice(0, n)); break; } catch { /* log ran past the end of the hole */ }
  }
  return { version: GEN_VERSION, holes, daily, round: hashHex(JSON.stringify(state)), shotsUsed: n };
}

test('golden snapshot: generator and resolver output is pinned for this GEN_VERSION', () => {
  assert.deepEqual(snapshot(), GOLDEN);
});

test('balance tool runs and the decent profile is in a sane range', () => {
  const holes = [];
  for (let i = 0; i < 250; i++) holes.push(generateHole('baltest-' + i));
  const a = runProfile('decent', PROFILES.decent, holes, 't');
  const b = runProfile('decent', PROFILES.decent, holes, 't');
  assert.deepEqual(a, b); // the tool's jitter is seeded, so runs repeat
  assert.ok(a.avgVsPar > 0 && a.avgVsPar < 0.9, 'avg ' + a.avgVsPar);
  assert.ok(a.doublePct < 12);
  const casual = runProfile('casual', PROFILES.casual, holes, 't');
  const expert = runProfile('expert', PROFILES.expert, holes, 't');
  assert.ok(expert.avgVsPar < a.avgVsPar && a.avgVsPar < casual.avgVsPar);
});

export { snapshot };
