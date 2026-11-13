import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVACY_KEYS, normalizePrivacy, buildShared, signature, liveDailyStreak, timeAgo, avatarColors, initial, comparable, shortName, nameSearchKey,
} from '../js/profile.js';

const rounds = [
  { id: 'a', date: '2026-01-01', course: 'Alpha GC', score: 90, par: 72, qualifying: true, notes: 'secret' },
  { id: 'b', date: '2026-02-01', course: 'Beta GC', score: 84, par: 72, qualifying: true, notes: 'secret' },
  { id: 'c', date: '2026-03-01', course: 'Gamma GC', score: 79, par: 72, qualifying: false, notes: 'scramble' },
  { id: 'd', date: '2026-03-05', course: 'Alpha GC', score: 88, par: 72, qualifying: true },
  { id: 'e', date: '2026-03-09', course: 'Beta GC', score: 86, par: 72, qualifying: true },
  { id: 'f', date: '2026-03-12', course: 'Alpha GC', score: 85, par: 72, qualifying: true },
  { id: 'g', date: '2026-03-20', course: 'Delta GC', score: 91, par: 72, qualifying: true },
];
const lifetime = { holes: 20, strokes: 82, par: 80, bestStreak: 4, birdies: 3, eagles: 1, holesInOne: 0, ob: 5, daily: { streak: 3, best: 6, lastDate: '2026-03-20' } };

test('name search uses a consistent case-insensitive, whitespace-normalized prefix', () => {
  assert.equal(nameSearchKey('  SaM   Lee '), 'sam lee');
  assert.ok(nameSearchKey(' Sam Lee ').startsWith(nameSearchKey(' SAM ')));
  assert.equal(nameSearchKey('İ'.repeat(24)).length, 24);
});

test('privacy defaults to everything on and ignores junk', () => {
  assert.deepEqual(normalizePrivacy(undefined), { handicap: true, rounds: true, recent: true, game: true });
  assert.deepEqual(normalizePrivacy({ handicap: false, rounds: 'no', extra: 1 }), { handicap: false, rounds: true, recent: true, game: true });
  assert.deepEqual(Object.keys(normalizePrivacy({})), PRIVACY_KEYS);
});

test('with everything shared the summary has every section', () => {
  const doc = buildShared({ name: ' Sam  Lee ', privacy: {}, handicap: 14.26, mode: 'overPar', rounds, lifetime });
  assert.equal(doc.name, 'Sam Lee');
  assert.equal(doc.handicap, 14.3);
  assert.equal(doc.mode, 'overPar');
  assert.equal(doc.roundsCount, 7);
  assert.equal(doc.qualifyingCount, 6);
  // Best qualifying round: 84 on par 72 (+12). The better non-qualifying 79 is ignored.
  assert.deepEqual(doc.best, { over: 12, score: 84, par: 72, date: '2026-02-01', course: 'Beta GC' });
  assert.equal(doc.recent.length, 5);
  assert.deepEqual(doc.recent.map((r) => r.date), ['2026-03-20', '2026-03-12', '2026-03-09', '2026-03-05', '2026-03-01']);
  assert.equal(doc.recent[4].q, false);
  assert.deepEqual(doc.game, { holes: 20, avgVsPar: 0.1, bestStreak: 4, birdies: 3, eagles: 1, holesInOne: 0, dailyStreak: 3, dailyBest: 6, dailyLast: '2026-03-20' });
});

test('anything switched off is simply not in the document', () => {
  const doc = buildShared({ name: 'Sam', privacy: { handicap: false, rounds: false, recent: false, game: false }, handicap: 10, mode: 'overPar', rounds, lifetime });
  assert.deepEqual(doc, { name: 'Sam' });
  const some = buildShared({ name: 'Sam', privacy: { recent: false, game: false }, handicap: 10, mode: 'differential', rounds, lifetime });
  assert.deepEqual(Object.keys(some).sort(), ['best', 'handicap', 'mode', 'name', 'qualifyingCount', 'roundsCount']);
  assert.equal(some.mode, 'differential');
});

