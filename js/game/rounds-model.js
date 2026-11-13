// Pure rules for an asynchronous nine-hole round.
import { GEN_VERSION } from './constants.js';
import { generateHole } from './generate.js';
import { isValidInput, replay } from './rules.js';

export const ROUND_HOLES = 9;

export function roundHoles(id, version = GEN_VERSION) {
  if (version !== GEN_VERSION) throw new Error('This round uses an older game version and cannot be played with this version.');
  return Array.from({ length: ROUND_HOLES }, (_, i) => generateHole(`handi-round-v1|${id}|${i + 1}`));
}

export function emptyRoundDraft() {
  return { genVersion: GEN_VERSION, holes: Array.from({ length: ROUND_HOLES }, () => ({ shots: [] })), pendingAim: null };
}

export function roundStates(holes, draft) {
  if (!draft || draft.genVersion !== GEN_VERSION || !Array.isArray(draft.holes) || draft.holes.length !== ROUND_HOLES) return null;
  try {
    const states = draft.holes.map((h, i) => {
      if (!h || !Array.isArray(h.shots) || h.shots.length > 12 || !h.shots.every(isValidInput)) throw new Error('Invalid shot log');
      return replay(holes[i], h.shots);
    });
    for (let i = 0; i < ROUND_HOLES - 1; i++) if (!states[i].done && draft.holes[i + 1].shots.length) return null;
    if (draft.pendingAim) {
      const p = draft.pendingAim;
      const firstOpen = states.findIndex((s) => !s.done);
      if (p.hole !== firstOpen || !isValidInput({ club: p.club, angle: p.angle, power: 0 })) return null;
    }
    return states;
  } catch { return null; }
}

export function roundResult(states) {
  if (states.length !== ROUND_HOLES || states.some((s) => !s.done)) throw new Error('Finish all nine holes first.');
  const holes = states.map((s) => s.strokes);
  return { holes, total: holes.reduce((sum, strokes) => sum + strokes, 0) };
}

export function rankRoundPlayers(members, scores) {
  const byUid = new Map(scores.map((s) => [s.uid, s]));
  return members.map((m) => ({ ...m, score: byUid.get(m.uid) || null }))
    .sort((a, b) => (a.score?.total ?? Infinity) - (b.score?.total ?? Infinity) || a.name.localeCompare(b.name));
}
