// Endless practice: a fresh random hole every time, session scorecard and
// lifetime stats (docs/game.md 7). DOM-touching.

import { generateHole } from '../generate.js';
import { scoreName } from '../rules.js';
import { h, createPlay, resultCard, openDialog, formatVsPar } from '../ui.js';

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

export function createEndless(root, env) {
  const { storage, settings } = env;
  const session = []; // [{ seed, par, strokes, state }]
  let lifetime = emptyLifetime();
  let hole = null;
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
    seedBtn.textContent = 'Seed ' + (hole ? hole.seed : '');
    seedBtn.setAttribute('aria-label', 'Seed ' + (hole ? hole.seed : '') + '. Copy it or play another seed.');
  }

  // Fresh seed each hole. Softly avoid repeating the previous hole's par or
  // archetype by re-rolling the seed a few times; the seed alone still
  // reproduces the hole.
  function nextHole(seed) {
    const prev = hole;
    let next = generateHole(seed || randomSeed());
    if (!seed && prev) {
      for (let i = 0; i < 3 && (next.par === prev.par || next.meta.archetype === prev.meta.archetype); i++) {
        next = generateHole(randomSeed());
      }
    }
    hole = next;
    play.load(hole, { holeNo: session.length + 1 });
    updateBar();
  }

  async function onDone(state) {
    session.push({ seed: hole.seed, par: hole.par, strokes: state.strokes, state });
    lifetime = addToLifetime(lifetime, hole.par, state);
    try { await storage.saveLifetime(lifetime); } catch (e) { console.warn('could not save stats', e); }
    if (!alive) return;
    updateBar();
    const parts = [state.shots.length + (state.shots.length === 1 ? ' shot' : ' shots')];
    if (state.putts) parts.push(state.putts + (state.putts === 1 ? ' putt' : ' putts'));
    if (state.penalties) parts.push(state.penalties + (state.penalties === 1 ? ' penalty' : ' penalties'));
    play.showCard(resultCard({
      title: scoreName(state.strokes, hole.par, state),
      lines: [
        state.strokes + ' on a par ' + hole.par + ' (' + parts.join(', ') + ')',
        'Session: ' + formatVsPar(sessionVsPar()) + ' after ' + session.length + (session.length === 1 ? ' hole' : ' holes'),
        'Seed: ' + hole.seed,
      ],
      actions: [
        { label: 'Next hole', primary: true, onClick: () => nextHole() },
        { label: 'Replay this hole', onClick: () => nextHole(hole.seed) },
      ],
    }));
  }

  function showCard() {
    const rows = session.map((r, i) => h('tr', null,
      h('td', { text: String(i + 1) }), h('td', { text: String(r.par) }), h('td', { text: String(r.strokes) }),
      h('td', { text: scoreName(r.strokes, r.par, r.state) }), h('td', { class: 'hg-mono', text: r.seed })));
    const body = session.length
      ? h('table', { class: 'hg-table' },
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
    const rows = [
      ['Holes played', s.holes],
      ['Average versus par', s.holes ? (avg >= 0 ? '+' : '−') + Math.abs(avg).toFixed(2) : '–'],
      ['Best streak of par or better', s.bestStreak],
      ['Birdies', s.birdies],
      ['Eagles or better', s.eagles],
      ['Holes-in-one', s.holesInOne],
      ['Out of bounds', s.ob],
      ['Water balls', s.water],
    ];
    openDialog(root, 'Lifetime stats', h('dl', { class: 'hg-stats' },
      rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])));
  }

  function showSeed() {
    const input = h('input', { class: 'hg-input', id: 'hg-seed-in', type: 'text', maxlength: '40', autocomplete: 'off', spellcheck: 'false' });
    const status = h('p', { class: 'hg-note', role: 'status' });
    const copy = h('button', { class: 'hg-btn', type: 'button', text: 'Copy seed' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(hole.seed); status.textContent = 'Copied.'; }
      catch { status.textContent = 'Could not copy. Select the seed above and copy it by hand.'; }
    });
    const go = h('button', { class: 'hg-btn hg-primary', type: 'submit', text: 'Play this seed' });
    const form = h('form', { class: 'hg-form' },
      h('label', { for: 'hg-seed-in', text: 'Play a seed' }), input, go);
    const dlg = openDialog(root, 'Hole seed', h('div', null,
      h('p', null, 'This hole: ', h('strong', { class: 'hg-mono hg-select', text: hole.seed })),
      h('p', { class: 'hg-note', text: 'The same seed always builds the same hole.' }),
      copy, status, form));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { status.textContent = 'Type a seed first.'; return; }
      dlg.close();
      nextHole(v);
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
    if (alive) nextHole(env.seed);
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
