import * as fb from './firebase.js';

let lastInfoTrigger = null;
let rounds = []; // derived: this user's rounds, with the course name filled in
let courseRatings = {}; // derived: courseKey(name) -> { rating, slope } (personal values win over shared)
let settings = {
  useCourseRatings: false,
  useCustomSelection: false,
  customBestCount: 8,
  customWindowCount: 20,
};
let currentView = 'dashboard';
let toastTimeout;
let modeUiInitialized = null; // the mode the estimator inputs were last set up for

// Live Firestore data (the data model is described in firebase.js)
let session = null; // { uid, email, stop }
let sessionReady = false;
let catalogue = new Map(); // courseId -> { id, name, rating?, slope? }  shared by every user
let myCourses = new Map(); // courseId -> { rating?, slope? }  this user's list + personal values
let rawRounds = []; // this user's round documents
let loaded = {};
const $ = (id) => document.getElementById(id);
const escapeHTML = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const dateShort = (d) => {
  if (!d) return '—';
  let [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
};
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const over = (r) => Number(r.score) - Number(r.par);
const signed = (n) => (n > 0 ? '+' + n : String(n));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const courseKey = (name) =>
  String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
const courseProfile = (name) => courseRatings[courseKey(name)] || null;
function courseDifferential(r) {
  let profile = courseProfile(r.course);
  if (
    !profile ||
    !Number.isFinite(Number(profile.rating)) ||
    !Number.isFinite(Number(profile.slope)) ||
    Number(profile.slope) <= 0
  )
    return null;
  let raw = ((Number(r.score) - Number(profile.rating)) * 113) / Number(profile.slope);
  return (Math.sign(raw) * Math.round(Math.abs(raw) * 10 + 1e-9)) / 10;
}
const handicapValue = (r) => (settings.useCourseRatings ? courseDifferential(r) : over(r));
const handicapValueLabel = () => (settings.useCourseRatings ? 'Differential' : 'Over par');
function compareHandicap(a, b, descending = false) {
  let av = handicapValue(a),
    bv = handicapValue(b);
  if (Number.isFinite(av) && Number.isFinite(bv)) return descending ? bv - av : av - bv;
  if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
  return Number.isFinite(av) ? -1 : 1;
}
// ---- Courses ---------------------------------------------------------------
// A course lives once in the shared catalogue. Its id is the name with everything
// except letters and digits removed, so "St. Andrew's" and "St Andrews" collide.
const STOP_WORDS = new Set([
  'golf',
  'club',
  'course',
  'country',
  'park',
  'estate',
  'resort',
  'links',
  'the',
  'and',
]);
const PROFILE_ERROR = 'Enter a Course Rating from 50 to 90 and a Slope Rating from 55 to 155.';
const courseDocId = (name) =>
  String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
const cleanCourseName = (name) =>
  String(name || '')
    .trim()
    .replace(/\s+/g, ' ');
const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const validProfile = (rating, slope) =>
  finite(rating) &&
  finite(slope) &&
  Number(rating) >= 50 &&
  Number(rating) <= 90 &&
  Number(slope) >= 55 &&
  Number(slope) <= 155;
const hasValues = (course) => validProfile(course?.rating, course?.slope);
const byName = (a, b) => a.name.localeCompare(b.name);
const findCourse = (name) => catalogue.get(courseDocId(name)) || null;
// The values a round at this course is scored with: your own if you set them, otherwise the shared ones.
function effectiveProfile(id) {
  const mine = myCourses.get(id);
  const shared = catalogue.get(id);
  const source = hasValues(mine) ? mine : hasValues(shared) ? shared : null;
  return source
    ? { rating: Number(source.rating), slope: Number(source.slope), custom: source === mine }
    : null;
}
// Courses on your list, plus any course one of your rounds points at.
function knownCourses() {
  const counts = new Map();
  rounds.forEach((r) => {
    if (r.courseId) counts.set(r.courseId, (counts.get(r.courseId) || 0) + 1);
  });
  return [...new Set([...myCourses.keys(), ...counts.keys()])]
    .map((id) =>
      catalogue.has(id)
        ? {
            id,
            key: courseKey(catalogue.get(id).name),
            name: catalogue.get(id).name,
            count: counts.get(id) || 0,
          }
        : null,
    )
    .filter(Boolean)
    .sort(byName);
}
function ratedCourses() {
  return knownCourses().filter((c) => courseProfile(c.name));
}
const uniqId = () => 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
// ---- Live data ---------------------------------------------------------------
// Turns Firestore documents into the shapes the rest of the app already works with.
function rebuild() {
  courseRatings = {};
  catalogue.forEach((course, id) => {
    const profile = effectiveProfile(id);
    if (profile) courseRatings[courseKey(course.name)] = { rating: profile.rating, slope: profile.slope };
  });
  rounds = rawRounds.map((r) => ({
    id: r.id,
    date: r.date,
    course: catalogue.get(r.courseId)?.name || '',
    courseId: r.courseId,
    score: Number(r.score),
    par: Number(r.par),
    qualifying: r.qualifying === true,
    notes: String(r.notes || ''),
  }));
}
// Renders once all four listeners have delivered their first snapshot, then on every change.
function onDataChange() {
  if (!session || !loaded.settings || !loaded.rounds || !loaded.mine || !loaded.courses) return;
  rebuild();
  if (!sessionReady) {
    sessionReady = true;
    switchView('dashboard');
    showApp();
  }
  renderAll();
}
function startSession(user) {
  if (session?.uid === user.uid) return;
  stopSession();
  session = { uid: user.uid, email: user.email || user.displayName || 'your account', stop: null };
  showAuth('loading');
  session.stop = fb.watchUserData(user.uid, {
    settings: (data) => {
      settings = normalizeSettings(data);
      loaded.settings = true;
      onDataChange();
    },
    rounds: (list) => {
      rawRounds = list;
      loaded.rounds = true;
      onDataChange();
    },
    myCourses: (map) => {
      myCourses = map;
      loaded.mine = true;
      onDataChange();
    },
    courses: (map) => {
      catalogue = map;
      loaded.courses = true;
      onDataChange();
    },
    error: (error) => {
      console.error(error);
      showAuth('error', 'We could not load your data. ' + fb.describeError(error));
    },
  });
  $('accountStatus').textContent =
    'Signed in as ' + session.email + '. Your rounds and courses are saved to your account.';
}
function stopSession() {
  session?.stop?.();
  session = null;
  sessionReady = false;
  loaded = {};
  rawRounds = [];
  rounds = [];
  catalogue = new Map();
  myCourses = new Map();
  courseRatings = {};
  settings = normalizeSettings();
  modeUiInitialized = null;
}
function endSession() {
  stopSession();
  showAuth('signedOut');
}
// Fire-and-forget: Firestore resolves a write only when the server confirms it (never, while offline),
// and the listeners above already show local writes immediately, so the UI never waits on this.
function fire(promise, what) {
  promise.catch((error) => {
    console.error(error);
    alert('Could not ' + what + ': ' + fb.describeError(error));
  });
}
function saveSettings() {
  if (session) fire(fb.saveSettings(session.uid, normalizeSettings(settings)), 'save your settings');
}
function currentBackup() {
  const ratings = {};
  knownCourses().forEach((c) => {
    const profile = effectiveProfile(c.id);
    if (profile) ratings[courseKey(c.name)] = { rating: profile.rating, slope: profile.slope };
  });
  return {
    format: 'fairway-golf-backup',
    version: 2,
    rounds: rounds.map(({ id, date, course, score, par, qualifying, notes }) => ({
      id,
      date,
      course,
      score,
      par,
      qualifying,
      notes,
    })),
    courseRatings: ratings,
    settings,
  };
}
// Works out what a backup file adds to the catalogue, to your course list and to your rounds.
function buildImportPlan(backup) {
  const plan = {
    newCourses: [],
    fillShared: [],
    myCourses: [],
    rounds: [],
    settings: backup.settings,
    skipped: 0,
  };
  const names = new Map();
  for (const r of backup.rounds) {
    const name = cleanCourseName(r.course).slice(0, 80);
    const id = courseDocId(name);
    if (!id || name.length < 2) {
      plan.skipped++;
      continue;
    }
    if (!names.has(id)) names.set(id, name);
    plan.rounds.push({
      id: String(r.id).replace(/\//g, '_').slice(0, 100),
      date: r.date,
      courseId: id,
      score: r.score,
      par: r.par,
      qualifying: r.qualifying,
      notes: r.notes.slice(0, 500),
    });
  }
  for (const [id, name] of names) {
    const profile = backup.courseRatings[courseKey(name)];
    const existing = catalogue.get(id);
    const entry = { id };
    if (!existing) {
      plan.newCourses.push(
        profile ? { id, name, rating: profile.rating, slope: profile.slope } : { id, name },
      );
    } else if (profile && !hasValues(existing)) {
      plan.fillShared.push({ id, rating: profile.rating, slope: profile.slope });
    } else if (
      profile &&
      (profile.rating !== Number(existing.rating) || profile.slope !== Number(existing.slope))
    ) {
      entry.rating = profile.rating; // differs from the shared values, so keep it as your own
      entry.slope = profile.slope;
    }
    plan.myCourses.push(entry);
  }
  return plan;
}
function validate(data) {
  if (!Array.isArray(data) || data.length > 50000) throw Error('Invalid round list');
  return data.map((r, i) => {
    if (
      !r ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
      !Number.isFinite(Number(r.score)) ||
      !Number.isFinite(Number(r.par)) ||
      Number(r.score) <= 0 ||
      Number(r.par) <= 0
    )
      throw Error('Invalid round at ' + (i + 1));
    return {
      id: String(r.id || uniqId()),
      date: r.date,
      course: String(r.course || ''),
      score: Number(r.score),
      par: Number(r.par),
      qualifying: r.qualifying === true,
      notes: String(r.notes || ''),
    };
  });
}
function validateCourseRatings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid course ratings');
  let out = {};
  for (let [key, p] of Object.entries(data)) {
    let rating = Number(p?.rating),
      slope = Number(p?.slope);
    if (
      !key ||
      !Number.isFinite(rating) ||
      rating < 50 ||
      rating > 90 ||
      !Number.isFinite(slope) ||
      slope < 55 ||
      slope > 155
    )
      throw Error('Invalid rating or slope for ' + key);
    out[courseKey(key)] = { rating, slope };
  }
  return out;
}
function normalizeSettings(raw = {}) {
  let windowCount = Number(raw?.customWindowCount),
    bestCount = Number(raw?.customBestCount);
  if (!Number.isInteger(windowCount) || windowCount < 1 || windowCount > 20) windowCount = 20;
  if (!Number.isInteger(bestCount) || bestCount < 1 || bestCount > windowCount)
    bestCount = Math.min(8, windowCount);
  return {
    useCourseRatings: raw?.useCourseRatings === true,
    useCustomSelection: raw?.useCustomSelection === true,
    customBestCount: bestCount,
    customWindowCount: windowCount,
  };
}
function validateBackup(data) {
  if (Array.isArray(data))
    return { rounds: validate(data), courseRatings: {}, settings: normalizeSettings() };
  if (!data || data.version !== 2 || !Array.isArray(data.rounds)) throw Error('Unsupported backup format');
  return {
    rounds: validate(data.rounds),
    courseRatings: validateCourseRatings(data.courseRatings || {}),
    settings: normalizeSettings(data.settings || {}),
  };
}
function ordered() {
  return [...rounds].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
function eligible() {
  return ordered().filter((r) => r.qualifying);
}
// WHS uses a score-count table until 20 differentials are available.
function selectionWindowSize() {
  return settings.useCustomSelection ? settings.customWindowCount : 20;
}
function officialCountRule(n) {
  if (n < 3) return { count: 0, adjustment: 0 };
  if (n === 3) return { count: 1, adjustment: -2 };
  if (n === 4) return { count: 1, adjustment: -1 };
  if (n === 5) return { count: 1, adjustment: 0 };
  if (n === 6) return { count: 2, adjustment: -1 };
  if (n <= 8) return { count: 2, adjustment: 0 };
  if (n <= 11) return { count: 3, adjustment: 0 };
  if (n <= 14) return { count: 4, adjustment: 0 };
  if (n <= 16) return { count: 5, adjustment: 0 };
  if (n <= 18) return { count: 6, adjustment: 0 };
  if (n === 19) return { count: 7, adjustment: 0 };
  return { count: 8, adjustment: 0 };
}
function selectionMethodText() {
  if (settings.useCustomSelection)
    return (
      'Custom selection: best ' +
      settings.customBestCount +
      ' of the latest ' +
      settings.customWindowCount +
      ' qualifying rounds.'
    );
  return 'WHS score-count schedule: 3–5 scores use the lowest 1; 6–8 use 2; 9–11 use 3; 12–14 use 4; 15–16 use 5; 17–18 use 6; 19 use 7; 20 uses 8 of the latest 20. Early-record offsets apply in Rating + Slope mode; other WHS safeguards are not included.';
}
function syncSelectionUI() {
  let enabled = settings.useCustomSelection;
  $('customSelectionToggle').checked = enabled;
  $('customSelectionFields').hidden = !enabled;
  $('customBestCount').value = settings.customBestCount;
  $('customWindowCount').value = settings.customWindowCount;
  $('selectionBadge').textContent = enabled
    ? 'Best ' + settings.customBestCount + ' of ' + settings.customWindowCount
    : 'WHS schedule';
  $('selectionSummary').textContent =
    selectionMethodText() +
    (settings.useCourseRatings
      ? ''
      : ' Over-par mode is an approximation; the official score-differential formula needs course ratings and slope.');
}
function saveCustomSelection() {
  let best = Number($('customBestCount').value),
    windowCount = Number($('customWindowCount').value),
    error = $('selectionError');
  if (
    !Number.isInteger(best) ||
    best < 1 ||
    best > 20 ||
    !Number.isInteger(windowCount) ||
    windowCount < 1 ||
    windowCount > 20 ||
    best > windowCount
  ) {
    error.textContent = 'Enter whole numbers from 1 to 20, with Best X no greater than Window Y.';
    error.hidden = false;
    return;
  }
  settings.customBestCount = best;
  settings.customWindowCount = windowCount;
  error.hidden = true;
  saveSettings();
  renderAll();
  showToast('Custom score window saved');
}
function calc(arr) {
  let windowSize = selectionWindowSize(),
    latest = arr.slice(-windowSize),
    sorted = latest
      .filter((r) => Number.isFinite(handicapValue(r)))
      .sort(
        (a, b) =>
          handicapValue(a) - handicapValue(b) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
      ),
    rule = settings.useCustomSelection
      ? { count: settings.customBestCount, adjustment: 0 }
      : officialCountRule(sorted.length),
    best = sorted.slice(0, Math.min(rule.count, sorted.length)),
    base = avg(best.map(handicapValue)),
    adjustment = settings.useCustomSelection || !settings.useCourseRatings ? 0 : rule.adjustment,
    handicap = base === null ? null : base + adjustment;
  if (!settings.useCustomSelection && sorted.length < 3) handicap = null;
  return {
    latest,
    best,
    other: sorted.slice(best.length),
    missing: latest.filter((r) => !Number.isFinite(handicapValue(r))),
    handicap,
    count: rule.count,
    recordCount: sorted.length,
    window: windowSize,
    adjustment,
  };
}
function positionInfo(arr) {
  let c = calc(arr),
    windowSize = c.window;
  return c.latest.map((r, i) => ({
    ...r,
    pos: i + 1,
    left: windowSize - c.latest.length + i + 1,
    window: windowSize,
    inBest: c.best.some((b) => b.id === r.id),
  }));
}
function simulate(n, courseName = '') {
  let a = eligible(),
    before = calc(a),
    synthetic = settings.useCourseRatings
      ? {
          id: 'simulation',
          date: '9999-12-31',
          course: courseName,
          score: Number(n),
          par: 72,
          qualifying: true,
          notes: '',
        }
      : {
          id: 'simulation',
          date: '9999-12-31',
          course: 'Simulated round',
          score: 72 + Number(n),
          par: 72,
          qualifying: true,
          notes: '',
        };
  if (settings.useCourseRatings && !Number.isFinite(courseDifferential(synthetic)))
    return {
      before,
      after: before,
      outgoing: null,
      entering: false,
      delta: null,
      exitingBest: [],
      newBest: [],
      invalid: true,
    };
  let windowSize = selectionWindowSize(),
    outgoing = a.length >= windowSize ? a[a.length - windowSize] : null,
    after = calc([...a, synthetic]),
    delta = before.handicap === null || after.handicap === null ? null : after.handicap - before.handicap;
  return {
    before,
    after,
    outgoing,
    entering: after.best.some((x) => x.id === 'simulation'),
    delta,
    exitingBest: before.best.filter((x) => !after.best.some((y) => y.id === x.id)),
    newBest: after.best.filter((x) => !before.best.some((y) => y.id === x.id)),
    invalid: false,
  };
}
function infoButtonMarkup(title, text, kind = '') {
  return `<button class="info-trigger" type="button" data-info="true" data-info-title="${escapeHTML(title)}" data-info-text="${escapeHTML(text)}" ${kind ? `data-info-kind="${escapeHTML(kind)}"` : ''} aria-label="More information about ${escapeHTML(title)}" title="More information">i</button>`;
}
function metric(k, v, foot, featured = false) {
  return `<div class="card ${featured ? 'highlight' : ''}"><div class="card-head"><div class="k">${escapeHTML(k)}</div>${infoButtonMarkup(k, foot)}</div><div class="v">${v}</div></div>`;
}
function setupPanelInfo() {
  document.querySelectorAll('.panel').forEach((panel) => {
    let head = panel.querySelector(':scope > .panel-head');
    if (!head || head.querySelector('[data-info]')) return;
    let title = head.querySelector('h2')?.textContent.trim() || 'More information',
      parts = [],
      sourceId = '',
      kind = panel.classList.contains('mode-panel')
        ? 'handicapMode'
        : panel.classList.contains('selection-panel')
          ? 'scoreSelection'
          : panel.classList.contains('scenario-panel')
            ? 'scenario'
            : '';
    head.querySelectorAll('p').forEach((p) => {
      let text = p.textContent.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      if (p.id) {
        p.hidden = true;
        sourceId = p.id;
      } else p.remove();
    });
    for (let el of [...panel.children])
      if (
        el !== head &&
        el.matches('p,.hint,.note,.legend') &&
        !['selectionSummary', 'quickPrompt', 'quickResult'].includes(el.id)
      ) {
        let text = el.textContent.replace(/\s+/g, ' ').trim();
        if (text && !kind) parts.push(text);
        el.remove();
      }
    if (kind) {
      panel.querySelectorAll('.hint').forEach((el) => {
        if (el.id === 'selectionSummary') {
          el.hidden = true;
          return;
        }
        let text = el.textContent.replace(/\s+/g, ' ').trim();
        if (text && !kind) parts.push(text);
        el.remove();
      });
    }
    let details = panel.querySelector('#scorePointDetails .hint,#distributionDetail > .hint');
    if (details) {
      let text = details.textContent.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      let box = details.parentElement;
      details.remove();
      box.hidden = true;
    }
    let legend = panel.querySelector(':scope > .legend');
    if (legend) {
      let text = legend.textContent.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      legend.remove();
    }
    let note = panel.querySelector(':scope > .note');
    if (note) {
      let text = note.textContent.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      note.remove();
    }
    if (!kind && !parts.length && !sourceId) return;
    let button = document.createElement('button');
    button.type = 'button';
    button.className = 'info-trigger';
    button.dataset.info = 'true';
    button.dataset.infoTitle = title;
    button.dataset.infoText = parts.join('\n\n');
    button.setAttribute('aria-label', 'More information about ' + title);
    button.title = 'More information';
    button.textContent = 'i';
    if (kind) button.dataset.infoKind = kind;
    if (sourceId) button.dataset.infoSource = sourceId;
    head.appendChild(button);
  });
  let quickPrompt = $('quickPrompt');
  if (quickPrompt) {
    let title = quickPrompt.previousElementSibling,
      button = document.createElement('button');
    quickPrompt.hidden = true;
    button.type = 'button';
    button.className = 'info-trigger';
    button.dataset.info = 'true';
    button.dataset.infoTitle = 'What if I shoot?';
    button.dataset.infoSource = 'quickPrompt';
    button.dataset.infoText = 'The estimate is a preview only and is not saved until you add a round.';
    button.setAttribute('aria-label', 'More information about the next-round estimate');
    button.title = 'More information';
    button.textContent = 'i';
    title?.appendChild(button);
  }
  let banner = document.querySelector('#forecast .banner');
  if (banner) banner.remove();
}
function infoMessage(button) {
  let parts = [button.dataset.infoText || ''];
  if (button.dataset.infoSource) {
    let source = $(button.dataset.infoSource);
    if (source?.textContent.trim()) parts.push(source.textContent.trim());
  }
  if (button.dataset.infoKind === 'handicapMode')
    parts.push(
      settings.useCourseRatings
        ? 'Course Rating and Slope mode compares gross scores using a course differential. Saved course values apply to every round at that course.'
        : 'Over Par mode compares gross score with the round par.',
      'In Course Rating and Slope mode the differential is (gross score − Course Rating) × 113 ÷ Slope Rating. It omits hole-by-hole net double bogey adjustments and the daily Playing Conditions Calculation.',
    );
  if (button.dataset.infoKind === 'scenario')
    parts.push(
      'The scenario is a preview only and is not saved as a round. It assumes the next qualifying round is added after all recorded rounds.',
    );
  if (button.dataset.infoKind === 'scoreSelection')
    parts.push(
      selectionMethodText(),
      'Each new qualifying round moves the oldest qualifying round out once the selected window is full. Non-qualifying rounds do not move the window.',
      'Custom selection does not apply the official early-record offsets. Over Par mode is an approximation; the official differential calculation requires Course Rating and Slope Rating.',
    );
  return parts.filter(Boolean).join('\n\n');
}
function setMobileMenu(open) {
  let sidebar = $('sidebar'),
    button = $('menuToggle'),
    backdrop = $('menuBackdrop'),
    wasOpen = sidebar?.classList.contains('menu-open');
  if (!sidebar || !button || !backdrop) return;
  sidebar.classList.toggle('menu-open', open);
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
  button.querySelector('.menu-icon').textContent = open ? '×' : '☰';
  button.lastElementChild.textContent = open ? 'Close' : 'Menu';
  backdrop.hidden = !open;
  if (!open && wasOpen && window.innerWidth <= 700 && document.activeElement?.closest('#sidebarMenu'))
    button.focus({ preventScroll: true });
}
function showToast(s) {
  let t = $('toast');
  t.textContent = s;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2600);
}
function lineChart(el, entries, { values, label, color = '#2f8056', minZero = false, onPoint = null } = {}) {
  let e = $(el);
  if (!entries.length) {
    e.innerHTML = '<div class="empty">Not enough data yet</div>';
    return;
  }
  let interactive = typeof onPoint === 'function',
    w = 650,
    h = 235,
    p = { l: 39, r: 15, t: 17, b: 35 },
    data = entries.map(values),
    lo = Math.min(...data),
    hi = Math.max(...data);
  if (minZero) lo = Math.min(0, lo);
  let pad = Math.max((hi - lo) * 0.18, 1);
  lo -= pad;
  hi += pad;
  let x = (i) => p.l + (entries.length === 1 ? 0.5 : i / (entries.length - 1)) * (w - p.l - p.r),
    y = (v) => p.t + ((hi - v) / (hi - lo)) * (h - p.t - p.b),
    coords = data.map((v, i) => [x(i), y(v)]);
  let path = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
    area = path + ` L${x(entries.length - 1)} ${h - p.b} L${x(0)} ${h - p.b} Z`;
  let grid = Array.from({ length: 5 }, (_, i) => {
    let v = lo + ((hi - lo) * i) / 4;
    return `<line class="gridline" x1="${p.l}" x2="${w - p.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${p.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(0)}</text>`;
  }).join('');
  let labels = [0, Math.floor((entries.length - 1) / 2), entries.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map(
      (i) =>
        `<text x="${x(i)}" y="${h - 8}" text-anchor="middle">${dateShort(entries[i].date).slice(0, 5)}</text>`,
    )
    .join('');
  let dots = coords
    .map(([cx, cy], i) => {
      let r = entries[i],
        pointMetric = settings.useCourseRatings
          ? `${Number.isFinite(handicapValue(r)) ? signed(handicapValue(r)) + ' differential' : 'Course rating missing'}`
          : `${signed(over(r))} over par`,
        pointLabel = interactive
          ? `${dateShort(r.date)} | ${r.course || 'Unknown course'} | ${r.score}/${r.par} | ${pointMetric}`
          : label(r, data[i]),
        attrs = interactive
          ? `data-point-index="${i}" data-round-id="${escapeHTML(r.id)}" tabindex="0" role="button" aria-pressed="false" aria-label="${escapeHTML(pointLabel)}"`
          : '';
      return `<circle class="dot" cx="${cx}" cy="${cy}" r="${interactive ? 5.2 : entries.length < 17 ? 4.2 : 2.8}" ${attrs}><title>${escapeHTML(pointLabel)}</title></circle>`;
    })
    .join('');
  e.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="${interactive ? 'group' : 'img'}" aria-label="${escapeHTML(el)} graph">${grid}<path class="area" d="${area}"/><path class="line" d="${path}" style="stroke:${color}"/>${dots}${labels}</svg>`;
  if (interactive) {
    let tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    e.appendChild(tip);
    let points = [...e.querySelectorAll('.dot[data-point-index]')],
      hide = () => {
        tip.classList.remove('visible');
        tip.hidden = true;
      },
      show = (i) => {
        let r = entries[i],
          px = (coords[i][0] / w) * e.clientWidth,
          py = (coords[i][1] / h) * e.clientHeight;
        let metricText = settings.useCourseRatings
          ? Number.isFinite(handicapValue(r))
            ? `${signed(handicapValue(r))} differential`
            : 'Course rating missing'
          : `${signed(over(r))} over par`;
        tip.textContent = `${dateShort(r.date)} | ${r.course || 'Unknown course'} | ${r.score}/${r.par} | ${metricText}`;
        tip.style.left = `${Math.max(100, Math.min(e.clientWidth - 100, px))}px`;
        tip.style.top = `${Math.max(38, py)}px`;
        tip.hidden = false;
        tip.classList.add('visible');
      },
      select = (point) => {
        points.forEach((p) => {
          let active = p === point;
          p.classList.toggle('selected', active);
          p.setAttribute('aria-pressed', String(active));
        });
        onPoint(entries[Number(point.dataset.pointIndex)]);
      };
    points.forEach((point, i) => {
      point.addEventListener('pointerenter', () => show(i));
      point.addEventListener('pointerleave', hide);
      point.addEventListener('focus', () => show(i));
      point.addEventListener('blur', hide);
      point.addEventListener('click', () => select(point));
      point.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          point.click();
        }
      });
    });
  }
}
function barChart(id, labels, vals, { onSelect = null } = {}) {
  let el = $(id);
  if (!vals.length) {
    el.innerHTML = '<div class="empty">No data yet</div>';
    return;
  }
  let interactive = typeof onSelect === 'function',
    w = 600,
    h = 238,
    p = { l: 35, r: 15, t: 15, b: 35 },
    max = Math.max(...vals, 1),
    bw = (w - p.l - p.r) / vals.length,
    bottom = h - p.b,
    plotHeight = h - p.t - p.b;
  let bars = vals
    .map((v, i) => {
      let barHeight = Math.max((v / max) * plotHeight, 3),
        barY = bottom - barHeight;
      return `<rect class="${interactive ? 'dist-bar' : ''}" x="${p.l + i * bw + bw * 0.15}" y="${barY}" width="${bw * 0.7}" height="${barHeight}" rx="4" fill="#428761" ${interactive ? `data-bar-index="${i}" tabindex="0" role="button" aria-pressed="false" aria-label="${escapeHTML(labels[i])}: ${v} rounds. Click to inspect."` : ''}><title>${escapeHTML(labels[i])}: ${v} rounds</title></rect><text class="dist-axis" x="${p.l + (i + 0.5) * bw}" y="${h - 9}" text-anchor="middle">${escapeHTML(labels[i])}</text><text class="dist-axis" x="${p.l + (i + 0.5) * bw}" y="${barY - 5}" text-anchor="middle">${v || ''}</text>`;
    })
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="${interactive ? 'group' : 'img'}" aria-label="Score distribution">${bars}</svg>`;
  if (interactive) {
    let bars = [...el.querySelectorAll('.dist-bar')],
      select = (bar) => {
        let was = bar.classList.contains('selected'),
          index = Number(bar.dataset.barIndex);
        bars.forEach((b) => {
          let active = !was && b === bar;
          b.classList.toggle('selected', active);
          b.setAttribute('aria-pressed', String(active));
        });
        onSelect(was ? null : index);
      };
    bars.forEach((bar) => {
      bar.addEventListener('click', () => select(bar));
      bar.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          bar.click();
        }
      });
    });
  }
}
function modeNoticeHTML() {
  if (!settings.useCourseRatings) return '';
  let c = calc(eligible()),
    missingCourses = [...new Set(c.missing.map((r) => r.course.trim() || 'Course not specified'))];
  return `<strong>Course Rating and Slope mode is on.</strong> ${c.missing.length ? `${c.missing.length} qualifying round${c.missing.length === 1 ? ' is' : 's are'} in the current score window missing a saved course profile and are omitted from the differential estimate (${missingCourses.map(escapeHTML).join(', ')}). Add ratings on the Courses page.` : 'All qualifying rounds in the current window have course profiles.'} Estimates use gross score only; hole-by-hole adjustments and daily playing conditions are not included.`;
}
function renderCourseRatings() {
  const el = $('courseRatingTable');
  // A refresh from the database must not wipe a rating that is half-typed.
  if (el.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const list = knownCourses();
  if (!list.length) {
    el.innerHTML =
      '<div class="empty">No courses yet. Use “Add course” to pick one that is already in the catalogue, or create a new one.</div>';
    return;
  }
  const rows = list
    .map((c) => {
      const profile = effectiveProfile(c.id);
      const shared = catalogue.get(c.id);
      const [label, cls] = !profile
        ? ['Needs values', 'warn']
        : profile.custom
          ? ['Custom', 'custom']
          : ['Ready', ''];
      const sharedNote = profile?.custom
        ? ` · Shared: ${hasValues(shared) ? `${shared.rating} / ${shared.slope}` : 'none yet'}`
        : '';
      const reset = profile?.custom
        ? `<button class="btn small" type="button" data-reset-course="${escapeHTML(c.id)}">Use shared</button>`
        : '';
      const remove =
        c.count === 0
          ? `<button class="btn small danger" type="button" data-remove-course="${escapeHTML(c.id)}">Remove</button>`
          : '';
      return `<tr><td><div class="course">${escapeHTML(c.name)}</div><div class="hint">${c.count} recorded round${c.count === 1 ? '' : 's'}${sharedNote}</div></td><td><input class="field" type="number" min="50" max="90" step="0.1" value="${profile ? profile.rating : ''}" data-profile-rating aria-label="Course Rating for ${escapeHTML(c.name)}"></td><td><input class="field" type="number" min="55" max="155" step="1" value="${profile ? profile.slope : ''}" data-profile-slope aria-label="Slope Rating for ${escapeHTML(c.name)}"></td><td><span class="pill profile-state ${cls}">${label}</span></td><td><div class="row-actions">${reset}${remove}<button class="btn small" type="button" data-save-course="${escapeHTML(c.id)}">Save</button></div></td></tr>`;
    })
    .join('');
  el.innerHTML = `<table class="table course-rating-table"><thead><tr><th>Course</th><th>Course Rating</th><th>Slope Rating</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll('[data-save-course]').forEach(
    (button) =>
      (button.onclick = () => {
        const row = button.closest('tr');
        const id = button.dataset.saveCourse;
        const course = catalogue.get(id);
        const rating = Number(row.querySelector('[data-profile-rating]').value);
        const slope = Number(row.querySelector('[data-profile-slope]').value);
        if (!validProfile(rating, slope)) {
          alert(PROFILE_ERROR);
          return;
        }
        const sharedMissing = !hasValues(course);
        fire(
          fb.saveCourseValues(session.uid, id, { rating, slope, shared: course }),
          'save the course values',
        );
        showToast(
          `${course?.name || 'Course'} values saved${sharedMissing ? ' and shared with everyone' : ' for you'}`,
        );
      }),
  );
  el.querySelectorAll('[data-reset-course]').forEach(
    (button) =>
      (button.onclick = () => {
        fire(fb.clearCourseValues(session.uid, button.dataset.resetCourse), 'reset the course values');
        showToast('Using the shared values again');
      }),
  );
  el.querySelectorAll('[data-remove-course]').forEach(
    (button) =>
      (button.onclick = () => {
        const course = catalogue.get(button.dataset.removeCourse);
        if (
          !confirm(
            `Remove ${course?.name || 'this course'} from your courses? It stays in the shared catalogue.`,
          )
        )
          return;
        fire(fb.removeFromMyCourses(session.uid, button.dataset.removeCourse), 'remove the course');
        showToast('Course removed from your list');
      }),
  );
}
function updateCoursePickers() {
  let names = ratedCourses(),
    latestRated = [...eligible()].reverse().find((r) => courseProfile(r.course))?.course || '',
    fallback = latestRated || names[0]?.name || '';
  ['quickCourse', 'scenarioCourse', 'estimateCourse'].forEach((id) => {
    let el = $(id);
    if (!el) return;
    let previous = el.value;
    el.innerHTML = names.length
      ? `<option value="">Choose a rated course</option>${names.map((c) => `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`).join('')}`
      : '<option value="">No rated courses yet</option>';
    el.value = names.some((c) => c.name === previous) ? previous : fallback;
  });
}
function syncModeUI() {
  let enabled = settings.useCourseRatings;
  // Whenever the mode changes (a toggle here, an import, or a change from another device), move the
  // estimator boxes between an over-par default (18) and a gross-score default (90).
  if (modeUiInitialized !== enabled) {
    ['quickScore', 'scenarioOver', 'estimateOver'].forEach((id) => {
      const input = $(id);
      if (enabled && Number(input.value) < 50) input.value = '90';
      if (!enabled && Number(input.value) >= 50) input.value = '18';
    });
    modeUiInitialized = enabled;
  }
  ['ratingModeToggle'].forEach((id) => {
    let el = $(id);
    if (el) el.checked = enabled;
  });
  if ($('modeBadge')) $('modeBadge').textContent = enabled ? 'Rating + slope' : 'Over par';
  [
    ['quickCourse', enabled],
    ['scenarioCourse', enabled],
    ['estimateCourseWrap', enabled],
  ].forEach(([id, show]) => {
    let el = $(id);
    if (el) el.hidden = !show;
  });
  if ($('estimateParWrap')) $('estimateParWrap').hidden = enabled;
  if ($('quickPrompt'))
    $('quickPrompt').textContent = enabled
      ? 'Enter a gross score and course for your next qualifying round.'
      : 'Enter an over-par score for your next qualifying round.';
  if ($('quickScore')) $('quickScore').setAttribute('aria-label', enabled ? 'Gross score' : 'Over-par score');
  if ($('scenarioScoreLabel'))
    $('scenarioScoreLabel').textContent = enabled ? 'Gross score' : 'Score over par';
  if ($('scenarioOver'))
    $('scenarioOver').setAttribute('aria-label', enabled ? 'Scenario gross score' : 'Scenario over par');
  if ($('scenarioPrompt'))
    $('scenarioPrompt').textContent = enabled
      ? 'Try a gross score at a course with saved ratings.'
      : 'Try an over-par score for your next qualifying round.';
  if ($('estimateScoreLabel'))
    $('estimateScoreLabel').textContent = enabled ? 'Gross score' : 'Score over par';
  if ($('estimateOver'))
    $('estimateOver').setAttribute('aria-label', enabled ? 'Gross score' : 'Score over par');
  let sort = $('historySort');
  if (sort) {
    let low = sort.querySelector('[value="over-asc"]'),
      high = sort.querySelector('[value="over-desc"]');
    if (low) low.textContent = enabled ? 'Lowest differential first' : 'Best scores first';
    if (high) high.textContent = enabled ? 'Highest differential first' : 'Highest over par';
  }
  updateCoursePickers();
  syncSelectionUI();
}
function setHandicapMode(enabled) {
  if (settings.useCourseRatings === enabled) return;
  settings.useCourseRatings = enabled;
  if (enabled) {
    ['quickScore', 'scenarioOver', 'estimateOver'].forEach((id) => {
      let input = $(id);
      if (Number(input.value) < 50) input.value = '90';
    });
  } else {
    ['quickScore', 'scenarioOver', 'estimateOver'].forEach((id) => {
      let input = $(id);
      if (Number(input.value) >= 50) input.value = '18';
    });
  }
  saveSettings();
  renderAll();
  showToast(enabled ? 'Rating and slope mode enabled' : 'Over-par mode enabled');
}
function renderDashboard() {
  let e = eligible(),
    c = calc(e),
    prev = e.length > 1 ? calc(e.slice(0, -1)).handicap : null,
    mean = avg(e.map(over)),
    best =
      e
        .filter((r) => Number.isFinite(handicapValue(r)))
        .sort((a, b) => handicapValue(a) - handicapValue(b))[0] || null;
  $('kpis').innerHTML =
    metric(
      'Estimated handicap',
      fmt(c.handicap),
      `${c.best.length} best of ${c.latest.length} qualifying rounds`,
      true,
    ) +
    metric('Qualifying rounds', e.length, `${rounds.length - e.length} non-qualifying recorded`) +
    metric(
      settings.useCourseRatings ? 'Lowest differential' : 'Best qualifying round',
      best ? signed(handicapValue(best)) : '-',
      best ? `${best.course || 'Course unknown'} | ${dateShort(best.date)}` : 'No rated scores',
    ) +
    metric(
      'Average over par',
      mean === null ? '-' : signed(Number(mean.toFixed(1))),
      prev === null ? 'All qualifying scores' : `Previous estimated handicap: ${fmt(prev)}`,
    );
  $('dashboardModeNotice').innerHTML = modeNoticeHTML();
  $('dashboardModeNotice').hidden = !settings.useCourseRatings;
  let trend = e
    .map((r, i) => ({ date: r.date, val: calc(e.slice(0, i + 1)).handicap }))
    .filter((x) => Number.isFinite(x.val));
  lineChart('handicapChart', trend, { values: (r) => r.val, label: (_, v) => 'Handicap ' + fmt(v) });
  lineChart('scoresChart', e.slice(-12), {
    values: over,
    label: (r, v) => signed(v) + ' at ' + (r.course || 'unknown course'),
  });
  let pos = positionInfo(e),
    row = pos.filter((r) => r.inBest).sort((a, b) => handicapValue(a) - handicapValue(b) || b.pos - a.pos);
  $('selectedScoresDashboard').innerHTML =
    `<table class="table"><thead><tr><th>Rank</th><th>Round</th><th>Score</th><th>${handicapValueLabel()}</th><th>Window</th><th>Expires in</th></tr></thead><tbody>${row.map((r, i) => `<tr><td><span class="rank">${i + 1}</span></td><td><div class="course" title="${escapeHTML(r.course)}">${escapeHTML(r.course || 'Unknown course')}</div><div class="hint">${dateShort(r.date)}</div></td><td>${r.score}/${r.par}</td><td class="num good">${signed(handicapValue(r))}</td><td>${r.pos}/${r.window}</td><td><span class="pill ${r.left <= 5 ? 'warn' : ''}">${r.left} rounds</span></td></tr>`).join('')}</tbody></table>`;
  let exp = [...pos].sort((a, b) => a.left - b.left).slice(0, 4);
  $('nextExpire').innerHTML =
    exp
      .map(
        (r) =>
          `<div style="padding:9px 0;border-bottom:1px solid #edf2ed"><div class="overline"><span style="font-weight:750;font-size:12px">${escapeHTML(r.course || 'Unknown course')}</span><span class="pill ${r.left <= 5 ? 'warn' : ''}">${r.left} new</span></div><div class="hint">${dateShort(r.date)} | ${Number.isFinite(handicapValue(r)) ? signed(handicapValue(r)) + ' ' + handicapValueLabel().toLowerCase() : 'Course rating missing'} | ${r.inBest ? 'Counted in estimate' : 'Outside current count'}</div></div>`,
      )
      .join('') || '<div class="empty">No qualifying rounds</div>';
  renderQuick();
}
function renderQuick() {
  let raw = $('quickScore').value,
    n = Number(raw),
    course = $('quickCourse').value;
  if (!raw.trim() || !Number.isFinite(n)) {
    $('quickResult').textContent = settings.useCourseRatings
      ? 'Enter a gross score and select a rated course.'
      : 'Enter a score to estimate.';
    return;
  }
  if (settings.useCourseRatings && !course) {
    $('quickResult').textContent =
      'Save a course rating and slope on the Courses page, then choose that course.';
    return;
  }
  let s = simulate(n, course);
  if (s.invalid) {
    $('quickResult').textContent = 'That course needs a saved Course Rating and Slope Rating.';
    return;
  }
  let deltaText =
    s.delta === null
      ? 'Add more qualifying rounds to compare'
      : `(${s.delta > 0 ? '+' : ''}${fmt(s.delta)} change)`;
  $('quickResult').innerHTML =
    `Estimated handicap: <strong style="color:#205a3b">${fmt(s.after.handicap)}</strong> <span class="muted">${deltaText}</span> | ${s.entering ? 'Score enters selected count' : 'Score does not enter selected count'}.`;
}
function renderHistory() {
  let q = $('searchRounds').value.toLowerCase().trim(),
    f = $('qualFilter').value,
    sort = $('historySort').value;
  let data = ordered().filter(
    (r) =>
      (f === 'all' || r.qualifying === (f === 'yes')) &&
      [r.course, r.date, dateShort(r.date), r.notes].join(' ').toLowerCase().includes(q),
  );
  data.sort((a, b) =>
    sort === 'date-asc'
      ? a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
      : sort === 'over-asc'
        ? compareHandicap(a, b)
        : sort === 'over-desc'
          ? compareHandicap(a, b, true)
          : sort === 'course-asc'
            ? a.course.localeCompare(b.course)
            : b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
  $('roundsCount').textContent = `${data.length} rounds`;
  $('historyTable').innerHTML =
    `<table class="table"><thead><tr><th>Date</th><th>Course</th><th>Gross</th><th>Par</th><th>${handicapValueLabel()}</th><th>Type</th><th>Notes</th><th>Action</th></tr></thead><tbody>${data.map((r) => `<tr><td>${dateShort(r.date)}</td><td><div class="course">${escapeHTML(r.course || 'Unknown course')}${courseProfile(r.course) && settings.useCourseRatings ? ' <span class="pill" title="Course rating saved">Rated</span>' : ''}</div></td><td class="num">${r.score}</td><td>${r.par}</td><td class="num ${Number.isFinite(handicapValue(r)) ? 'good' : ''}">${Number.isFinite(handicapValue(r)) ? signed(handicapValue(r)) : 'Needs rating'}</td><td><span class="pill ${r.qualifying ? '' : 'no'}">${r.qualifying ? 'Qualifying' : 'Non-qualifying'}</span></td><td class="muted" title="${escapeHTML(r.notes)}">${escapeHTML(r.notes || '-')}</td><td><button class="btn small" data-edit="${escapeHTML(r.id)}">Edit</button></td></tr>`).join('')}</tbody></table>${data.length ? '' : '<div class="empty">No matching rounds</div>'}`;
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openRound(b.dataset.edit)));
}
function renderForecast() {
  let e = eligible(),
    c = calc(e),
    pos = positionInfo(e),
    b = pos.filter((r) => r.inBest).sort((a, b) => a.left - b.left);
  $('forecastModeNotice').innerHTML = modeNoticeHTML();
  $('forecastModeNotice').hidden = !settings.useCourseRatings;
  $('forecastKpis').innerHTML =
    metric('Current estimate', fmt(c.handicap), selectionMethodText(), true) +
    metric(
      'Oldest counted score expires',
      b.length ? b[0].left + ' rounds' : '-',
      b.length ? dateShort(b[0].date) : 'No scores',
    ) +
    metric(
      'Counted scores near expiry',
      b.filter((r) => r.left <= 5).length,
      'Within next 5 qualifying rounds',
    ) +
    metric(
      settings.useCourseRatings ? 'Missing course ratings' : 'Outside the current count',
      settings.useCourseRatings ? c.missing.length : c.other.length,
      settings.useCourseRatings ? 'In the current score window' : 'Eligible replacement candidates',
    );
  $('expiryTable').innerHTML =
    `<table class="table"><thead><tr><th>Course / date</th><th>Score</th><th>${handicapValueLabel()}</th><th>Window pos.</th><th>New rounds until exit</th><th>Remaining</th></tr></thead><tbody>${b.map((r) => `<tr><td><div class="course">${escapeHTML(r.course || 'Unknown course')}</div><div class="hint">${dateShort(r.date)}</div></td><td>${r.score}/${r.par}</td><td class="num good">${signed(handicapValue(r))}</td><td>${r.pos}/${r.window}</td><td><span class="pill ${r.left <= 5 ? 'warn' : ''}">${r.left}</span></td><td style="min-width:110px"><div class="meter"><i style="width:${(r.left / r.window) * 100}%"></i></div></td></tr>`).join('')}</tbody></table>`;
  $('upcomingTable').innerHTML =
    `<table class="table"><thead><tr><th>After new round #</th><th>Round leaving current window</th><th>${handicapValueLabel()}</th><th>Counted now?</th></tr></thead><tbody>${pos.map((r) => `<tr><td class="num">${r.left}</td><td><div class="course">${escapeHTML(r.course || 'Unknown course')}</div><span class="hint">${dateShort(r.date)}</span></td><td class="num">${Number.isFinite(handicapValue(r)) ? signed(handicapValue(r)) : 'Needs rating'}</td><td>${r.inBest ? '<span class="pill warn">Yes</span>' : '<span class="muted">No</span>'}</td></tr>`).join('')}</tbody></table>`;
  $('replacements').innerHTML =
    `<table class="table"><thead><tr><th>Rank outside current count</th><th>Course / date</th><th>${handicapValueLabel()}</th></tr></thead><tbody>${c.other.map((r, i) => `<tr><td>${i + 1}</td><td><div class="course">${escapeHTML(r.course || 'Unknown course')}</div><span class="hint">${dateShort(r.date)}</span></td><td class="num">${signed(handicapValue(r))}</td></tr>`).join('')}</tbody></table>`;
  renderScenario();
}
function scenarioHTML(n, courseName = '') {
  let s = simulate(n, courseName);
  if (s.invalid) return '<div class="note">Choose a course with saved Course Rating and Slope Rating.</div>';
  let delta = s.delta,
    deltaLabel =
      delta === null
        ? 'Add more qualifying rounds to compare'
        : delta < -0.0001
          ? fmt(Math.abs(delta)) + ' lower'
          : delta > 0.0001
            ? fmt(delta) + ' higher'
            : 'No change',
    scoreDescription = settings.useCourseRatings
      ? `Gross score ${n} at ${escapeHTML(courseName)}`
      : `${signed(n)} over par`;
  return `<div class="projection"><div class="eyebrow">Projected estimate after one new qualifying round</div><div class="big">${fmt(s.after.handicap)}</div><div class="callout">${deltaLabel}${delta === null ? '' : ' vs ' + fmt(s.before.handicap)}</div><p>${scoreDescription}: ${s.entering ? 'the score enters the selected count.' : 'the score does not enter the selected count.'}</p></div><div class="stats3"><div class="statbox"><div class="n">${s.outgoing && Number.isFinite(handicapValue(s.outgoing)) ? signed(handicapValue(s.outgoing)) : '-'}</div><div class="l">Oldest round removed</div></div><div class="statbox"><div class="n">${s.exitingBest.length}</div><div class="l">Previous selected count displaced</div></div><div class="statbox"><div class="n">${s.newBest.length}</div><div class="l">New selected count entries</div></div></div><div class="section-label">Projected selected count</div><div class="tablewrap"><table class="table"><thead><tr><th>Course</th><th>Round</th><th>${handicapValueLabel()}</th></tr></thead><tbody>${[
    ...s.after.best,
  ]
    .sort((a, b) => handicapValue(a) - handicapValue(b))
    .map(
      (r) =>
        `<tr><td class="course">${escapeHTML(r.course || 'Unknown course')}</td><td>${r.id === 'simulation' ? 'Hypothetical' : dateShort(r.date)}</td><td class="num good">${signed(handicapValue(r))}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}
function renderScenario() {
  let raw = $('scenarioOver').value,
    n = Number(raw),
    course = $('scenarioCourse').value;
  if (!raw.trim() || !Number.isFinite(n)) {
    $('scenarioOutput').innerHTML = '<p>Enter a valid score.</p>';
    return;
  }
  if (settings.useCourseRatings && !course) {
    $('scenarioOutput').innerHTML =
      '<p>Select a course with saved ratings. Add course values on the Courses page.</p>';
    return;
  }
  $('scenarioOutput').innerHTML = scenarioHTML(n, course);
}
function renderCourseBreakdown() {
  let includeExcluded = $('includeExcludedRounds').checked,
    all = ordered(),
    visible = includeExcluded ? all : all.filter((r) => r.qualifying),
    groups = new Map();
  for (let r of visible) {
    let key = r.course || 'Unknown course';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let summary = [...groups]
    .map(([course, rr]) => {
      let courseRounds = all.filter((r) => (r.course || 'Unknown course') === course),
        values = rr.map(handicapValue).filter(Number.isFinite);
      return {
        course,
        count: rr.length,
        qualifying: courseRounds.filter((r) => r.qualifying).length,
        excluded: courseRounds.filter((r) => !r.qualifying).length,
        best: values.length ? Math.min(...values) : null,
        average: avg(values),
        last: rr.at(-1).date,
      };
    })
    .sort((a, b) => b.count - a.count || (a.average ?? Infinity) - (b.average ?? Infinity));
  $('courseBreakdown').innerHTML = summary.length
    ? `<table class="table"><thead><tr><th>Course</th><th>Rounds shown</th><th>Avg. ${handicapValueLabel()}</th><th>Best ${handicapValueLabel()}</th><th>Last played</th></tr></thead><tbody>${summary.map((r) => `<tr><td class="course">${escapeHTML(r.course)}</td><td>${r.count}<div class="hint">${r.qualifying} qualifying / ${r.excluded} excluded</div></td><td class="num">${r.average === null ? 'Needs rating' : signed(Number(r.average.toFixed(1)))}</td><td class="num good">${r.best === null ? 'Needs rating' : signed(r.best)}</td><td>${dateShort(r.last)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${includeExcluded ? 'No rounds recorded yet.' : 'No qualifying rounds yet. Turn on the Include non-qualifying rounds toggle to show excluded rounds.'}</div>`;
}
function renderInsights() {
  let e = eligible(),
    eOver = e.map(over),
    metricRounds = settings.useCourseRatings ? e.filter((r) => Number.isFinite(handicapValue(r))) : e,
    metricValues = metricRounds.map(handicapValue),
    l = ordered();
  let last5 = metricRounds.slice(-5).map(handicapValue),
    earlier = metricRounds.slice(-10, -5).map(handicapValue);
  $('insightKpis').innerHTML =
    metric('Rounds recorded', l.length, `${e.length} qualifying, ${l.length - e.length} excluded`, true) +
    metric(
      settings.useCourseRatings ? 'Lowest differential' : 'Lowest over par',
      metricValues.length ? signed(Math.min(...metricValues)) : '-',
      'Best recorded qualifying value',
    ) +
    metric(
      settings.useCourseRatings ? 'Last 5 differential avg' : 'Last 5 avg',
      last5.length ? signed(Number(avg(last5).toFixed(1))) : '-',
      earlier.length
        ? `Previous 5: ${signed(Number(avg(earlier).toFixed(1)))}`
        : 'Recent qualifying performance',
    ) +
    metric(
      'Courses played',
      new Set(l.map((r) => r.course.trim()).filter(Boolean)).size,
      'All recorded rounds',
    );
  $('insightsModeNotice').innerHTML = modeNoticeHTML();
  $('insightsModeNotice').hidden = !settings.useCourseRatings;
  let selectScoreRound = (r) => {
    document.querySelectorAll('#allScoresChart .dot').forEach((dot) => {
      let active = dot.dataset.roundId === r.id;
      dot.classList.toggle('selected', active);
      dot.setAttribute('aria-pressed', String(active));
    });
    let differential = courseDifferential(r),
      roundSummary = settings.useCourseRatings
        ? `${dateShort(r.date)} | ${r.score}/${r.par} | ${Number.isFinite(differential) ? signed(differential) + ' differential' : 'Needs course rating'} | ${signed(over(r))} over par`
        : `${dateShort(r.date)} | ${r.score}/${r.par} | ${signed(over(r))} over par`;
    $('scorePointDetails').hidden = false;
    $('scorePointDetails').innerHTML =
      `<div class="detail-copy"><strong>${escapeHTML(r.course || 'Unknown course')}</strong><span class="hint">${roundSummary}</span></div><button class="btn small" data-score-edit>Edit round</button>`;
    $('scorePointDetails').querySelector('[data-score-edit]').onclick = () => openRound(r.id);
  };
  let scoreRounds = settings.useCourseRatings ? e.filter((r) => Number.isFinite(handicapValue(r))) : e;
  $('statsScoreHeading').textContent = settings.useCourseRatings
    ? 'Score differentials across rated rounds'
    : 'Scores across all qualifying rounds';
  let scoreInfo = $('statsScoreHeading').closest('.panel-head')?.querySelector('[data-info]');
  if (scoreInfo) {
    scoreInfo.dataset.infoTitle = $('statsScoreHeading').textContent;
    scoreInfo.setAttribute('aria-label', 'More information about ' + scoreInfo.dataset.infoTitle);
  }
  lineChart('allScoresChart', scoreRounds, {
    values: settings.useCourseRatings ? handicapValue : over,
    label: (r, v) =>
      `${signed(v)} ${settings.useCourseRatings ? 'differential' : 'over par'} | ${r.course || 'Unknown course'}`,
    onPoint: selectScoreRound,
  });
  let buckets = [-Infinity, 10, 15, 20, 25, 30, Infinity],
    names = ['≤10', '11–15', '16–20', '21–25', '26–30', '31+'];
  barChart(
    'distChart',
    names,
    names.map((_, i) => eOver.filter((n) => n > buckets[i] && n <= buckets[i + 1]).length),
    {
      onSelect: (index) => {
        if (index === null) {
          $('distributionDetail').innerHTML = '';
          $('distributionDetail').hidden = true;
          return;
        }
        let matching = e
            .filter((r) => over(r) > buckets[index] && over(r) <= buckets[index + 1])
            .sort((a, b) => b.date.localeCompare(a.date)),
          shown = matching.slice(0, 6),
          label = names[index];
        $('distributionDetail').hidden = false;
        $('distributionDetail').innerHTML =
          `<div class="drilldown-head"><span>${label} over par</span><span class="muted">${matching.length} qualifying ${matching.length === 1 ? 'round' : 'rounds'}</span></div>${matching.length ? `<div class="drilldown-list">${shown.map((r) => `<button class="round-chip" data-range-round="${escapeHTML(r.id)}">${dateShort(r.date)} | ${escapeHTML(r.course || 'Unknown course')} | ${signed(over(r))}</button>`).join('')}</div>${matching.length > shown.length ? `<div class="hint" style="margin-top:8px">Showing the 6 most recent rounds.</div>` : ''}` : '<div class="hint" style="margin-top:8px">No qualifying rounds in this range.</div>'}`;
        $('distributionDetail')
          .querySelectorAll('[data-range-round]')
          .forEach(
            (button) =>
              (button.onclick = () => {
                let r = e.find((round) => round.id === button.dataset.rangeRound);
                if (r) selectScoreRound(r);
              }),
          );
      },
    },
  );
  renderCourseBreakdown();
  let totals = new Map();
  l.forEach((r) => {
    let k = r.course || 'Unknown course';
    totals.set(k, (totals.get(k) || 0) + 1);
  });
  let tops = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8),
    max = Math.max(...tops.map((x) => x[1]), 1);
  $('courseBars').innerHTML = tops
    .map(
      ([name, n]) =>
        `<div class="barrow"><div title="${escapeHTML(name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650">${escapeHTML(name)}</div><div class="bar"><b style="width:${(n / max) * 100}%"></b></div><div class="num">${n}</div></div>`,
    )
    .join('');
}
function renderAll() {
  syncModeUI();
  renderCourseRatings();
  renderDashboard();
  renderHistory();
  renderForecast();
  renderInsights();
  $('courseSuggestions').innerHTML = [...catalogue.values()]
    .sort(byName)
    .map((c) => `<option value="${escapeHTML(c.name)}"></option>`)
    .join('');
  if ($('courseOverlay').classList.contains('show')) renderCourseMatches();
}
function switchView(v) {
  setMobileMenu(false);
  currentView = v;
  document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === v));
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  let titles = {
    dashboard: ['Your performance at a glance', 'Track every round. Understand every stroke.'],
    rounds: ['Your round history', 'Search, filter, edit, and add scores.'],
    forecast: ['The handicap forecast', 'Know what drops off and what comes next.'],
    courses: [
      'Courses',
      'Find or add the courses you play and set the rating and slope used for your handicap.',
    ],
    insights: ['Golf by the numbers', 'Patterns and performance trends.'],
    guide: ['How this app works', 'A guide to the estimate, course ratings, slope, and your score window.'],
  };
  $('pageTitle').textContent = titles[v][0];
  $('pageSubtitle').textContent = titles[v][1];
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function close(id) {
  $(id).classList.remove('show');
  document.body.style.overflow = '';
  if (id === 'infoOverlay' && lastInfoTrigger?.isConnected) lastInfoTrigger.focus();
}
function open(id) {
  $(id).classList.add('show');
  document.body.style.overflow = 'hidden';
}
function openRound(id = null) {
  let r = id ? rounds.find((x) => x.id === id) : null;
  $('roundTitle').textContent = r ? 'Edit round' : 'Add a round';
  $('editId').value = r?.id || '';
  $('date').value = r?.date || new Date().toLocaleDateString('en-CA');
  $('course').value = r?.course || '';
  $('score').value = r?.score || '';
  $('par').value = r?.par || 72;
  $('qualifying').checked = r ? r.qualifying : true;
  $('notes').value = r?.notes || '';
  $('deleteRound').style.display = r ? '' : 'none';
  updateOver();
  open('roundOverlay');
}
function updateOver() {
  let s = Number($('score').value),
    p = Number($('par').value),
    course = $('course').value;
  if (!$('score').value || !$('par').value) {
    $('overPreview').textContent = 'Enter a gross score and par.';
    return;
  }
  if (settings.useCourseRatings) {
    let d = courseDifferential({ score: s, par: p, course });
    $('overPreview').textContent =
      `Over par: ${signed(s - p)} | ${d === null ? 'Save this course rating and slope to calculate a differential.' : 'Course differential: ' + signed(d)}`;
    return;
  }
  $('overPreview').textContent = `Over par: ${signed(s - p)} | Counts toward the current estimate`;
}
$('roundForm').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const id = $('editId').value;
  const name = cleanCourseName($('course').value);
  const course = findCourse(name);
  const r = {
    id: id || uniqId(),
    date: $('date').value,
    courseId: course?.id || '',
    score: Number($('score').value),
    par: Number($('par').value),
    qualifying: $('qualifying').checked,
    notes: $('notes').value.trim().slice(0, 500),
  };
  if (
    !r.date ||
    !name ||
    r.score <= 0 ||
    r.par <= 0 ||
    !Number.isFinite(r.score) ||
    !Number.isFinite(r.par)
  ) {
    alert('Please enter a valid date, course, score and par.');
    return;
  }
  if (!course) {
    // Not in the catalogue yet: offer to find it or add it before saving the round.
    openCourseModal({ name, fromRound: true });
    return;
  }
  fire(fb.saveRound(session.uid, r, !myCourses.has(course.id)), 'save the round');
  close('roundOverlay');
  showToast(id ? 'Round updated' : 'Round added');
});
$('deleteRound').onclick = () => {
  const id = $('editId').value;
  const r = rounds.find((x) => x.id === id);
  if (!r || !confirm(`Permanently delete ${dateShort(r.date)} at ${r.course || 'unknown course'}?`)) return;
  fire(fb.deleteRound(session.uid, id), 'delete the round');
  close('roundOverlay');
  showToast('Round deleted');
};
['score', 'par', 'qualifying', 'course'].forEach((x) => $(x).addEventListener('input', updateOver));
function estimateModal() {
  open('estimateOverlay');
  $('estimateOver').value = $('quickScore').value || '18';
  $('estimateCourse').value = $('quickCourse').value;
  renderEstimate();
}
function renderEstimate() {
  let raw = $('estimateOver').value,
    n = Number(raw),
    course = $('estimateCourse').value;
  if (!raw.trim() || !Number.isFinite(n)) {
    $('estimateResult').innerHTML = '<p>Enter a valid score.</p>';
    return;
  }
  if (settings.useCourseRatings && !course) {
    $('estimateResult').innerHTML =
      '<p>Select a course with saved ratings. Add course values on the Courses page.</p>';
    return;
  }
  $('estimateResult').innerHTML = scenarioHTML(n, course);
}
$('estimateCalculate').onclick = renderEstimate;
$('estimateOver').addEventListener('input', renderEstimate);
$('estimateCourse').addEventListener('change', renderEstimate);
$('quickEstimate').onclick = renderQuick;
$('quickScore').addEventListener('input', renderQuick);
$('quickCourse').addEventListener('change', renderQuick);
$('scenarioRun').onclick = renderScenario;
$('scenarioOver').addEventListener('input', renderScenario);
$('scenarioCourse').addEventListener('change', renderScenario);
$('ratingModeToggle').addEventListener('change', (evt) => setHandicapMode(evt.target.checked));
$('customSelectionToggle').addEventListener('change', (evt) => {
  settings.useCustomSelection = evt.target.checked;
  saveSettings();
  renderAll();
  showToast(evt.target.checked ? 'Custom score selection enabled' : 'WHS score-count schedule enabled');
});
$('saveCustomSelection').onclick = saveCustomSelection;
$('includeExcludedRounds').addEventListener('change', renderCourseBreakdown);
$('addTop').onclick = () => openRound();
$('estimateTop').onclick = estimateModal;
$('menuToggle').onclick = () => setMobileMenu(!$('sidebar').classList.contains('menu-open'));
$('menuBackdrop').onclick = () => setMobileMenu(false);
window.addEventListener('resize', () => {
  if (window.innerWidth > 700) setMobileMenu(false);
});
document.addEventListener('click', (evt) => {
  let info = evt.target.closest('[data-info]');
  if (info) {
    lastInfoTrigger = info;
    $('infoTitle').textContent = info.dataset.infoTitle || 'More information';
    $('infoBody').textContent = infoMessage(info);
    open('infoOverlay');
    $('infoClose').focus({ preventScroll: true });
    return;
  }
  if ($('sidebar').classList.contains('menu-open') && !evt.target.closest('#sidebar')) setMobileMenu(false);
});
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => switchView(b.dataset.go)));
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => close(b.dataset.close)));
document.querySelectorAll('.modal-backdrop').forEach((b) =>
  b.addEventListener('mousedown', (e) => {
    if (e.target === b) close(b.id);
  }),
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.show').forEach((b) => close(b.id));
    setMobileMenu(false);
  }
});
['searchRounds', 'qualFilter', 'historySort'].forEach((id) => $(id).addEventListener('input', renderHistory));
function exportJSON() {
  let data = JSON.stringify(currentBackup(), null, 2),
    blob = new Blob([data], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = 'fairway-golf-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  showToast('Backup downloaded');
}
// ---- Find or add a course ------------------------------------------------------
let courseModalFromRound = false;
function openCourseModal({ name = '', fromRound = false } = {}) {
  courseModalFromRound = fromRound;
  $('courseName').value = name;
  $('courseRating').value = '';
  $('courseSlope').value = '';
  renderCourseMatches();
  open('courseOverlay');
  $('courseName').focus();
}
function describeShared(course) {
  return hasValues(course)
    ? `Rating ${course.rating} · Slope ${course.slope}`
    : 'No rating or slope saved yet';
}
// Catalogue courses whose name resembles what was typed, so duplicates are caught before they are created.
function similarCourses(name) {
  const id = courseDocId(name);
  if (id.length < 3) return [];
  const words = cleanCourseName(name)
    .toLowerCase()
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...catalogue.values()]
    .filter((c) => courseDocId(c.name) !== id)
    .map((c) => {
      const key = courseDocId(c.name);
      const lower = c.name.toLowerCase();
      const score =
        (key.includes(id) || id.includes(key) ? 10 : 0) + words.filter((w) => lower.includes(w)).length;
      return { course: c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byName(a.course, b.course))
    .slice(0, 6)
    .map((x) => x.course);
}
function renderCourseMatches() {
  const name = cleanCourseName($('courseName').value);
  const id = courseDocId(name);
  const exact = id ? catalogue.get(id) : null;
  const box = $('courseMatches');
  const submit = $('courseSubmit');
  $('courseValues').hidden = Boolean(exact);
  if (exact) {
    const listed = myCourses.has(id);
    box.innerHTML = `<div class="match-item match-exact"><div><div class="name">${escapeHTML(exact.name)}</div><div class="hint">Already in the shared catalogue · ${escapeHTML(describeShared(exact))}</div></div></div><div class="hint">No need to add it again. If the values look wrong for you, set your own on the Courses page.</div>`;
    submit.textContent = courseModalFromRound
      ? 'Use this course'
      : listed
        ? 'Already in your courses'
        : 'Add to my courses';
    submit.disabled = !courseModalFromRound && listed;
    return;
  }
  const similar = similarCourses(name);
  box.innerHTML = similar.length
    ? `<div class="section-label" style="margin:0">Similar courses already added</div><div class="match-list">${similar
        .map(
          (c) =>
            `<div class="match-item"><div><div class="name">${escapeHTML(c.name)}</div><div class="hint">${escapeHTML(describeShared(c))}</div></div><button class="btn small" type="button" data-use-course="${escapeHTML(c.id)}">Use this</button></div>`,
        )
        .join('')}</div>`
    : '';
  submit.textContent = 'Create course';
  submit.disabled = !id || name.length < 2;
}
function finishCourseModal(name, message) {
  if (courseModalFromRound) {
    $('course').value = name;
    updateOver();
  }
  close('courseOverlay');
  showToast(message);
}
function useExistingCourse(id) {
  const course = catalogue.get(id);
  if (!course) return;
  if (!myCourses.has(id)) fire(fb.addToMyCourses(session.uid, id), 'add the course');
  finishCourseModal(course.name, `${course.name} added to your courses`);
}
$('courseName').addEventListener('input', renderCourseMatches);
$('courseMatches').addEventListener('click', (evt) => {
  const button = evt.target.closest('[data-use-course]');
  if (button) useExistingCourse(button.dataset.useCourse);
});
$('courseForm').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const name = cleanCourseName($('courseName').value);
  const id = courseDocId(name);
  if (!id || name.length < 2) {
    alert('Enter the course name.');
    return;
  }
  if (catalogue.has(id)) {
    useExistingCourse(id);
    return;
  }
  const rawRating = $('courseRating').value.trim();
  const rawSlope = $('courseSlope').value.trim();
  const rating = Number(rawRating);
  const slope = Number(rawSlope);
  const withValues = Boolean(rawRating || rawSlope);
  if (withValues && !validProfile(rating, slope)) {
    alert(PROFILE_ERROR);
    return;
  }
  fire(
    fb.createCourse(session.uid, withValues ? { id, name, rating, slope } : { id, name }),
    'add the course',
  );
  finishCourseModal(name, `${name} added`);
});
$('addCourseBtn').onclick = () => openCourseModal();
$('newCourseBtn').onclick = () => openCourseModal({ name: $('course').value, fromRound: true });

// ---- Sign-in screen --------------------------------------------------------------
let authMode = 'signin';
function setAuthError(message, ok = false) {
  $('authError').textContent = message;
  $('authError').classList.toggle('ok', ok);
}
function setAuthMode(mode) {
  authMode = mode;
  document
    .querySelectorAll('[data-auth-mode]')
    .forEach((b) => b.classList.toggle('active', b.dataset.authMode === mode));
  $('authSubmit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $('authPassword').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('authForgot').hidden = mode !== 'signin';
  setAuthError('');
}
// state: 'setup' (Firebase config missing) | 'loading' | 'error' | 'signedOut'
function showAuth(state, message = '') {
  $('authScreen').hidden = false;
  document.querySelector('.shell').hidden = true;
  $('authForms').hidden = state !== 'signedOut';
  $('authStatus').hidden = state === 'signedOut';
  $('authSignOut').hidden = state !== 'error';
  $('authMessage').textContent =
    state === 'setup'
      ? 'Firebase is not configured yet. Open js/firebase-config.js, paste in your Firebase web-app config and reload. The README has the full steps.'
      : state === 'loading'
        ? 'Loading…'
        : message;
  if (state === 'signedOut') $('authPassword').value = '';
}
function showApp() {
  $('authScreen').hidden = true;
  document.querySelector('.shell').hidden = false;
}
async function runAuth(action) {
  $('authSubmit').disabled = $('authGoogle').disabled = true;
  setAuthError('');
  try {
    await action();
  } catch (error) {
    setAuthError(fb.describeError(error));
  } finally {
    $('authSubmit').disabled = $('authGoogle').disabled = false;
  }
}
document
  .querySelectorAll('[data-auth-mode]')
  .forEach((b) => (b.onclick = () => setAuthMode(b.dataset.authMode)));
$('authForm').addEventListener('submit', (evt) => {
  evt.preventDefault();
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  runAuth(() =>
    authMode === 'signin' ? fb.signInWithEmail(email, password) : fb.createAccount(email, password),
  );
});
$('authGoogle').onclick = () => runAuth(() => fb.signInWithGoogle());
$('authForgot').onclick = () => {
  const email = $('authEmail').value.trim();
  if (!email) {
    setAuthError('Enter your email above first, then choose “Forgot password?”.');
    return;
  }
  runAuth(async () => {
    await fb.sendReset(email);
    setAuthError('Password reset email sent. Check your inbox, and your spam folder.', true);
  });
};
$('authSignOut').onclick = () => fb.logOut();
$('signOutNav').onclick = () => {
  setMobileMenu(false);
  fb.logOut();
};

// ---- Backup export / import ----------------------------------------------------------
$('exportNav').onclick = () => {
  setMobileMenu(false);
  exportJSON();
};
$('importNav').onclick = () => {
  setMobileMenu(false);
  $('importFile').click();
};
$('importFile').onchange = async (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  try {
    const plan = buildImportPlan(validateBackup(JSON.parse(await file.text())));
    if (!plan.rounds.length) throw Error('No rounds with a course name were found in that file.');
    const skipped = plan.skipped
      ? `\n\n${plan.skipped} rounds without a usable course name will be skipped.`
      : '';
    const message = `Import ${plan.rounds.length} rounds across ${plan.myCourses.length} courses into your account?\n\nRounds with the same ID are overwritten; nothing else of yours is deleted. Courses already in the shared catalogue are reused.${skipped}`;
    if (!confirm(message)) return;
    showToast('Importing…');
    await fb.importPlan(session.uid, plan);
    showToast('Backup imported');
  } catch (err) {
    alert('Could not import: ' + fb.describeError(err));
  } finally {
    evt.target.value = '';
  }
};

// ---- Start ---------------------------------------------------------------------------
function boot() {
  setupPanelInfo();
  setAuthMode('signin');
  if (!fb.configured) {
    showAuth('setup');
    return;
  }
  showAuth('loading');
  fb.onUser((user) => (user ? startSession(user) : endSession()));
}
boot();
