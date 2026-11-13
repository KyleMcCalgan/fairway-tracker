// The Settings view: profile, what friends can see, your data (export / import),
// the account (password, sign out) and account deletion.
//
// The app (js/app.js) owns the rounds data, so it passes in the few things this
// view needs through `initSettings`:
//   exportBackup()        downloads the backup file
//   prepareImport(file)   reads a backup and returns { file, summary, commit }
//   beforeDelete()        stop anything that writes to the account (listeners, publishing)
//   afterDeleteFailed()   undo that if deleting did not go through
//   toast(text)

import * as fb from './firebase.js';
import { subscribeProfile, getProfile, getPrivacy, isPrivacyReady, savePrivacy, renameSelf } from './social.js';
import { PRIVACY_KEYS, PRIVACY_LABELS } from './profile.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let host = null;
let wired = false;
let pendingImport = null;
let nameDirty = false;

function say(id, text, kind = '') {
  const box = $(id);
  box.textContent = text;
  box.classList.toggle('error', kind === 'error');
  box.classList.toggle('ok', kind === 'ok');
}

// Disables a button while its action runs and shows `label` on it, then puts the original text back.
function busy(button, on, label) {
  if (on) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    if (label) button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = on;
}

/* ---------------------------------------------------------------- render */

function renderPrivacy() {
  const box = $('privacyList');
  const privacy = getPrivacy();
  if (!box.firstChild) {
    box.innerHTML = PRIVACY_KEYS.map(
      (key) => `<label class="toggle"><input type="checkbox" data-privacy="${key}" /><span><strong>${esc(PRIVACY_LABELS[key][0])}</strong><div class="hint">${esc(PRIVACY_LABELS[key][1])}</div></span></label>`,
    ).join('');
  }
  box.querySelectorAll('[data-privacy]').forEach((input) => {
    input.checked = privacy[input.dataset.privacy];
    input.disabled = !isPrivacyReady();
  });
}

export function renderSettings() {
  const profile = getProfile();
  if (!nameDirty && document.activeElement !== $('setName')) $('setName').value = profile ? profile.name : '';
  $('nameSave').disabled = !profile;
  $('setCode').textContent = profile ? profile.code || 'Unavailable' : '…';
  $('copyCode').disabled = !(profile && profile.code);
  renderPrivacy();

  const info = fb.accountInfo();
  if (info) {
    $('accountLine').textContent =
      'Signed in as ' + info.email + (info.hasPassword ? ' with email and password.' : info.hasGoogle ? ' with Google.' : '.');
    $('pwForm').hidden = !info.hasPassword;
    $('googleNote').hidden = info.hasPassword;
    $('deletePwField').hidden = !info.hasPassword;
  }
}

/* --------------------------------------------------------------- profile */

async function onSaveName(evt) {
  evt.preventDefault();
  const name = $('setName').value.trim();
  if (!name) return say('nameMsg', 'Enter a name.', 'error');
  busy($('nameSave'), true, 'Saving…');
  try {
    await renameSelf(name);
    nameDirty = false;
    say('nameMsg', 'Saved. Friends will see the new name shortly.', 'ok');
  } catch (error) {
    console.error(error);
    say('nameMsg', error && error.message ? error.message : 'Could not save your name.', 'error');
  } finally {
    busy($('nameSave'), false);
  }
}

async function onCopyCode() {
  const code = (getProfile() || {}).code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    host.toast('Friend code copied');
  } catch {
    say('nameMsg', 'Could not copy automatically. Select the code and copy it.', 'error');
  }
}

function onPrivacy(evt) {
  const input = evt.target.closest('[data-privacy]');
  if (!input) return;
  const key = input.dataset.privacy;
  savePrivacy({ [key]: input.checked }).catch((error) => {
    console.error(error);
    savePrivacy({ [key]: !input.checked }).catch((e) => console.warn('could not restore sharing choice', e));
    host.toast('Could not save that choice. Check your connection.');
  });
  host.toast(input.checked ? PRIVACY_LABELS[key][0] + ' is visible to friends' : PRIVACY_LABELS[key][0] + ' is now hidden');
}

/* ------------------------------------------------------------------ data */

function renderImportPreview() {
  const box = $('importPreview');
  if (!pendingImport) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const { file, summary: s } = pendingImport;
  const rounds = `${s.rounds} ${s.rounds === 1 ? 'round' : 'rounds'}` +
    (s.overwritten ? ` (${s.newRounds} new, ${s.overwritten} will replace rounds you already have)` : ' (all new)');
  const courses = `${s.courses} ${s.courses === 1 ? 'course' : 'courses'}` +
    (s.newCourses ? `, ${s.newCourses} new to the shared catalogue` : ', all already in the catalogue');
  box.innerHTML = `
    <div class="import-title">Ready to import <strong>${esc(file)}</strong></div>
    <ul>
      <li>${esc(rounds)}</li>
      <li>${esc(courses)}</li>
      ${s.skipped ? `<li>${s.skipped} ${s.skipped === 1 ? 'round' : 'rounds'} skipped: no usable course name</li>` : ''}
      <li>Your handicap calculation settings will be set to the ones in the file</li>
    </ul>
    <div class="hint">Nothing of yours is deleted. Rounds with the same ID are replaced.</div>
    <div class="set-actions">
      <button class="btn primary" type="button" id="importConfirm">Import</button>
      <button class="btn" type="button" id="importCancel">Cancel</button>
    </div>`;
  box.hidden = false;
  $('importConfirm').onclick = onConfirmImport;
  $('importCancel').onclick = () => {
    pendingImport = null;
    renderImportPreview();
    say('dataMsg', '');
  };
}

