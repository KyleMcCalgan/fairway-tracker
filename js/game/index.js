// Handi Golf entry point and integration seam (docs/game.md 9).
//
//   import { mount } from './js/game/index.js';
//   const game = mount(container, { mode, storage, daily });
//   game.unmount();
//
// The game never imports Firebase or anything from the host app. The host
// supplies two adapters (every method may return a value or a promise):
//
//   storage: loadLifetime() -> stats | null
//            saveLifetime(stats)
//            loadDailyDraft(date) -> draft | null
//            saveDailyDraft(date, draft)
//            loadSettings() -> settings | null      (optional)
//            saveSettings(settings)                 (optional)
//   daily:   getToday() -> 'YYYY-MM-DD' (UTC)
//            submit(result) -> stored result
//            fetchLeaderboard(date) -> [{ uid, name, isYou, total | null, penalties, createdAt }]
//
// Without a `daily` adapter only Endless mode is offered. The host page must
// also load game/game.css.

import { METER } from './constants.js';
import { h, openDialog } from './ui.js';
import { createEndless } from './modes/endless.js';
import { createDaily } from './modes/daily.js';

function memoryStorage() {
  let lifetime = null, settings = null;
  const drafts = {};
  return {
    loadLifetime: () => lifetime,
    saveLifetime: (s) => { lifetime = s; },
    loadDailyDraft: (d) => drafts[d] || null,
    saveDailyDraft: (d, s) => { drafts[d] = s; },
    loadSettings: () => settings,
    saveSettings: (s) => { settings = s; },
  };
}

export function mount(container, options = {}) {
  const storage = options.storage || memoryStorage();
  const daily = options.daily || null;
  const settings = { assist: false, latencyMs: 0 };
  let mode = null, current = null, unmounted = false;

  const tabs = {};
  const nav = h('div', { class: 'hg-tabs', role: 'group', 'aria-label': 'Game mode' });
  const addTab = (id, label) => {
    const b = h('button', { class: 'hg-btn hg-tab', type: 'button', text: label, 'aria-pressed': 'false' });
    b.addEventListener('click', () => setMode(id));
    tabs[id] = b;
    nav.append(b);
  };
  addTab('endless', 'Endless');
  if (daily) addTab('daily', 'Daily');
  const settingsBtn = h('button', { class: 'hg-btn hg-small', type: 'button', text: 'Settings' });
  const header = h('header', { class: 'hg-header' }, h('h1', { text: 'Handi Golf' }), nav, ...(options.headerExtras || []), settingsBtn);
  const body = h('div', { class: 'hg-body' });
  const root = h('div', { class: 'hg-root' }, header, body);
  if (options.theme === 'light') root.classList.add('hg-light');
  container.append(root);

  function setMode(next) {
    if (unmounted) return;
    if (next !== 'daily' || !daily) next = 'endless';
    if (next === mode) return;
    if (current) current.destroy();
    mode = next;
    for (const id of Object.keys(tabs)) tabs[id].setAttribute('aria-pressed', String(id === mode));
    const env = { storage, daily, settings, root, seed: options.seed };
    current = mode === 'daily' ? createDaily(body, env) : createEndless(body, env);
  }

  function saveSettings() {
    if (storage.saveSettings) Promise.resolve(storage.saveSettings({ ...settings })).catch(() => {});
  }

  function showSettings() {
    const assist = h('input', { type: 'checkbox', id: 'hg-assist' });
    assist.checked = settings.assist;
    assist.addEventListener('change', () => { settings.assist = assist.checked; saveSettings(); });
    const out = h('output', { for: 'hg-latency', text: settings.latencyMs + ' ms' });
    const lat = h('input', { type: 'range', id: 'hg-latency', min: '0', max: String(METER.latencyMaxMs), step: '5', value: String(settings.latencyMs) });
    lat.addEventListener('input', () => {
      settings.latencyMs = Number(lat.value);
      out.textContent = settings.latencyMs + ' ms';
      saveSettings();
    });
    openDialog(root, 'Settings', h('div', { class: 'hg-settings' },
      h('div', { class: 'hg-field' },
        h('label', { for: 'hg-assist' }, assist, ' Assist: slower meters'),
        h('p', { class: 'hg-note', text: 'Endless mode only. Daily meter speeds are the same for everyone.' })),
      h('div', { class: 'hg-field' },
        h('label', { for: 'hg-latency', text: 'Input latency calibration' }),
        h('div', { class: 'hg-range' }, lat, out),
        h('p', { class: 'hg-note', text: 'If your shots lock later than you tapped, raise this until they match. Takes effect on your next swing.' }))));
  }
  settingsBtn.addEventListener('click', showSettings);

  (async () => {
    try {
      const saved = storage.loadSettings ? await storage.loadSettings() : null;
      if (saved) {
        settings.assist = !!saved.assist;
        settings.latencyMs = Math.max(0, Math.min(METER.latencyMaxMs, Number(saved.latencyMs) || 0));
      }
    } catch (e) { console.warn('could not load settings', e); }
    setMode(options.mode);
  })();

  return {
    setMode,
    unmount() {
      unmounted = true;
      if (current) current.destroy();
      root.remove();
    },
    // For automated checks only.
    debug: { get current() { return current; }, settings },
  };
}
