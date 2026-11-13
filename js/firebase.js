/**
 * Firebase data layer: authentication plus every Firestore read and write.
 * Nothing else in the app talks to Firebase directly.
 *
 * Data model
 *   courses/{courseId}                 shared catalogue, readable by every signed-in user
 *                                      name, createdBy, createdAt, rating?, slope?
 *   users/{uid}                        one user's settings
 *   users/{uid}/rounds/{roundId}       one user's rounds (courseId points into courses/)
 *   users/{uid}/myCourses/{courseId}   courses on the user's list, with optional
 *                                      personal rating/slope that override the shared ones
 *
 * courseId is the course name lower-cased with everything except letters and digits
 * removed ("Royal Durban Golf Club" -> "royaldurbangolfclub"), so a course can only
 * ever exist once in the catalogue.
 */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  collection,
  onSnapshot,
  writeBatch,
  deleteDoc,
  serverTimestamp,
  deleteField,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ---------------------------------------------------------------- setup */

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

/** False until js/firebase-config.js has been filled in. */
export const configured = REQUIRED_KEYS.every(
  (key) => firebaseConfig[key] && !String(firebaseConfig[key]).startsWith('PASTE_'),
);

let auth = null;
let db = null;

if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    // Keeps data on the device so the app opens instantly and works offline.
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (error) {
    console.warn('Offline cache unavailable, using in-memory cache', error);
    db = getFirestore(app);
  }
}

/* ----------------------------------------------------------------- auth */

export const onUser = (callback) => onAuthStateChanged(auth, callback);
export const signInWithGoogle = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signInWithEmail = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const createAccount = (email, password) => createUserWithEmailAndPassword(auth, email, password);
export const sendReset = (email) => sendPasswordResetEmail(auth, email);
export const logOut = () => signOut(auth);

const ERROR_MESSAGES = {
  'auth/invalid-credential': 'That email and password do not match an account.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/email-already-in-use': 'An account with that email already exists. Try signing in instead.',
  'auth/weak-password': 'Choose a password of at least 6 characters.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/popup-closed-by-user': 'Sign-in was cancelled.',
  'auth/cancelled-popup-request': 'Sign-in was cancelled.',
  'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups for this site and try again.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
  'auth/unauthorized-domain':
    'This site address is not authorised in Firebase (Authentication → Settings → Authorized domains).',
  'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase yet.',
  'permission-denied':
    'Permission denied. The Firestore security rules may not be published yet (see the README).',
};

/** Turns a Firebase error into a message a person can act on. */
export const describeError = (error) =>
  ERROR_MESSAGES[error?.code] || error?.message || 'Something went wrong. Please try again.';

/* ------------------------------------------------------------ documents */

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const withValues = (target, { rating, slope }) => {
  if (isNumber(rating) && isNumber(slope)) Object.assign(target, { rating, slope });
  return target;
};

const courseRef = (id) => doc(db, 'courses', id);
const myCourseRef = (uid, id) => doc(db, 'users', uid, 'myCourses', id);
const roundRef = (uid, id) => doc(db, 'users', uid, 'rounds', id);
const settingsRef = (uid) => doc(db, 'users', uid);

const newCourseDoc = (uid, course) =>
  withValues({ name: course.name, createdBy: uid, createdAt: serverTimestamp() }, course);

const roundDoc = (round) => ({
  date: round.date,
  courseId: round.courseId,
  score: round.score,
  par: round.par,
  qualifying: round.qualifying,
  notes: round.notes,
});

const settingsDoc = (settings) => ({
  useCourseRatings: settings.useCourseRatings,
  useCustomSelection: settings.useCustomSelection,
  customBestCount: settings.customBestCount,
  customWindowCount: settings.customWindowCount,
});

/** Clears a personal override so the shared values apply again. */
const CLEAR_VALUES = { rating: deleteField(), slope: deleteField() };

/* ---------------------------------------------------------------- reads */

/**
 * Subscribes to everything the app needs. Each handler is called with fresh data
 * immediately (from the local cache) and again whenever anything changes.
 * Returns a function that stops all four listeners.
 */
