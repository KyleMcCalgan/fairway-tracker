// Local-only adapters for the standalone page (docs/game.md 9, "Integration
// seam"). `storage` keeps lifetime stats, settings and the Daily draft in
// localStorage. `daily` is a stub backend: it stores your own result locally
// and invents a few friends with made-up scores so the leaderboard, streak and
// share text can be judged without a server. Nothing here touches the network.

import { makeRng } from '../js/game/rng.js';

const PREFIX = 'handi.game.';
const UID = 'local';

export const FAKE_FRIENDS = [
  { uid: 'stub-ana', name: 'Ana (demo)' },
  { uid: 'stub-ben', name: 'Ben (demo)' },
  { uid: 'stub-chidi', name: 'Chidi (demo)' },
  { uid: 'stub-dee', name: 'Dee (demo)' },
  { uid: 'stub-emre', name: 'Emre (demo)' },
];

// A made-up result for one fake friend on one date. Deterministic per date,
// and only "played" once their made-up tee time has passed.
export function fakeScore(friend, date, nowMs) {
  const rng = makeRng('stub|' + date + '|' + friend.uid);
  const plays = rng.chance(0.8);
  const total = 12 + rng.int(-2, 2) + rng.int(0, 3);
  const penalties = rng.chance(0.6) ? 0 : rng.int(1, 2);
  const createdAt = Date.parse(date + 'T00:00:00Z') + rng.int(5, 20 * 60) * 60000;
  if (!plays || createdAt > nowMs) return { uid: friend.uid, name: friend.name, isYou: false, total: null, penalties: 0, createdAt: null };
  return { uid: friend.uid, name: friend.name, isYou: false, total, penalties, createdAt };
}

// opts.store: a Storage-like object (defaults to localStorage, falls back to memory).
// opts.now: () => epoch ms. opts.date: fixed 'YYYY-MM-DD' for testing other days.
export function createLocalAdapters(opts = {}) {
  let store = opts.store;
  if (!store) {
    try {
      store = globalThis.localStorage;
      store.setItem(PREFIX + 'probe', '1');
      store.removeItem(PREFIX + 'probe');
    } catch {
      const mem = new Map();
      store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
    }
  }
  const now = opts.now || (() => Date.now());
  const read = (key) => {
    try { const v = store.getItem(PREFIX + key); return v == null ? null : JSON.parse(v); } catch { return null; }
  };
  const write = (key, value) => {
    try { store.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage full or blocked: play on */ }
  };

  const storage = {
    loadLifetime: () => read('lifetime'),
    saveLifetime: (stats) => write('lifetime', stats),
    loadDailyDraft: (date) => read('daily.draft.' + date + '.' + UID),
    saveDailyDraft: (date, draft) => write('daily.draft.' + date + '.' + UID, draft),
    loadSettings: () => read('settings'),
    saveSettings: (s) => write('settings', s),
  };

  const daily = {
    uid: UID,
    getToday: () => opts.date || new Date(now()).toISOString().slice(0, 10),
    // Create-only, like the real rules will be: a second submit for the same
    // day returns the stored result unchanged.
    submit(result) {
      const key = 'daily.score.' + result.date + '_' + UID;
      const existing = read(key);
      if (existing) return existing;
      const doc = { ...result, uid: UID, createdAt: now() };
      write(key, doc);
      return doc;
    },
    fetchLeaderboard(date) {
      const mine = read('daily.score.' + date + '_' + UID);
      const penalties = mine ? mine.holes.reduce((n, hole) => n + hole.penalties, 0) : 0;
      const rows = [{ uid: UID, name: 'You', isYou: true, total: mine ? mine.total : null, penalties, createdAt: mine ? mine.createdAt : null }];
      for (const f of FAKE_FRIENDS) rows.push(fakeScore(f, date, now()));
      return rows;
    },
    // Invented "everyone" histogram for the standalone page, stable per date.
    fetchGlobal(date) {
      const rng = makeRng('stub-global|' + date);
      const counts = {};
      let n = 0;
      for (let i = 0; i < 240; i++) {
        const total = Math.max(7, 13 + rng.int(-3, 3) + rng.int(-2, 4));
        counts[total] = (counts[total] || 0) + 1;
        n++;
      }
      const mine = read('daily.score.' + date + '_' + UID);
      if (mine) { counts[mine.total] = (counts[mine.total] || 0) + 1; n++; }
      return { n, counts };
    },
  };

  return { storage, daily };
}
