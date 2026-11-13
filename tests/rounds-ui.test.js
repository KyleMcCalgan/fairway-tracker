import test from 'node:test';
import assert from 'node:assert/strict';
import { createRounds } from '../js/game/modes/rounds.js';

// Minimal DOM for checking the round navigation and participant actions.
class Element {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.events = {}; this.attrs = {}; this._text = ''; this.disabled = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, fn) { this.events[type] = fn; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  async fire(type) { return this.events[type]?.({ preventDefault() {} }); }
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
const find = (node, tag, text) => walk(node).find((el) => el.tag === tag && el.textContent === text);

test('round list, scorecard and private non-friend profile actions', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => { const n = new Element('#text'); n.textContent = text; return n; } };
  try {
    const host = new Element('host'), gameRoot = new Element('root');
    const data = {
      round: { id: 'r1', title: 'Weekend nine', hostUid: 'me', genVersion: 1, pars: [3, 4, 5, 3, 4, 5, 3, 4, 5] },
      members: [{ uid: 'me', name: 'Me' }, { uid: 'other', name: 'Other player' }],
      scores: [{ uid: 'other', holes: [3, 4, 5, 3, 4, 5, 3, 4, 5], total: 36 }],
    };
    let watcher, requested = null, stopped = false, connected = false, openedProfile = null;
    const rounds = { uid: 'me', watchMine(cb) { watcher = cb; return () => { stopped = true; }; }, details: async () => data };
    const social = { getFriends: () => connected ? [{ uid: 'other', status: 'friend' }] : [], getBackend: () => ({ addPlayer: async (p) => { requested = p; } }) };
    const mode = createRounds(host, { rounds, social, settings: {}, root: gameRoot, openFriendProfile: (uid) => { openedProfile = uid; } });
    watcher([{ id: 'r1', title: 'Weekend nine' }]);
    const row = walk(host).find((el) => el.tag === 'button' && el.textContent.includes('Weekend nine'));
    await row.fire('click');
    assert.ok(host.textContent.includes('Leaderboard'));
    await find(host, 'button', 'Scorecard').fire('click');
    assert.ok(gameRoot.textContent.includes('Other player · scorecard'));
    assert.ok(gameRoot.textContent.includes('Total'));
    await find(host, 'button', 'Other player').fire('click');
    assert.ok(gameRoot.textContent.includes('Their profile is private until you become friends.'));
    await find(gameRoot, 'button', 'Send friend request').fire('click');
    assert.deepEqual(requested, { uid: 'other', name: 'Other player' });
    connected = true;
    await find(host, 'button', 'Other player').fire('click');
    assert.equal(openedProfile, 'other');
    mode.destroy();
    assert.equal(stopped, true);
  } finally { globalThis.document = originalDocument; }
});

test('creating a round sends only the friends selected by the host', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => { const n = new Element('#text'); n.textContent = text; return n; } };
  try {
    const host = new Element('host'), root = new Element('root');
    let watcher, created;
    const rounds = {
      uid: 'me', watchMine(cb) { watcher = cb; return () => {}; },
      async create(title, players) { created = { title, players }; return { id: 'new', failed: [] }; },
      async details() { return { round: { id: 'new', title: 'Weekend', hostUid: 'me', pars: Array(9).fill(4) }, members: [{ uid: 'me', name: 'Me' }], scores: [] }; },
    };
    const social = { getFriends: () => [{ uid: 'a', name: 'A', status: 'friend' }, { uid: 'b', name: 'B', status: 'friend' }] };
    const mode = createRounds(host, { rounds, social, settings: {}, root, openFriendProfile() {} });
    watcher([]);
    await find(host, 'button', 'Create a round').fire('click');
    const inputs = walk(host).filter((el) => el.tag === 'input');
    inputs[0].value = 'Weekend';
    inputs[1].checked = true;
    inputs[2].checked = false;
    await walk(host).find((el) => el.tag === 'form').fire('submit');
    assert.deepEqual(created, { title: 'Weekend', players: [{ uid: 'a', name: 'A' }] });
    assert.ok(host.textContent.includes('Leaderboard'));
    mode.destroy();
  } finally { globalThis.document = originalDocument; }
});
