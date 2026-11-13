// Daily mode: built in milestone 4. Placeholder so the entry point resolves.

import { h } from '../ui.js';

export function createDaily(root) {
  const el = h('div', { class: 'hg-mode' }, h('p', { class: 'hg-note', text: 'Daily mode is not built yet.' }));
  root.append(el);
  return { destroy() { el.remove(); } };
}
