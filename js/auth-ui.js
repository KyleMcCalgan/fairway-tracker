// The sign-in screen: Sign in / Create account / Forgot password / Google.
// Everything Firebase-specific stays in js/firebase.js; this file only drives the screen.
//
//   showAuth(state, message)  'setup' | 'loading' | 'error' | 'signedOut'
//   showApp()                 hides the sign-in screen and shows the app
//   initAuth()                wires the form once, at start-up

import * as fb from './firebase.js';
import { holeArt } from './auth-art.js';

const $ = (id) => document.getElementById(id);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COPY = {
  signin: {
    title: 'Welcome back',
    sub: 'Sign in to see your rounds, courses and handicap on any device.',
    submit: 'Sign in',
    busy: 'Signing in…',
  },
  signup: {
    title: 'Create your account',
    sub: 'Free, and your rounds are saved so they are there on every device.',
    submit: 'Create account',
    busy: 'Creating account…',
  },
};

let mode = 'signin';
let busy = false;

/* ------------------------------------------------------------ messages */

function setFormError(message, ok = false) {
  $('authError').textContent = message;
  $('authError').classList.toggle('ok', ok);
}

function setFieldError(field, message) {
  const input = $(field === 'email' ? 'authEmail' : 'authPassword');
  const box = $(field === 'email' ? 'authEmailError' : 'authPasswordError');
  box.textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  // The "at least 6 characters" hint would only repeat the error, so it steps aside.
  if (field === 'password') $('authPasswordHint').hidden = mode !== 'signup' || Boolean(message);
}

function clearErrors() {
  setFormError('');
  setFieldError('email', '');
  setFieldError('password', '');
}

function validEmail() {
  const value = $('authEmail').value.trim();
  if (!value) return setFieldError('email', 'Enter your email address.'), false;
  if (!EMAIL.test(value)) return setFieldError('email', 'That does not look like an email address.'), false;
  setFieldError('email', '');
  return true;
}

function validPassword() {
  const value = $('authPassword').value;
  if (!value) return setFieldError('password', 'Enter your password.'), false;
  if (mode === 'signup' && value.length < 6) {
    return setFieldError('password', 'Use at least 6 characters.'), false;
  }
  setFieldError('password', '');
  return true;
}

/* ---------------------------------------------------------------- modes */

function setMode(next) {
  mode = next;
  const copy = COPY[mode];
  document.querySelectorAll('[data-auth-mode]').forEach((b) => {
    const on = b.dataset.authMode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('authTitle').textContent = copy.title;
  $('authSub').textContent = copy.sub;
  $('authSubmitText').textContent = copy.submit;
  $('authPassword').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('authForgot').hidden = mode !== 'signin';
  $('authPasswordHint').hidden = mode !== 'signup';
  clearErrors();
}

function setBusy(on) {
  busy = on;
  const submit = $('authSubmit');
  submit.disabled = on;
  submit.classList.toggle('is-loading', on);
  $('authGoogle').disabled = on;
  $('authForgot').disabled = on;
  $('authSubmitText').textContent = on ? COPY[mode].busy : COPY[mode].submit;
}

/* ---------------------------------------------------------------- state */

// state: 'setup' (Firebase config missing) | 'loading' | 'error' | 'signedOut'
export function showAuth(state, message = '') {
  $('authScreen').hidden = false;
  document.querySelector('.shell').hidden = true;
  $('authForms').hidden = state !== 'signedOut';
  $('authStatus').hidden = state === 'signedOut';
  $('authSignOut').hidden = state !== 'error';
  $('authSpinner').hidden = state !== 'loading';
  $('authMessage').textContent =
    state === 'setup'
      ? 'Firebase is not configured yet. Open js/firebase-config.js, paste in your Firebase web-app config and reload. The README has the full steps.'
      : state === 'loading'
        ? 'Loading your rounds…'
        : message;
  if (state === 'signedOut') {
    $('authPassword').value = '';
    setBusy(false);
  }
}

export function showApp() {
  $('authScreen').hidden = true;
  document.querySelector('.shell').hidden = false;
}

/* --------------------------------------------------------------- actions */

// Which field a Firebase error belongs to, so the message appears next to it.
const FIELD_FOR = {
  'auth/invalid-email': 'email',
  'auth/email-already-in-use': 'email',
  'auth/weak-password': 'password',
  'auth/missing-password': 'password',
};

async function run(action) {
  if (busy) return;
  clearErrors();
  setBusy(true);
  try {
    await action();
  } catch (error) {
    const field = FIELD_FOR[error && error.code];
    if (field) {
      setFieldError(field, fb.describeError(error));
      $(field === 'email' ? 'authEmail' : 'authPassword').focus();
    } else {
      setFormError(fb.describeError(error));
    }
  } finally {
    // A successful sign-in swaps the whole screen, so this only matters after a failure.
    if (!$('authForms').hidden) setBusy(false);
  }
}

function onSubmit(evt) {
  evt.preventDefault();
  const okEmail = validEmail();
  const okPassword = validPassword();
  if (!okEmail) return $('authEmail').focus();
  if (!okPassword) return $('authPassword').focus();
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  run(() => (mode === 'signin' ? fb.signInWithEmail(email, password) : fb.createAccount(email, password)));
}

function onForgot() {
  if (!validEmail()) {
    $('authEmail').focus();
    return;
  }
  const email = $('authEmail').value.trim();
  run(async () => {
    await fb.sendReset(email);
    setFormError('Password reset email sent. Check your inbox, and your spam folder.', true);
  });
}

function onPeek() {
  const input = $('authPassword');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('authPeek').textContent = show ? 'Hide' : 'Show';
  $('authPeek').setAttribute('aria-pressed', String(show));
  input.focus();
}

export function initAuth() {
  // The art is decoration: if it ever failed to build, sign-in must still work.
  try {
    $('authArt').insertAdjacentHTML('afterbegin', holeArt());
  } catch (error) {
    console.warn('could not draw the sign-in artwork', error);
  }
  document.querySelectorAll('[data-auth-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.authMode)));
  $('authForm').addEventListener('submit', onSubmit);
  $('authGoogle').onclick = () => run(() => fb.signInWithGoogle());
  $('authForgot').onclick = onForgot;
  $('authPeek').onclick = onPeek;
  $('authSignOut').onclick = () => fb.logOut();
  // Check a field once the person leaves it, then keep it honest as they fix it.
  $('authEmail').addEventListener('blur', () => $('authEmail').value && validEmail());
  $('authEmail').addEventListener('input', () => $('authEmail').getAttribute('aria-invalid') && validEmail());
  $('authPassword').addEventListener('input', () => $('authPassword').getAttribute('aria-invalid') && validPassword());
  setMode('signin');
}
