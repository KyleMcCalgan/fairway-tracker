# HANDI Golf: minigame design

Planning document for the HANDI Golf minigame. The plan is to build it first as a **standalone page with no Firebase and no app integration**, get the feel right, and only then wire it into the HANDI app.

Status: planning complete, nothing built yet.

---

## 1. Summary

A 2D, top-down canvas golf game with procedurally generated holes. Units are yards.

- Three clubs: Driver, Iron, Wedge, each with a different max carry.
- Wind that the player must account for.
- Surfaces: tee box, fairway, rough, bunker, water, green, plus out-of-bounds (OB).
- Hitting uses two timed taps: an aiming arrow sweeps left and right (tap to lock the direction), then a power bar sweeps up and down (tap to lock the power).
- When the ball ends on the green, concentric rings around the cup decide how many putts it takes.
- Two modes:
  - **Endless practice**: every hole is different.
  - **Daily**: everyone gets the same 3 holes each day, with a small friends leaderboard.

## 2. Decisions log

| Topic | Decision |
|---|---|
| Control scheme | Two taps: aim arrow, then power bar. No third accuracy tap. |
| Randomness in play | None. A shot is a pure function of its inputs. Randomness exists only in seeded hole generation. |
| Redo | None. Once a tap locks, it is locked. |
| OB / water | Stroke-and-distance: +1 penalty stroke, ball returns to where it was struck from, hit again. |
| Water | Included in v1, with its own generators (streams, rivers, ponds). |
| Visual style | Very simple: flat colours, thin outlines. No textures, stripes, trees, scenery, first cut or fringe. |
| Short-sided pins | Yes, deliberately, on some holes. |
| Daily anti-cheat | Honour system plus Firestore rules. Shot log stored so replay verification is possible later. |
| Daily reset | 00:00 UTC, with a local-time countdown. |
| Assist (slower meters) | Endless mode only. Daily meter speeds are fixed for everyone. |
| Stack | Vanilla ES modules, no build step, no frameworks, canvas rendering. |

## 3. Design principles

1. **Very simple look.** Flat colours. Only these surfaces exist: tee box, fairway, rough, bunker, water, green. Rough is the default ground. Outside the OB line is a plain flat dark fill with a white dashed line. Minimal yardage markers (100/150/200 yards to the pin).
2. **No randomness in play.** The same inputs always give the same outcome, so the daily leaderboard measures skill only.
3. **No redo.** Where the ball goes is where it goes.
4. **Pure core.** Generation, physics, rules and meter maths have no DOM, no Firebase, no `Math.random`, no `Date`. They are unit-tested in Node.
5. **All tuning numbers live in one file**, `js/game/constants.js`, with comments. Every number in this document is a starting value to be tuned with the balance bot.

## 4. Determinism rules

- Seeded PRNG (xmur3 string hash into sfc32 or mulberry32). Separate derived sub-streams per generation stage (centerline, corridor, green, bunkers, water, wind), so changing one stage does not reshuffle the others.
- In generation and shot resolution use only exact IEEE operations: `+ - * / sqrt` and integer maths. `Math.sin`, `cos`, `atan2`, `log` and `exp` can differ in the last bit between browsers. Provide a deterministic sin/cos (polynomial or a table built from exact ops) in `js/game/math.js`. Rendering and animation may use `Math.*` freely.
- Polygons (32-64 vertices) are the canonical form of every shape. Hit-testing is point-in-polygon with exact ops. The renderer draws the same polygons, so the picture and the rules cannot disagree.
- Logged inputs are quantised integers: angle in 0.1 degree steps, power in 0.5 percent steps. The resolver consumes the integers.
- `GEN_VERSION` is part of every seed string and every stored daily score. Never change generator behaviour without bumping it, and bump only at a UTC midnight, otherwise early and late players on the same day get different holes.

## 5. Hole generation

### Data shape

Plain JSON-serialisable object:

