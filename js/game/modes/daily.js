// Daily mode: the same three holes for everyone each UTC day, one attempt,
// resumable draft, result, friends leaderboard, streak and share text
// (docs/game.md 7). DOM-touching, but the helpers at the top are pure.

import { GEN_VERSION } from '../constants.js';
import { dailyHoles } from '../generate.js';
import { newHoleState, replay, scoreName, isValidInput } from '../rules.js';
import { h, createPlay, resultCard, formatVsPar } from '../ui.js';

export const DRAFT_VERSION = 1;
const LEADERBOARD_CAP = 30;

export function emptyDraft(date) {
  return { v: DRAFT_VERSION, date, genVersion: GEN_VERSION, holes: [[], [], []], pendingAim: null, done: false, result: null };
}

// A stored draft is only trusted if it is for this date and generator version
// and its shot logs are well-formed; anything else starts a fresh attempt.
export function checkDraft(draft, date) {
  if (!draft || draft.v !== DRAFT_VERSION || draft.date !== date || draft.genVersion !== GEN_VERSION) return null;
  if (!Array.isArray(draft.holes) || draft.holes.length !== 3) return null;
  for (const log of draft.holes) {
    if (!Array.isArray(log) || log.length > 12) return null;
    for (const s of log) if (!isValidInput(s)) return null;
  }
  return draft;
}

// Rebuild the three hole states from the draft's shot logs by replaying them.
// Returns null if a log does not replay (tampered or from other holes).
export function statesFromDraft(holes, draft) {
  const states = [];
  try {
    for (let i = 0; i < 3; i++) states.push(replay(holes[i], draft.holes[i]));
  } catch {
    return null;
  }
  // Holes are played in order: nothing may be logged after an unfinished hole.
  for (let i = 0; i < 2; i++) if (!states[i].done && draft.holes[i + 1].length) return null;
  return states;
}

// The stored result document (docs/game.md 7).
export function buildResult(date, uid, states, createdAt) {
  const holes = states.map((s) => ({
    strokes: s.strokes,
    putts: s.putts,
    penalties: s.penalties,
    shots: s.shots.map((x) => ({ club: x.club, angle: x.angle, power: x.power, result: x.result })),
  }));
  return { date, uid, genVersion: GEN_VERSION, holes, total: holes.reduce((n, x) => n + x.strokes, 0), createdAt };
}

