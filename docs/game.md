# HANDI Golf: how the minigame works

This document describes the HANDI Golf minigame as it is built: how a hole is generated from a seed, how a shot is resolved, how the play screen drives both, and how the two modes sit on top. It replaces the original planning document, which is kept in git history (commit `774f340`).

**Status.** Milestones 1 to 4 are built on branch `game-standalone`: generator and gallery, shot mechanics and Endless mode, balance tool and tuning, and Daily mode against a local stub. Milestone 5 (integration into the HANDI app) is built too: a "Play" view in the app, Firebase-backed adapters, a friends system, a friends leaderboard and a global percentile (section 13.1). The standalone page (`game/index.html`) still runs fully offline, with no login and no network calls.

Every number quoted here comes from `js/game/constants.js`. If this document and that file disagree, the file is right.

## Contents

1. [What the game is](#1-what-the-game-is)
2. [Running it](#2-running-it)
3. [File map](#3-file-map)
4. [Determinism](#4-determinism)
5. [The hole object](#5-the-hole-object)
6. [Hole generation, step by step](#6-hole-generation-step-by-step)
7. [Surfaces](#7-surfaces)
8. [Shot mechanics](#8-shot-mechanics)
9. [Rules of a hole](#9-rules-of-a-hole)
10. [The play screen](#10-the-play-screen)
11. [Endless mode](#11-endless-mode)
12. [Daily mode](#12-daily-mode)
13. [Integration seam](#13-integration-seam)
14. [Balance tool](#14-balance-tool)
15. [Tests](#15-tests)
16. [Gallery](#16-gallery)
17. [Changing things safely](#17-changing-things-safely)
18. [Decisions and differences from the plan](#18-decisions-and-differences-from-the-plan)
19. [Not done and not verified](#19-not-done-and-not-verified)

---

## 1. What the game is

A 2D, top-down canvas golf game with procedurally generated holes. Units are yards.

- Three clubs: Driver, Iron, Wedge.
- Surfaces: tee box, fairway, rough, bunker, water, green, and out-of-bounds (OB).
- Wind that the player must allow for.
- A shot is two timed taps: an aim arrow sweeps left and right (tap to lock the direction), then a power bar sweeps up and down (tap to lock the power). There is no redo.
- When the ball stops on the green the hole ends: two rings around the cup decide whether it costs 1, 2 or 3 putts.
- Two modes: **Endless** (a new random hole every time) and **Daily** (the same three holes for everyone each UTC day, one attempt).

There is no randomness in play. A shot is a pure function of the hole, where the ball lies, and three integers. Randomness exists only in seeded hole generation.

## 2. Running it

From the `fairway-tracker` folder:

```
python -m http.server 8000
```

| Page | URL |
|---|---|
| Game | `http://localhost:8000/game/index.html` |
| Game, Daily tab | `http://localhost:8000/game/index.html?mode=daily` |
| Gallery | `http://localhost:8000/tools/gallery.html` |

Development query parameters on the game page: `?seed=abc` starts Endless on that seed, and `?date=YYYY-MM-DD` makes Daily use that date instead of today.

```
node --test                                        all tests (about 36 seconds)
node tools/balance.mjs                             balance report, 2000 holes
node tools/balance.mjs --holes 3000 --seed other   bigger run, other holes
node tools/balance.mjs --profile decent --json     one profile, JSON output
```

There is no build step, no bundler and no runtime dependency. `package.json` only sets `"type": "module"` and the `test` and `balance` scripts.

## 3. File map

```
fairway-tracker/
  docs/game.md              this document
  package.json              "type": "module", test script
  js/game/
    constants.js            every tuning number, with comments
    rng.js                  seeded PRNG, string hash, value noise        pure
    math.js                 deterministic sin, cos, atan2                pure
    geometry.js             polygon maths                                pure
    centerline.js           hole centerline by heading integration       pure
    corridor.js             fairway, OB boundary, tee box                pure
    green.js                green shape, cup, putting rings              pure
    water.js                streams, rivers, ponds                       pure
    bunkers.js              six bunker types                             pure
    validate.js             hole validation                              pure
    generate.js             the pipeline; daily holes                    pure
    physics.js              surfaceAt, resolveShot                       pure
    rules.js                strokes, penalties, putts, replay            pure
    meter.js                aim and power meter maths                    pure
    render.js               canvas drawing
    ui.js                   play screen: HUD, input, camera, animation
    modes/endless.js        Endless mode
    modes/daily.js          Daily mode
    index.js                mount(container, options)
  game/
    index.html              standalone page
    game.css                the game's own styles (scoped under .hg-root)
    local-adapters.js       localStorage storage and the stub daily backend
  tools/
    gallery.html            grid of generated holes
    balance.mjs             balance bot
  tests/
    math.test.js  generate.test.js  play.test.js  daily.test.js  golden.test.js
```

"Pure" means no DOM, no `Math.random`, no `Date`, no network and no Firebase. Those modules run unchanged in Node, which is how they are tested. `render.js`, `ui.js`, the two modes and `index.js` are the only parts that touch the DOM. Nothing in `js/game` or `game/` imports from the rest of the HANDI app.

How the pieces call each other:

```
generate.js ── centerline → green → corridor + tee → water → bunkers → pin → wind
     │                                                                    │
     └────────────── validate.js (regenerate if it fails) ◄───────────────┘
     ▼
  hole object (plain JSON)
     │
     ├── render.js draws its polygons
     └── physics.js resolveShot(hole, from, lie, {club, angle, power})
              ▲                       ▲
              │                       └── meter.js turns tap times into the two integers
         rules.js applyShot / replay
              ▲
           ui.js (one hole) ◄── modes/endless.js, modes/daily.js ◄── index.js mount()
```

## 4. Determinism

The daily leaderboard only measures skill if every player's device builds the same holes and resolves the same shot the same way. These rules make that hold.

**Seeded PRNG.** `rng.js` hashes a string with xmur3 and feeds the result to sfc32. Both use 32-bit integer maths only, so the stream is identical in every JS engine. `makeRng(seedString)` returns a generator with helpers (`range`, `int`, `chance`, `weighted`, `shuffle`); each helper consumes exactly one value.

**One sub-stream per stage.** Each generation stage gets its own generator, seeded with

```
GEN_VERSION | seed | attempt | stageName
```

where the stage names are `spec`, `centerline`, `green`, `corridor`, `water`, `bunkers`, `pin` and `wind`. Changing how one stage uses its random numbers does not reshuffle the others.

**Exact operations only.** Generation and shot resolution use only `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.round`, `Math.abs`, `Math.min`, `Math.max` and integer maths, all of which IEEE 754 defines exactly. `Math.sin`, `cos`, `atan2`, `log`, `exp` and `pow` can differ in the last bit between browsers, so the core never calls them. `math.js` supplies replacements built from the exact operations:

- `dsin`, `dcos`: reduce the angle to within a quarter turn, then evaluate a fixed Taylor polynomial.
- `datan2`: two half-angle reductions using `sqrt`, then a fixed series.
- `pow1625(u)`: `u * sqrt(u) * sqrt(sqrt(sqrt(u)))`, used for the wind speed curve.

Smooth noise (`makeNoise`) is value noise: random knots joined by a cubic blend, again exact operations only. Rendering and animation use `Math.*` freely because they do not affect results.

**Polygons are the canonical shapes.** Every surface is a polygon. The rules test a point against the same polygon the renderer draws, so the picture and the rules cannot disagree. All coordinates are rounded to 0.01 yards when a shape is created, and the rounded shape is the one that is checked, stored and drawn.

**Quantised inputs.** A shot is logged and resolved from integers:

| Field | Meaning | Range |
|---|---|---|
| `club` | `'driver'`, `'iron'` or `'wedge'` | |
| `angle` | absolute heading in 0.1 degree steps; 0 is straight up the map (+y), increasing clockwise | 0 to 3599 |
| `power` | 0.5 percent steps; 200 is 100% | 0 to 200 |

The resolver only ever sees these integers, never a raw tap time.

**`GEN_VERSION`** (currently 1) is part of every seed string and every stored daily result. It must be bumped whenever generator or resolver behaviour changes, and only at a UTC midnight, otherwise early and late players on the same day would get different holes.

## 5. The hole object

`generateHole(seed, opts)` returns a plain object that survives `JSON.stringify` and back unchanged.

```
{
  version,                  GEN_VERSION
  seed,                     the seed string
  par,                      3, 4 or 5
  lengthYds,                length along the centerline, tee to green centre
  wind: { mph, dirDeg },    dirDeg is the direction the wind blows TOWARD
  centerline: [[x, y], ...] one point every 2 yards, tee to green centre
  fairway: polygon,         [] when a par 3 has no fairway
  playable: polygon,        the OB boundary; outside it is out of bounds
  tee: polygon,
  green: polygon,
  cup: [x, y],
  rings: [r1, r2],          1-putt and 2-putt radii around the cup
  bunkers: [{ kind, poly, group? }],
  water: [{ kind, poly }],
  meta: { archetype, difficulty, shortSided, attempt, fallback }
}
```

Coordinates: the tee is at the origin and the hole runs toward +y. Angles everywhere (headings, shot angles, wind direction) use the same convention: 0 is +y, positive is clockwise toward +x, so a heading `a` is the direction `(sin a, cos a)`.

A polygon is an array of `[x, y]` points, implicitly closed. `group` appears only on cluster bunkers and identifies which blobs belong together.

## 6. Hole generation, step by step

`generateHole(seed, opts)` in `generate.js`. `opts.par` forces the par and `opts.wind` forces a wind flavour (`'calm'`, `'cross'`, `'strong'`); both are used by Daily mode.

The outer loop:

1. For `attempt` 0 to 19, build a hole from the sub-streams for that attempt and run `validateHole` on it. Return the first one that passes.
2. If all 20 fail, build the **safe hole**: same par and length, straight, difficulty 0.3, full fairway, no water and no bunkers. It must itself pass validation or generation throws.

In smoke runs of 1,500 to 3,000 seeds about 95% of holes passed on the first attempt, the rest on the second or third, and none needed the safe hole. The test suite allows at most 10 safe holes in 10,000 seeds.

The stages below run in this order. It differs from the numbered order in the original plan in two places, both harmless because each stage has its own sub-stream: the green is built before the corridor (the corridor needs the green's radius), and water is built before bunkers (water is the more constrained, so bunkers avoid water rather than the reverse).

### 6.1 Spec

| Choice | How |
|---|---|
| Par | 25% par 3, 50% par 4, 25% par 5, unless forced |
| Length | uniform in the par's band, rounded to an even number: par 3 110-210, par 4 300-400, par 5 470-580 |
| Archetype | par 3: straight 60%, gentle 40%. Par 4: straight 25%, gentle 30%, dogleg-left 22.5%, dogleg-right 22.5%. Par 5: straight 20%, gentle 25%, dogleg-left 20%, dogleg-right 20%, s-curve 15% |
| Difficulty | uniform 0 to 1, rounded to 0.01 |

Difficulty drives fairway width, rough width and hazard counts. Higher is harder.

### 6.2 Centerline

The centerline is built by heading integration, not splines. The heading is a function of distance `s` along the hole:

```
heading(s) = h0 + drift(s) + sum over bends of  turn * smoothstep((s - start) / length)
```

Position is then integrated in 2 yard steps: `x += 2 * sin(heading)`, `y += 2 * cos(heading)`, using the heading at the middle of each step.

Bends by archetype:

| Archetype | Bends |
|---|---|
| straight | none |
| gentle | one turn of 8-20 degrees, left or right, spread over 120-200 yards (at most 60% of the hole), centred 40-60% of the way along |
| dogleg-left / -right | one turn of 26-44 degrees. The corner is centred 200-240 yards from the tee, where a drive lands. On par 5s, 40% of the time it is instead 150-190 yards back from the green |
| s-curve | a turn of 22-34 degrees at 200-240 yards, then the opposite turn of 22-34 degrees at 150-190 yards back from the green |

Dogleg and S-curve bends obey three limits:

- The turn is spread over 60-90 yards. The peak curvature of a smoothstep ramp is `1.5 * turn / length`, so the length is set to at least `1.5 * 58 * turn` to keep the tightest turning radius at or above 58 yards.
- Every bend finishes at least 70 yards before the green.
- A corner that would break the second limit is moved back toward the tee.

`drift` is low-frequency noise (wavelength 160 yards) of 0.5-3 degrees, added to every hole so even a straight hole is not ruler-straight.

`h0`, the starting heading, is chosen so the line from tee to green points roughly along +y: each bend contributes `-turn * (share of the hole that lies after the bend)`. That keeps doglegs upright on a portrait screen.

### 6.3 Green

The green is centred on the last centerline point.

**Size.** The expected approach distance is the hole length for a par 3, `length - 235` for a par 4 and `length - 235 - 190` for a par 5 (never less than 40). The mean radius blends from 8-11 yards at a 70 yard approach up to 12-17 yards at a 190 yard approach.

**Shape.** Start from an ellipse with a long-to-short axis ratio up to 1.35 at a random rotation. Multiply its radius in each direction by

```
1 + h2 * cos(2 * angle + p2) + h3 * cos(3 * angle + p3)
```

with `h2` up to 0.08 and `h3` between 0.03 and 0.12. This gives ovals, pears and kidneys. The radius is always positive, so the shape is star-shaped about its centre and cannot self-intersect. It is sampled at 40 vertices.

**Cup.** Pick one of 8 directions around the green (front, back, sides, corners, relative to the hole's heading), jitter it by up to 15 degrees, and place the cup 55-80% of the way to the edge in that direction. If that is less than 3 yards inside the edge, step inward until it is.

**Rings.** `r1 = 0.19 * R` and `r2 = 0.4 * R`, where `R` is the mean radius. They are circles around the cup; only the part on the green matters, because putts are only counted for a ball resting on the green. A pin near the edge leaves most of the green in the 3-putt zone.

### 6.4 Corridor: fairway and OB line

The corridor is built in the frame of the centerline: `s` is distance along it and `lat` is the sideways offset (negative left, positive right). `toWorld(s, lat)` converts to map coordinates by stepping `lat` yards along the normal at `s`. Each side is computed separately, so holes are asymmetric.

**Fairway half-width** on each side at distance `s`:

```
base * (1 + 0.2 * lowNoise(s))  +  swell(s)
```

- The total base width runs from 44 yards (easiest) to 26 (hardest) by difficulty, plus or minus 3, split 42-58% between left and right.
- `lowNoise` has a 130 yard wavelength.
- `swell` adds up to 4 yards per side around the driver landing zone (218.75 yards from the tee, fading out over 45 yards either way). Par 4 and 5 only.
- It is capped so at least 8 yards of rough remain inside the OB line.

**Fairway extent.**

- Par 4 and 5: starts 40-70 yards from the tee.
- Par 3: half have no fairway at all; the rest get a partial strip starting 50-65% of the way along.
- 70% of fairways run into the green, narrowing over the last 50 yards to a neck 0.7 green radii wide and ending just inside the green (the green is drawn on top). The other 30% stop 12-28 yards short of the green's edge.
- Both ends are rounded over 12 yards, and the edge gets a small wobble of plus or minus 1.5 yards (12 yard wavelength).

**OB half-width** on each side:

```
fairway half-width  +  rough * (1 + 0.12 * obNoise(s))
```

- The rough band runs from 36 yards per side (easiest) to 15 (hardest), times a per-side factor of 0.8-1.2.
- Approaching the green it is widened, starting 110 yards out, to at least `1.25 * R + 22` so the green and its hazards fit.
- It closes with a blunt rounded cap 16 yards behind the tee and 25-40 yards behind the green.
- A par 3 with no fairway uses a nominal 15 yard half-width in place of the fairway so the OB line and hazards still have something to measure from.

**Inside corners.** On the inside of a dogleg the offset line folds over itself wherever the offset is larger than the turning radius. `removeLoops` finds where the line crosses itself and replaces the folded part with the crossing point. The result is a plain inside corner where the two straight runs of the OB line meet, which is what gives a dogleg its real shortcut over the corner.

Vertex counts: a full fairway has about 95 vertices (at most 104), and the playable polygon 64 to 116 depending on hole length. Greens always have 40, bunkers at most 64, and a long river can reach about 170.

### 6.5 Tee

A rounded rectangle 7 yards wide and 9 long, centred on the origin and rotated to the starting heading.

### 6.6 Water

65% of holes roll for water, and a quarter of those roll for a second feature of a different kind (stream 30%, river 35%, pond 35% by weight), so the cap is 2. In practice about 50% of holes end up with water, because a feature that cannot be placed is dropped (below).

**Crossing stream.** A band 10-22 yards wide that crosses the whole corridor.

- Position: on par 3s, and half the time otherwise, 30-60 yards short of the green's front edge; otherwise at the driver landing zone (about 211-231 yards), which forces a carry-or-lay-up decision.
- Shape: built in map space along the line square to the centerline at that point, with a meander of 3-8 yards, a slight slant, and varying width. It extends 14 yards beyond the OB line on both sides so it cannot be walked around; the part outside is hidden under the OB fill.
- It must be at least 50 yards from the tee and leave a dry, in-bounds spot on the centerline about 24 yards short of it.

**Side river.** Runs alongside one side for 80-250 yards.

- Its inner bank is 3-15 yards outside the fairway edge with a gentle meander; it is 12-36 yards wide and tapers to a point over 25 yards at each end.
- It starts at least 25 yards from the tee and ends at least 12 yards before the green's edge.
- It must leave 9 yards of rough between its outer bank and the OB line. If the rough band cannot fit a river at least 12 yards wide, there is no river.

**Greenside pond.** An irregular blob of radius 18-38 yards.

- Placed 4-12 yards off the green's edge, somewhere within 100 degrees either side of the direction back toward the tee: in front or beside the green, never behind it.

**Rules for all water**, checked as each shape is made:

| Rule | Value |
|---|---|
| Polygon is simple | |
| Gap to the tee | at least 20 yards (30 for a stream) |
| Gap to the green | at least 4 yards (8 for a stream) |
| Gap to the cup | at least 8 yards |
| Gap to other water | at least 6 yards |
| Rivers and ponds | entirely inside the OB line, by at least 2 yards |

Each feature gets up to 6 tries with fresh random parameters. If none passes, the hole simply has one fewer water feature.

### 6.7 Bunkers

All bunkers are polygons rounded with two passes of Chaikin corner cutting. Six types:

| Type | Where | Shape | Size |
|---|---|---|---|
| Crescent | wraps part of the green, 1-5 yards off its edge | an arc that follows the green's own outline, thickest in the middle, blunt at the ends | 34-64 long, 11-18 deep |
| Pot | tight to the green, 1-3 yards off | small circle with 2-3 lobes | radius 6-9.5 |
| Guard | at a landing zone, straddling a fairway edge | strip along the edge, thickest in the middle | 30-60 long, 12-20 deep |
| Cross | par 5 only, across the fairway, 265-340 yards from the tee | strip across the hole, anchored to one edge 60% of the time | spans 40-50% of the fairway width, 12-19 thick |
| Scatter | in the rough | lobed blob | radius 8-16 |
| Cluster | greenside or at a fairway edge | 2-3 overlapping small blobs sharing a `group` id | each radius 6-10 |

**How many.** With `d` the difficulty and `r` a fresh random number each time:

- Greenside: `floor(r * (1.6 + 2.4d) + 0.3)`, at most 3, and at least 2 on a par 3. A par 3's bunkers are all greenside. Each goes in a different slot around the green (front-left, front-right, left, right, front, back). The back slot always gets a pot; otherwise 25% pot, 20% cluster, 55% crescent.
- Fairway (par 4 and 5): `floor(r * (1.2 + 1.6d) + 0.2)`, at most 2 (3 on a par 5). Each goes to a random landing zone and side; 20% are clusters, the rest guards.
- Cross (par 5): chance `0.12 * (0.5 + d)`.
- Scatter: `floor(r * (1 + 1.5d))`, par 4 and 5 only.

**Landing zones** are 85-90% of a club's maximum carry from the tee: the driver zone always, the iron zone 25% of the time, and on par 5s a second-shot zone 150-215 yards beyond the first.

**Rules**, checked as each bunker is made:

| Rule | Value |
|---|---|
| Polygon is simple | |
| Inside the OB line | by at least 3 yards |
| Gap to the tee | at least 8 yards |
| Gap to the green | at least 0.5 yards (never overlapping) |
| Gap to the cup | at least 8 yards |
| Gap to water | at least 3 yards |
| Gap to other bunkers | at least 3 yards, except blobs of the same cluster |

A bunker gets up to 4 tries (3 for cross and scatter) and is dropped if none passes. One more rule, "never block more than half the fairway width", is checked by the validator on the finished hole; breaking it causes a whole new attempt. That is the reason for almost all regeneration retries.

### 6.8 Short-sided pin

If any bunker or water lies within 3 yards of the green, there is a 25% chance of a short-sided pin. One such hazard is picked, and the cup is moved to the spot on the green that is

- at least 3 yards inside the green's edge,
- 4-6 yards from that hazard (as close to 5 as possible), and
- at least 4 yards from every other hazard.

If no spot qualifies, the cup stays where it was. When it moves, `meta.shortSided` is true. About 9% of all holes end up short-sided. Ponds never qualify, because they start 4 yards off the green.

### 6.9 Wind

| Flavour | Speed | Direction |
|---|---|---|
| default | `round(20 * u^1.625)` mph: mostly light, up to 20, averaging about 7.6 | any, in 5 degree steps |
| `calm` | 0-3 mph | any |
| `cross` | 8-13 mph | within 20 degrees of square across the hole (toward +x or -x) |
| `strong` | 15-20 mph | any |

`dirDeg` is the direction the wind blows toward.

### 6.10 Validation

`validateHole(hole)` works on the plain hole object only, so it can run on a stored hole. It returns `{ ok, errors }`. The thresholds are slightly looser than the generator's to absorb coordinate rounding.

| Group | Checks |
|---|---|
| Spec | version matches, length inside the par's band, at most 2 water features |
| Polygons | playable, tee, green, fairway, every bunker and every water polygon is simple: at least 3 vertices, no zero-length edge, no two non-adjacent edges touching |
| Centerline | y strictly increases point to point; turning radius never below about 49 yards (58 with 15% slack) |
| Tee | the origin is on the tee; the tee is at least 8 yards inside the OB line |
| Cup and green | cup on the green and at least 2.9 yards inside its edge; cup at least 18 yards inside OB; green at least 8 yards inside OB; tee and green at least 40 yards apart; rings positive and ordered |
| Fairway | at least 4 yards inside OB |
| Bunkers | inside OB by 2 yards; 7.8 from the tee; not touching the green; 2.8 from water and from each other (clusters excepted); cup clearance (below) |
| Fairway blocking | on every cross-section near a fairway bunker, bunkers cover no more than half the fairway width |
| Water | 18 yards from the tee; 3.5 from the green; cup clearance; rivers and ponds inside OB |
| Stream | crosses the centerline; has vertices outside the OB line on both sides; the centerline point 24 yards short of it is fairway or rough |

Cup clearance from every hazard is 7.8 yards normally and 3.8 when `meta.shortSided` is set.

### 6.11 Daily holes

`dailyHoles(date)` builds the three holes for a UTC date string:

```
order generator seed:  handi-daily-<GEN_VERSION>-<YYYY-MM-DD>
hole n seed:           handi-daily-<GEN_VERSION>-<YYYY-MM-DD>-<n>     n = 1, 2, 3
```

The order generator shuffles `[3, 4, 5]` to assign pars and shuffles `['calm', 'cross', 'strong']` to assign wind flavours. Each hole is then `generateHole(seed_n, { par, wind })`. The date is passed in as a string; the pure code never reads a clock.

## 7. Surfaces

`surfaceAt(hole, x, y)` in `physics.js` returns the surface at a point by testing polygons in a fixed priority:

1. outside `playable`: `ob`
2. `tee`
3. `green`
4. any water polygon: `water`
5. any bunker polygon: `bunker`
6. `fairway`
7. otherwise `rough`

Point-in-polygon is a ray-crossing test with a bounding-box early exit, exact operations only.

## 8. Shot mechanics

### 8.1 Clubs and lies

| Club | Max carry | Aim sweep, one way | Roll factor | Wind sensitivity |
|---|---|---|---|---|
| Driver | 250 | 725 ms | 0.12 | 1.0 |
| Iron | 160 | 1000 ms | 0.07 | 0.8 |
| Wedge | 90 | 1200 ms | 0.03 | 0.6 |

The lie changes both distance and how fast the aim arrow moves.

| Lie | Carry multiplier (driver / iron / wedge) | Aim speed multiplier (driver / iron / wedge) |
|---|---|---|
| Tee | 1 / 1 / 1 | 1 / 1 / 1 |
| Fairway | 0.8 / 1 / 1 | 1 / 1 / 1 |
| Rough | 0.7 / 0.8 / 0.8 | 1.3 / 1.3 / 1.3 |
| Bunker | 0.35 / 0.5 / 0.75 | 1.6 / 1.6 / 1.2 |

`maxCarry(club, lie)` is the product of the club's max carry and the lie multiplier. The HUD shows it on each club button and the range ring on the map is drawn at that radius, so there are no hidden penalties. The aim arrow itself is only a short pointer (30% of that radius, `AIM_ARROW_FRAC` in `render.js`), so it shows direction, not distance.

### 8.2 The two meters

All meter maths is in `meter.js` and is a pure function of elapsed milliseconds. Nothing counts frames, so 60 Hz and 120 Hz screens behave the same.

Both meters are triangle waves: `triangle(t, oneWay)` goes 0 to 1 over `oneWay` milliseconds, back to 0 over the next `oneWay`, and repeats.

**Aim.** The arrow sweeps 40 degrees either side of a centre direction.

```
offset(t) = -40 + 80 * triangle(t, sweepMs)       degrees; starts at the left extreme
sweepMs   = club aim sweep / lie aim speed multiplier   (times 1.5 with assist on)
```

The centre is `aimCentre(hole, pos, club, lie)`:

- if the cup is within the club's max carry for this lie, the direction to the cup;
- otherwise the direction to the farthest centerline point within that range, which is what makes the arrow point around a dogleg;
- if that point would be behind the ball, the direction to the cup.

The centre is itself rounded to 0.1 degrees. The locked angle is `centre + round(offset * 10)`, wrapped to 0-3599.

**Power.** The bar sweeps 0 to 100% and back.

```
frac(t) = triangle(t, 900)                       (1350 ms one way with assist on)
power   = 200 if frac >= 0.97, else round(frac * 200)
```

Anything at 97% or above snaps to 100%, so a full shot is a window about 54 ms wide rather than a single instant. The power bar starts 350 ms after the aim is locked, to give the player a beat between taps.

### 8.3 Resolving a shot

`resolveShot(hole, from, lie, { club, angle, power })` in `physics.js`. Worked through in order:

**1. Carry without wind.**

```
carry0 = maxCarry(club, lie) * power / 200
```

**2. Direction.** `dir = (sin a, cos a)` where `a` is the angle in 0.1 degree steps, using the deterministic sine and cosine.

**3. Wind.** The wind vector is `mph * (sin w, cos w)`. Split it into the part along the shot and the part across it:

```
along = wind · dir                     positive is a tailwind
cross = wind · (dir rotated right)     positive pushes the ball right
k     = club wind sensitivity / 20

carry = carry0 * (1 + along * k * 0.12)
drift = carry0 * cross * k * 0.12
```

So a 20 mph tailwind adds 12% to a driver's carry, a headwind removes 12%, and a 20 mph crosswind moves a driver sideways by 12% of its carry: 30 yards on a full drive. Iron and wedge move 80% and 60% as much, relative to their carry. The aim arrow and power bar do not show the effect of wind; allowing for it is the player's job.

**4. Landing point.**

```
landing = from + dir * carry + (dir rotated right) * drift
```

The ball flies over everything between. Only where it lands matters.

**5. Landing surface.**

| Lands on | Outcome |
|---|---|
| OB | result `ob` |
| Water | result `water` |
| Within 0.4 yards of the cup | result `holed` |
| Bunker | stops dead; result `ok`, lie `bunker` |
| Anything else | rolls out (step 6) |

**6. Roll.**

```
rollLength = carry * club roll factor * firmness of the landing surface
firmness:    tee 1, fairway 1, green 0.6, rough 0.4, bunker 0
```

The ball rolls in the direction it travelled, from where it was hit to where it landed, so wind drift bends the roll direction too. The roll path is sampled every 0.25 yards, and at each sample, in order:

- if the ball is within 0.4 yards of the cup **and** within 3 yards of the end of its roll, it is `holed`. A ball still rolling fast runs over the cup;
- if the sample is OB, the result is `ob`;
- if it is water, the result is `water`;
- if it is a bunker, the ball stops there with lie `bunker`.

If none of those happens the ball stops at the end of the roll and its lie is the surface there.

A full driver from the tee carries 250 and rolls up to 30 on fairway or 12 in rough. A full iron rolls 11 on fairway and 6.7 on a green; a full wedge 2.7 and 1.6.

**7. Result.** The function returns

```
{ result, landing, rest, lie, landSurface, carry, roll }
```

`result` is `ok`, `ob`, `water` or `holed`. For `ob` and `water`, `rest` is where the ball was lost, which the animation uses; the ball itself goes back to `from`.

## 9. Rules of a hole

`rules.js` holds the state of one hole and applies shots to it. It never mutates a state; `applyShot` returns a new one.

**State.**

```
{ pos, lie, shots: [{ club, angle, power, result }], penalties, putts, strokes,
  done, holed, pickedUp, ob, water }
```

A hole starts at `pos [0, 0]`, lie `tee`.

**`applyShot(hole, state, input)`** validates the input (known club, integer angle 0-3599, integer power 0-200), resolves it, appends it to `shots`, and then:

| Result | Effect |
|---|---|
| `ob` or `water` | penalties + 1. Position and lie do not change: the next shot is from the same spot (stroke and distance) |
| `holed` | hole finished, 0 putts |
| `ok`, resting on the green | hole finished. Putts are counted from where the ball rests |
| `ok`, anywhere else | position and lie update; play on |

**Putting** is automatic and deterministic. `puttsFor(hole, pos)`: within `r1` of the cup is 1 putt, within `r2` is 2, anywhere else on the green is 3.

**Score.** `strokes = shots + penalties + putts`.

**Stroke cap.** If strokes reach 12 the hole ends at 12. `pickedUp` is true when the ball was not yet holed, or when the real total would have been more than 12. Penalties and putts count toward the cap. Six drives out of bounds, for example, is 6 shots plus 6 penalties and the hole is over.

**`replay(hole, shots)`** applies a logged list of shots from the tee and returns the final state. If a logged `result` does not match what the replay produces, or the log continues after the hole ended, it throws. This is what makes a stored round verifiable, and it is how Daily mode rebuilds a round after a refresh.

Other helpers: `suggestClub` picks the shortest club that reaches the pin, or the longest hitter for the lie if none does; `scoreName` gives "Birdie", "Par" and so on.

## 10. The play screen

`createPlay(root, cfg)` in `ui.js` runs one hole at a time. The mode gives it a hole with `play.load(hole, opts)` and gets three callbacks back: `onAimLocked`, `onShot` and `onDone`.

### 10.1 Layout

Top to bottom: a six-chip HUD (hole, par, strokes, distance to the pin, wind arrow and speed, lie), the canvas, three club buttons showing each club's carry for the current lie, one large action button, and a one-line hint. A "Whole hole" button over the canvas toggles between the aiming view and the full hole. Beside it, "−" and "+" buttons zoom the aiming view out and back in (three steps of 1.5x), and work during the aim and power meters too. The zoom is display only, persists from shot to shot and resets on a new hole.

### 10.2 Phases

```
intro ──► ready ──► aim ──► power ──► anim ──► ready ...
                                         └───► done
```

| Phase | What happens |
|---|---|
| `intro` | the whole hole is shown for 1.3 seconds, then the camera drops to the ball |
| `ready` | pick a club; the max-range ring and the faint sweep limits are drawn. The action button reads "Swing" |
| `aim` | the arrow sweeps. The button reads "Lock aim" |
| `power` | the arrow is fixed; the bar sweeps and nothing else is drawn: there is no yardage readout and no landing dot, so the player judges distance from the bar against the max-range ring and the club's carry on its button. The button reads "Lock power" |
| `anim` | the shot is resolved at once, then animated |
| `done` | the hole is over; the mode shows a result card |

### 10.3 Input and timing

- **Start a swing:** click or tap the action button, or press Space or Enter when no other control has focus.
- **The two locks:** `pointerdown` on the canvas or the action button, or Space or Enter. The canvas is the large tap area.
- **Clubs:** the three buttons, or keys 1, 2 and 3.

The lock time is taken from the input event's `timeStamp`, which is on the same clock as `performance.now()`. If a browser hands back an unusable timestamp, `performance.now()` is used instead. The elapsed time passed to the meter is

```
event time - meter start time - latency calibration
```

Guards: a lock within 120 ms of a meter starting is ignored (accidental double tap), taps during the 350 ms power delay are ignored, and a swing cannot start within 400 ms of a lock.

The latency calibration slider (0-150 ms, in Settings) subtracts a fixed amount from every lock time, for devices whose input arrives late.

### 10.4 From tap to result

When the second tap lands:

1. `applyShot` resolves the shot immediately. The outcome is known before any animation plays.
2. `onShot(shot, state)` fires, so the mode can save the shot before the animation.
3. The animation plays.
4. `onDone(state)` fires if the hole is finished; otherwise the screen returns to `ready` at the new position.

### 10.5 Camera

A view is a centre point and a scale; +y is up the screen and the map is never rotated.

- **Aiming:** fits the ball, the full range ring straight ahead, 80% of it out to each sweep limit, and the pin when it is nearly in range.
- **Whole hole:** fits the playable polygon.
- **During a shot:** stays put unless the landing or resting point would be off screen, in which case it widens to include them.
- **On the green:** zooms to the green with the rings drawn.

Moves are eased over 450 ms. The canvas is sized for the device pixel ratio and refits on resize.

### 10.6 Animations

| Event | Animation |
|---|---|
| Flight | the ball travels to the landing point in 450 ms plus 3 ms per yard (at most 1.3 s), drawn larger with a shadow to suggest height |
| Landing | a white ripple at the exact landing point, then the ball rolls to rest |
| OB | a red ring where the ball went out, an "OB +1" label, then the ball pops back to where it was hit from |
| Water | expanding rings and a few droplets, a "Water +1" label, then the ball pops back |
| Holed | the ball drops into the cup with a ring burst and a "Holed out!" or "Hole in one!" label |
| On the green | zoom, a label with the number of putts, then the ball rolls to the cup |
| Pick-up | a "Picked up at 12" label |

With `prefers-reduced-motion`, the flight, roll, ripples, plops and camera moves jump straight to their end state. Labels still show, briefly. The two meters keep moving because they are the game.

### 10.7 Accessibility

- Every control is a real button with a text label; club buttons and tabs use `aria-pressed`.
- Focus is visible everywhere, and the action button keeps focus through a shot so a keyboard player can keep pressing Space.
- A polite live region announces each result ("Fairway, 142 yards to the pin", "Out of bounds. One stroke penalty...").
- Dialogs are native `<dialog>` elements, so focus is trapped and Escape closes them.
- The page chrome follows `prefers-color-scheme`; the map uses the same colours in both.
- The layout fits a 360 px wide screen without horizontal scrolling.

### 10.8 Rendering

`render.js` draws, in order: rough fill, fairway, bunkers, water, green, tee, then a dark fill over everything outside the playable polygon with a white dashed OB line, then the yardage markers, rings (when shown) and the flag. Each shape is stroked first and filled second, so only the outer half of the outline shows and overlapping cluster bunkers read as one shape.

Yardage markers are small dots on the centerline 100, 150 and 200 yards from the green centre, labelled when the view is zoomed in enough.

## 11. Endless mode

`modes/endless.js`.

- **Seeds.** Each hole uses 8 base-36 characters from `crypto.getRandomValues`. The seed is shown on a button above the map and on the result card.
- **Variety.** If the new hole has the same par or the same archetype as the previous one, the seed is re-rolled, up to 3 times. Because the hole is still a function of its seed alone, typing the seed back in always reproduces it.
- **Seed dialog.** Copy the current seed, or type any seed to play it next.
- **Result card.** Score name, strokes with the breakdown into shots, putts and penalties, the session total, the seed, and "Next hole" or "Replay this hole".
- **Scorecard.** A table of every hole finished this session with par, score, result and seed, plus totals. The session lives in memory and is lost on reload.
- **Lifetime stats**, saved through the storage adapter after every hole: holes played, average versus par, current and best streak of par-or-better, birdies, eagles or better, holes-in-one, OB count, water count and pick-ups.
- **Assist.** A setting that makes both meters 1.5 times slower. Endless only.

## 12. Daily mode

`modes/daily.js`.

### 12.1 Flow

1. **Lobby.** Shows the date, the three holes' pars and lengths, a countdown to the next reset, the friends leaderboard, and "Play today's round" or "Resume round".
2. **Three holes** in order, with a result card after each.
3. **Result.** Total and score versus par, each hole's score, the streak, share text with a copy button, the leaderboard and the countdown.

Once a result is stored, opening Daily goes straight to the result screen. There is no way to play again that day from the UI.

Meter speeds are fixed in Daily: the assist setting is ignored. The latency calibration still applies.

### 12.2 The draft

The round in progress is saved through `storage.saveDailyDraft(date, draft)`:

```
{ v: 1, date, genVersion,
  holes: [ [shots of hole 1], [shots of hole 2], [shots of hole 3] ],
  pendingAim: { hole, club, angle } | null,
  done, result }
```

It is written at two moments:

- **When the aim locks**, `pendingAim` is saved. If the page is refreshed between the two taps, the player comes back with that club and direction already locked and the action button reading "Set power". A refresh cannot be used to re-aim.
- **When the power locks**, the shot is appended to the hole's log and `pendingAim` is cleared. This happens before the animation, so a refresh mid-flight keeps the shot.

### 12.3 Resuming

On load:

1. Ask the adapter for today's date and build the three holes.
2. Load the draft. It is discarded unless its version, date and generator version match, it has exactly three logs of at most 12 shots, and every shot is a valid input.
3. Replay each log with `replay`. If any recorded result does not match, or shots are logged on a later hole while an earlier one is unfinished, the draft is discarded and the round starts fresh.
4. Continue from the first unfinished hole. If all three are finished but no result was stored, finish the round now.

No positions or scores are stored in the draft. They are all recomputed from the shot logs, which is only possible because resolution is deterministic.

### 12.4 The result document

```
{ date, uid, genVersion,
  holes: [{ strokes, putts, penalties,
            shots: [{ club, angle, power, result }] }],
  total, createdAt }
```

`strokes` is the hole's full score. It is built by `buildResult` and handed to `daily.submit(result)`, which may replace `uid` and `createdAt` (the local stub does). Anyone holding this document can regenerate the day's holes from `date` and `genVersion`, replay the shots, and confirm the total.

### 12.5 Leaderboard

`daily.fetchLeaderboard(date)` returns rows of `{ uid, name, isYou, total | null, penalties, createdAt }`. `rankLeaderboard` sorts them:

1. fewer total strokes,
2. then fewer penalties,
3. then earlier submission.

Players level on strokes and penalties share a rank. Friends who have not played are listed last, in name order, as "not played". The list is capped at 30.

### 12.6 Streak

`nextStreak(previous, date)`: if the last counted date was yesterday (UTC), the streak grows by one; if it was today, nothing changes; otherwise it restarts at 1. The best streak is kept alongside. It is stored inside the lifetime stats object under the key `daily`, so no extra adapter method is needed.

### 12.7 Share text

```
HANDI Golf Daily 2026-11-13
13 strokes (+1)
🐦 🟢 🟠
🔥 4 day streak
```

One symbol per hole by score versus par: eagle or better 🦅, birdie 🐦, par 🟢, bogey 🟡, double 🟠, worse 🔴. The streak line appears from day 2. Nothing about seeds, yardages, layouts, or even which hole was the par 3.

### 12.8 Reset and countdown

The day changes at 00:00 UTC. The countdown shows the time remaining and the reset time in the player's own time zone. If the day rolls over while the lobby or result screen is open, the mode reloads with the new holes. A round already in progress keeps its original date.

## 13. Integration seam

```js
import { mount } from './js/game/index.js';
const game = mount(container, { mode, storage, daily, seed });
game.setMode('daily');
game.unmount();
```

`mode` is `'endless'` or `'daily'`. The host page must also load `game/game.css`. All of its rules are scoped under `.hg-root`.

The game never imports Firebase. The host supplies two adapters, and every method may return a value or a promise.

**`storage`**

| Method | Purpose |
|---|---|
| `loadLifetime()` | lifetime stats object, or null |
| `saveLifetime(stats)` | store it |
| `loadDailyDraft(date)` | the draft for that date, or null |
| `saveDailyDraft(date, draft)` | store it |
| `loadSettings()` *(optional)* | `{ assist, latencyMs }`, or null |
| `saveSettings(settings)` *(optional)* | store it |

**`daily`**

| Member | Purpose |
|---|---|
| `getToday()` | today's UTC date as `'YYYY-MM-DD'` |
| `submit(result)` | store the result; return the stored document |
| `fetchLeaderboard(date)` | rows as in 12.5 |
| `uid` *(optional)* | the player's id |

Without a `storage` adapter the game keeps everything in memory. Without a `daily` adapter the Daily tab is not shown.

**The standalone adapters** (`game/local-adapters.js`):

- `storage` writes JSON to `localStorage` under keys starting `handi.game.`: `lifetime`, `settings`, `daily.draft.<date>.local` and `daily.score.<date>_local`. If `localStorage` is blocked it falls back to memory.
- `daily` is a stub backend. `getToday()` reads the clock (or the `?date=` override). `submit` is create-only: a second submit for the same date returns the first result unchanged. `fetchLeaderboard` returns your row plus five invented friends, each labelled "(demo)". A fake friend's score is seeded by the date and their name, so it is stable all day, and it only appears once that friend's invented tee time has passed; about one in five does not play at all.

### 13.1 In the HANDI app

The app's "Play" view (`js/play.js`) mounts the game with `theme: 'light'` and the Firestore adapters from `js/game-firebase.js`. The game is mounted when the view opens and unmounted when the user leaves it, so an Endless session scorecard is lost on navigation; a Daily round in progress is not, because its draft is saved after every locked tap.

The adapters add three optional members to `daily`, which the game uses when present: `fetchMine(date)` (a result already stored for today, from this or another device, wins over a local draft), `fetchGlobal(date)` (the histogram below) and `emptyFriendsNote` (shown when you have no friends).

| Data | Where | Notes |
|---|---|---|
| Lifetime stats, settings, profile | `users/{uid}/game/{lifetime, settings, profile}` | private to the player |
| Daily draft | localStorage on this device | changes every shot; honour system anyway |
| Friend code | `friendCodes/{code}` = `{ uid, name }` | 8 characters; looked up by exact code only, never listed |
| Friend request / friendship | `friendships/{uidA_uidB}` (uids sorted) | `{ users, requestedBy, status: pending or accepted, names }`; only the two people can read it; only the person asked can accept; either can delete |
| Daily result | `dailyScores/{date_uid}` | create-only; readable by the owner and accepted friends, fetched by id (never queried) |
| Daily histogram | `dailyStats/{date}` = `{ n, b<total>: players }` | written in the same batch as the result; a write may only add one player to that player's own bucket |

**Friends.** A player finds another by friend code (Friends button above the game), the other accepts, and each then appears on the other's Daily leaderboard with their real strokes and penalties. Everyone's code and display name are created on first visit to Play.

**Global percentile.** On the Daily result screen, "Everyone today" shows where the player's total sits: "Better than X% of the other N players" (ties count half), or "Top Y% of N players" when below the middle, plus a histogram of every total with the player's highlighted. `percentile(counts, total)` in `modes/daily.js` computes it from the `dailyStats` histogram, so no one has to read every score.

**What the rules do and do not enforce.** They check shape and arithmetic (three holes, strokes 1 to 12, putts, penalties, total equals the sum, one result per player per day, the histogram write matches the stored result). They cannot replay the shots, so Daily stays honour-system; the shot log is stored so a later server-side check is possible. The date in a result is also taken from the player's clock.

**Publishing the rules.** `firestore.rules` must be published in the Firebase console (Firestore Database, Rules, Publish) before Play can store or read anything. Until then the game still plays, but Daily results, friends and stats fail with a permission error.

## 14. Balance tool

`tools/balance.mjs` plays seeded holes with a heuristic bot and reports scoring. It goes through the same meter maths, quantised inputs and resolver as a real player.

**Choosing a shot.** For each club the bot considers the pin, if it is in reach, and lay-ups to the farthest centerline point within 100%, 90%, 80%, 70% and 60% of the club's reach. For each target it solves for the input whose result rests on the target, allowing for wind and roll by iterating on the real resolver. It then scores that input as a weighted average of the ideal result (40%) and four typical misses (15% each): aim left, aim right, long and short, each by one standard deviation of its own jitter. A result is worth the strokes used plus an estimate of strokes still needed from where the ball ends up. The lowest score wins.

**Executing it.** The bot works out the moment the meter would show the wanted value, adds a normally distributed timing error, and reads the meter at that moment. Reflections at the ends of the sweep and the 97% snap therefore apply exactly as they do to a person.

**Profiles** differ only in timing jitter (standard deviation per tap): casual 60 ms, decent 35 ms, expert 20 ms. The jitter is seeded, so runs repeat. It is the tool's randomness, not the game's.

**Targets** for the decent profile: about par plus 0.5, birdies about 15%, double bogey or worse under 10%, OB about 3% per full driver from the tee. The tool exits with an error if the decent profile falls outside 0.3 to 0.7, 12 to 18%, 0 to 10% and 1.5 to 4.5%.

**Results**, 3000 holes, seed `bal`:

| | Profile | Avg vs par | Birdie | Par | Bogey | Double+ | GIR | OB per full driver | Hole-out | Putts per green |
|---|---|---|---|---|---|---|---|---|---|---|
| Starting values | casual | +0.77 | 10.9% | 28.1% | 43.1% | 17.9% | 43.0% | 6.95% | 9.1% | 2.14 |
| Starting values | decent | -0.05 | 28.2% | 42.4% | 26.5% | 2.9% | 72.0% | 1.05% | 17.3% | 2.01 |
| Starting values | expert | -0.66 | 51.4% | 38.6% | 9.8% | 0.2% | 87.5% | 0.09% | 29.1% | 1.82 |
| Tuned | casual | +1.51 | 3.3% | 16.9% | 40.7% | 39.1% | 29.7% | 15.59% | 2.0% | 2.26 |
| Tuned | **decent** | **+0.41** | **14.6%** | 37.2% | 41.2% | **6.9%** | 62.5% | **3.04%** | 4.3% | 2.05 |
| Tuned | expert | -0.22 | 36.3% | 44.7% | 18.3% | 0.7% | 85.8% | 0.41% | 7.6% | 1.79 |

By par, the tuned decent profile averages +0.56 on par 3s, +0.43 on par 4s and +0.22 on par 5s. A second set of 2000 holes (seed `other`) gave +0.40, 15.3%, 7.2% and 3.22%.

**What tuning changed:**

| Constant | Starting | Tuned |
|---|---|---|
| Driver aim sweep | 900 ms | 725 ms |
| Iron aim sweep | 1100 ms | 1000 ms |
| Wedge aim sweep | 1300 ms | 1200 ms |
| Power sweep | 1000 ms | 900 ms |
| Driver carry off the fairway | 1.0x | 0.8x |
| Rough band per side | 18-45 | 15-36 |
| Rings (share of green radius) | 0.2 / 0.5 | 0.19 / 0.4 |
| Cup capture radius | 1.0 yard | 0.4 yard |
| Capture only near the end of the roll | no | last 3 yards |

A caution on reading these numbers: the bot compensates for wind perfectly and never misjudges a distance, so real players will score somewhat worse than the profile whose jitter matches theirs.

## 15. Tests

`node --test` runs 30 tests in five files.

| File | What it proves |
|---|---|
| `math.test.js` | the deterministic sin, cos and atan2 agree with `Math.*` to 1e-12; the PRNG repeats, and three of its outputs and one hash are pinned |
| `generate.test.js` | the same seed gives byte-identical JSON; a hole survives a JSON round trip; 10,000 seeds all validate with at most 10 safe holes; simplicity and every clearance rule hold when checked independently of the validator on 600 seeds; forced par and wind flavours work; daily holes have one of each par, three wind flavours, and an order that varies by date |
| `play.test.js` | `resolveShot` gives identical results for identical inputs, including on a JSON copy of the hole; replaying a logged round reproduces the identical state; a tampered log is rejected; OB and water cost one stroke and return the ball; the cap ends a hole at 12; rings give 1, 2 or 3 putts; wind moves the ball the right way and by no more than 15%; meter maths and quantisation; the aim centre; score names and lifetime stats |
| `daily.test.js` | a draft rebuilds the exact round; wrong date, version or a tampered draft is rejected; the result document has the stored shape and replays to its total; leaderboard ranking and the cap of 30; streak rules; share text contains no spoilers; the UTC countdown; the local adapters |
| `golden.test.js` | hashes of six generated holes, the daily holes for one date and one replayed round are pinned for `GEN_VERSION` 1; the balance tool repeats and orders the three profiles correctly |

## 16. Gallery

`tools/gallery.html` renders 24, 36 or 48 holes from a base seed (seeds are `<base>-1`, `<base>-2`, ...) using the real generator and renderer. Each tile shows par, length, archetype, wind, bunker and water counts by type, the seed, and a red warning if a hole fails validation. Controls: base seed, tile count, a par filter, "Random base", and "Replay one seed", which opens a single hole large with its putting rings drawn. The large view also lists why any earlier generation attempts for that seed failed. The summary line reports generation time, retries, safe holes and invalid holes for the grid.

It also accepts `?base=`, `?n=`, `?par=` and `?seed=`.

## 17. Changing things safely

**Tuning play numbers** (meter speeds, lie multipliers, wind, roll, capture, rings): edit `constants.js`, run `node tools/balance.mjs`, and check the decent profile against the targets.

**Anything that changes a generated hole or a resolved shot** changes what a seed means. That includes most of `GEN`, `CLUBS`, `LIE_DIST`, `FIRMNESS` and `PLAY`, the ring fractions (they are stored in the hole), and any code in the pure modules. Before Daily mode is live this is free. Once it is live:

1. bump `GEN_VERSION`,
2. ship the change so it takes effect at a UTC midnight,
3. re-pin `tests/golden.test.js`.

The golden test exists to catch an accidental change of this kind: if it fails and you did not mean to change behaviour, something drifted.

**Numbers that are safe to change at any time** because they affect only how things are timed, shown or paced, not what a logged shot does: `METER` speeds and delays, `LIE_AIM_SPEED`, the clubs' `aimSweepMs`, `COLORS` and `ANIM`. Meter speeds do change difficulty, so in Daily they should still change at a UTC midnight to keep a day fair.

**Adding a generation stage:** give it its own sub-stream name so existing stages keep their random numbers, check its shapes as they are made, and add its rules to `validateHole`.

## 18. Decisions and differences from the plan

Decisions carried over from planning:

| Topic | Decision |
|---|---|
| Control scheme | Two taps: aim arrow, then power bar. No third accuracy tap |
| Randomness in play | None |
| Redo | None. Once a tap locks, it is locked |
| OB and water | Stroke and distance: +1, replay from the same spot and lie |
| Visual style | Flat colours, thin outlines. No textures, stripes, trees, scenery, first cut or fringe |
| Short-sided pins | Yes, deliberately, on some holes |
| Daily anti-cheat | Honour system plus (later) Firestore rules. The shot log is stored so replay verification is possible |
| Daily reset | 00:00 UTC, with a local-time countdown |
| Assist | Endless only |
| Stack | Vanilla ES modules, no build step, no frameworks, canvas rendering |

Where the build differs from the original plan, and why:

| Plan | As built | Reason |
|---|---|---|
| Cap curvature so the turning radius is at least 1.5 times the largest lateral offset | The cap (58 yard minimum radius) covers fairway offsets only. The OB line on the inside of a dogleg is fixed by cutting the fold out | Clamping the OB offset left a circular notch at every corner |
| Cup capture radius about 1 yard | 0.4 yards, and only for a ball within 3 yards of the end of its roll | At 1 yard the decent bot holed out on 17% of holes |
| Tee and fairway are both baseline | Driver carries 0.8x off the fairway | Follows "the tee box is the best lie"; stopped par 5s being far the easiest holes |
| Cross bunkers span 40-60% of the fairway | 40-50% | The plan also says never block more than half |
| Wind speed `20 * u^1.6` | `20 * u^1.625` | Computable from square roots alone |
| Angle logged in 0.1 degree steps | Logged as an absolute heading, not an offset from the sweep centre | The log stays valid if the aim-centring logic changes |
| Polygons of 32-64 vertices | Greens and bunkers stay in range. Fairway and OB polygons use up to about 115, and a long river up to about 170 | Long curved edges looked faceted |
| Bunkers before water | Water first, then bunkers avoid it | Water is the more constrained |
| Short-sided on about a quarter of holes with greenside hazards | About 9% of all holes | Only hazards within 3 yards of the green can qualify |
| Avoid repeating the previous par or archetype | Re-roll the seed up to 3 times, then accept | Keeps the seed alone sufficient to reproduce the hole |
| Draft saved after every locked shot | Also saved when the aim locks | Closes the refresh-to-re-aim loophole |
| `storage` has four methods | Plus optional `loadSettings` and `saveSettings` | Assist and latency need to persist |

Other things worth knowing:

- Water uses the same penalty as OB. A lateral drop would be more realistic and more complex.
- The Daily draft lives in local storage only. Clearing storage allows a retry; that is the honour system. The local stub's `submit` is create-only, but it is in the same storage.
- The aim arrow always starts at the left extreme, so the timing to "straight" is learnable. That is intended: it is a timing game.

## 19. Not done and not verified

**Integration (section 13.1) is built but was not exercised against a live Firebase project.** It was written without access to one, so these are unverified until someone signs in and tries them: that the published rules accept every write the app makes (the rules were not run in the Firebase emulator), the friend request and accept flow between two real accounts, the Daily submit and percentile, and offline behaviour. The rules also need publishing by hand (13.1).

**Not done:** a privacy toggle for game stats (names and scores are visible to friends, and the histogram is anonymous), removing a friend does not hide their past results from you beyond not listing them, a way to change the Daily date for testing in the app, and server-side replay of Daily shots.

**Not verified:**

- **Determinism across browser engines.** Only Node and Edge have been run, and both use V8. The design avoids every operation known to differ, and `tests/golden.test.js` pins the outputs to compare against, but nothing yet runs that comparison in Safari or Firefox. This needs doing before Daily goes live.
- **Feel on a real phone.** Touch was emulated in a headless browser. Tap latency, the 350 ms beat between taps and the meter speeds need judging by hand.
- **Screen readers.** Labels, announcements and focus order are in place but untested with assistive technology.
- **GitHub Pages.** All paths are relative and there is no build step, but it has not been deployed.
- **The streak across two real days.** Covered by unit tests only.

**Out of scope:** trees, elevation, slopes, a putting mini-game, hole-by-hole data in the handicap tracker, weather beyond wind, real-time multiplayer, and server-side score verification.

**Revision (hazards and aiming aids).** Bunkers and water were enlarged and water made more common (sizes above; hazards were enlarged a second time after the first pass), the aim arrow was shortened to a direction pointer, and the power bar's yardage readout and landing dot were removed, so distance must be inferred from the bar and the max-range ring. This changed generated holes, so the golden hashes were re-pinned (Daily was not live). The decent bot's balance run after the change: +0.46 vs par, birdies 13.8%, double+ 8.7%, OB 4.2% per full driver. The bot reads exact values, so it does not feel the loss of the aids; real players will score worse.
