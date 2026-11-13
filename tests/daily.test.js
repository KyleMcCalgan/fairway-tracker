import test from 'node:test';
import assert from 'node:assert/strict';
import { GEN_VERSION, CLUB_ORDER } from '../js/game/constants.js';
import { dailyHoles } from '../js/game/generate.js';
import { newHoleState, applyShot, aimCentre } from '../js/game/rules.js';
import { makeRng } from '../js/game/rng.js';
import {
  emptyDraft, checkDraft, statesFromDraft, buildResult, rankLeaderboard, nextStreak,
  shareText, msToReset, formatCountdown, percentile,
} from '../js/game/modes/daily.js';
import { createLocalAdapters, FAKE_FRIENDS, fakeScore } from '../game/local-adapters.js';

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

function playRound(holes, seed) {
  const rng = makeRng(seed);
  return holes.map((hole) => {
    let state = newHoleState();
    while (!state.done) {
      const club = CLUB_ORDER[rng.int(0, 2)];
      const angle = (aimCentre(hole, state.pos, club, state.lie) + rng.int(-80, 80) + 3600) % 3600;
      state = applyShot(hole, state, { club, angle, power: rng.int(90, 200) }).state;
    }
    return state;
  });
}

const DATE = '2026-11-13';

test('draft: saved shot logs rebuild the exact round after a refresh', () => {
  const holes = dailyHoles(DATE);
  const states = playRound(holes, 'draft');
  const draft = emptyDraft(DATE);
  // Mid-round: hole 1 finished, hole 2 two shots in (or fewer if it ended sooner).
  draft.holes[0] = states[0].shots;
  draft.holes[1] = states[1].shots.slice(0, Math.min(2, states[1].shots.length - 1));
  const stored = JSON.parse(JSON.stringify(draft)); // what localStorage gives back
  assert.ok(checkDraft(stored, DATE));
  const rebuilt = statesFromDraft(holes, stored);
  assert.deepEqual(rebuilt[0], states[0]);
  assert.equal(rebuilt[1].shots.length, draft.holes[1].length);
  assert.equal(rebuilt[1].done, false);
  assert.deepEqual(rebuilt[2], newHoleState());
});

test('draft: wrong date, wrong generator version or a tampered log is rejected', () => {
  const holes = dailyHoles(DATE);
  const states = playRound(holes, 'tamper');
  const draft = emptyDraft(DATE);
  draft.holes[0] = states[0].shots;
  assert.equal(checkDraft(draft, '2026-11-14'), null);
  assert.equal(checkDraft({ ...draft, genVersion: GEN_VERSION + 1 }, DATE), null);
  assert.equal(checkDraft({ ...draft, holes: [[], []] }, DATE), null);
  assert.equal(checkDraft({ ...draft, holes: [[{ club: 'driver', angle: 1.5, power: 200 }], [], []] }, DATE), null);
  assert.equal(checkDraft(null, DATE), null);
  // A log whose recorded results do not match the replay.
  const bad = JSON.parse(JSON.stringify(draft));
  bad.holes[0][0].result = bad.holes[0][0].result === 'ok' ? 'holed' : 'ok';
  assert.equal(statesFromDraft(holes, bad), null);
  // Shots logged on hole 3 while hole 2 is unfinished.
  const skip = JSON.parse(JSON.stringify(draft));
  skip.holes[2] = states[2].shots;
  assert.equal(statesFromDraft(holes, skip), null);
});

test('result document has the stored shape and replays to the same total', () => {
  const holes = dailyHoles(DATE);
  const states = playRound(holes, 'result');
  const r = buildResult(DATE, 'u1', states, 123);
  assert.deepEqual(Object.keys(r), ['date', 'uid', 'genVersion', 'holes', 'total', 'createdAt']);
  assert.equal(r.genVersion, GEN_VERSION);
  assert.equal(r.holes.length, 3);
  assert.equal(r.total, states[0].strokes + states[1].strokes + states[2].strokes);
  for (const hole of r.holes) {
    assert.deepEqual(Object.keys(hole), ['strokes', 'putts', 'penalties', 'shots']);
    for (const s of hole.shots) {
      assert.deepEqual(Object.keys(s), ['club', 'angle', 'power', 'result']);
      assert.ok(Number.isInteger(s.angle) && Number.isInteger(s.power));
      assert.ok(['ok', 'ob', 'water', 'holed'].includes(s.result));
    }
  }
  // Replay verification from the stored document alone.
  const again = statesFromDraft(holes, { holes: r.holes.map((x) => x.shots) });
  assert.equal(again.reduce((n, s) => n + s.strokes, 0), r.total);
});