```
{
  version, seed, par, lengthYds,
  wind: { mph, dirDeg },
  centerline: [[x, y], ...],
  fairway: polygon,
  playable: polygon,        // the OB boundary
  tee: polygon,
  green: polygon,
  cup: [x, y],
  rings: [r1, r2],
  bunkers: [{ kind, poly }],
  water: [{ kind, poly }],
  meta: { archetype, difficulty }
}
```

Local coordinates: tee at the origin, hole runs toward +y.

### Surface priority at a point

Outside `playable` is OB, then tee, green, water, bunker, fairway, and finally rough.

### Pipeline

1. **Spec.** Choose par (endless weights about 25% par 3, 50% par 4, 25% par 5). Choose length, measured along the centerline, from bands with deliberate gaps: par 3 about 110-210, par 4 about 300-400, par 5 about 470-580. Choose an archetype (straight, gentle bend, dogleg left or right, S-curve for rare par 5s) and a difficulty budget that drives fairway width, rough band, hazard counts and wind.
2. **Centerline by heading integration**, not splines. Step along the hole in about 2 yard steps and vary the heading as a function of distance. A bend is a smooth ramp over about 60-90 yards. Cap the total turn so y always increases, and cap curvature so the minimum turning radius is at least 1.5 times the largest lateral offset used. A dogleg gives a real shortcut over the rough corner at the cost of OB being closer on the inside.
3. **Corridor.** Work in a frame of `s` (distance along the centerline) and `lat` (sideways offset).
   - Fairway edges at `lat = -wL(s)` and `+wR(s)`. Base width about 26-44 yards, asymmetric left and right, low-frequency noise of +/-20%, about 8 yards of swell near the driver landing zone, small high-frequency edge wobble of +/-1.5 yards. The fairway starts 40-70 yards from the tee. Par 3s get a partial strip or none.
   - Rough band beyond the fairway, about 18-45 yards per side by difficulty.
   - OB boundary (the `playable` polygon) is the outer edge of the rough band, plus 25-40 yards behind the green and about 15 yards behind the tee, smoothed with low-frequency noise.
4. **Tee box.** Small rounded rectangle at the origin aligned to the initial heading.
5. **Green.** A world-space polygon built from an ellipse whose radius is modulated by 2-3 random harmonics (ovals, pears, kidneys), kept star-shaped and simple.
   - Size scales with the expected approach distance: about 8-11 yard radius for wedge approaches up to about 12-17 for long approaches.
   - Cup in a chosen pin zone (front, back, left, right, corners), 55-80% of the way to the edge and at least 3 yards inside it.
   - Rings: `r1` about 0.2R and `r2` about 0.5R, clipped to the green. An edge pin leaves most of the green in the 3-putt zone, so safe shots to the middle of the green cost strokes.
   - Short-sided pins: for about a quarter of holes with greenside hazards, place the cup 4-6 yards from a bunker lip or water edge. Otherwise keep the cup at least 8 yards from hazards.
6. **Bunkers.** All polygons, rounded with 2 Chaikin passes.

   | Type | Placement | Shape recipe | Size |
   |---|---|---|---|
   | Greenside crescent | Wraps the green front-left, front-right or sides, 0-5 yd off the edge | Arc sector with tapered ends and noisy edges | 14-30 long, 4-8 deep |
   | Pot | Tight to the green | Small irregular circle with 2-3 lobes | radius 2.5-4 |
   | Fairway guard | At landing zones, hugging a fairway edge, partly in the fairway | Strip along the edge, tapered ends, wobbled | 12-28 by 5-9 |
   | Cross bunker | Par 5 only, rare | Strip across the fairway | spans 40-60% of width |
   | Scatter | In the rough | Small blobs | 3-7 |
   | Cluster | Greenside or fairway | 2-3 overlapping small blobs | varies |

   Landing zones are 85-90% of each club's max carry from the tee, and for par 5 second shots.

   Rules: none within 8 yards of the tee, at least 3 yards between bunkers (except clusters), never blocking more than half the fairway width at any `s`, never overlapping the green, never overlapping water.
