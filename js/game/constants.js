// HANDI Golf: every tuning number lives here (docs/game.md, principle 5).
// Units are yards, degrees and milliseconds unless a comment says otherwise.

// Part of every seed and every stored daily score. Bump whenever generator
// behaviour changes, and only at a UTC midnight.
export const GEN_VERSION = 1;

// ---------------------------------------------------------------------------
// Clubs and shot physics
// ---------------------------------------------------------------------------

export const CLUB_ORDER = ['driver', 'iron', 'wedge'];

export const CLUBS = {
  driver: {
    name: 'Driver',
    maxCarry: 250,     // carry at 100% power from a tee or fairway lie
    aimSweepMs: 725,   // time for the aim arrow to cross from one extreme to the other
    rollK: 0.12,       // roll-out as a fraction of carry on a firmness-1 surface
    windSens: 1.0,     // multiplier on the wind effect
  },
  iron: { name: 'Iron', maxCarry: 160, aimSweepMs: 1000, rollK: 0.07, windSens: 0.8 },
  wedge: { name: 'Wedge', maxCarry: 90, aimSweepMs: 1200, rollK: 0.03, windSens: 0.6 },
};

// Carry multiplier by lie and club. Tee and fairway are the baseline.
export const LIE_DIST = {
  tee: { driver: 1, iron: 1, wedge: 1 },
  fairway: { driver: 0.8, iron: 1, wedge: 1 },
  rough: { driver: 0.7, iron: 0.8, wedge: 0.8 },
  bunker: { driver: 0.35, iron: 0.5, wedge: 0.75 },
};

// Aim sweep speed multiplier by lie and club (higher is faster, so harder).
export const LIE_AIM_SPEED = {
  tee: { driver: 1, iron: 1, wedge: 1 },
  fairway: { driver: 1, iron: 1, wedge: 1 },
  rough: { driver: 1.3, iron: 1.3, wedge: 1.3 },
  bunker: { driver: 1.6, iron: 1.6, wedge: 1.2 },
};

// Roll-out multiplier for the surface the ball lands on. Bunker is 0: no roll.
export const FIRMNESS = { tee: 1, fairway: 1, rough: 0.4, green: 0.6, bunker: 0 };

export const PLAY = {
  windRefMph: 20,        // wind speed at which the "max" effects below apply
  windAlongMax: 0.12,    // carry change (fraction of carry) for a 20 mph head/tail wind, driver
  windCrossMax: 0.12,    // sideways drift (fraction of carry) for a 20 mph crosswind, driver
  rollStep: 0.25,        // sampling step along the roll path
  captureRadius: 0.4,    // ball within this of the cup is holed, if it lands there or is rolling slowly
  captureTail: 3,        // "slowly" = within this many yards of the end of its roll (a fast ball rolls over)
  strokeCap: 12,         // auto pick-up at this many strokes
  angleUnitsPerDeg: 10,  // logged angle is an integer in 0.1 degree steps
  powerUnits: 200,       // logged power is an integer in 0.5% steps (200 = 100%)
};

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

export const METER = {
  aimHalfDeg: 40,        // the aim arrow sweeps +/- this around the sweep centre
  powerSweepMs: 900,    // time for the power bar to go 0 -> 100%
  powerSnap: 0.97,       // power at or above this snaps to 100%
  powerDelayMs: 350,     // pause between the aim lock and the power bar starting
  assistFactor: 1.5,     // Endless-only assist: meters take this many times longer
  minTapGapMs: 120,      // ignore a lock tap this soon after a meter starts (double-tap guard)
  latencyMaxMs: 150,     // top of the input-latency calibration slider
};

// ---------------------------------------------------------------------------
// Hole generation
// ---------------------------------------------------------------------------

