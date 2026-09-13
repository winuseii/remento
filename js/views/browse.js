// Browse — the table, the filter bar, search, bulk actions and the trash.
// An instrument screen: mono, tight rows, tabular numbers, no decoration.

import {
  el, clear, toast, toastError, plainText, pluralise, confirmDialog, promptDialog,
  loadingBlock, errorBlock, fmtInterval, fmtDue,
} from '../ui.js';
import * as db from '../db.js';
import { frontTextOf, CARD_TYPES } from '../importer.js';
import { renderFront, renderBack } from '../card-render.js';
import { editCard } from '../card-editor.js';
import { isLeech } from '../scheduler.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 50;

const COLUMNS = [
  { key: 'star', label: '', sort: 'starred', width: '28px' },
  { key: 'front', label: 'Front', sort: null },
  { key: 'type', label: 'Type', sort: 'type' },
  { key: 'unit', label: 'Unit', sort: 'unit_id' },
  { key: 'tags', label: 'Tags', sort: null },
  { key: 'due', label: 'Due', sort: 'due', num: true },
  { key: 'ivl', label: 'Ivl', sort: 'ivl', num: true },
  { key: 'reps', label: 'Reps', sort: 'reps', num: true },
  { key: 'lapses', label: 'Lapses', sort: 'lapses', num: true },
  { key: 'retention', label: 'Ret', sort: null, num: true },
];

