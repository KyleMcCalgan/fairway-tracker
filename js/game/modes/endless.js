// Endless practice: a reproducible sequence per run, session scorecard and
// lifetime stats (docs/game.md 7). DOM-touching.

import { generateHole } from '../generate.js';
import { scoreName } from '../rules.js';
import { h, createPlay, resultCard, openDialog, formatVsPar, toneFor } from '../ui.js';

export function emptyLifetime() {
  return {
    holes: 0, strokes: 0, par: 0,
    streak: 0, bestStreak: 0,       // consecutive holes at par or better
    birdies: 0, eagles: 0, holesInOne: 0,
    ob: 0, water: 0, pickups: 0,
  };
}

// Fold one finished hole into the lifetime stats. Pure.
export function addToLifetime(stats, par, state) {
  const s = { ...emptyLifetime(), ...stats };
  const d = state.strokes - par;
  s.holes++;
  s.strokes += state.strokes;
  s.par += par;
  s.streak = d <= 0 ? s.streak + 1 : 0;
  if (s.streak > s.bestStreak) s.bestStreak = s.streak;
  if (d === -1) s.birdies++;
  if (d <= -2) s.eagles++;
  if (state.strokes === 1) s.holesInOne++;
  s.ob += state.ob;
  s.water += state.water;
  if (state.pickedUp) s.pickups++;
  return s;
}

function randomSeed() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0].toString(36) + a[1].toString(36)).slice(0, 8);
}

// The first hole keeps the original seed's meaning. Subsequent holes are
// derived solely from the run seed and position, independent of player scores.
export function endlessHoleSeed(runSeed, index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('Hole index must be a non-negative integer.');
  const seed = String(runSeed);
  return index === 0 ? seed : `handi-endless-v1|${seed.length}|${seed}|${index + 1}`;
}

