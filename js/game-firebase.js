// Firestore-backed adapters for Handi Golf (docs/game.md, "Integration seam").
//
// The game itself never imports Firebase; this module is the host's side of the
// seam. It also holds the friends logic used by the Play view's Friends dialog.
//
//   users/{uid}/game/{lifetime|settings|profile|privacy}   private to the player
//   sharedStats/{uid}                              what the player shows friends (js/profile.js)
//   friendCodes/{code}                             { uid, name }; read by exact code only
//   friendships/{uidA_uidB}                        { users, requestedBy, status, names }
//   dailyScores/{date_uid}                         one result per player per day, create-only
//   dailyStats/{date}                              { n, b<total>: count } for the percentile
//
// The Daily draft (the round in progress) stays in this browser's localStorage:
// it changes after every shot, and Daily is an honour-system game anyway.

import { getDb } from './firebase.js';
import { normalizePrivacy, nameSearchKey } from './profile.js';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  increment,
  orderBy,
  startAt,
  endAt,
  limit,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const SUBMIT_WAIT_MS = 8000; // a write only resolves once the server confirms it; offline never does

export const pairId = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
export const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24);
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// Firestore rejects `undefined`; a JSON round trip also drops anything exotic.
const plain = (x) => JSON.parse(JSON.stringify(x));

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);