7. **Water.** Own generators, flat blue, never overlapping tee, green, cup or bunkers.
   - **Crossing stream.** A meandering polyline (heading integration with small noisy bends) offset to a variable width of 3-9 yards, spanning the whole playable corridor so it cannot be walked around. Placed at the driver landing zone (forcing carry-or-lay-up) or about 30-60 yards short of the green. Always carryable by every club from a dry lay-up spot that exists.
   - **Side river.** Runs parallel to one side for about 80-250 yards, 3-15 yards off the fairway edge, 8-20 yards wide, meandering with tapered ends. Never consumes the whole rough band and stays at least 20 yards from the tee.
   - **Greenside pond.** A blob of radius 8-20 yards, 4-12 yards off the front or side of the green, never behind it.
   - Budget: at most 2 water features per hole, and about a third of holes have any water.
8. **Wind.** Speed `20 * u^1.6` mph (mostly light, up to about 20), direction uniform, both quantised.
9. **Validate** and regenerate from a derived seed (`hash(seed + ':' + attempt)`, up to 20 attempts, then a known-safe straight hole) if any check fails. Checks: polygons are simple (no self-intersection), widths and curvature within limits, tee and cup well inside `playable` and not in hazards, the clearances above, a dry lay-up spot exists before any crossing stream.
10. **Endless variety.** Avoid repeating the previous hole's archetype or par.

## 6. Shot mechanics

### Clubs (starting values)

| Club | Max carry | Aim sweep (one way) | Roll-out | Wind sensitivity |
|---|---|---|---|---|
| Driver | 250 | about 0.9 s | most | highest |
| Iron | 160 | about 1.1 s | medium | medium |
| Wedge | 90 | about 1.3 s | least | lowest |

### Shot flow

1. Pick a club. The HUD shows hole number, par, strokes, distance to the pin, wind (arrow plus mph), the current lie, and each club's max carry for the current lie. A range ring on the map shrinks with the lie, so there are no hidden penalties.
2. Press **Swing**. The aiming arrow, drawn from the ball, sweeps left and right (constant-speed triangle wave, about +/-40 degrees). The sweep is centred on the direction to the farthest centerline point within the club's range, which makes doglegs work. On approach shots this is the pin.
3. **Tap 1** locks the direction. No redo.
4. The power bar sweeps 0 to 100 to 0 percent repeatedly. **Tap 2** locks the power. Anything at 97% or above snaps to 100%. While sweeping, show the resulting carry in yards on the bar, without wind.
5. Resolve and animate. `resolveShot()` is deterministic.

### Timing

- Compute meter positions analytically from elapsed time using the input event's `timeStamp`. Never use frame counts, so 60Hz and 120Hz devices behave the same.
- Use `pointerdown` (not click), `touch-action: manipulation`, a large tap area, and Space/Enter for keyboard.
- Optional input-latency calibration slider in Settings.

### Resolution (pure function in `physics.js`)

- `carry = maxCarry(club) * lieDistMult(club, lie) * power`.
- Lie changes both distance and meter difficulty:
  - Rough: about 0.8x distance (driver 0.7x), about +30% aim sweep speed.
  - Bunker: about 0.5x distance (driver 0.35x, iron 0.5x, wedge 0.75x), about +60% aim sweep speed (wedge +20%).
  - Tee and fairway are baseline. The tee box is the best lie.
- Wind is split into along-shot and cross-shot components. Crosswind shifts the landing point, headwind and tailwind change carry. Scale by club sensitivity. Maximum effect about 10-15% of carry at 20 mph. The aim and power previews do not compensate for wind.
- Roll-out is `carry * rollK(club) * firmness(surface landed on)` in the direction of travel. A bunker landing has no roll, and the ball stops at the first bunker its roll path enters.
- The result is evaluated at the resting point and along the roll path:
  - Outside `playable` at any sampled point: OB.
  - Water at the landing or along the roll: water.
  - Cup within the capture radius (about 1 yard): holed out, 0 putts.
  - Otherwise the new lie is the surface at the resting point.
