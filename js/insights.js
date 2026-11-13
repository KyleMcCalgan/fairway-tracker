// The extra statistics on the Statistics page, below the original charts.
//
// The numbers come from js/stats.js (pure, unit-tested). This file only turns them
// into HTML, using the same "value" the rest of the page uses: the score over par,
// or the course differential when Rating + Slope mode is on. Only data the app
// really has is used: nothing here needs hole-by-hole data.
//
// app.js passes everything in through `renderExtraStats(ctx)`:
//   all         every recorded round, oldest first
//   qualifying  qualifying rounds, oldest first (these feed the handicap)
//   valueOf     round -> number | null   (over par, or differential)
//   label       'Over par' | 'Differential'
//   series      [{ date, val }] estimated handicap after each qualifying round
//   before      handicap going into each qualifying round (aligned with `qualifying`) | null
//   lineChart, barChart, esc, dateShort, today ('YYYY-MM-DD')

import {
  summarize, rolling, recentVsPrevious, handicapRange, beatRate, streaks, personalBests,
  byCategory, monthOf, weekdayOf, monthCounts, courseExtremes, activity, qualifyingSplit, MONTHS, WEEKDAYS,
} from './stats.js';

const $ = (id) => document.getElementById(id);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const num = (n, digits = 1) => {
  if (!isNum(n)) return '—';
  const text = n.toFixed(digits);
  const v = Number(text);
  if (v === 0) return (0).toFixed(digits);
  return (v > 0 ? '+' : '') + text;
};
const plain = (n, digits = 1) => (isNum(n) ? n.toFixed(digits) : '—');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

let rollSize = 5;
let last = null; // the most recent context, so the window tabs can redraw the chart alone

function box(label, value, hint = '') {
  return `<div class="statbox"><div class="n">${value}</div><div class="l">${label}</div>${hint ? `<div class="l sub">${hint}</div>` : ''}</div>`;
}

function empty(id, text) {
  $(id).innerHTML = `<div class="empty">${text}</div>`;
}

/* ------------------------------------------------------------ form */

function renderSummary(ctx, vals) {
  const s = summarize(vals);
  if (!s) return empty('xSummary', 'Add a few qualifying rounds to see this.');
  const e = ctx.esc;
  $('xSummary').innerHTML =
    box('Average', num(s.mean)) +
    box('Median', num(s.median)) +
    box('Best', num(s.min)) +
    box('Worst', num(s.max)) +
    box('Consistency', s.sd === null ? '—' : '±' + plain(s.sd), 'Typical swing between rounds. Lower is steadier.') +
    box('Rounds counted', s.n, e(ctx.label));
}

