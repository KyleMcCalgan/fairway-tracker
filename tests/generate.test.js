import test from 'node:test';
import assert from 'node:assert/strict';
import { GEN, GEN_VERSION } from '../js/game/constants.js';
import { generateHole, dailyHoles, dailySeed } from '../js/game/generate.js';
import { validateHole } from '../js/game/validate.js';
import { isSimple, polyDist, distPointPoly, pointInPoly, polyInside } from '../js/game/geometry.js';
import { surfaceAt } from '../js/game/physics.js';
import { fairwayBlockAt } from '../js/game/bunkers.js';

test('same seed produces byte-identical hole JSON', () => {
  for (let i = 0; i < 300; i++) {
    const a = JSON.stringify(generateHole('same-' + i));
    const b = JSON.stringify(generateHole('same-' + i));
    assert.equal(a, b);
  }
  assert.notEqual(JSON.stringify(generateHole('same-1')), JSON.stringify(generateHole('same-2')));
});

test('a hole is plain JSON: it survives a round trip and still validates', () => {
  for (let i = 0; i < 100; i++) {
    const hole = generateHole('json-' + i);
    const copy = JSON.parse(JSON.stringify(hole));
    assert.deepEqual(copy, hole);
    assert.ok(validateHole(copy).ok);
  }
});

test('10,000 seeds all pass validation', () => {
  let fallbacks = 0, retries = 0, water = 0;
  const pars = { 3: 0, 4: 0, 5: 0 };
  for (let i = 0; i < 10000; i++) {
    const hole = generateHole('bulk-' + i);
    const v = validateHole(hole);
    assert.ok(v.ok, 'seed bulk-' + i + ': ' + v.errors.join(','));
    assert.equal(hole.version, GEN_VERSION);
    if (hole.meta.fallback) fallbacks++;
    retries += hole.meta.attempt;
    pars[hole.par]++;
    if (hole.water.length) water++;
  }
  assert.ok(fallbacks <= 10, 'fallback holes: ' + fallbacks);
  assert.ok(retries < 2000, 'retries: ' + retries);
  // Spec distribution: about 25/50/25 pars, about a third with water.
  assert.ok(Math.abs(pars[3] / 10000 - 0.25) < 0.03);
  assert.ok(Math.abs(pars[4] / 10000 - 0.5) < 0.03);
  assert.ok(Math.abs(water / 10000 - 0.33) < 0.06, 'water share ' + water / 10000);
});

