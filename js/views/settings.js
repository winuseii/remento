// Settings — daily limits, the semester/subject/unit editor, and sign-out.
// An instrument screen: mono, dense, no decoration.

import {
  el, clear, toast, toastError, confirmDialog, promptDialog, pluralise,
} from '../ui.js';
import * as db from '../db.js';
import { DEFAULTS } from '../config.js';
import { doSignOut } from '../app.js';

export async function render(panel, ctx) {
  const { state, refreshStructure } = ctx;

  const root = el('div', { class: 'wrap' });
  panel.append(root);

  const draw = () => {
    clear(root);
    root.append(
      el('div', { class: 'page-head' },
        el('h2', { class: 'page-title' }, 'Settings'),
        el('p', { class: 'page-sub' }, state.user?.email ?? ''),
      ),
      limitsPanel(state),
      structurePanel(state, refreshStructure, draw),
      accountPanel(),
    );
  };

  draw();
  return { teardown() { clear(root); } };
}

// ── daily limits ────────────────────────────────────────────────────────────

function limitsPanel(state) {
  const s = state.settings ?? db.defaultSettings();

  const num = (name, value, min, max, hint) => {
    const input = el('input', {
      class: 'input', type: 'number', min, max, step: 1, value, name,
      inputmode: 'numeric',
    });
    return {
      input,
      node: el('label', { class: 'field' },
        el('span', { class: 'label' }, name),
        input,
        el('span', { class: 'hint' }, hint),
      ),
    };
  };

  const size = num('Session size', s.sessionSize, 1, 500, 'Cards before the finish line.');
  const fresh = num('New per day', s.newPerDay, 0, 500, 'Unseen cards introduced daily.');
  const revs = num('Reviews per day', s.reviewsPerDay, 0, 2000, 'Cap on scheduled reviews.');

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save limits');

  const form = el('form', { class: 'settings-grid' }, size.node, fresh.node, revs.node);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = {
      ...s,
      sessionSize: clampInt(size.input.value, 1, 500, DEFAULTS.sessionSize),
      newPerDay: clampInt(fresh.input.value, 0, 500, DEFAULTS.newPerDay),
      reviewsPerDay: clampInt(revs.input.value, 0, 2000, DEFAULTS.reviewsPerDay),
    };
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving…';
    try {
      state.settings = await db.saveSettings(next);
      size.input.value = next.sessionSize;
      fresh.input.value = next.newPerDay;
      revs.input.value = next.reviewsPerDay;
      toast('Limits saved.', 'ok');
    } catch (err) {
      toastError('Could not save limits', err);
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  });

  form.append(el('div', { class: 'settings-actions' }, save));

  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, 'Daily limits'),
    form,
  );
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── structure ───────────────────────────────────────────────────────────────

function structurePanel(state, refreshStructure, redraw) {
  const body = el('div', { class: 'tree' });

  const busy = async (fn, okMsg) => {
    try {
      await fn();
      await refreshStructure();
      if (okMsg) toast(okMsg, 'ok');
      redraw();
    } catch (err) {
      toastError('Structure change failed', err);
    }
  };

  if (!state.semesters.length) {
    body.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-title' }, 'No semesters yet'),
      el('p', {}, 'Create one, then add subjects and units inside it. Nothing is seeded for you.'),
    ));
  }

  for (const sem of state.semesters) {
    body.append(semesterNode(sem, state, busy));
  }

  const addSem = el('button', { class: 'btn btn-sm', type: 'button' }, '+ Semester');
  addSem.addEventListener('click', async () => {
    const label = await promptDialog({
      title: 'New semester', label: 'Label', placeholder: 'Semester 3', confirmLabel: 'Create',
    });
    if (!label) return;
    busy(() => db.createSemester({
      slug: slugify(label), label, position: state.semesters.length,
    }), `Created ${label}.`);
  });

  return el('section', { class: 'card-panel' },
    el('div', { class: 'panel-head' },
      el('h3', { class: 'panel-title' }, 'Structure'),
      addSem,
    ),
    body,
  );
}

