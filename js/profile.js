// Pure helpers for the public side of a profile: what a player chooses to share
// with accepted friends, and how a friend's shared summary is shown.
//
// What is shared lives in one document, sharedStats/{uid}, which only the owner
// can write and only the owner and accepted friends can read (firestore.rules).
// The owner's browser builds it with buildShared(); anything the owner has
// switched off in Settings is simply not written, so it cannot leak. Notes,
// course ratings and email addresses are never part of it.
//
// No DOM and no Firebase here, so tests/profile.test.js covers it in Node.

import { dayNumber } from './stats.js';

export const PRIVACY_KEYS = ['handicap', 'rounds', 'recent', 'game'];
export const PRIVACY_LABELS = {
  handicap: ['Estimated handicap', 'Your estimated handicap and whether it is over par or a course differential.'],
  rounds: ['Rounds and best round', 'How many rounds you have recorded, and your best qualifying round (score, course and date).'],
  recent: ['Recent rounds', 'Your five most recent rounds: date, course, score and par. Notes are never shared.'],
  game: ['Handi Golf stats', 'Holes played, average against par, best par-or-better streak, birdies and your Daily streak.'],
};
export const MAX_RECENT = 5;
export const MAX_NAME = 24;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const clip = (s, n) => String(s ?? '').slice(0, n);

export const shortName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
// Use the same key for writing a directory entry and looking up a prefix.
export const nameSearchKey = (s) => shortName(s).toLowerCase().slice(0, MAX_NAME);

// Everything is shared until the owner switches it off.
export function normalizePrivacy(raw) {
  const out = {};
  for (const k of PRIVACY_KEYS) out[k] = raw && typeof raw[k] === 'boolean' ? raw[k] : true;
  return out;
}

// rounds: [{ id, date, course, score, par, qualifying }] (all recorded rounds)
// handicap: number | null     mode: 'differential' | 'overPar'
// lifetime: the game's lifetime stats (js/game/modes/endless.js) or null
export function buildShared({ name, privacy, handicap, mode, rounds = [], lifetime = null }) {
  const p = normalizePrivacy(privacy);
  const doc = { name: shortName(name) || 'Golfer' };

  if (p.handicap && isNum(handicap)) {
    doc.handicap = round1(handicap);
    doc.mode = mode === 'differential' ? 'differential' : 'overPar';
  }

  if (p.rounds) {
    doc.roundsCount = rounds.length;
    const q = rounds.filter((r) => r.qualifying);
    doc.qualifyingCount = q.length;
    let best = null;
    for (const r of q) {
      const over = Number(r.score) - Number(r.par);
      if (!Number.isFinite(over)) continue;
      if (!best || over < best.over || (over === best.over && r.date > best.date)) {
        best = { over, score: Number(r.score), par: Number(r.par), date: r.date, course: clip(r.course, 80) };
      }
    }
    if (best) doc.best = best;
  }

  if (p.recent) {
    const recent = [...rounds]
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)))
      .slice(0, MAX_RECENT)
      .map((r) => ({ date: r.date, course: clip(r.course, 80), score: Number(r.score), par: Number(r.par), q: !!r.qualifying }));
    if (recent.length) doc.recent = recent;
  }

  if (p.game && lifetime) {
    const g = {};
    if (lifetime.holes > 0) {
      g.holes = lifetime.holes;
      g.avgVsPar = round2((lifetime.strokes - lifetime.par) / lifetime.holes);
      g.bestStreak = lifetime.bestStreak || 0;
      g.birdies = lifetime.birdies || 0;
      g.eagles = lifetime.eagles || 0;
      g.holesInOne = lifetime.holesInOne || 0;
    }
    const d = lifetime.daily;
    if (d && d.lastDate && /^\d{4}-\d{2}-\d{2}$/.test(d.lastDate)) {
      g.dailyStreak = d.streak || 0;
      g.dailyBest = d.best || 0;
      g.dailyLast = d.lastDate;
    }
    if (Object.keys(g).length) doc.game = g;
  }
  return doc;
}

// Used to skip a write when nothing a friend could see has changed.
export const signature = (doc) => JSON.stringify(doc);

// A Daily streak only counts while it is alive: last played today or yesterday (UTC).
export function liveDailyStreak(game, today) {
  if (!game || !game.dailyLast) return 0;
  const gap = dayNumber(today) - dayNumber(game.dailyLast);
  return gap >= 0 && gap <= 1 ? game.dailyStreak || 0 : 0;
}

export function signedOver(n) {
  return n > 0 ? '+' + n : String(n);
}

// "just now", "12 min ago", "3 h ago", "2 days ago", then a plain date.
export function timeAgo(ms, now = Date.now()) {
  if (!isNum(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 14) return Math.round(s / 86400) + ' days ago';
  return new Date(ms).toISOString().slice(0, 10);
}

// A stable colour for a player's avatar, taken from their id so it needs no storage.
const AVATARS = [
  ['#e7f2e9', '#215a42'],
  ['#e6eef8', '#3f6492'],
  ['#f6ecd9', '#8a5f1d'],
  ['#f3e3df', '#a1493a'],
  ['#ece6f3', '#5f4a85'],
  ['#dff1f0', '#1f6a67'],
];
export function avatarColors(id) {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}
export const initial = (name) => ([...String(name || '').trim()][0] || '?').toUpperCase();

// Whether two handicaps can be compared: both present and measured the same way.
export function comparable(mine, theirs) {
  return !!mine && !!theirs && isNum(mine.handicap) && isNum(theirs.handicap) && mine.mode === theirs.mode;
}
