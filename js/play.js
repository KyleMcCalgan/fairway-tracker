// The "Play" view: mounts HANDI Golf (js/game) with Firestore-backed adapters
// and runs the Friends dialog. The game itself knows nothing about Firebase;
// see js/game-firebase.js for the data layer and docs/game.md for the game.

import { mount } from './game/index.js';
import { createGameBackend } from './game-firebase.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let backend = null; // for the signed-in user
let game = null; // the mounted game, only while the Play view is open
let stopFriends = null;
let friends = [];
let profile = null;
let message = { text: '', error: false };
let wired = false;

function renderBadge() {
  const incoming = friends.filter((f) => f.status === 'incoming').length;
  const badge = $('friendsBadge');
  badge.hidden = incoming === 0;
  badge.textContent = String(incoming);
}

function renderFriends() {
  renderBadge();
  const body = $('friendsBody');
  if (!$('friendsOverlay').classList.contains('show')) return;
  const keep = {
    name: document.activeElement && document.activeElement.id === 'friendName' ? $('friendName').value : null,
    code: document.activeElement && document.activeElement.id === 'friendCodeInput' ? $('friendCodeInput').value : null,
  };
  const group = (status) => friends.filter((f) => f.status === status);
  const rows = (list, buttons) =>
    list.length
      ? list.map((f) => `<div class="row"><span class="grow">${esc(f.name)}</span>${buttons(f)}</div>`).join('')
      : '';
  const incoming = group('incoming');
  const outgoing = group('outgoing');
  const mine = group('friend');
  body.innerHTML = `
    <section>
      <h3>YOUR FRIEND CODE</h3>
      ${profile && profile.code
        ? `<div class="inline"><span class="code" id="myCode">${esc(profile.code)}</span>
           <button class="btn small" type="button" data-act="copy">Copy</button></div>
           <div class="hint">Share this code. Anyone who enters it can send you a friend request.</div>`
        : '<div class="hint">Setting up your profile…</div>'}
    </section>
    <section>
      <h3>DISPLAY NAME</h3>
      <div class="inline">
        <input id="friendName" type="text" maxlength="24" autocomplete="nickname" value="${esc(profile ? profile.name : '')}" aria-label="Display name" />
        <button class="btn small" type="button" data-act="rename">Save</button>
      </div>
      <div class="hint">Shown to friends and on their leaderboards.</div>
    </section>
    <section>
      <h3>ADD A FRIEND</h3>
      <div class="inline">
        <input id="friendCodeInput" type="text" maxlength="12" autocomplete="off" autocapitalize="characters" placeholder="Their 8-character code" aria-label="Friend code" />
        <button class="btn small primary" type="button" data-act="add">Send request</button>
      </div>
      <div class="msg${message.error ? ' error' : ''}" role="status" aria-live="polite">${esc(message.text)}</div>
    </section>
    ${incoming.length ? `<section><h3>REQUESTS FOR YOU</h3>${rows(incoming, (f) =>
      `<button class="btn small primary" type="button" data-act="accept" data-id="${esc(f.id)}">Accept</button>
       <button class="btn small" type="button" data-act="remove" data-id="${esc(f.id)}">Decline</button>`)}</section>` : ''}
    ${outgoing.length ? `<section><h3>WAITING FOR THEM</h3>${rows(outgoing, (f) =>
      `<span class="hint">Pending</span>
       <button class="btn small" type="button" data-act="remove" data-id="${esc(f.id)}">Cancel</button>`)}</section>` : ''}
    <section>
      <h3>FRIENDS (${mine.length})</h3>
      ${mine.length ? rows(mine, (f) =>
        `<button class="btn small danger" type="button" data-act="remove" data-id="${esc(f.id)}" data-name="${esc(f.name)}">Remove</button>`)
        : '<div class="hint">No friends yet. Add one with their code, and they will appear on your daily leaderboard once they accept.</div>'}
    </section>`;
  if (keep.name != null) $('friendName').value = keep.name;
  if (keep.code != null) $('friendCodeInput').value = keep.code;
}

function setMessage(text, error = false) {
  message = { text, error };
  renderFriends();
}

async function onAction(evt) {
  const button = evt.target.closest('[data-act]');
  if (!button || !backend) return;
  const { act, id, name } = button.dataset;
  try {
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(profile.code); setMessage('Code copied.'); }
      catch { setMessage('Could not copy automatically. Select the code and copy it.', true); }
    } else if (act === 'rename') {
      profile.name = await backend.setName($('friendName').value);
      setMessage('Name saved.');
    } else if (act === 'add') {
      const entered = $('friendCodeInput').value;
      setMessage('Sending…');
      const who = await backend.addByCode(entered);
      $('friendCodeInput').value = '';
      setMessage('Request sent to ' + who + '. They will see it in their Friends list.');
    } else if (act === 'accept') {
      await backend.accept(id);
      setMessage('');
    } else if (act === 'remove') {
      if (name && !confirm('Remove ' + name + ' from your friends?')) return;
      await backend.remove(id);
      setMessage('');
    }
  } catch (e) {
    console.error(e);
    setMessage(e && e.message ? e.message : 'Something went wrong. Try again.', true);
  }
}

function wire() {
  if (wired) return;
  wired = true;
  $('friendsBtn').addEventListener('click', async () => {
    message = { text: '', error: false };
    $('friendsOverlay').classList.add('show');
    document.body.style.overflow = 'hidden';
    renderFriends();
    if (backend) {
      profile = await backend.profile();
      renderFriends();
    }
  });
  $('friendsBody').addEventListener('click', onAction);
  $('friendsBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'friendCodeInput') {
      e.preventDefault();
      onAction({ target: $('friendsBody').querySelector('[data-act="add"]') });
    }
  });
}

/** Called when the Play view opens. `user` is the signed-in Firebase user. */
export function showPlay(user) {
  wire();
  if (!backend || backend.uid !== user.uid) {
    resetPlay();
    backend = createGameBackend(user);
    backend.profile().then((p) => { profile = p; });
    stopFriends = backend.watchFriends(
      (list) => { friends = list; renderFriends(); },
      (e) => console.warn('could not load friends', e),
    );
  }
  if (game) return;
  game = mount($('gameHost'), {
    mode: 'endless',
    theme: 'light', // the app has no dark theme
    storage: backend.storage,
    daily: backend.daily,
  });
}

/** Called when the user leaves the Play view. Daily progress is already saved after every shot. */
export function hidePlay() {
  if (game) game.unmount();
  game = null;
}

/** Called on sign-out: drops everything tied to the user. */
export function resetPlay() {
  hidePlay();
  if (stopFriends) stopFriends();
  stopFriends = null;
  backend = null;
  friends = [];
  profile = null;
  renderBadge();
}