function semesterNode(sem, state, busy) {
  const subjects = state.subjects.filter((s) => s.semester_id === sem.id);

  const rename = async () => {
    const label = await promptDialog({ title: 'Rename semester', label: 'Label', value: sem.label });
    if (!label || label === sem.label) return;
    busy(() => db.updateSemester(sem.id, { label }), 'Renamed.');
  };

  const remove = async () => {
    const n = state.subjects.filter((s) => s.semester_id === sem.id).length;
    const ok = await confirmDialog({
      title: `Delete ${sem.label}?`,
      message: n
        ? `This deletes ${pluralise(n, 'subject')} and every card inside them. Cards deleted this way do not go to the trash — they are gone.`
        : 'This semester has no subjects. It will be removed.',
      confirmLabel: 'Delete semester',
    });
    if (ok) busy(() => db.deleteSemester(sem.id), `Deleted ${sem.label}.`);
  };

  const addSubject = async () => {
    const name = await promptDialog({
      title: `New subject in ${sem.label}`, label: 'Name',
      placeholder: 'Thermodynamics', confirmLabel: 'Create',
    });
    if (!name) return;
    busy(() => db.createSubject({
      semesterId: sem.id, slug: slugify(name), name, position: subjects.length,
    }), `Created ${name}.`);
  };

  return el('div', { class: 'tree-sem' },
    el('div', { class: 'tree-row tree-row-sem' },
      el('span', { class: 'tree-name' }, sem.label),
      el('span', { class: 'tree-meta num' }, pluralise(subjects.length, 'subject')),
      el('span', { class: 'row-actions' },
        moveButtons(sem, state.semesters, (id, position) =>
          busy(() => db.updateSemester(id, { position }))),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: rename }, 'Rename'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: addSubject }, '+ Subject'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: remove, title: 'Delete semester' }, '×'),
      ),
    ),
    subjects.length
      ? subjects.map((sub) => subjectNode(sub, subjects, state, busy))
      : el('div', { class: 'tree-empty' }, 'No subjects.'),
  );
}