- **Penalties.** OB or water adds 1 stroke, the ball returns to where it was struck from (same lie), and the player hits again. Penalties count toward the cap.
- **Green.** When the ball rests on the green, zoom to it. Inside ring `r1` is 1 putt, inside `r2` is 2 putts, elsewhere on the green is 3 putts. Putting is deterministic and auto-resolved. Hole score is shots plus penalties plus putts, with auto pick-up at 12 strokes total.

### Feedback animations

Keep them small and simple.

- **Landing**: a circle or ripple at the exact landing point, then the ball rolls out.
- **OB**: red ring at the landing point, then the ball pops back to the spot it was hit from, with a short "OB +1" label.
- **Water**: a small plop (expanding rings plus a few droplet dots), then the ball pops back to the previous spot with "Water +1".
- **Holed**: a brief cup animation.

Respect `prefers-reduced-motion` for these effects by jumping to the end state. The meters themselves keep moving because they are the game.

### Camera

Tee at the bottom, green toward the top (portrait-friendly). Hole overview on intro. During aiming, frame the ball and the club's range ring. DPR-aware and resizes cleanly. No fine-targeting UI is needed because the meters replace it.

## 7. Modes

### Endless practice

- Each hole is a fresh seed from `crypto.getRandomValues`. Show the seed so a hole can be replayed.
- Session scorecard, running total versus par, "next hole" flow, never ends.
- Lifetime stats saved privately per user: holes played, average versus par, best streak of par-or-better, birdies/eagles, holes-in-one, OB and water counts.
- Playable signed out with local-only persistence.
- Optionally surfaced to friends under a privacy toggle.
- The assist setting (slower meters) is available here only.

### Daily

- Everyone gets the same 3 holes each day. Seed: `handi-daily-<GEN_VERSION>-YYYY-MM-DD-<n>` from the UTC date. One par 3, one par 4, one par 5, in a date-seeded order. Give the three holes different wind flavours: one calm, one crosswind, one strong.
- Show a local-time countdown to the next UTC reset.
- One attempt per user per day. In-progress state is saved to localStorage (keyed by date and uid) after every locked shot, so a refresh resumes at the same point. Clearing storage could allow a retry, which is the honour system.
- Completed result stored at `dailyScores/{YYYY-MM-DD}_{uid}`:

  ```
  { date, uid, genVersion,
    holes: [{ strokes, putts, penalties,
              shots: [{ club, angle, power, result }] }],
    total, createdAt }
  ```

  `angle` and `power` are the quantised integers, and `result` is one of `ok | ob | water | holed`.
- Firestore rules: create-only (no update or delete), doc id must equal date plus uid, uid must be the caller, strokes, angle and power within plausible ranges, array sizes bounded, and the date must be today (UTC) as far as rules can express. Document any limit that cannot be closed. Readable only by the owner and accepted friends.
- Small friends leaderboard for today: you plus accepted friends who played (fetch by document id per friend, cap 30), ranked by total strokes, tie-break fewer penalties then earlier submission. Friends who have not played show as "not played".
- Daily-play streak, and a "copy result" share text (emoji grid, no spoilers about hole layouts).

## 8. Balance bot and tests

### Balance tool: `tools/balance.mjs`

A Node script with a heuristic bot that plays N seeds: choose a club, aim at the pin or a safe lay-up, set power from the desired carry. It simulates human timing jitter as `error = jitter(ms) * meter speed`. The jitter is tool-only randomness. The game itself has none.

Profiles:

| Profile | Jitter |
|---|---|
| Casual | about 60 ms |
| Decent | about 35 ms |
| Expert | about 20 ms |