export const GEN = {
  maxAttempts: 20,       // regenerate from a derived seed this many times, then use the safe hole
  quantum: 100,          // coordinates are rounded to 1/quantum yards

  parWeights: [[3, 0.25], [4, 0.5], [5, 0.25]],
  lengthBands: { 3: [110, 210], 4: [300, 400], 5: [470, 580] },
  archetypeWeights: {
    3: [['straight', 0.6], ['gentle', 0.4]],
    4: [['straight', 0.25], ['gentle', 0.3], ['dogleg-left', 0.225], ['dogleg-right', 0.225]],
    5: [['straight', 0.2], ['gentle', 0.25], ['dogleg-left', 0.2], ['dogleg-right', 0.2], ['s-curve', 0.15]],
  },

  centerline: {
    step: 2,                 // integration step
    minRadius: 58,           // minimum turning radius of any bend
    rampMin: 60,             // a dogleg turns over at least this distance
    rampMax: 90,             // ... and at most this
    doglegTurn: [26, 44],    // dogleg turn, degrees
    gentleTurn: [8, 20],     // gentle bend turn, degrees
    gentleRamp: [120, 200],  // gentle bend length
    sTurn: [22, 34],         // each half of an S-curve, degrees
    cornerAt: [200, 240],    // dogleg corner distance from the tee (driver landing area)
    secondCornerBack: [150, 190], // par 5 second corner, distance back from the green
    bendEndMargin: 70,       // every bend finishes at least this far before the green
    driftDeg: [0.5, 3],      // low-frequency heading drift on every hole
    driftWavelength: 160,
  },

  corridor: {
    fwWidth: [26, 44],       // total fairway width, hard to easy
    fwSplit: [0.42, 0.58],   // share of the width on the left side
    lowNoise: 0.2,           // +/- low-frequency width noise (fraction)
    lowWavelength: 130,
    highNoise: 1.5,          // +/- edge wobble
    highWavelength: 12,
    swell: 8,                // extra total width at the driver landing zone
    swellSpan: 45,           // half-length of the swell
    fwStart: [40, 70],       // fairway starts this far from the tee (par 4/5)
    par3FairwayChance: 0.5,  // par 3s get a partial strip this often, else none
    par3FwStart: [0.5, 0.65],// partial strip start as a fraction of hole length
    gapChance: 0.3,          // fairway stops short of the green this often
    gap: [12, 28],           // ... by this much (from the green edge)
    capLen: 12,              // length of the rounded fairway ends
    greenNeck: 0.7,          // fairway half-width at the green, as a fraction of green radius
    rough: [15, 36],         // rough band per side, hard to easy
    obNoise: 0.12,           // +/- low-frequency noise on the OB line (fraction of rough band)
    obWavelength: 110,
    minRough: 8,             // rough band never thinner than this (inside of doglegs)
    greenSideMargin: 22,     // OB at least this far beyond the green's sides
    greenFlare: 110,         // the corridor starts widening toward that this far before the green
    behindGreen: [25, 40],   // OB this far behind the green
    behindTee: 16,           // OB this far behind the tee
    par3NominalHalf: 15,     // nominal half "fairway" used for OB/hazard placement with no fairway
  },

  tee: { halfWidth: 3.5, halfLength: 4.5, corner: 1.2 },

  green: {
    vertices: 40,
    approachNear: 70,        // approach distance at which the green is smallest
    approachFar: 190,        // ... and largest
    radiusNear: [8, 11],
    radiusFar: [12, 17],
    driveLen: 235,           // assumed drive, to estimate the approach distance
    secondLen: 190,          // assumed par 5 second shot
    maxAspect: 1.35,         // ellipse long/short axis ratio
    harm2: 0.08,             // amplitude of the 2nd radius harmonic
    harm3: 0.12,             // amplitude of the 3rd radius harmonic (pear/kidney)
    pinFrac: [0.55, 0.8],    // cup this fraction of the way to the edge
    pinEdgeMin: 3,           // cup at least this far inside the edge
    ring1: 0.19,              // 1-putt ring radius, fraction of green radius
    ring2: 0.4,              // 2-putt ring radius, fraction of green radius
    shortSideChance: 0.25,   // of holes with greenside hazards
    shortSide: [4, 6],       // short-sided cup distance to the hazard
    cupHazardMin: 8,         // otherwise the cup stays this far from hazards
  },

  bunkers: {
    teeMin: 8,               // none within this of the tee
    spacing: 3,              // minimum gap between bunkers (clusters excepted)
    waterGap: 3,             // minimum gap to water
    greenGap: 0.5,           // minimum gap to the green
    obMargin: 3,             // minimum gap inside the OB line
    maxFairwayBlock: 0.5,    // never block more than this share of the fairway width
    crescent: { off: [1, 5], length: [34, 64], depth: [11, 18] },
    pot: { radius: [6, 9.5], off: [1, 3] },
    guard: { length: [30, 60], depth: [12, 20] },
    cross: { chance: 0.12, span: [0.4, 0.5], thick: [12, 19] },
    scatter: { radius: [8, 16] },
    cluster: { radius: [6, 10], count: [2, 3] },
    landing: [0.85, 0.9],    // landing zones are this share of a club's max carry
    secondShot: [150, 215],  // par 5 second landing zone, beyond the first
  },

  water: {
    anyChance: 0.65,         // share of holes with any water
    secondChance: 0.25,      // of those, share with two features
    kindWeights: [['stream', 0.3], ['river', 0.35], ['pond', 0.35]],
    stream: { width: [10, 22], shortOfGreen: [30, 60], meander: [3, 8], overhang: 14, teeMin: 50, greenGap: 8 },
    river: { length: [80, 250], off: [3, 15], width: [12, 36], teeMin: 25, greenGap: 12, obMargin: 9, taper: 25 },
    pond: { radius: [18, 38], off: [4, 12], spread: 100 },
    teeGap: 20,
    greenGap: 4,
    waterGap: 6,
  },

  wind: {
    maxMph: 20,              // speed is maxMph * u^1.625 (sqrt-only stand-in for u^1.6)
    dirStepDeg: 5,           // direction quantum
    calm: [0, 3],            // daily "calm" flavour, mph
    cross: [8, 13],          // daily "crosswind" flavour, mph
    crossSpread: 20,         // crosswind is within this of square across the hole
    strong: [15, 20],        // daily "strong" flavour, mph
  },

  // Validation thresholds (slightly looser than the generator to absorb rounding).
  check: {
    cupEdge: 2.9,
    cupOb: 18,
    teeOb: 8,
    greenOb: 8,
    fairwayOb: 4,
    cupHazardShort: 3.8,
    cupHazard: 7.8,
    bunkerTee: 7.8,
    bunkerGap: 2.8,
    bunkerWater: 2.8,
    bunkerGreen: 0.3,
    bunkerOb: 2,
    waterGreen: 3.5,
    waterTee: 18,
    layupBack: 24,
    radiusSlack: 0.85,
  },
};