function subjectNode(sub, siblings, state, busy) {
  const units = state.units.filter((u) => u.subject_id === sub.id)
    .sort((a, b) => a.no - b.no);
  const declared = sub.units_declared;

  const rename = async () => {
    const name = await promptDialog({ title: 'Rename subject', label: 'Name', value: sub.name });
    if (!name || name === sub.name) return;
    busy(() => db.updateSubject(sub.id, { name }), 'Renamed.');
  };

  const setCode = async () => {
    const code = await promptDialog({
      title: `${sub.name} — course code`, label: 'Code',
      value: sub.code ?? '', placeholder: '23MEE202',
    });
    if (code == null) return;
    busy(() => db.updateSubject(sub.id, { code: code || null }), 'Saved.');
  };

  // units_declared exists solely so the coverage line can be honest.
  // Undeclared means the app says "Coverage: undeclared" rather than flattering you.
  const setDeclared = async () => {
    const v = await promptDialog({
      title: `${sub.name} — units in the syllabus`,
      label: 'Declared unit count (blank = undeclared)',
      value: declared == null ? '' : String(declared),
      placeholder: '5',
    });
    if (v == null) return;
    const n = v === '' ? null : clampInt(v, 1, 99, sub.units_declared);
    busy(() => db.updateSubject(sub.id, { units_declared: n }), 'Saved.');
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${sub.name}?`,
      message: 'This deletes the subject, its units and every card in it, permanently. Cards deleted this way do not go to the trash.',
      confirmLabel: 'Delete subject',
    });
    if (ok) busy(() => db.deleteSubject(sub.id), `Deleted ${sub.name}.`);
  };

  const addUnit = async () => {
    const nextNo = units.length ? Math.max(...units.map((u) => u.no)) + 1 : 1;
    const title = await promptDialog({
      title: `New unit in ${sub.name}`,
      label: `Unit ${nextNo} title`,
      placeholder: 'Second Law and Entropy',
      confirmLabel: 'Create',
    });
    if (!title) return;
    busy(() => db.createUnit({ subjectId: sub.id, no: nextNo, title }), `Created Unit ${nextNo}.`);
  };

  const coverage = declared == null
    ? el('span', { class: 'tree-meta dim' }, `${units.length}/? units · undeclared`)
    : el('span', { class: units.length >= declared ? 'tree-meta num' : 'tree-meta num is-short' },
      `${units.length}/${declared} units`);

  return el('div', { class: 'tree-sub' },
    el('div', { class: 'tree-row' },
      el('span', { class: 'tree-name' }, sub.name),
      sub.code ? el('span', { class: 'tree-code num' }, sub.code) : null,
      coverage,
      el('span', { class: 'row-actions' },
        moveButtons(sub, siblings, (id, position) =>
          busy(() => db.updateSubject(id, { position }))),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: rename }, 'Rename'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: setCode }, 'Code'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: setDeclared }, 'Units'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: addUnit }, '+ Unit'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: remove, title: 'Delete subject' }, '×'),
      ),
    ),
    units.length
      ? el('div', { class: 'tree-units' }, units.map((u) => unitNode(u, sub, busy)))
      : el('div', { class: 'tree-empty' }, 'No units. Cards can still sit at subject level.'),
  );
}

function unitNode(unit, sub, busy) {
  const rename = async () => {
    const title = await promptDialog({
      title: `Rename Unit ${unit.no}`, label: 'Title', value: unit.title,
    });
    if (!title || title === unit.title) return;
    busy(() => db.updateUnit(unit.id, { title }), 'Renamed.');
  };

  const renumber = async () => {
    const v = await promptDialog({
      title: `Renumber Unit ${unit.no}`, label: 'Unit number', value: String(unit.no),
    });
    if (!v) return;
    const no = clampInt(v, 1, 99, unit.no);
    if (no === unit.no) return;
    busy(() => db.updateUnit(unit.id, { no }), `Now Unit ${no}.`);
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete Unit ${unit.no}?`,
      message: `Cards in this unit are not deleted — they fall back to subject level in ${sub.name} and stay drillable.`,
      confirmLabel: 'Delete unit',
    });
    if (ok) busy(() => db.deleteUnit(unit.id), `Deleted Unit ${unit.no}.`);
  };

  return el('div', { class: 'tree-row tree-row-unit' },
    el('span', { class: 'tree-no num' }, String(unit.no).padStart(2, '0')),
    el('span', { class: 'tree-name' }, unit.title),
    el('span', { class: 'row-actions' },
      el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: rename }, 'Rename'),
      el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: renumber }, 'No.'),
      el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: remove, title: 'Delete unit' }, '×'),
    ),
  );
}

/** Up/down reordering. Swaps `position` with the neighbour. */
function moveButtons(item, siblings, apply) {
  const ordered = siblings.slice().sort(byPosition);
  const i = ordered.findIndex((s) => s.id === item.id);

  const move = (delta) => {
    const other = ordered[i + delta];
    if (!other) return;
    // Positions can be duplicated or all-zero; normalise to the array order.
    Promise.all(
      ordered.map((s, idx) => {
        const want = idx === i ? i + delta : idx === i + delta ? i : idx;
        return s.position === want ? null : apply(s.id, want);
      }).filter(Boolean),
    );
  };

  return [
    el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', title: 'Move up',
      disabled: i <= 0, onclick: () => move(-1),
    }, '↑'),
    el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', title: 'Move down',
      disabled: i < 0 || i >= ordered.length - 1, onclick: () => move(1),
    }, '↓'),
  ];
}

function byPosition(a, b) {
  return (a.position ?? 0) - (b.position ?? 0) || String(a.name ?? a.label).localeCompare(String(b.name ?? b.label));
}

/** 'Semester 3' -> 's3-…'; good enough for a unique-per-user key. */
function slugify(s) {
  const base = String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base || `x${Date.now().toString(36)}`;
}

// ── account ─────────────────────────────────────────────────────────────────

function accountPanel() {
  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, 'Account'),
    el('div', { class: 'row-actions' },
      el('button', {
        class: 'btn', type: 'button', onclick: () => doSignOut(),
      }, 'Sign out'),
    ),
    el('p', { class: 'hint', style: 'margin-top:12px' },
      'Signing out clears this device only. Your cards and schedule live in Postgres.'),
  );
}