Report per profile: scoring average versus par, birdie/par/bogey/double-or-worse rates, OB and water rates, green-in-regulation rate, hole-out rate.

Targets for the decent profile: about par plus 0.5 on average, birdies about 15%, double bogey or worse under 10%, OB about 3% per full driver. Tune the constants until those hold and record the final numbers.

Sanity check on the starting numbers: a sweep of +/-40 degrees in about 1.1 seconds is about 73 degrees per second. 40 ms of human jitter is then about +/-3 degrees, which is about +/-13 yards sideways on a full driver.

### Node tests (`node --test`, minimal `package.json`)

- Same seed produces byte-identical hole JSON.
- 10,000 seeds all pass validation.
- Polygon simplicity and the clearance rules hold.
- `resolveShot` is deterministic for identical inputs.
- Replaying a logged, quantised shot sequence reproduces the identical result.

### Gallery: `tools/gallery.html`

Renders a grid of 24-48 seeds (and a seed input to replay one) using the real generator and renderer. Each tile shows par, length, archetype, wind and hazard counts. This is the fastest way to judge bunker and water shapes by eye, and it is the first checkpoint of the build.

## 9. Build plan: standalone first, then integrate

The game is built as a standalone page with no Firebase dependency. Integration into the app comes afterwards.

### Proposed layout

```
fairway-tracker/
  docs/game.md              this document
  js/game/
    constants.js            all tuning numbers
    rng.js  math.js  geometry.js
    centerline.js  corridor.js  green.js  bunkers.js  water.js
    validate.js  generate.js
    physics.js  rules.js  meter.js
    render.js  ui.js
    modes/endless.js  modes/daily.js
    index.js                mount(container, options)
  game/index.html           standalone page that mounts the game (dev and play)
  tools/gallery.html  tools/balance.mjs
  tests/
```

The core modules (`rng` through `meter`) stay pure. `render`, `ui` and `modes` are the only DOM-touching parts.

### Integration seam

The game exposes `mount(container, { mode, storage, daily })` and never imports Firebase itself. The standalone page supplies local-only adapters, and the app supplies Firebase-backed ones later.

- `storage`: `loadLifetime()`, `saveLifetime(stats)`, `loadDailyDraft(date)`, `saveDailyDraft(date, state)`.
- `daily`: `getToday()`, `submit(result)`, `fetchLeaderboard(date)`. The standalone version uses a local stub with fake friends, so the leaderboard UI can be developed without a backend.

### Milestones

1. **Generator + gallery.** `rng`, `math`, `geometry`, generation modules, validation, a basic renderer, the gallery page and the generation tests. Checkpoint: judge hole shapes by eye.
2. **Shot mechanics + Endless.** Meters, `resolveShot`, rules (OB, water, putting rings), animations, camera, HUD, the standalone play page, determinism tests.
3. **Balance.** `tools/balance.mjs`, tune `constants.js` to the targets, record the final numbers.
4. **Daily mode (local).** Seeded daily holes, countdown, localStorage draft, share text, leaderboard against the local stub.
5. **Integration.** Add the "Play" section to the app, plug in Firebase-backed `storage` and `daily` adapters, add `dailyScores` rules, add the privacy toggle for game stats, and update the README.

## 10. Assumptions to revisit

- Water uses the same penalty as OB (+1 stroke, replay from the previous spot). A realistic lateral drop would be more complex.
- Daily draft lives in localStorage only. An append-only Firestore draft would harden against restart-and-retry but needs more rules.
- The yardage markers are kept because they are information, not decoration.
- Club distances (250 / 160 / 90) and all meter, lie and wind numbers are starting points for the balance bot, not final values.
- Cross-browser determinism is designed in, but only verifiable by testing in at least Chrome, Safari and Firefox once the generator exists.

## 11. Out of scope

Trees, elevation, slopes, putting mini-game, hole-by-hole data in the handicap tracker, weather effects, multiplayer in real time, and server-side score verification.
