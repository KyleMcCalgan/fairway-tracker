// The Friends view: your friend code, adding friends, requests, your friends
// and, one click in, each friend's profile.
//
// A profile only shows what that friend has chosen to share (js/profile.js
// builds it; Settings controls it; firestore.rules enforces who can read it).
// Every name and course comes from another person, so all of it is escaped.
//
// The app tells this view about changes through `setFriends` and asks it to
// draw through `renderFriends`. `initFriends` supplies the few things it needs
// from the app: getMine() -> { handicap, mode } | null, and toast(text).

import * as social from './social.js?v=20261113-2';
import { avatarColors, initial, timeAgo, liveDailyStreak, signedOver, comparable } from './profile.js?v=20261113-2';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const dateShort = (d) => {
  const [y, m, day] = String(d).split('-');
  return day && m && y ? `${day}/${m}/${y}` : '—';
};

let host = null;
let wired = false;
let friends = [];
let viewing = null; // a friend's uid while their profile is open
let message = { text: '', error: false };
let draftCode = '';
let searchTerm = '';
let searchResults = null;
let searching = false;
const summaries = new Map(); // friend uid -> shared summary | null (none shared) ; absent = not fetched yet
let fetching = false;

const isActive = () => $('friends') && $('friends').classList.contains('active');

/* ------------------------------------------------------------------ data */

export function setFriends(list) {
  friends = list;
  if (viewing && !friends.some((f) => f.uid === viewing && f.status === 'friend')) viewing = null;
  if (isActive()) {
    renderFriends();
    loadSummaries();
  }
}

export function resetFriends() {
  friends = [];
  viewing = null;
  summaries.clear();
  draftCode = '';
  searchTerm = '';
  searchResults = null;
  searching = false;
  message = { text: '', error: false };
  const page = $('friendsPage');
  if (page) page.innerHTML = '';
}

// Fetches every friend's shared summary once per visit (the social layer caches for a minute).
async function loadSummaries({ force = false } = {}) {
  if (fetching) return;
  const todo = friends.filter((f) => f.status === 'friend');
  if (!todo.length) return;
  fetching = true;
  try {
    await Promise.all(
      todo.map(async (f) => {
        summaries.set(f.uid, await social.fetchShared(f.uid, { force }));
      }),
    );
  } catch (error) {
    console.warn('could not load friend summaries', error);
  } finally {
    fetching = false;
  }
  if (isActive()) renderFriends();
}

/** Called each time the Friends view opens. */
export function showFriends() {
  viewing = null;
  message = { text: '', error: false };
  renderFriends();
  loadSummaries({ force: true });
}

/* ---------------------------------------------------------------- pieces */

function avatar(uid, name, size = '') {
  const [bg, fg] = avatarColors(uid);
  return `<span class="avatar ${size}" style="background:${bg};color:${fg}" aria-hidden="true">${esc(initial(name))}</span>`;
}

function displayName(f) {
  const s = summaries.get(f.uid);
  return (s && s.name) || f.name;
}

function cardMeta(f) {
  const s = summaries.get(f.uid);
  if (s === undefined) return 'Loading…';
  if (s === null) return 'Has not shared anything yet';
  const parts = [];
  if (typeof s.handicap === 'number') parts.push('Handicap ' + s.handicap.toFixed(1));
  if (typeof s.roundsCount === 'number') parts.push(s.roundsCount + (s.roundsCount === 1 ? ' round' : ' rounds'));
  const streak = liveDailyStreak(s.game, todayUtc());
  if (streak > 1) parts.push(streak + '-day streak');
  return parts.length ? parts.join(' · ') : 'Keeps their stats private';
}

