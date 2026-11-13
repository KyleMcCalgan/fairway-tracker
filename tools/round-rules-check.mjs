// Run against a local Firestore emulator started with firestore.rules.
// This uses mock emulator authentication and never contacts a real project.
import assert from 'node:assert/strict';

const project = 'demo-handi-rounds';
const base = `http://127.0.0.1:8792/v1/projects/${project}/databases/(default)/documents`;
const name = (path) => `projects/${project}/databases/(default)/documents/${path}`;
const token = (uid) => {
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: uid, user_id: uid, aud: project, iss: `https://securetoken.google.com/${project}`, iat: 1, exp: 4102444800, firebase: { sign_in_provider: 'custom' } })}.`;
};
function value(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  return { mapValue: { fields: fields(v) } };
}
const fields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]));
const update = (path, data, timestamp = false) => ({ update: { name: name(path), fields: fields(data) }, ...(timestamp ? { updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] } : {}) });
async function request(uid, suffix, method = 'GET', body) {
  const response = await fetch(base + suffix, { method, headers: { Authorization: `Bearer ${token(uid)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, text };
}
async function commit(uid, writes, expected = 200) {
  const result = await request(uid, ':commit', 'POST', { writes });
  assert.equal(result.status, expected, result.text);
}
async function expect(uid, path, status) {
  const result = await request(uid, '/' + path);
  assert.equal(result.status, status, result.text);
}

await commit('alice', [update('friendships/alice_bob', { users: ['alice', 'bob'], requestedBy: 'alice', status: 'pending', names: { alice: 'Alice', bob: 'Bob' } })]);
await commit('bob', [{ update: { name: name('friendships/alice_bob'), fields: fields({ status: 'accepted' }) }, updateMask: { fieldPaths: ['status'] } }]);
await commit('alice', [update('gameRounds/r1', { title: 'Weekend nine', hostUid: 'alice', genVersion: 1, pars: [3, 4, 5, 3, 4, 5, 3, 4, 5] }, true)]);
await commit('alice', [update('users/alice/gameRounds/r1', { hostUid: 'alice' }), update('gameRounds/r1/members/alice', { name: 'Alice' })]);
await commit('alice', [update('users/bob/gameRounds/r1', { hostUid: 'alice' }), update('gameRounds/r1/members/bob', { name: 'Bob' })]);
await commit('alice', [update('users/eve/gameRounds/r1', { hostUid: 'alice' }), update('gameRounds/r1/members/eve', { name: 'Eve' })], 403);
await expect('bob', 'gameRounds/r1', 200);
await expect('eve', 'gameRounds/r1', 403);
await expect('alice', 'gameRounds/r1/members', 200);
await expect('eve', 'gameRounds/r1/members', 403);
await expect('bob', 'users/bob/gameRounds', 200);
await expect('alice', 'users/bob/gameRounds', 403);
await commit('bob', [update('gameRounds/r1/progress/bob', { genVersion: 1, holes: Array.from({ length: 9 }, () => ({ shots: [] })), pendingAim: null })]);
await expect('alice', 'gameRounds/r1/progress/bob', 403);
await expect('bob', 'gameRounds/r1/progress/bob', 200);
const holes = Array.from({ length: 9 }, () => 4);
await commit('bob', [update('gameRounds/r1/scores/bob', { holes, total: 36 }, true)]);
await expect('alice', 'gameRounds/r1/scores/bob', 200);
await expect('eve', 'gameRounds/r1/scores/bob', 403);
await commit('bob', [update('gameRounds/r1/scores/bob', { holes, total: 36 }, true)], 403);
await commit('alice', [update('gameRounds/r1/scores/bob', { holes, total: 36 }, true)], 403);
await commit('alice', [update('gameRounds/r1/scores/alice', { holes, total: 1 }, true)], 403);
await commit('alice', [update('gameRounds/r1/progress/bob', { genVersion: 1, holes: [], pendingAim: null })], 403);
await commit('bob', [
  { delete: name('gameRounds/r1/progress/bob') }, { delete: name('gameRounds/r1/scores/bob') },
  { delete: name('gameRounds/r1/members/bob') }, { delete: name('users/bob/gameRounds/r1') },
]);
await expect('bob', 'gameRounds/r1', 403);
console.log('Round rules: participant access, invitations, private progress and score validation passed.');
