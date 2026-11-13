// The "Play" view: mounts Handi Golf (js/game) with Firestore-backed adapters.
// The game itself knows nothing about Firebase; see js/game-firebase.js for the
// data layer and docs/game.md for the game. Friends are managed on the Friends
// page (js/friends.js); this view only shows a button that opens it.

import { mount } from './game/index.js';
import { startSocial, subscribeFriends } from './social.js?v=20261113-2';

const $ = (id) => document.getElementById(id);

let game = null; // the mounted game, only while the Play view is open
let stopWatching = null;
let button = null; // lives in the game's header, so it is rebuilt on every mount
let badge = null;
let incoming = 0;

function renderBadge() {
  if (!badge) return;
  badge.hidden = incoming === 0;
  badge.textContent = String(incoming);
}

function makeFriendsButton(openFriends) {
  badge = document.createElement('span');
  badge.className = 'hg-badge';
  badge.hidden = true;
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'hg-btn hg-small';
  button.append('Friends', badge);
  button.addEventListener('click', () => openFriends && openFriends());
  renderBadge();
  return button;
}

/** Called when the Play view opens. `user` is the signed-in Firebase user. */
export function showPlay(user, { openFriends } = {}) {
  if (game) return;
  const backend = startSocial(user);
  stopWatching = subscribeFriends((list) => {
    incoming = list.filter((f) => f.status === 'incoming').length;
    renderBadge();
  });
  game = mount($('gameHost'), {
    mode: 'daily',
    theme: 'light', // the app has no dark theme
    headerExtras: [makeFriendsButton(openFriends)],
    storage: backend.storage,
    daily: backend.daily,
  });
}

/** Called when the user leaves the Play view. Daily progress is already saved after every shot. */
export function hidePlay() {
  if (game) game.unmount();
  game = null;
  if (stopWatching) stopWatching();
  stopWatching = null;
  button = badge = null;
}

/** Called on sign-out. */
export function resetPlay() {
  hidePlay();
  incoming = 0;
}
