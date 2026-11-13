// Seeded PRNG: xmur3 string hash into sfc32. Integer maths only, so it is
// bit-identical in every engine. Pure: no DOM, no Math.random, no Date.

export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// A generator with a few helpers. Every helper consumes exactly one value.
export function makeRng(seedStr) {
  const h = xmur3(String(seedStr));
  const next = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 12; i++) next();
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)), // inclusive
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted(pairs) {
      let total = 0;
      for (const p of pairs) total += p[1];
      let r = next() * total;
      for (const p of pairs) {
        r -= p[1];
        if (r < 0) return p[0];
      }
      return pairs[pairs.length - 1][0];
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },
  };
}

// 32-bit hash of a string as 8 hex characters.
export function hashHex(str) {
  return ('0000000' + xmur3(String(str))().toString(16)).slice(-8);
}

// Smooth 1D value noise in [-1, 1], built from exact operations only.
export function makeNoise(rng, wavelength, knots = 64) {
  const v = new Array(knots);
  for (let i = 0; i < knots; i++) v[i] = rng.next() * 2 - 1;
  return function (s) {
    const t = s / wavelength;
    const i = Math.floor(t);
    const f = t - i;
    const a = v[((i % knots) + knots) % knots];
    const b = v[(((i + 1) % knots) + knots) % knots];
    return a + (b - a) * f * f * (3 - 2 * f);
  };
}