export function createGameBackend(user) {
  const db = getDb();
  const uid = user.uid;
  const fallbackName = cleanName(user.displayName || (user.email || '').split('@')[0]) || 'Golfer';
  const gameDoc = (id) => doc(db, 'users', uid, 'game', id);
  const draftKey = (date) => 'handi.game.daily.draft.' + date + '.' + uid;

  /* ------------------------------------------------------------ profile */

  let profileP = null;
  // Loads (or creates) { name, code }. The code is how friends find you.
  function profile() {
    if (!profileP) {
      profileP = (async () => {
        try {
          const snap = await getDoc(gameDoc('profile'));
          if (snap.exists() && snap.data().code) return snap.data();
        } catch (e) {
          console.warn('could not read the game profile', e);
          return { name: fallbackName, code: null };
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          const code = newCode();
          const data = { name: fallbackName, code };
          try {
            const batch = writeBatch(db);
            batch.set(doc(db, 'friendCodes', code), { uid, name: data.name });
            batch.set(gameDoc('profile'), data);
            await batch.commit();
            return data;
          } catch (e) {
            console.warn('friend code attempt failed', e);
          }
        }
        return { name: fallbackName, code: null };
      })();
    }
    return profileP;
  }

  async function setName(name) {
    const clean = cleanName(name);
    if (!clean) throw new Error('Enter a name.');
    const p = await profile();
    if (!p.code) throw new Error('Your profile is not ready yet. Try again in a moment.');
    const batch = writeBatch(db);
    batch.update(doc(db, 'friendCodes', p.code), { name: clean });
    batch.set(gameDoc('profile'), { name: clean, code: p.code });
    batch.set(doc(db, 'playerDirectory', uid), { name: clean, nameLower: nameSearchKey(clean) });
    await batch.commit();
    p.name = clean;
    return clean;
  }

  /* ------------------------------------------------------------ storage */

  const storage = {
    async loadLifetime() {
      const s = await getDoc(gameDoc('lifetime'));
      return s.exists() ? s.data() : null;
    },
    saveLifetime(stats) {
      // Not awaited: the write completes in the background (and offline).
      setDoc(gameDoc('lifetime'), plain(stats)).catch((e) => console.warn('could not save game stats', e));
    },
    async loadSettings() {
      const s = await getDoc(gameDoc('settings'));
      return s.exists() ? s.data() : null;
    },
    saveSettings(settings) {
      setDoc(gameDoc('settings'), plain(settings)).catch((e) => console.warn('could not save game settings', e));
    },
    loadDailyDraft(date) {
      try { return JSON.parse(localStorage.getItem(draftKey(date))); } catch { return null; }
    },
    saveDailyDraft(date, draft) {
      try { localStorage.setItem(draftKey(date), JSON.stringify(draft)); } catch { /* storage full or blocked */ }
    },
  };

  /* -------------------------------------------------------------- daily */

  const scoreRef = (date, who) => doc(db, 'dailyScores', date + '_' + who);
  const fromScore = (data) => ({
    ...data,
    createdAt: data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : Date.now(),
  });

  // Accepted friends: [{ uid, name }].
  async function acceptedFriends() {
    const snap = await getDocs(query(collection(db, 'friendships'), where('users', 'array-contains', uid)));
    return snap.docs
      .map((d) => d.data())
      .filter((f) => f.status === 'accepted')
      .map((f) => {
        const other = f.users.find((u) => u !== uid);
        return { uid: other, name: (f.names && f.names[other]) || 'Friend' };
      });
  }

  const daily = {
    uid,
    getToday: () => new Date().toISOString().slice(0, 10),
    emptyFriendsNote: 'No friends yet. Use the Friends button above the game to add some with a friend code.',

    // The player's stored result for a date, or null. Lets a second device show
    // the result instead of offering another attempt.
    async fetchMine(date) {
      try {
        const s = await getDoc(scoreRef(date, uid));
        return s.exists() ? fromScore(s.data()) : null;
      } catch (e) {
        console.warn('could not check for a stored daily result', e);
        return null;
      }
    },

    // Create-only: if a result already exists, it is returned unchanged.
    async submit(result) {
      const existing = await daily.fetchMine(result.date);
      if (existing) return existing;
      const p = await profile();
      const penalties = result.holes.reduce((n, x) => n + x.penalties, 0);
      const data = plain({
        date: result.date,
        uid,
        name: p.name,
        genVersion: result.genVersion,
        holes: result.holes,
        total: result.total,
        penalties,
      });
      const batch = writeBatch(db);
      batch.set(scoreRef(result.date, uid), { ...data, createdAt: serverTimestamp() });
      batch.set(
        doc(db, 'dailyStats', result.date),
        { n: increment(1), ['b' + result.total]: increment(1) },
        { merge: true },
      );
      const outcome = await withTimeout(batch.commit(), SUBMIT_WAIT_MS);
      if (outcome === 'timeout') console.warn('daily result is queued and will upload when the connection returns');
      return { ...data, createdAt: Date.now() };
    },

    // Your row plus one per accepted friend (friends who have not played have total: null).
    async fetchLeaderboard(date) {
      const me = await profile();
      const [mine, friends] = await Promise.all([daily.fetchMine(date), acceptedFriends()]);
      const rows = [{
        uid,
        name: me.name,
        isYou: true,
        total: mine ? mine.total : null,
        penalties: mine ? mine.penalties || 0 : 0,
        createdAt: mine ? mine.createdAt : null,
      }];
      const theirs = await Promise.all(friends.map(async (f) => {
        try {
          const s = await getDoc(scoreRef(date, f.uid));
          if (s.exists()) {
            const d = fromScore(s.data());
            return { uid: f.uid, name: d.name || f.name, isYou: false, total: d.total, penalties: d.penalties || 0, createdAt: d.createdAt };
          }
        } catch (e) {
          console.warn('could not read a friend score', e);
        }
        return { uid: f.uid, name: f.name, isYou: false, total: null, penalties: 0, createdAt: null };
      }));
      return rows.concat(theirs);
    },

    // Histogram of everyone's totals for the day: { n, counts: { total: players } }.
    async fetchGlobal(date) {
      const s = await getDoc(doc(db, 'dailyStats', date));
      if (!s.exists()) return { n: 0, counts: {} };
      const counts = {};
      let n = 0;
      for (const [k, v] of Object.entries(s.data())) {
        if (k[0] === 'b' && Number.isInteger(v) && v > 0) {
          counts[Number(k.slice(1))] = v;
          n += v;
        }
      }
      return { n, counts };
    },
  };

  /* ------------------------------------------------------------ friends */

  // Calls back with [{ id, uid, name, status: 'friend' | 'incoming' | 'outgoing' }] on every change.
  function watchFriends(callback, onError) {
    return onSnapshot(
      query(collection(db, 'friendships'), where('users', 'array-contains', uid)),
      (snap) => {
        const list = snap.docs.map((d) => {
          const f = d.data();
          const other = f.users.find((u) => u !== uid);
          const status = f.status === 'accepted' ? 'friend' : f.requestedBy === uid ? 'outgoing' : 'incoming';
          return { id: d.id, uid: other, name: (f.names && f.names[other]) || 'Friend', status };
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        callback(list);
      },
      onError,
    );
  }

  async function addPlayer(other) {
    const me = await profile();
    if (other.uid === uid) throw new Error('You cannot add yourself.');
    const id = pairId(uid, other.uid);
    // A direct read of a missing friendship is denied by the rules because it
    // has no users field. Query our own friendships instead.
    const matches = await getDocs(query(collection(db, 'friendships'), where('users', 'array-contains', uid)));
    const existing = matches.docs.find((d) => d.id === id);
    if (existing) {
      const f = existing.data();
      throw new Error(
        f.status === 'accepted' ? other.name + ' is already your friend.'
          : f.requestedBy === uid ? 'You already sent ' + other.name + ' a request.'
            : other.name + ' already sent you a request. Accept it in the list below.',
      );
    }
    const users = [uid, other.uid].sort();
    await setDoc(doc(db, 'friendships', id), {
      users,
      requestedBy: uid,
      status: 'pending',
      names: { [uid]: me.name, [other.uid]: other.name },
    });
    return other.name;
  }

  async function addByCode(rawCode) {
    const code = cleanCode(rawCode);
    if (code.length !== 8) throw new Error('A friend code is 8 letters and numbers.');
    const found = await getDoc(doc(db, 'friendCodes', code));
    if (!found.exists()) throw new Error('No player has that code. Check it and try again.');
    return addPlayer(found.data());
  }

  const directoryRef = (who) => doc(db, 'playerDirectory', who);
  async function searchPlayers(term) {
    const key = nameSearchKey(term);
    if (key.length < 2) throw new Error('Enter at least 2 characters to search.');
    const results = await getDocs(query(collection(db, 'playerDirectory'), orderBy('nameLower'), startAt(key), endAt(key + '\uf8ff'), limit(20)));
    return results.docs.filter((d) => d.id !== uid).map((d) => ({ uid: d.id, name: d.data().name }));
  }
  async function addByUser(otherUid) {
    const found = await getDoc(directoryRef(otherUid));
    if (!found.exists()) throw new Error('This player is no longer searchable.');
    return addPlayer({ uid: found.id, name: found.data().name });
  }
  const publishDirectory = (name) => setDoc(directoryRef(uid), { name, nameLower: nameSearchKey(name) });

  const accept = (id) => updateDoc(doc(db, 'friendships', id), { status: 'accepted' });
  const remove = (id) => deleteDoc(doc(db, 'friendships', id));

  /* ------------------------------------------------- sharing with friends */

  const sharedRef = (who) => doc(db, 'sharedStats', who);

  // What this player lets friends see (js/profile.js). Everything is on until switched off.
  async function loadPrivacy() {
    const s = await getDoc(gameDoc('privacy'));
    return normalizePrivacy(s.exists() ? s.data() : null);
  }
  const savePrivacy = (privacy) => setDoc(gameDoc('privacy'), normalizePrivacy(privacy));

  // Replaces the whole summary: anything not in `summary` stops being visible to friends.
  const publishShared = (summary) =>
    setDoc(sharedRef(uid), { ...plain(summary), updatedAt: serverTimestamp() });

  // A friend's summary, or null if they have not published one (or you may not read it).
  async function fetchShared(friendUid) {
    try {
      const s = await getDoc(sharedRef(friendUid));
      if (!s.exists()) return null;
      const d = s.data();
      return { ...d, updatedAtMs: d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : null };
    } catch (e) {
      console.warn('could not read a friend profile', e);
      return null;
    }
  }

  // Lifetime Handi Golf stats; fires again whenever the game saves them.
  const watchLifetime = (callback, onError) =>
    onSnapshot(gameDoc('lifetime'), (s) => callback(s.exists() ? s.data() : null), onError);

  return {
    uid, storage, daily, profile, setName, watchFriends, addByCode, searchPlayers, addByUser, publishDirectory, accept, remove,
    loadPrivacy, savePrivacy, publishShared, fetchShared, watchLifetime,
  };
}