test('leaderboard ranks by strokes, then fewer penalties, then earlier submission', () => {
  const rows = rankLeaderboard([
    { uid: 'a', name: 'Ana', total: 14, penalties: 0, createdAt: 5 },
    { uid: 'b', name: 'Ben', total: 12, penalties: 2, createdAt: 9 },
    { uid: 'c', name: 'Cy', total: 12, penalties: 0, createdAt: 8 },
    { uid: 'd', name: 'Dee', total: null, penalties: 0, createdAt: null },
    { uid: 'e', name: 'Emre', total: 12, penalties: 0, createdAt: 3 },
    { uid: 'f', name: 'Abe', total: null, penalties: 0, createdAt: null },
  ]);
  assert.deepEqual(rows.map((r) => r.uid), ['e', 'c', 'b', 'a', 'f', 'd']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3, 4, null, null]);
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ uid: 'u' + i, name: 'U' + i, total: 10 + i, penalties: 0, createdAt: i });
  assert.equal(rankLeaderboard(many).length, 30);
});

test('streak counts consecutive UTC days and is idempotent', () => {
  let s = nextStreak(null, '2026-11-12');
  assert.deepEqual(s, { streak: 1, best: 1, lastDate: '2026-11-12' });
  s = nextStreak(s, '2026-11-13');
  assert.equal(s.streak, 2);
  assert.deepEqual(nextStreak(s, '2026-11-13'), s);
  s = nextStreak(s, '2026-11-14');
  s = nextStreak(s, '2026-11-16'); // missed a day
  assert.deepEqual(s, { streak: 1, best: 3, lastDate: '2026-11-16' });
  assert.equal(nextStreak({ streak: 4, best: 4, lastDate: '2026-12-31' }, '2027-01-01').streak, 5);
});

test('share text has scores only: no seeds, yardages or hole details', () => {
  const text = shareText(DATE, [4, 3, 5], [3, 3, 7], 4);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Handi Golf Daily 2026-11-13');
  assert.equal(lines[1], '13 strokes (+1)');
  assert.equal(lines[2], '−1  E  +2'); // each hole versus par, no pars or hole details
  assert.match(lines[3], /4 day streak/);
  assert.ok(!/seed|yds|yard|par \d|bunker|water|wind/i.test(text));
  assert.equal(shareText(DATE, [3, 4, 5], [3, 4, 5], 1).split('\n').length, 3);
  assert.match(shareText(DATE, [3, 4, 5], [2, 4, 5], 1), /\(−1\)/);
});

test('countdown to the UTC reset', () => {
  assert.equal(msToReset(Date.UTC(2026, 10, 13, 0, 0, 0)), 86400000);
  assert.equal(msToReset(Date.UTC(2026, 10, 13, 23, 59, 59)), 1000);
  assert.equal(msToReset(Date.UTC(2026, 11, 31, 12, 0, 0)), 12 * 3600000);
  assert.equal(formatCountdown(3723000), '01:02:03');
  assert.equal(formatCountdown(-5), '00:00:00');
});