export function createEndless(root, env) {
  const { storage, settings } = env;
  const session = []; // [{ seed, par, strokes, state }]
  let lifetime = emptyLifetime();
  let hole = null;
  let runSeed = '';
  let holeIndex = 0;
  let replaying = false;
  let runVersion = 0;
  let alive = true;

  const total = h('span', { class: 'hg-bar-main' });
  const seedBtn = h('button', { class: 'hg-btn hg-small hg-seedbtn', type: 'button' });
  const cardBtn = h('button', { class: 'hg-btn hg-small', type: 'button', text: 'Card' });
  const statsBtn = h('button', { class: 'hg-btn hg-small', type: 'button', text: 'Stats' });
  const bar = h('div', { class: 'hg-bar' }, total, h('div', { class: 'hg-bar-btns' }, seedBtn, cardBtn, statsBtn));
  const playRoot = h('div', { class: 'hg-playroot' });
  const el = h('div', { class: 'hg-mode' }, bar, playRoot);
  root.append(el);

  const play = createPlay(playRoot, {
    settings: () => ({ assist: !!settings.assist, latencyMs: settings.latencyMs || 0 }),
    onDone,
  });

  const sessionVsPar = () => session.reduce((n, r) => n + r.strokes - r.par, 0);

  function updateBar() {
    total.textContent = session.length
      ? formatVsPar(sessionVsPar()) + ' thru ' + session.length
      : 'New session';
    total.setAttribute('aria-label', session.length
      ? 'Session score ' + formatVsPar(sessionVsPar()) + ' after ' + session.length + ' holes'
      : 'New session');
    seedBtn.textContent = 'Seed ' + runSeed;
    seedBtn.setAttribute('aria-label', 'Run seed ' + runSeed + '. Copy it or start another run.');
  }

  function loadHole() {
    hole = generateHole(endlessHoleSeed(runSeed, holeIndex));
    play.load(hole, { holeNo: holeIndex + 1 });
    updateBar();
  }

  function startRun(seed) {
    runVersion++;
    runSeed = seed;
    holeIndex = 0;
    replaying = false;
    session.length = 0;
    loadHole();
  }

  function nextHole() {
    holeIndex++;
    replaying = false;
    loadHole();
  }

  function replayHole() {
    replaying = true;
    loadHole();
  }

  async function onDone(state) {
    const completedRun = runVersion;
    const result = { seed: hole.seed, par: hole.par, strokes: state.strokes, state };
    if (replaying && session.length) session[session.length - 1] = result;
    else session.push(result);
    replaying = false;
    lifetime = addToLifetime(lifetime, hole.par, state);
    try { await storage.saveLifetime(lifetime); } catch (e) { console.warn('could not save stats', e); }
    if (!alive || completedRun !== runVersion) return;
    updateBar();
    play.showCard(resultCard({
      title: scoreName(state.strokes, hole.par, state),
      tone: toneFor(state.strokes, hole.par, state),
      subtitle: state.strokes + (state.strokes === 1 ? ' stroke' : ' strokes') + ' on a par ' + hole.par,
      tiles: [['Shots', state.shots.length], ['Putts', state.putts], ['Penalties', state.penalties]],
      lines: [
        'Run ' + formatVsPar(sessionVsPar()) + ' after ' + session.length + (session.length === 1 ? ' hole' : ' holes') + '  ·  Seed ' + runSeed,
      ],
      actions: [
        { label: 'Next hole', primary: true, onClick: () => nextHole() },
        { label: 'Replay this hole', onClick: replayHole },
      ],
    }));
  }

  function showCard() {
    const rows = session.map((r, i) => h('tr', null,
      h('td', { text: String(i + 1) }), h('td', { text: String(r.par) }),
      h('td', null, h('span', { class: 'hg-chip-score hg-tone-' + toneFor(r.strokes, r.par, r.state), text: String(r.strokes) })),
      h('td', { text: scoreName(r.strokes, r.par, r.state) }), h('td', { class: 'hg-mono', text: r.seed })));
    const body = session.length
      ? h('table', { class: 'hg-table hg-scorecard' },
        h('thead', null, h('tr', null, ['Hole', 'Par', 'Score', 'Result', 'Seed'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', null, rows),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row', text: 'Total' }),
          h('td', { text: String(session.reduce((n, r) => n + r.par, 0)) }),
          h('td', { text: String(session.reduce((n, r) => n + r.strokes, 0)) }),
          h('td', { text: formatVsPar(sessionVsPar()) }), h('td'))))
      : h('p', { text: 'No holes finished yet this session.' });
    openDialog(root, 'Session scorecard', body);
  }

  function showStats() {
    const s = lifetime;
    const avg = s.holes ? (s.strokes - s.par) / s.holes : 0;
    const hero = [
      ['Holes played', s.holes],
      ['Average vs par', s.holes ? (avg >= 0 ? '+' : '−') + Math.abs(avg).toFixed(2) : '–'],
    ];
    const rows = [
      ['Best par-or-better streak', s.bestStreak],
      ['Birdies', s.birdies],
      ['Eagles or better', s.eagles],
      ['Holes-in-one', s.holesInOne],
      ['Out of bounds', s.ob],
      ['Water balls', s.water],
    ];
    const tile = ([k, v], cls) => h('div', { class: 'hg-stat ' + cls }, h('b', { text: String(v) }), h('span', { text: k }));
    openDialog(root, 'Lifetime stats', h('div', { class: 'hg-statgrid' },
      hero.map((r) => tile(r, 'hg-stat-hero')), rows.map((r) => tile(r, ''))));
  }

  function showSeed() {
    const input = h('input', { class: 'hg-input', id: 'hg-seed-in', type: 'text', maxlength: '40', autocomplete: 'off', spellcheck: 'false' });
    const status = h('p', { class: 'hg-note', role: 'status' });
    const copy = h('button', { class: 'hg-btn', type: 'button', text: 'Copy seed' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(runSeed); status.textContent = 'Copied.'; }
      catch { status.textContent = 'Could not copy. Select the seed above and copy it by hand.'; }
    });
    const go = h('button', { class: 'hg-btn hg-primary', type: 'submit', text: 'Start seeded run' });
    const form = h('form', { class: 'hg-form' },
      h('label', { for: 'hg-seed-in', text: 'Enter a run seed' }), input, go);
    const random = h('button', { class: 'hg-btn', type: 'button', text: 'Start random run' });
    const dlg = openDialog(root, 'Run seed', h('div', null,
      h('p', null, 'This run: ', h('strong', { class: 'hg-mono hg-select', text: runSeed })),
      h('p', { class: 'hg-note', text: 'Share this seed to play the same sequence of holes. Starting a run resets your session scorecard.' }),
      copy, status, form, random));
    random.addEventListener('click', () => { dlg.close(); startRun(randomSeed()); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { status.textContent = 'Type a seed first.'; return; }
      dlg.close();
      startRun(v);
    });
  }

  seedBtn.addEventListener('click', showSeed);
  cardBtn.addEventListener('click', showCard);
  statsBtn.addEventListener('click', showStats);

  (async () => {
    try {
      const saved = await storage.loadLifetime();
      if (saved) lifetime = { ...emptyLifetime(), ...saved };
    } catch (e) { console.warn('could not load stats', e); }
    if (alive) startRun(env.seed || randomSeed());
  })();

  return {
    destroy() {
      alive = false;
      play.destroy();
      el.remove();
    },
    play,
  };
}
