// Invited, asynchronous nine-hole rounds.
import { h, createPlay, resultCard, openDialog, toneFor } from '../ui.js';
import { scoreName } from '../rules.js';
import { roundHoles, emptyRoundDraft, roundStates, roundResult, rankRoundPlayers } from '../rounds-model.js';

export function createRounds(root, env) {
  const { rounds, social, settings, openFriendProfile } = env;
  const el = h('div', { class: 'hg-mode' });
  root.append(el);
  let alive = true, play = null, generation = 0, draft = null, states = null, holes = null;
  let invitations = [], stopWatch = null, loading = true, listError = '', lastSave = Promise.resolve(), listVisible = false;

  function clear() {
    generation++;
    if (play) { play.destroy(); play = null; }
    el.textContent = '';
  }
  function notice(text) { return h('p', { class: 'hg-note', text }); }
  function button(text, fn, primary = false) {
    return h('button', { type: 'button', class: 'hg-btn' + (primary ? ' hg-primary' : ''), text, onclick: fn });
  }
  function showList() {
    listVisible = true;
    clear();
    const body = h('div', { class: 'hg-daily hg-rounds' },
      h('h2', { text: 'Rounds' }),
      notice('Play nine shared holes with friends, whenever it suits you.'),
      button('Create a round', showCreate, true));
    const list = h('div', { class: 'hg-panel' }, h('h3', { text: 'Your rounds' }));
    if (loading) list.append(notice('Loading rounds…'));
    else if (listError) list.append(notice('Could not load rounds. Check your connection.'));
    else if (!invitations.length) list.append(notice('No rounds yet. Create one or ask a friend to invite you.'));
    else for (const round of invitations) {
      const date = round.createdAt?.toDate?.();
      const detail = date ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'New round';
      list.append(h('button', { type: 'button', class: 'hg-round-row', onclick: () => openRound(round.id) },
        h('span', null, h('strong', { text: round.title }), h('span', { class: 'hg-note', text: detail })), h('span', { 'aria-hidden': 'true', text: '›' })));
    }
    body.append(list);
    el.append(body);
  }
  function showCreate() {
    listVisible = false;
    clear();
    const friends = social.getFriends().filter((f) => f.status === 'friend');
    const title = h('input', { class: 'hg-input', maxlength: '60', required: true, placeholder: 'e.g. Weekend nine', 'aria-label': 'Round name' });
    const status = h('p', { class: 'hg-note', role: 'status' });
    const choices = friends.map((f) => ({ ...f, input: h('input', { type: 'checkbox', value: f.uid }) }));
    const list = h('div', { class: 'hg-round-friends' }, choices.map((f) => h('label', { class: 'hg-round-choice' }, f.input, h('span', { text: f.name }))));
    const submit = h('button', { type: 'submit', class: 'hg-btn hg-primary', text: 'Create and invite' });
    const form = h('form', { class: 'hg-round-create' },
      h('label', null, h('strong', { text: 'Round name' }), title),
      h('strong', { text: 'Invite friends' }),
      friends.length ? list : notice('Add friends first, or create a round for yourself.'),
      notice('Everyone plays the same nine holes. Starting a round sends invitations inside Handi.'),
      submit, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!title.value.trim()) { status.textContent = 'Enter a round name.'; return; }
      submit.disabled = true; status.textContent = 'Creating round…';
      try {
        const result = await rounds.create(title.value, choices.filter((f) => f.input.checked).map(({ uid, name }) => ({ uid, name })));
        if (!alive) return;
        await openRound(result.id, result.failed.length ? 'Could not invite: ' + result.failed.join(', ') + '.' : '');
      } catch (error) {
        console.error(error); if (alive) { status.textContent = 'Could not create round. Check your connection and try again.'; submit.disabled = false; }
      }
    });
    el.append(h('div', { class: 'hg-daily hg-rounds' }, button('‹ Your rounds', showList), h('h2', { text: 'Create a round' }), h('div', { class: 'hg-panel' }, form)));
  }
  async function openRound(id, message = '') {
    listVisible = false;
    clear();
    const request = generation;
    el.append(h('div', { class: 'hg-daily' }, notice('Loading round…')));
    try {
      const data = await rounds.details(id);
      if (!alive || request !== generation) return;
      showRound(data, message);
    } catch (error) {
      console.error(error);
      if (!alive || request !== generation) return;
      clear(); el.append(h('div', { class: 'hg-daily' }, button('‹ Your rounds', showList), notice('Could not load this round. Check your connection.')));
    }
  }
  function openPlayer(player) {
    if (player.uid === rounds.uid) return;
    const connection = social.getFriends().find((f) => f.uid === player.uid);
    if (connection?.status === 'friend') return openFriendProfile(player.uid);
    const status = h('p', { class: 'hg-note', role: 'status', text: connection ? (connection.status === 'incoming' ? 'This player sent you a request. Open Friends to respond.' : 'Friend request already sent.') : 'Their profile is private until you become friends.' });
    const content = h('div', null, h('p', { text: player.name }), status);
    if (!connection) {
      const add = button('Send friend request', async () => {
        add.disabled = true;
        try { await social.getBackend().addPlayer({ uid: player.uid, name: player.name }); status.textContent = 'Friend request sent.'; }
        catch (error) { status.textContent = error.message || 'Could not send request.'; add.disabled = false; }
      }, true);
      content.append(add);
    }
    openDialog(env.root, 'Player profile', content);
  }
  function showScorecard(player, pars) {
    const score = player.score;
    const rows = score.holes.map((strokes, i) => h('tr', null,
      h('th', { scope: 'row', text: String(i + 1) }), h('td', { text: String(pars[i]) }), h('td', { text: String(strokes) }),
      h('td', { text: scoreName(strokes, pars[i]) })));
    openDialog(env.root, player.name + ' · scorecard', h('table', { class: 'hg-table' },
      h('thead', null, h('tr', null, ['Hole', 'Par', 'Strokes', 'Result'].map((x) => h('th', { scope: 'col', text: x })))),
      h('tbody', null, rows), h('tfoot', null, h('tr', null, h('th', { scope: 'row', text: 'Total' }),
        h('td', { text: String(pars.reduce((a, b) => a + b, 0)) }), h('td', { text: String(score.total) }), h('td')))));
  }
  function showInvite(data) {
    clear();
    const members = new Set(data.members.map((m) => m.uid));
    const choices = social.getFriends().filter((f) => f.status === 'friend' && !members.has(f.uid))
      .map((f) => ({ ...f, input: h('input', { type: 'checkbox', value: f.uid }) }));
    const list = h('div', { class: 'hg-round-friends' }, choices.map((f) => h('label', { class: 'hg-round-choice' }, f.input, h('span', { text: f.name }))));
    const status = h('p', { class: 'hg-note', role: 'status' });
    const send = h('button', { type: 'submit', class: 'hg-btn hg-primary', text: 'Send invitations' });
    const form = h('form', { class: 'hg-round-create' }, choices.length ? list : notice('All your friends are already invited.'), choices.length ? send : null, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const players = choices.filter((f) => f.input.checked).map(({ uid, name }) => ({ uid, name }));
      if (!players.length) { status.textContent = 'Choose at least one friend.'; return; }
      send.disabled = true; status.textContent = 'Sending invitations…';
      try {
        const failed = await rounds.invitePlayers(data.round.id, players);
        if (alive) openRound(data.round.id, failed.length ? 'Could not invite: ' + failed.join(', ') + '.' : 'Invitations sent.');
      } catch (error) { console.error(error); if (alive) { status.textContent = 'Could not send invitations.'; send.disabled = false; } }
    });
    el.append(h('div', { class: 'hg-daily hg-rounds' }, button('‹ Back to round', () => openRound(data.round.id)),
      h('h2', { text: 'Invite friends' }), h('div', { class: 'hg-panel' }, form)));
  }
  function showRound(data, message = '') {
    clear();
    const { round, members, scores } = data;
    const myScore = scores.find((s) => s.uid === rounds.uid);
    const ranking = rankRoundPlayers(members, scores);
    const view = h('div', { class: 'hg-daily hg-rounds' },
      button('‹ Your rounds', showList), h('h2', { text: round.title }),
      notice('Nine holes · scores are visible to everyone invited.'), message ? notice(message) : null);
    if (!myScore) view.append(button('Play or resume round', () => startPlaying(round), true));
    else view.append(notice('You finished in ' + myScore.total + ' strokes.'));
    const board = h('div', { class: 'hg-panel' }, h('h3', { text: 'Leaderboard' }), notice('Finished players are ranked by total strokes.'));
    for (let i = 0; i < ranking.length; i++) {
      const player = ranking[i];
      const who = h('button', { class: 'hg-round-name', type: 'button', text: player.name + (player.uid === rounds.uid ? ' (you)' : ''), onclick: () => openPlayer(player) });
      if (player.uid === rounds.uid) who.disabled = true;
      const row = h('div', { class: 'hg-round-row hg-round-ranking' },
        h('span', { class: 'hg-round-rank', text: player.score ? String(1 + ranking.filter((r) => r.score && r.score.total < player.score.total).length) : '–' }),
        who, h('span', { class: 'hg-round-total', text: player.score ? String(player.score.total) : 'Not finished' }));
      if (player.score) row.append(button('Scorecard', () => {
        try { showScorecard(player, round.pars); }
        catch (e) { openDialog(env.root, 'Scorecard', notice(e.message)); }
      }));
      board.append(row);
    }
    view.append(board, button('Refresh leaderboard', () => openRound(round.id)));
    if (round.hostUid === rounds.uid) view.append(button('Invite more friends', () => showInvite(data)));
    el.append(view);
  }
  async function startPlaying(round) {
    listVisible = false;
    clear();
    const request = generation;
    el.append(h('div', { class: 'hg-daily' }, notice('Loading your round…')));
    try {
      const loadedHoles = roundHoles(round.id, round.genVersion);
      const saved = await rounds.loadProgress(round.id);
      if (!alive || request !== generation) return;
      const nextDraft = saved || emptyRoundDraft();
      const nextStates = roundStates(loadedHoles, nextDraft);
      if (!nextStates) throw new Error('Saved progress could not be verified.');
      holes = loadedHoles; draft = nextDraft; states = nextStates; lastSave = Promise.resolve();
      const index = states.findIndex((s) => !s.done);
      if (index < 0) return finish(round);
      playHole(round, index);
    } catch (error) {
      console.error(error);
      if (!alive || request !== generation) return;
      clear(); el.append(h('div', { class: 'hg-daily' }, button('‹ Back to round', () => openRound(round.id)), notice(error.message || 'Could not load your progress.')));
    }
  }
  function save(round) {
    // Firestore queues writes in order and stores them offline. Snapshot the
    // draft so later shots cannot mutate an earlier write.
    const snapshot = JSON.parse(JSON.stringify(draft));
    lastSave = rounds.saveProgress(round.id, snapshot);
    lastSave.catch((error) => console.warn('could not save round progress', error));
  }
  function playHole(round, i) {
    clear();
    const bar = h('div', { class: 'hg-bar' }, h('span', { class: 'hg-bar-main', text: round.title + ' · hole ' + (i + 1) + ' of 9' }),
      button('Exit', () => openRound(round.id)));
    const playRoot = h('div', { class: 'hg-playroot' });
    el.append(bar, playRoot);
    play = createPlay(playRoot, {
      settings: () => ({ assist: false, latencyMs: settings.latencyMs || 0 }),
      onAimLocked(p) { draft.pendingAim = { hole: i, club: p.club, angle: p.angle }; save(round); },
      onShot(shot, state) { draft.holes[i] = { shots: state.shots }; draft.pendingAim = null; states[i] = state; save(round); },
      onDone(state) {
        states[i] = state;
        play.showCard(resultCard({ title: scoreName(state.strokes, holes[i].par, state), tone: toneFor(state.strokes, holes[i].par, state),
          subtitle: 'Hole ' + (i + 1) + ' of 9 · ' + state.strokes + ' strokes on a par ' + holes[i].par,
          tiles: [['Shots', state.shots.length], ['Putts', state.putts], ['Penalties', state.penalties]],
          actions: [{ label: i === 8 ? 'Finish round' : 'Next hole', primary: true, onClick: () => i === 8 ? finish(round) : playHole(round, i + 1) }] }));
      },
    });
    play.load(holes[i], { holeNo: (i + 1) + '/9', state: states[i], pendingAim: draft.pendingAim?.hole === i ? draft.pendingAim : null });
  }
  async function finish(round) {
    clear();
    const request = generation;
    const status = notice('Saving your score… Keep this page open until it is saved.');
    el.append(h('div', { class: 'hg-daily' }, status));
    try {
      save(round);
      await Promise.race([lastSave, new Promise((_, reject) => setTimeout(() => reject(new Error('The connection is taking too long.')), 12000))]);
      await rounds.submit(round.id, roundResult(states));
      if (alive && request === generation) openRound(round.id);
    } catch (error) {
      console.error(error);
      if (alive && request === generation) {
        status.textContent = 'Could not save your score. Check your connection and retry.';
        el.firstChild.append(button('Retry', () => finish(round), true), button('Back to round', () => openRound(round.id)));
      }
    }
  }
  stopWatch = rounds.watchMine((list) => {
    if (!alive) return;
    invitations = list; loading = false; listError = '';
    if (listVisible) showList();
  }, (error) => {
    console.warn('could not load rounds', error); loading = false; listError = 'error';
    if (alive && listVisible) showList();
  });
  showList();
  return { destroy() { alive = false; stopWatch?.(); clear(); el.remove(); } };
}