test('local adapters: storage round-trips, submit is create-only, stub leaderboard', async () => {
  const store = memStore();
  let now = Date.UTC(2026, 10, 13, 23, 0, 0);
  const { storage, daily } = createLocalAdapters({ store, now: () => now });
  assert.equal(storage.loadLifetime(), null);
  storage.saveLifetime({ holes: 3 });
  assert.deepEqual(storage.loadLifetime(), { holes: 3 });
  assert.equal(storage.loadDailyDraft(DATE), null);
  storage.saveDailyDraft(DATE, emptyDraft(DATE));
  assert.deepEqual(storage.loadDailyDraft(DATE), emptyDraft(DATE));
  assert.equal(storage.loadDailyDraft('2026-11-14'), null);
  storage.saveSettings({ assist: true, latencyMs: 40 });
  assert.deepEqual(storage.loadSettings(), { assist: true, latencyMs: 40 });
  for (const k of store.map.keys()) assert.ok(k.startsWith('handi.game.'));

  assert.equal(daily.getToday(), DATE);
  now = Date.UTC(2026, 10, 14, 0, 0, 1);
  assert.equal(daily.getToday(), '2026-11-14'); // rolls over at 00:00 UTC
  now = Date.UTC(2026, 10, 13, 23, 0, 0);

  let board = daily.fetchLeaderboard(DATE);
  assert.equal(board.length, 1 + FAKE_FRIENDS.length);
  assert.equal(board[0].isYou, true);
  assert.equal(board[0].total, null);
  assert.deepEqual(daily.fetchLeaderboard(DATE), board); // fake scores are stable for a date

  const holes = dailyHoles(DATE);
  const result = buildResult(DATE, 'x', playRound(holes, 'adapter'), 0);
  const stored = daily.submit(result);
  assert.equal(stored.uid, 'local');
  assert.equal(stored.createdAt, now);
  const second = daily.submit({ ...result, total: 3 });
  assert.deepEqual(second, stored); // one attempt: the first result stands
  board = daily.fetchLeaderboard(DATE);
  assert.equal(board[0].total, result.total);
  const ranked = rankLeaderboard(board);
  assert.equal(ranked.filter((r) => r.isYou).length, 1);

  // Friends only show a score once their made-up tee time has passed.
  const early = Date.UTC(2026, 10, 13, 0, 1, 0);
  for (const f of FAKE_FRIENDS) assert.equal(fakeScore(f, DATE, early).total, null);
  const late = FAKE_FRIENDS.map((f) => fakeScore(f, DATE, Date.UTC(2026, 10, 13, 23, 59, 0)));
  assert.ok(late.some((r) => r.total != null));
  for (const r of late) if (r.total != null) assert.ok(r.total >= 10 && r.total <= 17);
});

test('percentile: where a total sits among everyone who played', () => {
  // 10 players: three on 10, four on 12 (you), three on 14.
  const counts = { 10: 3, 12: 4, 14: 3 };
  const p = percentile(counts, 12);
  assert.equal(p.n, 10);
  assert.equal(p.ahead, 3);
  assert.equal(p.tied, 4);
  assert.equal(p.behind, 3);
  // Of the 9 others: 3 are worse, 3 tied (half credit each) => (3 + 1.5) / 9.
  assert.ok(Math.abs(p.beat - 4.5 / 9) < 1e-12);
  // The best total beats everyone else; the worst beats nobody.
  assert.equal(percentile(counts, 10).beat, (7 + 2 / 2) / 9);
  assert.equal(percentile({ 10: 3, 12: 4, 14: 1 }, 14).beat, 0);
});

test('percentile: your own result is counted even if the histogram lacks it', () => {
  const p = percentile({ 12: 4, 14: 5 }, 11);
  assert.equal(p.n, 10);
  assert.equal(p.tied, 1);
  assert.equal(p.beat, 1);
});

test('percentile: the first player of the day has nobody to compare with', () => {
  assert.equal(percentile({}, 12).beat, null);
  assert.equal(percentile({ 12: 1 }, 12).beat, null);
  assert.equal(percentile(undefined, 12).beat, null);
});

test('percentile: bad histogram entries are ignored', () => {
  const p = percentile({ 12: 2, x: 5, 13: -1, 14: 'a' }, 12);
  assert.equal(p.n, 2);
});

test('local adapter offers a stable "everyone" histogram that includes your result', async () => {
  const store = memStore();
  const { daily } = createLocalAdapters({ store, date: '2026-11-13', now: () => Date.parse('2026-11-13T12:00:00Z') });
  const a = await daily.fetchGlobal('2026-11-13');
  const b = await daily.fetchGlobal('2026-11-13');
  assert.deepEqual(a, b);
  assert.equal(a.n, 240);
  const holes = [0, 1, 2].map(() => ({ strokes: 4, putts: 2, penalties: 0, shots: [] }));
  daily.submit({ date: '2026-11-13', genVersion: GEN_VERSION, holes, total: 12 });
  const c = await daily.fetchGlobal('2026-11-13');
  assert.equal(c.n, 241);
  assert.equal(c.counts[12], a.counts[12] + 1 || 1);
});