export async function render(panel, ctx) {
  const { state, onStateChange, setHeader, args } = ctx;

  const root = el('div', { class: 'wrap browse-root' });
  panel.append(root);

  const q = {
    search: args?.search ?? '',
    subjectId: state.focus.subjectId ?? null,
    unitId: null,
    type: '',
    importance: '',
    tag: '',
    starred: Boolean(args?.starred),
    suspended: null,
    trash: Boolean(args?.trash),
    sort: 'updated_at',
    dir: 'desc',
    page: 0,
  };

  let rows = [];
  let total = 0;
  let retention = new Map();
  const selected = new Set();

  const bar = el('div');
  const tableBox = el('div');

  const unsub = onStateChange((what) => { if (what === 'editMode') draw(); });

  // ── query ─────────────────────────────────────────────────────────────────

  /**
   * `tag:derivation` and `subj:thermo` filter instead of searching (§5.4).
   * Everything left over goes to the full-text index.
   */
  function buildFilters() {
    let text = q.search;
    const tags = [...(q.tag ? [q.tag] : [])];
    let subjectId = q.subjectId;

    text = text.replace(/\btag:([^\s]+)/gi, (_, t) => { tags.push(t.toLowerCase()); return ''; });
    text = text.replace(/\bsubj(?:ect)?:([^\s]+)/gi, (_, s) => {
      const hit = state.subjects.find((x) => x.slug.startsWith(s.toLowerCase())
        || x.name.toLowerCase().startsWith(s.toLowerCase()));
      if (hit) subjectId = hit.id;
      return '';
    });
    text = text.trim();

    return {
      trash: q.trash,
      ...(subjectId ? { subjectId } : {}),
      ...(q.unitId ? { unitId: q.unitId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.importance ? { importance: q.importance } : {}),
      ...(tags.length ? { tags } : {}),
      ...(q.starred ? { starred: true } : {}),
      ...(q.suspended === null ? {} : { suspended: q.suspended }),
      ...(text ? { search: text } : {}),
    };
  }

  async function load() {
    clear(tableBox);
    tableBox.append(loadingBlock('Loading cards…'));
    try {
      const res = await db.listCards({
        filters: buildFilters(), sort: q.sort, dir: q.dir, page: q.page, pageSize: PAGE_SIZE,
      });
      rows = res.rows;
      total = res.total;
      retention = await loadRetention(rows).catch(() => new Map());
      drawTable();
    } catch (err) {
      clear(tableBox);
      tableBox.append(errorBlock(err, load));
    }
  }

  /** Per-card retention over the visible page only — one extra query, bounded. */
  async function loadRetention(pageRows) {
    if (!pageRows.length) return new Map();
    const stats = await db.reviewStatsFor(pageRows.map((r) => r.id));
    return stats;
  }

  // ── filter bar ────────────────────────────────────────────────────────────

  function drawBar() {
    clear(bar);

    const search = el('input', {
      class: 'input', type: 'search', value: q.search,
      placeholder: 'Search everything · tag:derivation · subj:thermo',
    });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { q.search = search.value; q.page = 0; load(); }, 280);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(t); q.search = search.value; q.page = 0; load(); }
    });

    const subSel = el('select', { class: 'select' },
      el('option', { value: '' }, 'All subjects'),
      state.subjects.map((s) => el('option', { value: s.id, selected: s.id === q.subjectId }, s.name)),
    );
    subSel.addEventListener('change', () => {
      q.subjectId = subSel.value || null; q.unitId = null; q.page = 0; drawBar(); load();
    });

    const units = state.units.filter((u) => u.subject_id === q.subjectId).sort((a, b) => a.no - b.no);
    const unitSel = el('select', { class: 'select', disabled: !units.length },
      el('option', { value: '' }, 'All units'),
      units.map((u) => el('option', { value: u.id, selected: u.id === q.unitId }, `Unit ${u.no}`)),
    );
    unitSel.addEventListener('change', () => { q.unitId = unitSel.value || null; q.page = 0; load(); });

    const typeSel = el('select', { class: 'select' },
      el('option', { value: '' }, 'All types'),
      CARD_TYPES.map((t2) => el('option', { value: t2, selected: t2 === q.type }, t2)),
    );
    typeSel.addEventListener('change', () => { q.type = typeSel.value; q.page = 0; load(); });

    const impSel = el('select', { class: 'select' },
      el('option', { value: '' }, 'Any importance'),
      [3, 2, 1].map((n) => el('option', { value: n, selected: String(n) === String(q.importance) },
        '★'.repeat(n))),
    );
    impSel.addEventListener('change', () => { q.importance = impSel.value; q.page = 0; load(); });

    const toggle = (label, on, fn) => {
      const b = el('button', { class: on ? 'btn btn-sm is-on' : 'btn btn-sm btn-ghost', type: 'button' }, label);
      b.addEventListener('click', () => { fn(); q.page = 0; drawBar(); load(); });
      return b;
    };

    bar.append(el('section', { class: 'card-panel filter-bar' },
      el('div', { class: 'search-wrap' },
        el('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon('search', { size: 16 })),
        search),
      el('div', { class: 'filter-row' },
        subSel, unitSel, typeSel, impSel,
        toggle('★ Starred', q.starred, () => { q.starred = !q.starred; }),
        toggle('Suspended', q.suspended === true, () => { q.suspended = q.suspended === true ? null : true; }),
        toggle('Trash', q.trash, () => { q.trash = !q.trash; selected.clear(); }),
      ),
    ));
  }

  // ── table ─────────────────────────────────────────────────────────────────

  function drawTable() {
    clear(tableBox);

    if (state.editMode && selected.size) tableBox.append(bulkBar());

    if (!rows.length) {
      tableBox.append(el('div', { class: 'empty' },
        el('p', { class: 'empty-title' }, q.trash ? 'Trash is empty' : 'No cards match'),
        el('p', {}, q.trash
          ? 'Deleted cards land here and are purged automatically after 10 days.'
          : 'Widen the filter, or import some cards.'),
      ));
      return;
    }

    const head = el('tr', {},
      state.editMode ? el('th', { class: 'col-pick' }, selectAllBox()) : null,
      COLUMNS.map((c) => {
        const active = c.sort && q.sort === c.sort;
        const th = el('th', {
          class: [c.num ? 'num' : '', c.sort ? 'is-sortable' : '', active ? 'is-active' : '']
            .filter(Boolean).join(' '),
          style: c.width ? `width:${c.width}` : null,
          scope: 'col',
          // aria-sort is how a screen reader learns the table is ordered at all.
          'aria-sort': c.sort ? (active ? (q.dir === 'asc' ? 'ascending' : 'descending') : 'none') : null,
        }, c.label, active ? (q.dir === 'asc' ? ' ↑' : ' ↓') : '');
        if (c.sort) {
          th.addEventListener('click', () => {
            if (q.sort === c.sort) q.dir = q.dir === 'asc' ? 'desc' : 'asc';
            else { q.sort = c.sort; q.dir = c.sort === 'due' ? 'asc' : 'desc'; }
            q.page = 0;
            load();
          });
        }
        return th;
      }),
      el('th', { class: 'col-actions' }),
    );

    const body = el('tbody', {}, rows.map(cardRow));

    tableBox.append(
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' }, el('thead', {}, head), body)),
      pager(),
    );
  }

  function selectAllBox() {
    const box = el('input', { type: 'checkbox', class: 'tick-box' });
    box.checked = rows.length > 0 && rows.every((r) => selected.has(r.id));
    box.addEventListener('change', () => {
      for (const r of rows) (box.checked ? selected.add(r.id) : selected.delete(r.id));
      drawTable();
    });
    return box;
  }

  function cardRow(card) {
    const unit = state.units.find((u) => u.id === card.unit_id);
    const ret = retention.get(card.id);
    const front = plainText(frontTextOf(card.content)) || '(no front text)';

    const star = el('button', {
      class: `star-btn ${card.starred ? 'is-on' : ''}`.trim(), type: 'button',
      title: card.starred ? 'Unstar' : 'Star',
      'aria-label': card.starred ? 'Unstar this card' : 'Star this card',
      'aria-pressed': String(Boolean(card.starred)),
    }, icon('star', { size: 14 }));
    star.classList.toggle('is-filled', Boolean(card.starred));
    star.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await db.updateCards([card.id], { starred: !card.starred });
        card.starred = !card.starred;
        star.classList.toggle('is-on', card.starred);
        star.classList.toggle('is-filled', card.starred);
        star.setAttribute('aria-pressed', String(card.starred));
      } catch (err) { toastError('Could not star', err); }
    });

    const pick = el('input', { type: 'checkbox', class: 'tick-box' });
    pick.checked = selected.has(card.id);
    pick.addEventListener('click', (e) => e.stopPropagation());
    pick.addEventListener('change', () => {
      if (pick.checked) selected.add(card.id); else selected.delete(card.id);
      drawTable();
    });

    const tr = el('tr', {
      class: [
        card.suspended ? 'is-suspended' : '',
        isLeech(card) ? 'is-leech' : '',
        selected.has(card.id) ? 'is-selected' : '',
      ].filter(Boolean).join(' '),
      'aria-expanded': 'false',
    },
      state.editMode ? el('td', { class: 'col-pick' }, pick) : null,
      el('td', {}, star),
      el('td', { class: 'col-front' },
        el('span', { class: 'front-text' }, front),
        card.importance === 3 ? el('span', { class: 'imp-dot', title: 'Load-bearing' }, '★') : null,
      ),
      el('td', { class: 'col-type' }, card.type),
      el('td', { class: 'col-unit num' }, unit ? String(unit.no) : '—'),
      el('td', { class: 'col-tags' }, (card.tags ?? []).slice(0, 3).map((t) => el('span', { class: 'tag' }, t))),
      el('td', { class: 'num' }, q.trash ? '—' : fmtDue(card.due)),
      el('td', { class: 'num' }, fmtInterval(card.ivl)),
      el('td', { class: 'num' }, String(card.reps ?? 0)),
      el('td', { class: `num ${isLeech(card) ? 'is-bad' : ''}`.trim() }, String(card.lapses ?? 0)),
      el('td', { class: 'num' }, ret?.reviews ? `${Math.round(ret.pct)}%` : '—'),
      el('td', { class: 'col-actions' }, rowActions(card)),
    );

    tr.addEventListener('click', () => toggleExpand(tr, card));
    return tr;
  }

  function rowActions(card) {
    const actions = [];
    if (q.trash) {
      actions.push(btn(icon('restore', { size: 14 }), async () => {
        await db.restoreCards([card.id]);
        toast('Restored with its schedule intact.', 'ok');
        load();
      }));
      actions.push(btn(icon('trash', { size: 14 }), async () => {
        const ok = await confirmDialog({
          title: 'Delete permanently?',
          message: 'This card and its review history go for good. There is no undo.',
          confirmLabel: 'Delete for good',
        });
        if (!ok) return;
        await db.hardDeleteCards([card.id]);
        toast('Deleted permanently.', 'ok');
        load();
      }, 'Delete permanently'));
    } else if (state.editMode) {
      actions.push(btn(icon('edit', { size: 14 }), async () => {
        const saved = await editCard(card, { structure: state });
        if (saved) { Object.assign(card, saved); load(); }
      }, 'Edit'));
      actions.push(btn(icon('trash', { size: 14 }), async () => {
        await db.softDeleteCards([card.id]);
        toast('Moved to trash. Restorable for 10 days.', 'ok');
        load();
      }, 'Move to trash'));
    }
    return actions;
  }

  function btn(label, fn, title) {
    const b = el('button', {
      class: 'btn btn-sm btn-ghost btn-icon', type: 'button',
      title: title ?? (typeof label === 'string' ? label : ''),
      'aria-label': title ?? (typeof label === 'string' ? label : 'Action'),
    }, label);
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try { await fn(); } catch (err) { toastError('Action failed', err); } finally { b.disabled = false; }
    });
    return b;
  }

  /** Click a row to see the whole card, rendered exactly as Drill draws it. */
  function toggleExpand(tr, card) {
    const next = tr.nextElementSibling;
    if (next?.classList.contains('row-expanded')) {
      next.remove();
      tr.setAttribute('aria-expanded', 'false');
      return;
    }
    for (const open of tableBox.querySelectorAll('.row-expanded')) {
      open.previousElementSibling?.setAttribute('aria-expanded', 'false');
      open.remove();
    }
    tr.setAttribute('aria-expanded', 'true');

    const colspan = tr.children.length;
    const cell = el('td', { colspan: String(colspan) },
      el('div', { class: 'row-expand-inner' }, renderFront(card), renderBack(card)));
    tr.after(el('tr', { class: 'row-expanded' }, cell));
  }

  // ── bulk actions ──────────────────────────────────────────────────────────

  function bulkBar() {
    const ids = [...selected];
    const run = async (fn, msg) => {
      try {
        await fn(ids);
        selected.clear();
        toast(msg, 'ok');
        load();
      } catch (err) { toastError('Bulk action failed', err); }
    };

    const actions = q.trash
      ? [
        btn('Restore', () => run((i) => db.restoreCards(i), `${pluralise(ids.length, 'card')} restored.`)),
        btn('Delete for good', async () => {
          const ok = await confirmDialog({
            title: `Permanently delete ${pluralise(ids.length, 'card')}?`,
            message: 'The cards and their review history go for good. There is no undo.',
            confirmLabel: 'Delete for good',
          });
          if (ok) await run((i) => db.hardDeleteCards(i), 'Deleted permanently.');
        }),
      ]
      : [
        btn('Move to unit', async () => {
          const unit = await pickUnit(state, q.subjectId);
          if (unit === undefined) return;
          await run((i) => db.updateCards(i, { unit_id: unit }), 'Moved.');
        }),
        btn('Add tag', async () => {
          const tag = await promptDialog({ title: 'Add a tag to the selection', label: 'Tag' });
          if (!tag) return;
          await run(async (i) => {
            // tags is an array column; merge per card rather than overwriting.
            for (const id of i) {
              const card = rows.find((r) => r.id === id);
              const next = [...new Set([...(card?.tags ?? []), tag.toLowerCase()])];
              await db.updateCards([id], { tags: next });
            }
          }, `Tagged ${pluralise(ids.length, 'card')}.`);
        }),
        btn('Remove tag', async () => {
          const tag = await promptDialog({ title: 'Remove a tag from the selection', label: 'Tag' });
          if (!tag) return;
          await run(async (i) => {
            for (const id of i) {
              const card = rows.find((r) => r.id === id);
              const next = (card?.tags ?? []).filter((x) => x !== tag.toLowerCase());
              await db.updateCards([id], { tags: next });
            }
          }, 'Tag removed.');
        }),
        btn('★★★', () => run((i) => db.updateCards(i, { importance: 3 }), 'Importance set.')),
        btn('★★', () => run((i) => db.updateCards(i, { importance: 2 }), 'Importance set.')),
        btn('★', () => run((i) => db.updateCards(i, { importance: 1 }), 'Importance set.')),
        btn('Star', () => run((i) => db.updateCards(i, { starred: true }), 'Starred.')),
        btn('Suspend', () => run((i) => db.updateCards(i, { suspended: true }), 'Suspended.')),
        btn('Unsuspend', () => run((i) => db.updateCards(i, { suspended: false }), 'Unsuspended.')),
        btn('Reset schedule', async () => {
          const ok = await confirmDialog({
            title: `Reset ${pluralise(ids.length, 'card')} to new?`,
            message: 'Interval, ease, reps and lapses go back to zero. The review history is kept, but the cards start again from scratch.',
            confirmLabel: 'Reset schedule',
          });
          if (ok) await run((i) => db.resetSchedule(i), 'Schedules reset.');
        }),
        btn('Delete', async () => {
          const ok = await confirmDialog({
            title: `Move ${pluralise(ids.length, 'card')} to trash?`,
            message: 'They stay restorable with their schedules for 10 days, then they are purged.',
            confirmLabel: 'Move to trash',
          });
          if (ok) await run((i) => db.softDeleteCards(i), 'Moved to trash.');
        }),
      ];

    const clearSel = btn('Clear', () => { selected.clear(); drawTable(); });

    return el('div', { class: 'bulk-bar' },
      el('span', { class: 'bulk-count num' }, `${selected.size} selected`),
      el('span', { class: 'row-actions' }, actions, clearSel),
    );
  }

  // ── pager ─────────────────────────────────────────────────────────────────

  function pager() {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const from = total ? q.page * PAGE_SIZE + 1 : 0;
    const to = Math.min(total, (q.page + 1) * PAGE_SIZE);

    const go = (n) => { q.page = n; load(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

    return el('div', { class: 'pager' },
      el('span', { class: 'pager-count num' }, `${from}–${to} of ${total}`),
      el('span', { class: 'row-actions' },
        el('button', {
          class: 'btn btn-sm', type: 'button', disabled: q.page === 0,
          onclick: () => go(q.page - 1),
        }, 'Prev'),
        el('span', { class: 'pager-page num' }, `${q.page + 1} / ${pages}`),
        el('button', {
          class: 'btn btn-sm', type: 'button', disabled: q.page + 1 >= pages,
          onclick: () => go(q.page + 1),
        }, 'Next'),
      ),
    );
  }

  // ── go ────────────────────────────────────────────────────────────────────

  function draw() {
    clear(root);
    setHeader({
      crumb: [q.trash ? 'Trash' : 'All cards'],
      actions: [
        el('span', { class: 'hint' },
          state.editMode ? 'Editing' : 'Read-only'),
      ],
    });
    root.append(bar, tableBox);
    drawBar();
    drawTable();
  }

  draw();
  await load();

  return { teardown() { unsub(); clear(root); } };
}

/** Ask which unit to move a selection into. Returns null for subject level. */
async function pickUnit(state, subjectId) {
  const units = state.units.filter((u) => !subjectId || u.subject_id === subjectId)
    .sort((a, b) => a.no - b.no);
  const { openModal } = await import('../ui.js');

  return new Promise((resolve) => {
    const sel = el('select', { class: 'select' },
      el('option', { value: '' }, 'Subject level (no unit)'),
      units.map((u) => {
        const sub = state.subjects.find((s) => s.id === u.subject_id);
        return el('option', { value: u.id }, `${sub?.name ?? ''} · Unit ${u.no} — ${u.title}`);
      }),
    );
    openModal({
      title: 'Move to unit',
      body: el('div', { class: 'field' }, el('span', { class: 'label' }, 'Destination'), sel),
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Move', value: 'ok', primary: true }],
      onDone: (v) => resolve(v === 'ok' ? (sel.value || null) : undefined),
    });
  });
}
