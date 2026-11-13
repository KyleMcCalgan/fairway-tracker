import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, median, stdev, summarize, dayNumber, rolling, recentVsPrevious, handicapRange, beatRate,
  streaks, personalBests, byCategory, monthOf, weekdayOf, monthCounts, courseExtremes, activity, qualifyingSplit,
} from '../js/stats.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);

test('mean, median and standard deviation', () => {
  assert.equal(mean([]), null);
  assert.equal(mean([2, 4, 9]), 5);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(stdev([5]), null);
  close(stdev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
});

test('summarize ignores non-numbers and handles empty input', () => {
  assert.equal(summarize([]), null);
  assert.equal(summarize([NaN, null, undefined]), null);
  const s = summarize([10, NaN, 20, 30]);
  assert.deepEqual({ n: s.n, mean: s.mean, median: s.median, min: s.min, max: s.max }, { n: 3, mean: 20, median: 20, min: 10, max: 30 });
});

test('dayNumber counts whole days and survives month and year ends', () => {
  assert.equal(dayNumber('1970-01-02') - dayNumber('1970-01-01'), 1);
  assert.equal(dayNumber('2026-03-01') - dayNumber('2026-02-28'), 1);
  assert.equal(dayNumber('2025-01-01') - dayNumber('2024-01-01'), 366);
});

test('rolling averages cover full windows only', () => {
  const entries = [10, 20, 30, 40].map((value, i) => ({ date: '2026-01-0' + (i + 1), value }));
  assert.deepEqual(rolling(entries, 5), []);
  assert.deepEqual(rolling(entries, 2).map((x) => x.val), [15, 25, 35]);
  assert.equal(rolling(entries, 2)[2].date, '2026-01-04');
});

test('recent versus previous needs real history on both sides', () => {
  assert.equal(recentVsPrevious([1, 2, 3, 4, 5, 6, 7], 5), null);
  const r = recentVsPrevious([30, 30, 30, 20, 20, 20, 20, 20], 5);
  assert.equal(r.recent, 20);
  assert.equal(r.previous, 30);
  assert.equal(r.previousN, 3);
  assert.equal(r.delta, -10);
});

test('handicap range: low, high, rounds and days since the low', () => {
  assert.equal(handicapRange([], '2026-06-01'), null);
  assert.equal(handicapRange([{ date: '2026-01-01', val: null }], '2026-06-01'), null);
  const series = [
    { date: '2026-01-01', val: 20 },
    { date: '2026-02-01', val: 16 },
    { date: '2026-03-01', val: 18 },
    { date: '2026-04-01', val: 19 },
  ];
  const r = handicapRange(series, '2026-04-11');
  assert.equal(r.current, 19);
  assert.deepEqual(r.low, { val: 16, date: '2026-02-01' });
  assert.deepEqual(r.high, { val: 20, date: '2026-01-01' });
  assert.equal(r.roundsSinceLow, 2);
  assert.equal(r.daysSinceLow, dayNumber('2026-04-11') - dayNumber('2026-02-01'));
  // A tie goes to the most recent time the low was matched.
  assert.equal(handicapRange([{ date: '2026-01-01', val: 10 }, { date: '2026-02-01', val: 10 }], '2026-02-02').low.date, '2026-02-01');
});

test('beat rate only counts rounds that have a handicap to beat', () => {
  assert.deepEqual(beatRate([]), { n: 0, beat: 0, pct: null });
  const r = beatRate([
    { value: 10, before: null },
    { value: 12, before: 15 },
    { value: 15, before: 15 },
    { value: 20, before: 15 },
    { value: NaN, before: 15 },
  ]);
  assert.deepEqual(r, { n: 3, beat: 1, pct: 1 / 3 });
});

test('streaks', () => {
  assert.deepEqual(streaks([]), { current: 0, best: 0 });
  assert.deepEqual(streaks([true, true, false, true, true, true]), { current: 3, best: 3 });
  assert.deepEqual(streaks([true, true, true, false]), { current: 0, best: 3 });
});

test('personal bests are strict improvements in order', () => {
  const e = [20, 18, 18, 25, 15, NaN, 15, 14].map((value, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), course: 'C', value }));
  assert.deepEqual(personalBests(e).map((x) => x.value), [20, 18, 15, 14]);
});

test('grouping by month and weekday', () => {
  const e = [
    { date: '2026-01-03', value: 10 }, // Saturday
    { date: '2026-01-10', value: 20 }, // Saturday
    { date: '2026-02-02', value: 30 }, // Monday
  ];
  assert.equal(monthOf(e[0]), 0);
  assert.equal(weekdayOf(e[0]), 5);
  assert.equal(weekdayOf(e[2]), 0);
  const months = byCategory(e, monthOf, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(months.map((m) => [m.n, m.avg]), [[2, 15], [1, 30], [0, null]]);
  const days = byCategory(e, weekdayOf, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(days[5].n, 2);
  assert.equal(days[0].avg, 30);
});

test('month counts span a rolling year and wrap years', () => {
  const m = monthCounts(['2026-01-15', '2026-01-20', '2025-12-31', '2024-01-01', '2026-03-09'], '2026-03-15', 12);
  assert.equal(m.length, 12);
  assert.equal(m[0].key, '2025-04');
  assert.equal(m[11].key, '2026-03');
  assert.equal(m[11].n, 1);
  assert.equal(m.find((x) => x.key === '2026-01').n, 2);
  assert.equal(m.find((x) => x.key === '2025-12').n, 1);
  assert.equal(m.reduce((s, x) => s + x.n, 0), 4); // the 2024 round is outside the window
});

test('course extremes need two courses with enough rounds', () => {
  assert.equal(courseExtremes([]), null);
  assert.equal(courseExtremes([{ course: 'A', value: 5 }, { course: 'A', value: 7 }]), null);
  const r = courseExtremes([
    { course: 'A', value: 10 }, { course: 'A', value: 14 },
    { course: 'B', value: 20 }, { course: 'B', value: 22 },
    { course: 'C', value: 1 }, // one round: below the threshold
    { course: '', value: 3 },
  ]);
  assert.equal(r.best.course, 'A');
  assert.equal(r.best.avg, 12);
  assert.equal(r.worst.course, 'B');
  assert.equal(r.count, 2);
});

test('activity: windows, pace, longest break', () => {
  assert.equal(activity([], '2026-06-01'), null);
  const a = activity(['2026-01-01', '2026-03-01', '2026-05-20', '2026-05-30'], '2026-06-01');
  assert.equal(a.total, 4);
  assert.equal(a.last30, 2);
  assert.equal(a.last90, 2);
  assert.equal(a.last365, 4);
  assert.equal(a.daysSinceLast, 2);
  assert.equal(a.longestGap, dayNumber('2026-05-20') - dayNumber('2026-03-01'));
  assert.ok(a.perMonth > 0.5 && a.perMonth < 1);
});

test('qualifying split', () => {
  const s = qualifyingSplit([{ qualifying: true, over: 10 }, { qualifying: true, over: 20 }, { qualifying: false, over: 30 }]);
  assert.deepEqual(s, { q: { n: 2, avgOver: 15 }, nq: { n: 1, avgOver: 30 } });
  assert.deepEqual(qualifyingSplit([]), { q: { n: 0, avgOver: null }, nq: { n: 0, avgOver: null } });
});
