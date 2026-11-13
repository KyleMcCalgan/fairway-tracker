import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShot } from '../js/game/rules.js';
import { GEN_VERSION } from '../js/game/constants.js';
import { roundHoles, emptyRoundDraft, roundStates, roundResult, rankRoundPlayers } from '../js/game/rounds-model.js';

test('nine holes are identical for every player in a round and differ between rounds', () => {
  const holes = roundHoles('round-one');
  assert.equal(holes.length, 9);
  assert.deepEqual(holes, roundHoles('round-one'));
  assert.notEqual(holes[0].seed, roundHoles('round-two')[0].seed);
  assert.throws(() => roundHoles('round-one', GEN_VERSION + 1), /older game version/);
});

test('progress resumes from verified shots, and invalid or out-of-order drafts are rejected', () => {
  const holes = roundHoles('resume-test');
  const draft = emptyRoundDraft();
  let states = roundStates(holes, draft);
  assert.equal(states.length, 9);
  let state = states[0];
  while (!state.done) state = applyShot(holes[0], state, { club: 'driver', angle: 0, power: 0 }).state;
  draft.holes[0] = { shots: state.shots };
  states = roundStates(holes, draft);
  assert.equal(states[0].strokes, state.strokes);
  assert.equal(states[0].done, true);
  draft.pendingAim = { hole: 1, club: 'iron', angle: 10 };
  assert.ok(roundStates(holes, draft));
  draft.pendingAim.hole = 2;
  assert.equal(roundStates(holes, draft), null);
  draft.pendingAim = null;
  draft.holes[2] = { shots: [{ club: 'driver', angle: 0, power: 0 }] };
  assert.equal(roundStates(holes, draft), null);
  assert.throws(() => roundResult(states), /Finish all nine/);
});

test('finished scorecards total all holes and leaderboard retains unfinished players', () => {
  const states = Array.from({ length: 9 }, (_, i) => ({ done: true, strokes: i + 1, putts: 1, penalties: 0, shots: [] }));
  const score = roundResult(states);
  assert.equal(score.holes.length, 9);
  assert.equal(score.total, 45);
  assert.deepEqual(rankRoundPlayers([{ uid: 'a', name: 'A' }, { uid: 'b', name: 'B' }, { uid: 'c', name: 'C' }],
    [{ uid: 'a', total: 45 }, { uid: 'b', total: 39 }]).map((p) => p.uid), ['b', 'a', 'c']);
});