test('polygon simplicity and the clearance rules hold (checked independently of the validator)', () => {
  for (let i = 0; i < 600; i++) {
    const h = generateHole('rules-' + i);
    const tag = 'seed rules-' + i + ' ';
    const polys = [h.playable, h.tee, h.green, ...h.bunkers.map((b) => b.poly), ...h.water.map((w) => w.poly)];
    if (h.fairway.length) polys.push(h.fairway);
    for (const p of polys) assert.ok(isSimple(p), tag + 'simple');
    // Length bands with deliberate gaps.
    const band = GEN.lengthBands[h.par];
    assert.ok(h.lengthYds >= band[0] && h.lengthYds <= band[1], tag + 'length');
    // Tee at the origin, hole runs toward +y.
    assert.equal(surfaceAt(h, 0, 0), 'tee');
    for (let k = 1; k < h.centerline.length; k++) assert.ok(h.centerline[k][1] > h.centerline[k - 1][1], tag + '+y');
    // Cup: on the green, at least 3 yards inside the edge.
    assert.ok(pointInPoly(h.green, h.cup[0], h.cup[1]), tag + 'cup on green');
    assert.ok(distPointPoly(h.green, h.cup[0], h.cup[1]) >= 2.9, tag + 'cup edge');
    assert.ok(polyInside(h.green, h.playable, 8), tag + 'green inside OB');
    // Cup to hazards: 4-6 when short-sided, otherwise at least 8.
    const hazards = [...h.bunkers, ...h.water];
    let nearest = Infinity;
    for (const z of hazards) nearest = Math.min(nearest, distPointPoly(z.poly, h.cup[0], h.cup[1]));
    if (h.meta.shortSided) assert.ok(nearest >= 3.9 && nearest <= 6.1, tag + 'short side ' + nearest);
    else assert.ok(nearest >= 7.9, tag + 'cup hazard ' + nearest);
    // Bunkers.
    for (let a = 0; a < h.bunkers.length; a++) {
      const b = h.bunkers[a];
      assert.ok(polyDist(b.poly, h.tee) >= 7.9, tag + 'bunker-tee');
      assert.ok(polyDist(b.poly, h.green) > 0, tag + 'bunker-green');
      assert.ok(polyInside(b.poly, h.playable, 2), tag + 'bunker-ob');
      for (const w of h.water) assert.ok(polyDist(b.poly, w.poly) >= 2.9, tag + 'bunker-water');
      for (let c = a + 1; c < h.bunkers.length; c++) {
        const o = h.bunkers[c];
        if (b.group && b.group === o.group) continue;
        assert.ok(polyDist(b.poly, o.poly) >= 2.9, tag + 'bunker spacing');
      }
    }
    if (h.fairway.length && h.bunkers.length) {
      for (let k = 0; k < h.centerline.length; k++) {
        const r = fairwayBlockAt(h, k);
        if (r && r.fw >= 8) assert.ok(r.blocked <= 0.5 * r.fw + 1, tag + 'fairway block');
      }
    }
    // Water: never on the tee, green or cup; at most 2 features.
    assert.ok(h.water.length <= 2, tag + 'water budget');
    for (const w of h.water) {
      assert.ok(polyDist(w.poly, h.tee) >= 18, tag + 'water-tee');
      assert.ok(polyDist(w.poly, h.green) >= 3.5, tag + 'water-green');
      assert.ok(!pointInPoly(w.poly, h.cup[0], h.cup[1]), tag + 'water-cup');
    }
  }
});

test('forced par and wind flavours', () => {
  for (let i = 0; i < 60; i++) {
    for (const par of [3, 4, 5]) assert.equal(generateHole('par-' + i, { par }).par, par);
    const calm = generateHole('w-' + i, { wind: 'calm' }).wind;
    const cross = generateHole('w-' + i, { wind: 'cross' }).wind;
    const strong = generateHole('w-' + i, { wind: 'strong' }).wind;
    assert.ok(calm.mph <= 3);
    assert.ok(cross.mph >= 8 && cross.mph <= 13);
    const off = Math.min(Math.abs(cross.dirDeg - 90), Math.abs(cross.dirDeg - 270));
    assert.ok(off <= 20, 'crosswind direction ' + cross.dirDeg);
    assert.ok(strong.mph >= 15 && strong.mph <= 20);
    const any = generateHole('w-' + i).wind;
    assert.ok(Number.isInteger(any.mph) && any.mph >= 0 && any.mph <= 20 && any.dirDeg % 5 === 0);
  }
});

test('daily holes: par 3, 4 and 5 in a date-seeded order with three wind flavours', () => {
  const orders = new Set();
  for (let d = 1; d <= 28; d++) {
    const date = '2026-11-' + String(d).padStart(2, '0');
    const holes = dailyHoles(date);
    assert.equal(holes.length, 3);
    assert.deepEqual(holes.map((h) => h.par).sort(), [3, 4, 5]);
    holes.forEach((h, i) => {
      assert.equal(h.seed, dailySeed(date, i + 1));
      assert.ok(h.seed.startsWith('handi-daily-' + GEN_VERSION + '-' + date));
      assert.ok(validateHole(h).ok);
    });
    const mph = holes.map((h) => h.wind.mph).sort((a, b) => a - b);
    assert.ok(mph[0] <= 3 && mph[1] >= 8 && mph[1] <= 13 && mph[2] >= 15);
    orders.add(holes.map((h) => h.par).join(''));
    assert.equal(JSON.stringify(dailyHoles(date)), JSON.stringify(holes));
  }
  assert.ok(orders.size >= 4, 'par order varies by date');
});
