// Pure helpers behind the extra statistics on the Statistics page.
//
// Nothing here touches the DOM or Firebase, so it is unit-tested in Node
// (tests/stats.test.js). The page (js/insights.js) feeds these functions the
// values it already works with: for each round a "value" that is either the
// score over par or the course differential, depending on the handicap mode.
// Only data the app really has is used: date, course, score, par, qualifying.
// Nothing here needs hole-by-hole data.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Sample standard deviation; needs at least two values.
export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

export function summarize(values) {
  const v = values.filter(isNum);
  if (!v.length) return null;
  return { n: v.length, mean: mean(v), median: median(v), sd: stdev(v), min: Math.min(...v), max: Math.max(...v) };
}

// 'YYYY-MM-DD' -> whole days since 1970-01-01 (UTC, so no daylight-saving drift).
export function dayNumber(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// Mean of each trailing window of `size` values. entries: [{ date, value }], oldest first.
export function rolling(entries, size) {
  const out = [];
  for (let i = size - 1; i < entries.length; i++) {
    out.push({ date: entries[i].date, val: mean(entries.slice(i - size + 1, i + 1).map((e) => e.value)) });
  }
  return out;
}

// The last `size` values against the (up to) `size` before them. Needs a sensible
// amount of history on both sides, otherwise there is nothing fair to compare.
export function recentVsPrevious(values, size) {
  if (values.length < size + 3) return null;
  const recent = values.slice(-size);
  const previous = values.slice(Math.max(0, values.length - 2 * size), values.length - size);
  return { recent: mean(recent), previous: mean(previous), previousN: previous.length, delta: mean(recent) - mean(previous) };
}

// series: [{ date, val }] the estimated handicap after each qualifying round, oldest first.
export function handicapRange(series, today) {
  const s = series.filter((x) => isNum(x.val));
  if (!s.length) return null;
  let low = 0, high = 0;
  s.forEach((x, i) => {
    if (x.val <= s[low].val) low = i; // ties go to the most recent time you matched it
    if (x.val >= s[high].val) high = i;
  });
  return {
    current: s[s.length - 1].val,
    low: { val: s[low].val, date: s[low].date },
    high: { val: s[high].val, date: s[high].date },
    roundsSinceLow: s.length - 1 - low,
    daysSinceLow: Math.max(0, dayNumber(today) - dayNumber(s[low].date)),
  };
}

// entries: [{ value, before }] where `before` is the handicap you held going into the round.
// Lower is better, so "beating" it means a lower value.
export function beatRate(entries) {
  const c = entries.filter((e) => isNum(e.value) && isNum(e.before));
  const beat = c.filter((e) => e.value < e.before).length;
  return { n: c.length, beat, pct: c.length ? beat / c.length : null };
}

// flags: booleans in playing order. current = the run you are on now.
export function streaks(flags) {
  let current = 0, best = 0;
  for (const f of flags) {
    current = f ? current + 1 : 0;
    if (current > best) best = current;
  }
  return { current, best };
}

// Each round that set a new lowest value. entries: [{ date, course, value }], oldest first.
export function personalBests(entries) {
  let best = Infinity;
  const out = [];
  for (const e of entries) {
    if (isNum(e.value) && e.value < best) {
      best = e.value;
      out.push(e);
    }
  }
  return out;
}

// Average value per category. labels[i] names category i; keyFn returns an index or null.
export function byCategory(entries, keyFn, labels) {
  const groups = labels.map(() => []);
  for (const e of entries) {
    const k = keyFn(e);
    if (isNum(e.value) && Number.isInteger(k) && groups[k]) groups[k].push(e.value);
  }
  return labels.map((label, i) => ({ label, n: groups[i].length, avg: mean(groups[i]) }));
}

export const monthOf = (e) => Number(e.date.slice(5, 7)) - 1;
export const weekdayOf = (e) => {
  const [y, m, d] = e.date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
};

// Rounds per calendar month for the last `months` months, ending with today's month.
export function monthCounts(dates, today, months = 12) {
  const [ty, tm] = today.split('-').map(Number);
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    let m = tm - 1 - i, y = ty;
    while (m < 0) { m += 12; y--; }
    out.push({ key: y + '-' + String(m + 1).padStart(2, '0'), label: MONTHS[m], n: 0 });
  }
  const byKey = new Map(out.map((o) => [o.key, o]));
  for (const d of dates) {
    const o = byKey.get(String(d).slice(0, 7));
    if (o) o.n++;
  }
  return out;
}

// Best and toughest course by average value, among courses with at least `minRounds` rounds.
// entries: [{ course, value }]. Returns null unless two or more courses qualify.
export function courseExtremes(entries, minRounds = 2) {
  const groups = new Map();
  for (const e of entries) {
    if (!e.course || !isNum(e.value)) continue;
    if (!groups.has(e.course)) groups.set(e.course, []);
    groups.get(e.course).push(e.value);
  }
  const rows = [...groups]
    .filter(([, v]) => v.length >= minRounds)
    .map(([course, v]) => ({ course, n: v.length, avg: mean(v), best: Math.min(...v) }))
    .sort((a, b) => a.avg - b.avg || a.course.localeCompare(b.course));
  if (rows.length < 2) return null;
  return { best: rows[0], worst: rows[rows.length - 1], count: rows.length };
}

// How much and how regularly you play. dates: every recorded round, today: 'YYYY-MM-DD'.
export function activity(dates, today) {
  const t = dayNumber(today);
  const d = dates.map(dayNumber).filter(Number.isFinite).sort((a, b) => a - b);
  if (!d.length) return null;
  const within = (days) => d.filter((x) => t - x >= 0 && t - x < days).length;
  let longestGap = 0;
  for (let i = 1; i < d.length; i++) longestGap = Math.max(longestGap, d[i] - d[i - 1]);
  const months = Math.max(1, (t - d[0]) / 30.44);
  return {
    total: d.length,
    last30: within(30),
    last90: within(90),
    last365: within(365),
    perMonth: d.length / months,
    longestGap,
    daysSinceLast: Math.max(0, t - d[d.length - 1]),
  };
}

// rounds: [{ qualifying, over }] -> counts and average over par for each kind.
export function qualifyingSplit(rounds) {
  const side = (list) => ({ n: list.length, avgOver: mean(list.map((r) => r.over).filter(isNum)) });
  return { q: side(rounds.filter((r) => r.qualifying)), nq: side(rounds.filter((r) => !r.qualifying)) };
}