// ---------------------------------------------------------------------------
// Rendering and animation (not part of the deterministic core)
// ---------------------------------------------------------------------------

export const COLORS = {
  ob: '#27332b',
  obLine: '#ffffff',
  rough: '#5d9c4f',
  fairway: '#86c56a',
  fairwayLine: '#6aa856',
  green: '#b5e08c',
  greenLine: '#7fb45f',
  tee: '#a3d67c',
  teeLine: '#6aa856',
  bunker: '#ead9a4',
  bunkerLine: '#c2ad6e',
  water: '#5aa7dd',
  waterLine: '#3b82b8',
  marker: '#ffffff',
  ring: 'rgba(255,255,255,0.75)',
  cup: '#1b1f1c',
  flag: '#e5484d',
  ball: '#ffffff',
  ballLine: '#1b1f1c',
  aim: '#ffffff',
  penalty: '#e5484d',
};

export const ANIM = {
  flightBaseMs: 450,     // flight time = base + perYard * carry, capped
  flightPerYardMs: 3,
  flightMaxMs: 1300,
  rollMs: 500,
  rippleMs: 450,
  penaltyMs: 1100,       // how long "OB +1" / "Water +1" stays up
  puttMs: 700,
  holedMs: 900,
  cameraMs: 450,
  introMs: 1300,         // hole overview before the camera drops to the ball
  labelMs: 900,
};

export const MARKERS = [100, 150, 200]; // yardage markers, distance to the green centre