function renderRolling() {
  const ctx = last;
  if (!ctx) return;
  document.querySelectorAll('#xRollTabs [data-roll]').forEach((b) => {
    const on = Number(b.dataset.roll) === rollSize;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const entries = ctx.qualifying
    .map((r) => ({ date: r.date, value: ctx.valueOf(r) }))
    .filter((x) => isNum(x.value));
  const series = rolling(entries, rollSize);
  if (series.length < 2) {
    $('xRollChart').innerHTML = `<div class="empty">Needs at least ${rollSize + 1} rounds for a ${rollSize}-round average.</div>`;
    $('xRollNote').textContent = '';
    return;
  }
  ctx.lineChart('xRollChart', series, {
    values: (p) => p.val,
    label: (p, v) => `${rollSize}-round average ${num(v)} on ${ctx.dateShort(p.date)}`,
  });
  const cmp = recentVsPrevious(entries.map((x) => x.value), rollSize);
  $('xRollNote').textContent = cmp
    ? `Last ${rollSize}: ${num(cmp.recent)} · previous ${plural(cmp.previousN, 'round', 'rounds')}: ${num(cmp.previous)} · ` +
      (cmp.delta === 0 ? 'no change' : `${Math.abs(cmp.delta).toFixed(1)} ${cmp.delta < 0 ? 'better' : 'worse'}`)
    : `Each point is the average of the ${rollSize} rounds up to that date (${ctx.label.toLowerCase()}, lower is better).`;
}

/* -------------------------------------------------------- handicap */

function renderHandicap(ctx) {
  const e = ctx.esc;
  const range = handicapRange(ctx.series, ctx.today);
  if (!range) {
    empty('xHandicap', 'Your handicap estimate appears after a few qualifying rounds.');
  } else {
    const since = range.roundsSinceLow === 0
      ? 'At your low right now'
      : `${plural(range.roundsSinceLow, 'round', 'rounds')} · ${plural(range.daysSinceLow, 'day', 'days')}`;
    $('xHandicap').innerHTML =
      box('Current', plain(range.current)) +
      box('Lifetime low', plain(range.low.val), e(ctx.dateShort(range.low.date))) +
      box('Highest', plain(range.high.val), e(ctx.dateShort(range.high.date))) +
      box('Since your low', range.roundsSinceLow === 0 ? 'Now' : String(range.roundsSinceLow), e(since));
  }

  const entries = ctx.qualifying.map((r, i) => ({ value: ctx.valueOf(r), before: ctx.before[i] }));
  const beat = beatRate(entries);
  if (!beat.n) {
    empty('xBeat', 'Needs a handicap to compare against: a few more qualifying rounds.');
  } else {
    const flags = entries.filter((x) => isNum(x.value) && isNum(x.before)).map((x) => x.value < x.before);
    const run = streaks(flags);
    $('xBeat').innerHTML =
      box('Beat your handicap', `${beat.beat} of ${beat.n}`, `${Math.round(beat.pct * 100)}% of rounds scored better than the handicap you held going in`) +
      box('Current streak', plural(run.current, 'round', 'rounds'), 'In a row, better than your handicap') +
      box('Best streak', plural(run.best, 'round', 'rounds'));
  }

  const pbs = personalBests(ctx.qualifying.map((r) => ({ date: r.date, course: r.course, value: ctx.valueOf(r) })));
  $('xBests').innerHTML = pbs.length
    ? `<div class="pb-list">${pbs.slice(-6).reverse().map((p, i) =>
        `<div class="pb-row"><span class="pb-val ${i === 0 ? 'good' : ''}">${num(p.value)}</span><span class="pb-what"><strong>${e(p.course || 'Unknown course')}</strong><span class="hint">${e(ctx.dateShort(p.date))}${i === 0 ? ' · current best' : ''}</span></span></div>`).join('')}</div>`
    : '<div class="empty">No rounds to show yet.</div>';
}

/* ----------------------------------------------------- where / when */

function categoryRows(ctx, groups) {
  const shown = groups.filter((g) => g.n > 0);
  if (!shown.length) return '<div class="empty">Not enough rounds yet.</div>';
  const withAvg = shown.filter((g) => isNum(g.avg));
  const best = shown.length > 1 && withAvg.length ? Math.min(...withAvg.map((g) => g.avg)) : null;
  const most = Math.max(...shown.map((g) => g.n));
  return shown
    .map((g) => `<div class="xrow"><span class="xlabel">${ctx.esc(g.label)}</span><span class="bar"><b style="width:${Math.max(6, (g.n / most) * 100)}%"></b></span><span class="xval ${g.avg === best ? 'good' : ''}">${num(g.avg)}<span class="hint"> · ${plural(g.n, 'round', 'rounds')}</span></span></div>`)
    .join('');
}

function renderWhere(ctx, entries) {
  const e = ctx.esc;
  const ext = courseExtremes(entries.map((x) => ({ course: x.course, value: x.value })), 2);
  $('xCourses').innerHTML = ext
    ? `<div class="pb-list">
        <div class="pb-row"><span class="pb-val good">${num(ext.best.avg)}</span><span class="pb-what"><strong>${e(ext.best.course)}</strong><span class="hint">Your best course on average · ${plural(ext.best.n, 'round', 'rounds')}</span></span></div>
        <div class="pb-row"><span class="pb-val bad">${num(ext.worst.avg)}</span><span class="pb-what"><strong>${e(ext.worst.course)}</strong><span class="hint">Your toughest course on average · ${plural(ext.worst.n, 'round', 'rounds')}</span></span></div>
      </div><div class="hint" style="margin-top:8px">Only courses with at least 2 rounds count. Average ${e(ctx.label.toLowerCase())}, lower is better.</div>`
    : '<div class="empty">Play at least two courses twice each to compare them.</div>';
  $('xMonth').innerHTML = categoryRows(ctx, byCategory(entries, monthOf, MONTHS));
  $('xWeekday').innerHTML = categoryRows(ctx, byCategory(entries, weekdayOf, WEEKDAYS));
}

/* -------------------------------------------------------- activity */

function renderActivity(ctx) {
  const dates = ctx.all.map((r) => r.date);
  const counts = monthCounts(dates, ctx.today, 12);
  if (!dates.length) {
    empty('xMonthly', 'No rounds recorded yet.');
  } else {
    ctx.barChart('xMonthly', counts.map((c) => c.label), counts.map((c) => c.n), { ariaLabel: 'Rounds per month, last 12 months', unit: 'rounds' });
  }
  const a = activity(dates, ctx.today);
  const split = qualifyingSplit(ctx.all.map((r) => ({ qualifying: r.qualifying, over: r.score - r.par })));
  if (!a) return empty('xActivity', 'No rounds recorded yet.');
  $('xActivity').innerHTML =
    box('Last 30 days', a.last30, plural(a.last30, 'round', 'rounds')) +
    box('Last 90 days', a.last90) +
    box('Last 12 months', a.last365) +
    box('Per month', plain(a.perMonth), 'Average since your first round') +
    box('Longest break', plural(a.longestGap, 'day', 'days'), 'Between two rounds') +
    box('Since last round', plural(a.daysSinceLast, 'day', 'days')) +
    `<div class="statbox wide"><div class="l">Qualifying vs not counted</div><div class="n split"><span>${split.q.n} <small>qualifying · avg ${num(split.q.avgOver)} over par</small></span><span>${split.nq.n} <small>not counted${split.nq.n ? ' · avg ' + num(split.nq.avgOver) + ' over par' : ''}</small></span></div></div>`;
}

/* ----------------------------------------------------------- entry */

export function renderExtraStats(ctx) {
  last = ctx;
  const entries = ctx.qualifying.map((r) => ({ date: r.date, course: r.course, value: ctx.valueOf(r) })).filter((x) => isNum(x.value));
  renderSummary(ctx, entries.map((x) => x.value));
  renderRolling();
  renderHandicap(ctx);
  renderWhere(ctx, entries);
  renderActivity(ctx);
}

export function initInsights() {
  const tabs = $('xRollTabs');
  if (!tabs) return;
  tabs.addEventListener('click', (evt) => {
    const b = evt.target.closest('[data-roll]');
    if (!b) return;
    rollSize = Number(b.dataset.roll);
    renderRolling();
  });
}