export function watchUserData(uid, { settings, rounds, myCourses, courses, error }) {
  const idMap = (snapshot, extra) =>
    new Map(snapshot.docs.map((d) => [d.id, { ...(extra ? { id: d.id } : {}), ...d.data() }]));
  const stops = [
    onSnapshot(settingsRef(uid), (s) => settings(s.exists() ? s.data() : {}), error),
    onSnapshot(
      collection(db, 'users', uid, 'rounds'),
      (s) => rounds(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      error,
    ),
    onSnapshot(collection(db, 'users', uid, 'myCourses'), (s) => myCourses(idMap(s)), error),
    onSnapshot(collection(db, 'courses'), (s) => courses(idMap(s, true)), error),
  ];
  return () => stops.forEach((stop) => stop());
}

/* --------------------------------------------------------------- writes
 * Writes resolve only once the server confirms them, so callers should not
 * wait on them before updating the screen: the listeners above already
 * reflect a local write instantly, even offline.
 */

export function saveSettings(uid, settings) {
  const batch = writeBatch(db);
  batch.set(settingsRef(uid), settingsDoc(settings));
  return batch.commit();
}

/** Saves a round and makes sure its course is on the user's list. */
export function saveRound(uid, round, addCourseToList) {
  const batch = writeBatch(db);
  batch.set(roundRef(uid, round.id), roundDoc(round));
  if (addCourseToList) batch.set(myCourseRef(uid, round.courseId), {}, { merge: true });
  return batch.commit();
}

export const deleteRound = (uid, id) => deleteDoc(roundRef(uid, id));

/** Adds a brand-new course to the shared catalogue and to the user's list. */
export function createCourse(uid, course) {
  const batch = writeBatch(db);
  batch.set(courseRef(course.id), newCourseDoc(uid, course));
  batch.set(myCourseRef(uid, course.id), {}, { merge: true });
  return batch.commit();
}

/** Puts an existing catalogue course on the user's list. */
export const addToMyCourses = (uid, id) => setMerge(myCourseRef(uid, id), {});

export const removeFromMyCourses = (uid, id) => deleteDoc(myCourseRef(uid, id));

export const clearCourseValues = (uid, id) => setMerge(myCourseRef(uid, id), CLEAR_VALUES);

/**
 * Saves rating/slope the user typed for a course.
 *  - If the shared course has no values yet, they become the shared values.
 *  - If they match the shared values, any personal override is cleared.
 *  - Otherwise they are stored as this user's personal override.
 */
export function saveCourseValues(uid, id, { rating, slope, shared }) {
  const batch = writeBatch(db);
  const sharedKnown = isNumber(shared?.rating) && isNumber(shared?.slope);
  if (!sharedKnown) {
    batch.update(courseRef(id), { rating, slope });
    batch.set(myCourseRef(uid, id), CLEAR_VALUES, { merge: true });
  } else if (shared.rating === rating && shared.slope === slope) {
    batch.set(myCourseRef(uid, id), CLEAR_VALUES, { merge: true });
  } else {
    batch.set(myCourseRef(uid, id), { rating, slope }, { merge: true });
  }
  return batch.commit();
}

/**
 * Writes an imported backup in one go (in chunks, because a Firestore batch is
 * limited to 500 operations). The plan is prepared by the app:
 *   { newCourses, fillShared, myCourses, rounds, settings }
 */
export async function importPlan(uid, plan) {
  const operations = [
    ...plan.newCourses.map((c) => (batch) => batch.set(courseRef(c.id), newCourseDoc(uid, c))),
    ...plan.fillShared.map(
      (c) => (batch) => batch.update(courseRef(c.id), { rating: c.rating, slope: c.slope }),
    ),
    ...plan.myCourses.map(
      (c) => (batch) => batch.set(myCourseRef(uid, c.id), withValues({}, c), { merge: true }),
    ),
    ...plan.rounds.map((r) => (batch) => batch.set(roundRef(uid, r.id), roundDoc(r))),
    (batch) => batch.set(settingsRef(uid), settingsDoc(plan.settings)),
  ];
  const CHUNK = 400;
  for (let i = 0; i < operations.length; i += CHUNK) {
    const batch = writeBatch(db);
    operations.slice(i, i + CHUNK).forEach((apply) => apply(batch));
    await batch.commit();
  }
}

function setMerge(ref, data) {
  const batch = writeBatch(db);
  batch.set(ref, data, { merge: true });
  return batch.commit();
}