// Rank: total strokes, then fewer penalties, then earlier submission.
// Friends who have not played go last, in name order.
export function rankLeaderboard(rows) {
  const played = rows.filter((r) => r.total != null).sort((a, b) =>
    a.total - b.total || (a.penalties || 0) - (b.penalties || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  const idle = rows.filter((r) => r.total == null).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let rank = 0;
  const out = played.map((r, i) => {
    const prev = played[i - 1];
    if (!prev || prev.total !== r.total || (prev.penalties || 0) !== (r.penalties || 0)) rank = i + 1;
    return { ...r, rank };
  });
  return out.concat(idle.map((r) => ({ ...r, rank: null }))).slice(0, LEADERBOARD_CAP);
}

function dayBefore(date) {
  return new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

// Daily-play streak. Idempotent for a date already counted.
export function nextStreak(prev, date) {
  const p = prev || { streak: 0, best: 0, lastDate: null };
  if (p.lastDate === date) return p;
  const streak = p.lastDate === dayBefore(date) ? p.streak + 1 : 1;
  return { streak, best: Math.max(p.best || 0, streak), lastDate: date };
}

const EMOJI = (d) => (d <= -2 ? '\u{1F985}' : d === -1 ? '\u{1F426}' : d === 0 ? '\u{1F7E2}' : d === 1 ? '\u{1F7E1}' : d === 2 ? '\u{1F7E0}' : '\u{1F534}');

// Share text: scores relative to par only. Nothing about the hole layouts,
// and not even which hole was the par 3, 4 or 5.
export function shareText(date, pars, strokes, streak) {
  const total = strokes.reduce((a, b) => a + b, 0);
  const par = pars.reduce((a, b) => a + b, 0);
  const lines = [
    'HANDI Golf Daily ' + date,
    total + ' strokes (' + formatVsPar(total - par) + ')',
    strokes.map((s, i) => EMOJI(s - pars[i])).join(' '),
  ];
  if (streak > 1) lines.push('\u{1F525} ' + streak + ' day streak');
  return lines.join('\n');
}

export function msToReset(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
}

function prettyDate(date) {
  try {
    return new Date(date + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch {
    return date;
  }
}

export function createDaily(root, env) {
  const { storage, daily, settings } = env;
  const el = h('div', { class: 'hg-mode' });
  root.append(el);
  let alive = true, play = null, timer = 0;
  let date = '', holes = [], draft = null, states = [];
  const uid = daily.uid || 'me';

  const save = () => Promise.resolve(storage.saveDailyDraft(date, draft)).catch((e) => console.warn('could not save daily draft', e));

  function clear() {
    if (play) { play.destroy(); play = null; }
    if (timer) { clearInterval(timer); timer = 0; }
    el.textContent = '';
  }

  // Countdown to the next UTC midnight, shown in local terms.
  function countdown() {
    const out = h('span', { class: 'hg-countdown' });
    const resetAt = new Date(Date.now() + msToReset(Date.now()));
    let local = '';
    try { local = resetAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch { /* no locale data */ }
    const tick = () => {
      const ms = msToReset(Date.now());
      out.textContent = formatCountdown(ms);
      // The day rolled over while this screen was open: offer the new holes.
      if (alive && daily.getToday && ms > 86395000) Promise.resolve(daily.getToday()).then((d) => { if (alive && d !== date && !play) start(); });
    };
    tick();
    timer = setInterval(tick, 1000);
    return h('p', { class: 'hg-note' }, 'Next daily in ', out, local ? ' (00:00 UTC, ' + local + ' your time)' : ' (00:00 UTC)');
  }

  async function leaderboard() {
    const box = h('div', { class: 'hg-panel' }, h('h3', { text: 'Friends today' }), h('p', { class: 'hg-note', text: 'Loading…' }));
    try {
      const rows = rankLeaderboard(await daily.fetchLeaderboard(date));
      const body = rows.map((r) => h('tr', { class: (r.isYou ? 'hg-you ' : '') + (r.total == null ? 'hg-idle' : '') },
        h('td', { text: r.rank == null ? '–' : String(r.rank) }),
        h('th', { scope: 'row', text: r.name + (r.isYou && r.name !== 'You' ? ' (you)' : '') }),
        h('td', { text: r.total == null ? 'not played' : String(r.total) }),
        h('td', { text: r.total == null ? '' : String(r.penalties || 0) })));
      box.lastChild.replaceWith(h('table', { class: 'hg-table' },
        h('thead', null, h('tr', null, ['#', 'Player', 'Strokes', 'Penalties'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', null, body)));
    } catch (e) {
      console.warn('leaderboard failed', e);
      box.lastChild.replaceWith(h('p', { class: 'hg-note', text: 'Could not load the leaderboard.' }));
    }
    return box;
  }

  function holeIndex() {
    for (let i = 0; i < 3; i++) if (!states[i].done) return i;
    return 3;
  }

  async function showLobby() {
    clear();
    const idx = holeIndex();
    const started = draft.holes[0].length > 0 || !!draft.pendingAim;
    const go = h('button', { class: 'hg-btn hg-primary hg-swing', type: 'button', text: started ? 'Resume round' : 'Play today’s round' });
    go.addEventListener('click', () => playHole(holeIndex()));
    const view = h('div', { class: 'hg-daily' },
      h('h2', { text: 'Daily · ' + prettyDate(date) }),
      h('div', { class: 'hg-panel' },
        h('p', { text: 'Three holes, the same for everyone today. One attempt: once a tap locks, it is locked.' }),
        h('div', { class: 'hg-holes' }, holes.map((hole, i) => h('div', null,
          h('span', { class: 'hg-note', text: 'Hole ' + (i + 1) }),
          h('b', { text: states[i].done ? String(states[i].strokes) : 'Par ' + hole.par }),
          h('span', { class: 'hg-note', text: states[i].done ? scoreName(states[i].strokes, hole.par, states[i]) : hole.lengthYds + ' yds' })))),
        started ? h('p', { class: 'hg-note', text: 'Round in progress: you are on hole ' + (idx + 1) + ' of 3.' }) : null,
        go,
        countdown()));
    el.append(view);
    view.append(await leaderboard());
  }

  function playHole(i) {
    clear();
    const bar = h('div', { class: 'hg-bar' }, h('span', { class: 'hg-bar-main' }), h('span', { class: 'hg-note' }));
    const playRoot = h('div', { class: 'hg-playroot' });
    el.append(bar, playRoot);
    const updateBar = () => {
      const done = states.filter((s) => s.done);
      const vs = done.reduce((n, s, k) => n + s.strokes - holes[k].par, 0);
      bar.firstChild.textContent = 'Daily · hole ' + (i + 1) + ' of 3';
      bar.lastChild.textContent = done.length ? 'Round ' + formatVsPar(vs) + ' thru ' + done.length : 'One attempt';
    };
    play = createPlay(playRoot, {
      // Daily meter speeds are fixed for everyone: assist never applies here.
      settings: () => ({ assist: false, latencyMs: settings.latencyMs || 0 }),
      onAimLocked(p) { draft.pendingAim = { hole: i, club: p.club, angle: p.angle }; save(); },
      onShot(shot, state) {
        draft.holes[i] = state.shots.map((x) => ({ club: x.club, angle: x.angle, power: x.power, result: x.result }));
        draft.pendingAim = null;
        states[i] = state;
        save();
      },
      onDone(state) {
        states[i] = state;
        updateBar();
        const last = i === 2;
        const parts = [state.shots.length + (state.shots.length === 1 ? ' shot' : ' shots')];
        if (state.putts) parts.push(state.putts + (state.putts === 1 ? ' putt' : ' putts'));
        if (state.penalties) parts.push(state.penalties + (state.penalties === 1 ? ' penalty' : ' penalties'));
        play.showCard(resultCard({
          title: scoreName(state.strokes, holes[i].par, state),
          lines: ['Hole ' + (i + 1) + ' of 3: ' + state.strokes + ' on a par ' + holes[i].par + ' (' + parts.join(', ') + ')'],
          actions: [{ label: last ? 'See result' : 'Next hole', primary: true, onClick: () => (last ? finish() : playHole(i + 1)) }],
        }));
      },
    });
    const pending = draft.pendingAim && draft.pendingAim.hole === i ? draft.pendingAim : null;
    play.load(holes[i], { holeNo: (i + 1) + '/3', state: states[i], pendingAim: pending });
    updateBar();
  }

  async function finish() {
    if (!draft.done) {
      let result = buildResult(date, uid, states, Date.now());
      try {
        const stored = await daily.submit(result);
        if (stored && stored.holes) result = stored;
      } catch (e) { console.warn('daily submit failed', e); }
      draft.done = true;
      draft.result = result;
      draft.pendingAim = null;
      await save();
      try {
        const life = (await storage.loadLifetime()) || {};
        life.daily = nextStreak(life.daily, date);
        await storage.saveLifetime(life);
      } catch (e) { console.warn('could not save streak', e); }
    }
    if (alive) showResult();
  }

  async function showResult() {
    clear();
    const result = draft.result;
    const pars = holes.map((x) => x.par);
    const strokes = result.holes.map((x) => x.strokes);
    const par = pars.reduce((a, b) => a + b, 0);
    let streak = { streak: 1, best: 1 };
    try {
      const life = await storage.loadLifetime();
      if (life && life.daily) streak = life.daily;
    } catch { /* keep the default */ }
    if (!alive) return;
    const text = shareText(date, pars, strokes, streak.streak);
    const status = h('p', { class: 'hg-note', role: 'status' });
    const copy = h('button', { class: 'hg-btn hg-primary', type: 'button', text: 'Copy result' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); status.textContent = 'Copied to the clipboard.'; }
      catch { status.textContent = 'Could not copy automatically. Select the text above and copy it.'; }
    });
    const view = h('div', { class: 'hg-daily' },
      h('h2', { text: 'Daily · ' + prettyDate(date) }),
      h('div', { class: 'hg-panel' },
        h('p', { class: 'hg-big', text: result.total + ' strokes (' + formatVsPar(result.total - par) + ')' }),
        h('div', { class: 'hg-holes' }, result.holes.map((x, i) => h('div', null,
          h('span', { class: 'hg-note', text: 'Hole ' + (i + 1) + ' · par ' + pars[i] }),
          h('b', { text: String(x.strokes) }),
          h('span', { class: 'hg-note', text: scoreName(x.strokes, pars[i], { pickedUp: x.strokes >= 12 && states[i] && states[i].pickedUp }) })))),
        h('p', null, 'Streak: ', h('strong', { text: streak.streak + (streak.streak === 1 ? ' day' : ' days') }), ' · best ' + streak.best),
        h('p', { class: 'hg-note', text: 'You have played today’s round. Come back after the reset for new holes.' }),
        countdown()),
      h('div', { class: 'hg-panel' },
        h('h3', { text: 'Share' }),
        h('pre', { class: 'hg-share hg-select', tabindex: '0', 'aria-label': 'Result text to share', text }),
        copy, status));
    el.append(view);
    view.append(await leaderboard());
  }

  async function start() {
    clear();
    el.append(h('p', { class: 'hg-note', style: 'padding:12px', text: 'Loading today’s holes…' }));
    try {
      date = await daily.getToday();
      holes = dailyHoles(date);
      draft = checkDraft(await storage.loadDailyDraft(date), date) || emptyDraft(date);
      states = statesFromDraft(holes, draft);
      if (!states) { draft = emptyDraft(date); states = [newHoleState(), newHoleState(), newHoleState()]; }
    } catch (e) {
      console.error(e);
      clear();
      el.append(h('p', { class: 'hg-note', style: 'padding:12px', text: 'Could not load the daily round.' }));
      return;
    }
    if (!alive) return;
    if (draft.done && draft.result) showResult();
    else if (holeIndex() === 3) finish(); // all three holes logged but the result was never stored
    else showLobby();
  }

  start();

  return {
    destroy() {
      alive = false;
      clear();
      el.remove();
    },
    get play() { return play; },
    get holes() { return holes; },
  };
}
