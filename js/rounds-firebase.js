// Firestore adapter for invited nine-hole rounds. The game itself stays Firebase-free.
import { getDb } from './firebase.js?v=20261114-3';
import { GEN_VERSION } from './game/constants.js';
import { roundHoles } from './game/rounds-model.js?v=20261114-3';
import { doc, collection, getDoc, getDocs, setDoc, writeBatch, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export function createRoundsBackend(user, socialBackend) {
  const db = getDb();
  const uid = user.uid;
  const group = (id) => doc(db, 'gameRounds', id);
  const invite = (who, id) => doc(db, 'users', who, 'gameRounds', id);
  const member = (id, who) => doc(db, 'gameRounds', id, 'members', who);
  const progress = (id) => doc(db, 'gameRounds', id, 'progress', uid);
  const score = (id, who) => doc(db, 'gameRounds', id, 'scores', who);

  async function invitePlayers(id, players) {
    const failed = [];
    for (const player of players) {
      try {
        const batch = writeBatch(db);
        batch.set(invite(player.uid, id), { hostUid: uid });
        batch.set(member(id, player.uid), { name: player.name });
        await batch.commit();
      } catch (error) { console.warn('round invite failed', error); failed.push(player.name); }
    }
    return failed;
  }

  async function create(title, friends) {
    const clean = String(title || '').trim().slice(0, 60);
    if (!clean) throw new Error('Give your round a name.');
    const me = await socialBackend.profile();
    const ref = doc(collection(db, 'gameRounds'));
    const pars = roundHoles(ref.id).map((hole) => hole.par);
    await setDoc(ref, { title: clean, hostUid: uid, genVersion: GEN_VERSION, pars, createdAt: serverTimestamp() });
    // Each invitation is a separate atomic pair, so round size is not limited
    // by Firestore's per-batch write and rules-access limits.
    const ownFailure = await invitePlayers(ref.id, [{ uid, name: me.name }]);
    if (ownFailure.length) throw new Error('Could not create your round invitation.');
    const failed = await invitePlayers(ref.id, friends);
    return { id: ref.id, failed };
  }

  function watchMine(callback, onError) {
    let current = 0, active = true;
    const stop = onSnapshot(collection(db, 'users', uid, 'gameRounds'), async (snapshot) => {
      const request = ++current;
      try {
        const items = await Promise.all(snapshot.docs.map(async (d) => {
          const g = await getDoc(group(d.id));
          return g.exists() ? { id: g.id, ...g.data() } : null;
        }));
        if (active && request === current) callback(items.filter(Boolean).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
      } catch (e) { if (active && request === current) onError(e); }
    }, onError);
    return () => { active = false; stop(); };
  }
  async function details(id) {
    const [g, members, scores] = await Promise.all([
      getDoc(group(id)), getDocs(collection(db, 'gameRounds', id, 'members')), getDocs(collection(db, 'gameRounds', id, 'scores')),
    ]);
    if (!g.exists()) throw new Error('This round is unavailable.');
    return {
      round: { id, ...g.data() },
      members: members.docs.map((d) => ({ uid: d.id, ...d.data() })),
      scores: scores.docs.map((d) => ({ uid: d.id, ...d.data() })),
    };
  }
  async function loadProgress(id) {
    const d = await getDoc(progress(id));
    return d.exists() ? d.data() : null;
  }
  const saveProgress = (id, data) => setDoc(progress(id), JSON.parse(JSON.stringify(data)));
  async function submit(id, result) {
    const ref = score(id, uid);
    const existing = await getDoc(ref);
    if (existing.exists()) return existing.data();
    await setDoc(ref, { ...JSON.parse(JSON.stringify(result)), createdAt: serverTimestamp() });
    return result;
  }
  return { uid, create, invitePlayers, watchMine, details, loadProgress, saveProgress, submit };
}