test('notes and other private fields never reach the summary', () => {
  const text = JSON.stringify(buildShared({ name: 'Sam', privacy: {}, handicap: 10, mode: 'overPar', rounds, lifetime }));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('scramble'));
  assert.ok(!text.includes('notes'));
});

test('no handicap yet, no rounds, no game: a bare but valid summary', () => {
  assert.deepEqual(buildShared({ name: '', privacy: {}, handicap: null, mode: 'overPar', rounds: [], lifetime: null }), { name: 'Golfer', roundsCount: 0, qualifyingCount: 0 });
  assert.equal('game' in buildShared({ name: 'S', privacy: {}, handicap: null, rounds: [], lifetime: { holes: 0 } }), false);
});

test('long course names are clipped and the name is limited', () => {
  const doc = buildShared({ name: 'x'.repeat(60), privacy: {}, handicap: 1, rounds: [{ id: 'z', date: '2026-01-01', course: 'c'.repeat(200), score: 80, par: 72, qualifying: true }], lifetime: null });
  assert.equal(doc.name.length, 24);
  assert.equal(doc.best.course.length, 80);
  assert.equal(doc.recent[0].course.length, 80);
  assert.equal(shortName('  a   b  '), 'a b');
});

test('signature only changes when something visible changes', () => {
  const a = buildShared({ name: 'S', privacy: {}, handicap: 10, mode: 'overPar', rounds, lifetime });
  const b = buildShared({ name: 'S', privacy: {}, handicap: 10, mode: 'overPar', rounds: rounds.map((r) => ({ ...r, notes: 'changed' })), lifetime });
  assert.equal(signature(a), signature(b));
  assert.notEqual(signature(a), signature(buildShared({ name: 'S', privacy: {}, handicap: 11, mode: 'overPar', rounds, lifetime })));
});

test('a Daily streak only counts while it is alive', () => {
  const game = { dailyStreak: 5, dailyLast: '2026-03-20' };
  assert.equal(liveDailyStreak(game, '2026-03-20'), 5);
  assert.equal(liveDailyStreak(game, '2026-03-21'), 5);
  assert.equal(liveDailyStreak(game, '2026-03-22'), 0);
  assert.equal(liveDailyStreak(null, '2026-03-22'), 0);
  assert.equal(liveDailyStreak({ dailyStreak: 2 }, '2026-03-22'), 0);
});

test('time ago', () => {
  const now = Date.parse('2026-03-20T12:00:00Z');
  assert.equal(timeAgo(now - 5000, now), 'just now');
  assert.equal(timeAgo(now - 12 * 60000, now), '12 min ago');
  assert.equal(timeAgo(now - 3 * 3600000, now), '3 h ago');
  assert.equal(timeAgo(now - 2 * 86400000, now), '2 days ago');
  assert.equal(timeAgo(now - 40 * 86400000, now), '2026-02-08');
  assert.equal(timeAgo(undefined, now), '');
});

test('avatars are stable and initials are safe', () => {
  assert.deepEqual(avatarColors('abc'), avatarColors('abc'));
  assert.equal(avatarColors('abc').length, 2);
  assert.equal(initial('  zoe'), 'Z');
  assert.equal(initial(''), '?');
  assert.equal(initial('<b>'), '<');
});

test('handicaps are only compared when measured the same way', () => {
  assert.equal(comparable({ handicap: 10, mode: 'overPar' }, { handicap: 12, mode: 'overPar' }), true);
  assert.equal(comparable({ handicap: 10, mode: 'overPar' }, { handicap: 12, mode: 'differential' }), false);
  assert.equal(comparable({ mode: 'overPar' }, { handicap: 12, mode: 'overPar' }), false);
  assert.equal(comparable(null, { handicap: 12, mode: 'overPar' }), false);
});