function stat(label, value, foot = '') {
  return `<div class="card"><div class="card-head"><div class="k">${esc(label)}</div></div><div class="v">${value}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
}

/* ------------------------------------------------------------------ list */

function listHTML() {
  const profile = social.getProfile();
  const incoming = friends.filter((f) => f.status === 'incoming');
  const outgoing = friends.filter((f) => f.status === 'outgoing');
  const mine = friends.filter((f) => f.status === 'friend');
  const requestRow = (f, buttons) =>
    `<div class="friend-row">${avatar(f.uid, f.name)}<span class="friend-name">${esc(f.name)}</span>${buttons}</div>`;

  return `
    <div class="friends-top">
      <div class="panel">
        <div class="panel-head"><div><h2>Find a player</h2><p>Search for a player by their display name. Up to 20 matches are shown.</p></div></div>
        <form class="set-inline" id="searchForm" novalidate>
          <input id="playerSearch" type="search" maxlength="24" autocomplete="off" placeholder="Search names" aria-label="Search player names" value="${esc(searchTerm)}" ${searching ? 'disabled' : ''} />
          <button class="btn primary" type="submit"${searching ? ' disabled' : ''}>${searching ? 'Searching…' : 'Search'}</button>
        </form>
        ${searchResults === null ? '' : searchResults.length ? `<div class="friend-section">${searchResults.map((p) => {
          const existing = friends.find((f) => f.uid === p.uid);
          const status = existing ? (existing.status === 'friend' ? 'Friends' : existing.status === 'incoming' ? 'Respond below' : 'Request sent') : '';
          return `<div class="friend-row">${avatar(p.uid, p.name)}<span class="friend-name">${esc(p.name)} <span class="hint">#${esc(p.uid.slice(-6))}</span></span>${status ? `<span class="hint">${status}</span>` : `<button class="btn small" type="button" data-act="add-player" data-id="${esc(p.uid)}">Add</button>`}</div>`;
        }).join('')}</div>` : '<div class="hint friend-section">No matching players. They may need to open Handi first.</div>'}
        <div class="hint friend-section">Or add someone using their 8-character friend code.</div>
        <form class="set-inline" id="addForm" novalidate>
          <input id="friendCodeInput" type="text" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false"
            placeholder="e.g. K7M2QP9X" aria-label="Friend code" value="${esc(draftCode)}" />
          <button class="btn primary" type="submit">Send request</button>
        </form>
        <div class="set-msg${message.error ? ' error' : ''}" role="status" aria-live="polite">${esc(message.text)}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Your friend code</h2><p>Share it so people can add you.</p></div></div>
        ${profile && profile.code
          ? `<div class="set-inline"><output class="friend-code">${esc(profile.code)}</output><button class="btn" type="button" data-act="copy">Copy</button></div>`
          : '<div class="hint">Setting up your profile…</div>'}
        <div class="hint" style="margin-top:10px">Change your name or choose what friends can see in <button class="link-btn" type="button" data-go-settings>Settings</button>.</div>
        <div class="hint friend-section">Signed-in players can find you by your display name${profile && social.getBackend() ? `, ${esc(profile.name)} #${esc(social.getBackend().uid.slice(-6))}` : ''}. Your stats stay private until you accept a request.</div>
      </div>
    </div>
    ${incoming.length ? `<div class="panel friend-section"><div class="panel-head"><div><h2>Requests</h2><p>People who want to be your friend.</p></div></div>${incoming
      .map((f) => requestRow(f, `<button class="btn primary small" type="button" data-act="accept" data-id="${esc(f.id)}">Accept</button><button class="btn small" type="button" data-act="remove" data-id="${esc(f.id)}">Decline</button>`))
      .join('')}</div>` : ''}
    ${outgoing.length ? `<div class="panel friend-section"><div class="panel-head"><div><h2>Sent</h2><p>Waiting for them to accept.</p></div></div>${outgoing
      .map((f) => requestRow(f, `<span class="hint">Waiting</span><button class="btn small" type="button" data-act="remove" data-id="${esc(f.id)}">Cancel</button>`))
      .join('')}</div>` : ''}
    <div class="panel friend-section">
      <div class="panel-head"><div><h2>Friends${mine.length ? ' (' + mine.length + ')' : ''}</h2><p>Open a friend to see what they have shared.</p></div></div>
      ${mine.length
        ? `<div class="friend-grid">${mine
            .map((f) => `<button class="friend-card" type="button" data-open="${esc(f.uid)}">${avatar(f.uid, displayName(f), 'lg')}<span class="friend-meta"><strong>${esc(displayName(f))}</strong><span class="hint">${esc(cardMeta(f))}</span></span><span class="chev" aria-hidden="true">›</span></button>`)
            .join('')}</div>`
        : '<div class="empty">No friends yet. Add someone with their code. Once they accept, you will see each other here and on the Daily leaderboard.</div>'}
    </div>`;
}

/* --------------------------------------------------------------- profile */

function comparisonFoot(s) {
  const mine = host.getMine();
  if (!comparable(mine, s)) return '';
  const diff = Math.round((mine.handicap - s.handicap) * 10) / 10;
  const unit = s.mode === 'differential' ? 'differential' : 'over par';
  if (diff === 0) return `You: ${mine.handicap.toFixed(1)} · level on ${unit}`;
  return `You: ${mine.handicap.toFixed(1)} · ${Math.abs(diff).toFixed(1)} ${diff < 0 ? 'better' : 'higher'} than them`;
}

function profileHTML(f) {
  const s = summaries.get(f.uid);
  const name = (s && s.name) || f.name;
  const head = `
    <button class="link-btn back-link" type="button" data-act="back">‹ All friends</button>
    <div class="profile-head">
      ${avatar(f.uid, name, 'xl')}
      <div>
        <h2 class="profile-name">${esc(name)}</h2>
        <div class="hint">${s ? (s.updatedAtMs ? 'Updated ' + esc(timeAgo(s.updatedAtMs)) : '') : ''}</div>
      </div>
      <button class="btn danger small profile-remove" type="button" data-act="remove" data-id="${esc(f.id)}" data-name="${esc(name)}">Remove friend</button>
    </div>`;
  if (s === undefined) return head + '<div class="panel"><div class="empty">Loading…</div></div>';
  if (s === null) {
    return head + `<div class="panel"><div class="empty">${esc(name)} has not shared anything yet. Their stats appear here once they open Handi.</div></div>`;
  }

  const hasHandicap = typeof s.handicap === 'number';
  const kind = s.mode === 'differential' ? 'Course differential' : 'Over par';
  const cards = [];
  cards.push(hasHandicap
    ? stat('Estimated handicap', s.handicap.toFixed(1), esc(kind) + (comparisonFoot(s) ? ' · ' + esc(comparisonFoot(s)) : ''))
    : stat('Estimated handicap', '—', 'Not shared'));
  cards.push(typeof s.roundsCount === 'number'
    ? stat('Rounds recorded', s.roundsCount, `${s.qualifyingCount} qualifying`)
    : stat('Rounds recorded', '—', 'Not shared'));
  cards.push(s.best
    ? stat('Best round', signedOver(s.best.over), `${s.best.score}/${s.best.par} · ${esc(s.best.course || 'Unknown course')} · ${esc(dateShort(s.best.date))}`)
    : stat('Best round', '—', typeof s.roundsCount === 'number' ? 'No qualifying rounds yet' : 'Not shared'));

  const recent = s.recent
    ? `<div class="tablewrap"><table class="table"><thead><tr><th>Date</th><th>Course</th><th>Score</th><th>Vs par</th></tr></thead><tbody>${s.recent
        .map((r) => `<tr><td>${esc(dateShort(r.date))}</td><td class="course" title="${esc(r.course)}">${esc(r.course || 'Unknown course')}${r.q ? '' : ' <span class="pill no">Not counted</span>'}</td><td>${esc(r.score)}/${esc(r.par)}</td><td class="num">${esc(signedOver(r.score - r.par))}</td></tr>`)
        .join('')}</tbody></table></div>`
    : `<div class="empty">${typeof s.roundsCount === 'number' && s.roundsCount === 0 ? 'No rounds recorded yet.' : 'Not shared.'}</div>`;

  let game = '<div class="empty">Not shared.</div>';
  if (s.game) {
    const g = s.game;
    const streak = liveDailyStreak(g, todayUtc());
    const tiles = [];
    if (typeof g.holes === 'number') {
      tiles.push(['Holes played', g.holes]);
      tiles.push(['Average vs par', (g.avgVsPar > 0 ? '+' : '') + g.avgVsPar.toFixed(2)]);
      tiles.push(['Best par-or-better streak', g.bestStreak]);
      tiles.push(['Birdies', g.birdies]);
      tiles.push(['Eagles', g.eagles]);
      tiles.push(['Holes in one', g.holesInOne]);
    }
    if (g.dailyLast) {
      tiles.push(['Daily streak', streak + (streak === 1 ? ' day' : ' days')]);
      tiles.push(['Best Daily streak', g.dailyBest + (g.dailyBest === 1 ? ' day' : ' days')]);
    }
    game = `<div class="game-tiles">${tiles.map(([k, v]) => `<div class="statbox"><div class="n">${esc(v)}</div><div class="l">${esc(k)}</div></div>`).join('')}</div>`;
  }

  return `${head}
    <div class="cards cards3">${cards.join('')}</div>
    <div class="panel friend-section"><div class="panel-head"><div><h2>Recent rounds</h2><p>Their latest five.</p></div></div>${recent}</div>
    <div class="panel friend-section"><div class="panel-head"><div><h2>Handi Golf</h2><p>Endless practice and Daily rounds.</p></div></div>${game}</div>`;
}

/* ---------------------------------------------------------------- render */

export function renderFriends() {
  const page = $('friendsPage');
  if (!page) return;
  const focusedId = document.activeElement && document.activeElement.id;
  const friend = viewing && friends.find((f) => f.uid === viewing && f.status === 'friend');
  page.innerHTML = friend ? profileHTML(friend) : listHTML();
  if (!friend) {
    const input = ['friendCodeInput', 'playerSearch'].includes(focusedId) && $(focusedId);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function setMessage(text, error = false) {
  message = { text, error };
  renderFriends();
}

/* --------------------------------------------------------------- actions */

async function onClick(evt) {
  if (evt.target.closest('[data-go-settings]')) return host.goSettings();
  const open = evt.target.closest('[data-open]');
  if (open) {
    viewing = open.dataset.open;
    renderFriends();
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }
  const button = evt.target.closest('[data-act]');
  const backend = social.getBackend();
  if (!button || !backend) return;
  const { act, id, name } = button.dataset;
  try {
    if (act === 'back') {
      viewing = null;
      renderFriends();
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText((social.getProfile() || {}).code);
        host.toast('Friend code copied');
      } catch {
        setMessage('Could not copy automatically. Select the code and copy it.', true);
      }
    } else if (act === 'accept') {
      await backend.accept(id);
      host.toast('Friend added');
    } else if (act === 'add-player') {
      button.disabled = true;
      const who = await backend.addByUser(id);
      setMessage('Request sent to ' + who + '. They will see it in their Friends list.');
    } else if (act === 'remove') {
      if (name && !confirm('Remove ' + name + ' from your friends?')) return;
      await backend.remove(id);
      viewing = null;
    }
  } catch (error) {
    console.error(error);
    setMessage(error && error.message ? error.message : 'Something went wrong. Try again.', true);
  }
}

async function onAdd(evt) {
  if (evt.target.id === 'searchForm') {
    evt.preventDefault();
    const backend = social.getBackend();
    if (!backend || searching) return;
    searchTerm = $('playerSearch').value;
    searching = true;
    setMessage('');
    try {
      const results = await backend.searchPlayers(searchTerm);
      if (social.getBackend() !== backend) return;
      searchResults = results;
    } catch (error) {
      if (social.getBackend() !== backend) return;
      searchResults = null;
      message = { text: error.message || 'Could not search. Try again.', error: true };
    } finally {
      searching = false;
      if (social.getBackend() === backend) renderFriends();
    }
    return;
  }
  if (evt.target.id !== 'addForm') return;
  evt.preventDefault();
  const backend = social.getBackend();
  if (!backend) return;
  const entered = $('friendCodeInput').value;
  setMessage('Sending…');
  try {
    const who = await backend.addByCode(entered);
    draftCode = '';
    setMessage('Request sent to ' + who + '. They will see it in their Friends list.');
  } catch (error) {
    console.error(error);
    draftCode = entered;
    setMessage(error && error.message ? error.message : 'Something went wrong. Try again.', true);
  }
}

export function initFriends(callbacks) {
  host = callbacks;
  if (wired) return;
  wired = true;
  const page = $('friendsPage');
  page.addEventListener('click', onClick);
  page.addEventListener('submit', onAdd);
  page.addEventListener('input', (e) => {
    if (e.target.id === 'friendCodeInput') draftCode = e.target.value;
    if (e.target.id === 'playerSearch') searchTerm = e.target.value;
  });
}