async function onPickFile(evt) {
  const file = evt.target.files[0];
  evt.target.value = '';
  if (!file) return;
  say('dataMsg', 'Reading ' + file.name + '…');
  try {
    pendingImport = await host.prepareImport(file);
    say('dataMsg', '');
  } catch (error) {
    pendingImport = null;
    say('dataMsg', 'Could not import that file: ' + (error && error.message ? error.message : error), 'error');
  }
  renderImportPreview();
}

async function onConfirmImport() {
  const pending = pendingImport;
  if (!pending) return;
  busy($('importConfirm'), true, 'Importing…');
  $('importCancel').disabled = true;
  try {
    await pending.commit();
    pendingImport = null;
    renderImportPreview();
    say('dataMsg', `Imported ${pending.summary.rounds} ${pending.summary.rounds === 1 ? 'round' : 'rounds'}.`, 'ok');
    host.toast('Backup imported');
  } catch (error) {
    console.error(error);
    busy($('importConfirm'), false);
    $('importCancel').disabled = false;
    say('dataMsg', 'Could not import: ' + fb.describeError(error), 'error');
  }
}

/* --------------------------------------------------------------- account */

async function onChangePassword(evt) {
  evt.preventDefault();
  const current = $('pwCurrent').value;
  const next = $('pwNew').value;
  if (!current) return say('pwMsg', 'Enter your current password.', 'error');
  if (next.length < 6) return say('pwMsg', 'Choose a new password of at least 6 characters.', 'error');
  if (next !== $('pwConfirm').value) return say('pwMsg', 'The new passwords do not match.', 'error');
  if (next === current) return say('pwMsg', 'Your new password is the same as the current one.', 'error');
  busy($('pwSave'), true, 'Updating…');
  try {
    await fb.changePassword(current, next);
    $('pwForm').reset();
    say('pwMsg', 'Password updated.', 'ok');
  } catch (error) {
    say('pwMsg', fb.describeError(error), 'error');
  } finally {
    busy($('pwSave'), false);
  }
}

function syncDeleteButton() {
  $('deleteBtn').disabled = $('deleteConfirm').value.trim().toUpperCase() !== 'DELETE';
}

async function onDelete(evt) {
  evt.preventDefault();
  if ($('deleteBtn').disabled) return;
  const info = fb.accountInfo();
  if (info && info.hasPassword && !$('deletePassword').value) return say('deleteMsg', 'Enter your password to confirm.', 'error');
  busy($('deleteBtn'), true, 'Deleting…');
  say('deleteMsg', '');
  try {
    // Prove who you are first, so a failure here happens before anything is deleted.
    await fb.reauthenticate($('deletePassword').value);
  } catch (error) {
    busy($('deleteBtn'), false);
    syncDeleteButton();
    return say('deleteMsg', fb.describeError(error), 'error');
  }
  host.beforeDelete();
  try {
    await fb.deleteAccount(); // signing out follows automatically
  } catch (error) {
    console.error(error);
    host.afterDeleteFailed();
    busy($('deleteBtn'), false);
    syncDeleteButton();
    say('deleteMsg', 'Could not delete your account: ' + fb.describeError(error), 'error');
  }
}

/* ------------------------------------------------------------------ wire */

export function initSettings(callbacks) {
  host = callbacks;
  if (wired) return;
  wired = true;
  $('nameForm').addEventListener('submit', onSaveName);
  $('setName').addEventListener('input', () => (nameDirty = true));
  $('copyCode').addEventListener('click', onCopyCode);
  $('privacyList').addEventListener('change', onPrivacy);
  $('exportBtn').addEventListener('click', () => host.exportBackup());
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', onPickFile);
  $('pwForm').addEventListener('submit', onChangePassword);
  $('settingsSignOut').addEventListener('click', () => fb.logOut());
  $('deleteConfirm').addEventListener('input', syncDeleteButton);
  $('deleteForm').addEventListener('submit', onDelete);
  subscribeProfile(renderSettings);
}

/** Called when the view is opened or the user changes, so nothing from a previous account lingers. */
export function resetSettings() {
  pendingImport = null;
  nameDirty = false;
  renderImportPreview();
  $('deleteForm').reset();
  $('pwForm').reset();
  ['nameMsg', 'dataMsg', 'pwMsg', 'deleteMsg'].forEach((id) => say(id, ''));
  syncDeleteButton();
}
