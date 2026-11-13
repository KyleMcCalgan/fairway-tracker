// The signed-in player's social state, shared by the Play, Friends and Settings
// views so there is one friends listener, one profile and one publisher.
//
//   - owns the Firestore backend for the signed-in user (js/game-firebase.js)
//   - keeps the friends list live and tells subscribers when it changes
//   - holds the player's profile (name, friend code) and sharing choices
//   - publishes "what friends can see" (sharedStats/{uid}, built by js/profile.js)
//     a couple of seconds after anything it depends on changes, and only when
//     something a friend could actually see is different
//
// No DOM in here. The views call these functions and render the results.

import { createGameBackend } from './game-firebase.js';
import { buildShared, signature, normalizePrivacy } from './profile.js';

const PUBLISH_DELAY_MS = 2000;
const SHARED_TTL_MS = 60 * 1000;

let backend = null;
let stopFriends = null;
let stopLifetime = null;
let friends = [];
let profile = null; // { name, code }
let privacy = normalizePrivacy(null);
let lifetime = null;
let input = null; // the latest { rounds, handicap, mode } from the app
let ready = { profile: false, privacy: false, lifetime: false };
let lastSignature = null;
let timer = null;
let paused = false;
const friendListeners = new Set();
const profileListeners = new Set();
const sharedCache = new Map(); // friend uid -> { data, at }

const notifyFriends = () => friendListeners.forEach((fn) => fn(friends));
const notifyProfile = () => profileListeners.forEach((fn) => fn(profile));

/** Starts (or keeps) the social state for this user. Returns the Firestore backend. */
export function startSocial(user) {
  if (backend && backend.uid === user.uid) return backend;
  stopSocial();
  backend = createGameBackend(user);
  const mine = backend;

  mine.profile().then((p) => {
    if (backend !== mine) return;
    profile = p;
    ready.profile = true;
    notifyProfile();
    schedulePublish();
  });
  mine.loadPrivacy().then((p) => {
    if (backend !== mine) return;
    privacy = p;
    ready.privacy = true;
    notifyProfile();
    schedulePublish();
  }).catch((e) => {
    // Never publish defaults when the saved privacy choices could not be read.
    console.warn('could not load sharing choices', e);
  });
  stopLifetime = mine.watchLifetime(
    (l) => {
      lifetime = l;
      ready.lifetime = true;
      schedulePublish();
    },
    (e) => console.warn('could not watch game stats', e),
  );
  stopFriends = mine.watchFriends(
    (list) => {
      friends = list;
      notifyFriends();
    },
    (e) => console.warn('could not load friends', e),
  );
  return mine;
}

/** Drops everything tied to the user (sign-out, account deletion). */
export function stopSocial() {
  if (stopFriends) stopFriends();
  if (stopLifetime) stopLifetime();
  stopFriends = stopLifetime = null;
  clearTimeout(timer);
  timer = null;
  backend = null;
  friends = [];
  profile = null;
  privacy = normalizePrivacy(null);
  lifetime = null;
  input = null;
  ready = { profile: false, privacy: false, lifetime: false };
  lastSignature = null;
  paused = false;
  sharedCache.clear();
  notifyFriends();
  notifyProfile();
}

export const getBackend = () => backend;
export const getFriends = () => friends;
export const getProfile = () => profile;
export const getPrivacy = () => privacy;
export const isPrivacyReady = () => ready.privacy;

/** Calls `fn(friends)` now and after every change. Returns an unsubscribe function. */
export function subscribeFriends(fn) {
  friendListeners.add(fn);
  fn(friends);
  return () => friendListeners.delete(fn);
}

/** Calls `fn(profile)` now and whenever the profile or sharing choices load or change. */
export function subscribeProfile(fn) {
  profileListeners.add(fn);
  fn(profile);
  return () => profileListeners.delete(fn);
}

/* ------------------------------------------------------------- publishing */

/** The app tells us its latest rounds and handicap; this is the only input from outside. */
export function updateRounds(next) {
  input = next;
  schedulePublish();
}

function schedulePublish() {
  if (paused || !backend || !input || !ready.profile || !ready.privacy || !ready.lifetime) return;
  clearTimeout(timer);
  timer = setTimeout(publish, PUBLISH_DELAY_MS);
}

async function publish() {
  timer = null;
  if (paused || !backend || !input || !profile) return;
  const doc = buildShared({
    name: profile.name,
    privacy,
    handicap: input.handicap,
    mode: input.mode,
    rounds: input.rounds,
    lifetime,
  });
  const sig = signature(doc);
  if (sig === lastSignature) return;
  const mine = backend;
  lastSignature = sig;
  try {
    await mine.publishShared(doc);
  } catch (e) {
    if (backend === mine) lastSignature = null; // try again at the next change
    console.warn('could not update what friends can see', e);
  }
}

/** Stops publishing, for example while the account is being deleted. */
export function pausePublishing() {
  paused = true;
  clearTimeout(timer);
  timer = null;
}
export function resumePublishing() {
  paused = false;
  schedulePublish();
}

/* ----------------------------------------------------------------- choices */

/**
 * Updates the sharing choices. The screen changes straight away; the returned promise settles
 * when the server confirms (it never does while offline, so do not wait on it for the UI).
 */
export function savePrivacy(patch) {
  privacy = normalizePrivacy({ ...privacy, ...patch });
  notifyProfile();
  schedulePublish();
  return backend ? backend.savePrivacy(privacy) : Promise.resolve();
}

export async function renameSelf(name) {
  if (!backend) throw new Error('You are signed out.');
  const clean = await backend.setName(name);
  if (profile) profile.name = clean;
  notifyProfile();
  schedulePublish();
  return clean;
}

/* ------------------------------------------------------------ friends' data */

/** A friend's shared summary (or null), cached for a minute. */
export async function fetchShared(friendUid, { force = false } = {}) {
  if (!backend) return null;
  const hit = sharedCache.get(friendUid);
  if (hit && !force && Date.now() - hit.at < SHARED_TTL_MS) return hit.data;
  const mine = backend;
  const data = await mine.fetchShared(friendUid);
  if (backend === mine) sharedCache.set(friendUid, { data, at: Date.now() });
  return data;
}

/** What is already cached for a friend, without a request: a summary, null (none), or undefined (not fetched). */
export const peekShared = (friendUid) => (sharedCache.has(friendUid) ? sharedCache.get(friendUid).data : undefined);

/** The signed-in player's own shared summary as friends will see it (used by the Settings preview). */
export function previewMine() {
  if (!input || !profile) return null;
  return buildShared({ name: profile.name, privacy, handicap: input.handicap, mode: input.mode, rounds: input.rounds, lifetime });
}
