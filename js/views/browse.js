// Browse — placeholder. Built at its checkpoint in CLAUDE.md.
import { el } from '../ui.js';

export function render(panel) {
  panel.append(
    el('div', { class: 'wrap' },
      el('div', { class: 'empty' },
        el('p', { class: 'empty-title' }, 'Browse'),
        el('p', {}, 'Not built yet.'))),
  );
}
