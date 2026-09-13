// The command palette. Cmd/Ctrl+K.
//
// Two things in one list: commands, and card search. Typing anything that is
// not a command falls through to full-text search across the deck, and the
// existing tag: and subj: syntax keeps working because the query goes through
// the same db.listCards filters Browse uses.
//
// Keyboard is the fast path, never the required one — every command here also
// exists as a visible control somewhere in the app.

import { el, clear, plainText, toast } from './ui.js';
import { icon } from './icons.js';
import { frontTextOf } from './importer.js';
import * as db from './db.js';

let close = null;

export function openPalette(ctx) {
  if (close) return;                     // already open
  const root = document.getElementById('palette-root');
  const restoreFocus = document.activeElement;
  clear(root);
  root.hidden = false;

  const input = el('input', {
    class: 'palette-input', type: 'text', spellcheck: 'false',
    placeholder: 'Search cards, or type a command…',
    'aria-label': 'Search cards or run a command',
    'aria-controls': 'palette-list', 'aria-expanded': 'true', role: 'combobox',
  });

  const list = el('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const hintBar = el('div', { class: 'palette-foot' },
    kbdHint('↑↓', 'Navigate'), kbdHint('↵', 'Run'), kbdHint('esc', 'Close'));

  const box = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    el('div', { class: 'palette-head' },
      el('span', { class: 'palette-icon', 'aria-hidden': 'true' }, icon('search', { size: 16 })),
      input),
    list, hintBar);

  root.append(box);

  const COMMANDS = commands(ctx);
  let rows = [];
  let active = 0;
  let searchToken = 0;

  function kbdHint(key, label) {
    return el('span', { class: 'palette-hint' }, el('kbd', { class: 'kbd' }, key), label);
  }

  function paint() {
    clear(list);
    if (!rows.length) {
      list.append(el('div', { class: 'palette-empty' }, 'Nothing matches.'));
      return;
    }
    let group = null;
    rows.forEach((row, i) => {
      if (row.group !== group) {
        group = row.group;
        list.append(el('div', { class: 'palette-group' }, group));
      }
      const node = el('button', {
        class: i === active ? 'palette-row is-active' : 'palette-row',
        type: 'button', role: 'option', 'aria-selected': String(i === active),
      },
        el('span', { class: 'palette-row-icon', 'aria-hidden': 'true' }, icon(row.icon, { size: 15 })),
        el('span', { class: 'palette-row-label' }, row.label),
        row.meta ? el('span', { class: 'palette-row-meta' }, row.meta) : null,
      );
      node.addEventListener('click', () => run(row));
      node.addEventListener('mousemove', () => { if (active !== i) { active = i; paint(); } });
      list.append(node);
    });
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  async function refresh() {
    const q = input.value.trim();
    const token = ++searchToken;

    const matched = COMMANDS.filter((c) => !q || fuzzy(c.label, q));
    rows = matched.map((c) => ({ ...c, group: 'Commands' }));
    active = 0;
    paint();

    if (q.length < 2) return;

    try {
      const { rows: cards } = await db.listCards({
        filters: { search: q }, sort: 'updated_at', dir: 'desc', pageSize: 7,
      });
      if (token !== searchToken) return;                 // a newer keystroke won
      const found = cards.map((card) => ({
        group: 'Cards', icon: 'browse',
        label: plainText(frontTextOf(card.content)) || '(no front text)',
        meta: card.type,
        act: () => ctx.navigate('browse', { cardId: card.id, search: q }),
      }));
      rows = [...rows, ...found];
      paint();
    } catch (err) {
      if (token !== searchToken) return;
      rows = [...rows, { group: 'Cards', icon: 'alert', label: `Search failed: ${err.message}`, act: () => {} }];
      paint();
    }
  }

  function run(row) {
    finish();
    try { row.act(); } catch (err) { toast(`Could not run that: ${err.message}`, 'err'); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) run(rows[active]); }
  }

  function finish() {
    root.hidden = true;
    clear(root);
    document.removeEventListener('keydown', onKey, true);
    close = null;
    restoreFocus?.focus?.();
  }
  close = finish;

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 130);
  });
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', (e) => { if (e.target === root) finish(); });

  refresh();
  input.focus();
}

/** Every command here is also a visible control elsewhere in the app. */
function commands(ctx) {
  const { state, navigate, setEdit } = ctx;
  return [
    { icon: 'drill',    label: 'Start a drill session',  act: () => navigate('drill') },
    { icon: 'drill',    label: 'Cram (no schedule change)', act: () => navigate('drill', { mode: 'cram' }) },
    { icon: 'alert',    label: 'Drill weak cards',       act: () => navigate('drill', { mode: 'weak' }) },
    { icon: 'browse',   label: 'Browse all cards',       act: () => navigate('browse') },
    { icon: 'star',     label: 'Browse starred cards',   act: () => navigate('browse', { starred: true }) },
    { icon: 'trash',    label: 'Open trash',             act: () => navigate('browse', { trash: true }) },
    { icon: 'import',   label: 'Import cards',           act: () => navigate('import') },
    { icon: 'stats',    label: 'Open stats',             act: () => navigate('stats') },
    { icon: 'settings', label: 'Open settings',          act: () => navigate('settings') },
    {
      icon: 'edit',
      label: state.editMode ? 'Turn edit mode off' : 'Turn edit mode on',
      meta: 'E',
      act: () => setEdit(!state.editMode),
    },
    ...state.subjects.map((s) => ({
      icon: 'subject', label: `Go to ${s.name}`, meta: s.code ?? '',
      act: () => navigate('subject', { subjectId: s.id }),
    })),
  ];
}

/** Subsequence match, so "sta" finds "Open stats" and "drl" finds "Start a drill". */
function fuzzy(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of q) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}
