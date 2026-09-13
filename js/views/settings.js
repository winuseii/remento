// Settings — sectioned, the way a mature application settings screen is (§29).
//
// Desktop puts a section list beside the content. Phone shows the list, and
// choosing a section replaces it — list, then detail, rather than one very
// long scroll.
//
// The sections are only the ones that exist. Export and a Trash screen are in
// the brief but not in the codebase, and a settings menu that leads nowhere is
// worse than a shorter menu.

import {
  el, clear, toast, toastError, confirmDialog, promptDialog, pluralise,
} from '../ui.js';
import { icon } from '../icons.js';
import * as db from '../db.js';
import { DEFAULTS } from '../config.js';
import { doSignOut } from '../app.js';

const SECTIONS = [
  { id: 'study', label: 'Study', blurb: 'Session size and the daily caps.' },
  { id: 'structure', label: 'Structure', blurb: 'Semesters, subjects and units.' },
  { id: 'data', label: 'Data', blurb: 'Trash and what the app deletes for you.' },
  { id: 'account', label: 'Account', blurb: 'Who you are signed in as.' },
];

export async function render(panel, ctx) {
  const { state, refreshStructure, setHeader, navigate } = ctx;

  const root = el('div', { class: 'wrap settings-root' });
  panel.append(root);

  // On a phone the list is a screen of its own; on desktop both are visible.
  let current = window.matchMedia('(max-width: 900px)').matches ? null : 'study';

  const draw = () => {
    clear(root);
    const section = SECTIONS.find((s) => s.id === current);
    setHeader({
      crumb: section ? ['Settings', section.label] : ['Settings'],
      actions: [],
    });

    root.append(
      el('div', { class: current ? 'settings-shell has-detail' : 'settings-shell' },
        sectionNav(),
        current ? el('div', { class: 'settings-detail' }, body(section)) : null,
      ),
    );
  };

  function sectionNav() {
    return el('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
      SECTIONS.map((s) => {
        const on = s.id === current;
        const b = el('button', {
          class: on ? 'settings-nav-item is-active' : 'settings-nav-item',
          type: 'button', 'aria-current': on ? 'true' : null,
        },
          el('span', { class: 'settings-nav-label' }, s.label),
          el('span', { class: 'settings-nav-blurb' }, s.blurb),
          el('span', { class: 'settings-nav-chev', 'aria-hidden': 'true' }, icon('chevron', { size: 15 })),
        );
        b.addEventListener('click', () => { current = s.id; draw(); });
        return b;
      }),
    );
  }

  function body(section) {
    switch (section?.id) {
      case 'structure': return structureSection(state, refreshStructure, draw);
      case 'data': return dataSection(navigate);
      case 'account': return accountSection(state);
      case 'study':
      default: return studySection(state);
    }
  }

  draw();
  return { teardown() { clear(root); } };
}

// ── study ───────────────────────────────────────────────────────────────────

function studySection(state) {
  const s = state.settings ?? db.defaultSettings();

  const num = (key, label, value, min, max, hint) => {
    const input = el('input', {
      class: 'input', type: 'number', min, max, step: 1, value,
      inputmode: 'numeric', id: `set-${key}`,
    });
    return {
      key, input,
      node: el('div', { class: 'field' },
        el('label', { class: 'label', for: `set-${key}` }, label),
        input,
        el('span', { class: 'hint' }, hint)),
    };
  };

  const fields = [
    num('sessionSize', 'Session size', s.sessionSize, 1, 500, 'Cards before the finish line. A visible end is what makes a session start.'),
    num('newPerDay', 'New per day', s.newPerDay, 0, 500, 'Unseen cards introduced daily.'),
    num('reviewsPerDay', 'Reviews per day', s.reviewsPerDay, 0, 2000, 'Cap on scheduled reviews.'),
  ];

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save limits');
  const form = el('form', { class: 'settings-grid' }, fields.map((f) => f.node));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = {
      ...s,
      sessionSize: clampInt(fields[0].input.value, 1, 500, DEFAULTS.sessionSize),
      newPerDay: clampInt(fields[1].input.value, 0, 500, DEFAULTS.newPerDay),
      reviewsPerDay: clampInt(fields[2].input.value, 0, 2000, DEFAULTS.reviewsPerDay),
    };
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving…';
    try {
      state.settings = await db.saveSettings(next);
      fields[0].input.value = next.sessionSize;
      fields[1].input.value = next.newPerDay;
      fields[2].input.value = next.reviewsPerDay;
      toast('Limits saved.', 'ok');
    } catch (err) {
      toastError('Could not save limits', err);
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  });

  form.append(el('div', { class: 'settings-actions' }, save));

  return el('div', {},
    sectionHead('Daily limits', 'These caps apply across every subject. Drill fills reviews before new cards, so a backlog is never buried under fresh material.'),
    form,
  );
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── structure ───────────────────────────────────────────────────────────────

function structureSection(state, refreshStructure, redraw) {
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
      el('p', {}, 'Create one, then add subjects and units inside it. Nothing is seeded for you.')));
  }
  for (const sem of state.semesters) body.append(semesterNode(sem, state, busy));

  const addSem = el('button', { class: 'btn btn-sm', type: 'button' },
    icon('plus', { size: 14 }), 'Semester');
  addSem.addEventListener('click', async () => {
    const label = await promptDialog({
      title: 'New semester', label: 'Label', placeholder: 'Semester 3', confirmLabel: 'Create',
    });
    if (!label) return;
    busy(() => db.createSemester({ slug: slugify(label), label, position: state.semesters.length }),
      `Created ${label}.`);
  });

  return el('div', {},
    el('div', { class: 'settings-head-row' },
      sectionHead('Structure', 'Semester, then subject, then unit. Declared unit counts are what let the coverage figure be honest.'),
      addSem),
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
    const n = subjects.length;
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
      el('span', { class: 'tree-meta' }, pluralise(subjects.length, 'subject')),
      el('span', { class: 'row-actions' },
        moveButtons(sem, state.semesters, (id, position) => busy(() => db.updateSemester(id, { position }))),
        iconBtn('edit', 'Rename semester', rename),
        iconBtn('plus', 'Add subject', addSubject),
        iconBtn('trash', 'Delete semester', remove),
      ),
    ),
    subjects.length
      ? subjects.map((sub) => subjectNode(sub, subjects, state, busy))
      : el('div', { class: 'tree-empty' }, 'No subjects.'),
  );
}

function subjectNode(sub, siblings, state, busy) {
  const units = state.units.filter((u) => u.subject_id === sub.id).sort((a, b) => a.no - b.no);
  const declared = sub.units_declared;

  const rename = async () => {
    const name = await promptDialog({ title: 'Rename subject', label: 'Name', value: sub.name });
    if (!name || name === sub.name) return;
    busy(() => db.updateSubject(sub.id, { name }), 'Renamed.');
  };
  const setCode = async () => {
    const code = await promptDialog({
      title: `${sub.name} — course code`, label: 'Code', value: sub.code ?? '', placeholder: '23MEE202',
    });
    if (code == null) return;
    busy(() => db.updateSubject(sub.id, { code: code || null }), 'Saved.');
  };
  const setDeclared = async () => {
    const v = await promptDialog({
      title: `${sub.name} — units in the syllabus`,
      label: 'Declared unit count (blank = undeclared)',
      value: declared == null ? '' : String(declared), placeholder: '5',
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
      title: `New unit in ${sub.name}`, label: `Unit ${nextNo} title`,
      placeholder: 'Second Law and Entropy', confirmLabel: 'Create',
    });
    if (!title) return;
    busy(() => db.createUnit({ subjectId: sub.id, no: nextNo, title }), `Created Unit ${nextNo}.`);
  };

  const coverage = declared == null
    ? el('span', { class: 'tree-meta dim' }, `${units.length}/? units`)
    : el('span', { class: units.length >= declared ? 'tree-meta' : 'tree-meta is-short' },
      `${units.length}/${declared} units`);

  return el('div', { class: 'tree-sub' },
    el('div', { class: 'tree-row' },
      el('span', { class: 'tree-name' }, sub.name),
      sub.code ? el('span', { class: 'tree-code' }, sub.code) : null,
      coverage,
      el('span', { class: 'row-actions' },
        moveButtons(sub, siblings, (id, position) => busy(() => db.updateSubject(id, { position }))),
        iconBtn('edit', 'Rename subject', rename),
        textBtn('Code', 'Set course code', setCode),
        textBtn('Units', 'Set declared unit count', setDeclared),
        iconBtn('plus', 'Add unit', addUnit),
        iconBtn('trash', 'Delete subject', remove),
      ),
    ),
    units.length
      ? el('div', { class: 'tree-units' }, units.map((u) => unitNode(u, sub, busy)))
      : el('div', { class: 'tree-empty' }, 'No units. Cards can still sit at subject level.'),
  );
}

function unitNode(unit, sub, busy) {
  const rename = async () => {
    const title = await promptDialog({ title: `Rename Unit ${unit.no}`, label: 'Title', value: unit.title });
    if (!title || title === unit.title) return;
    busy(() => db.updateUnit(unit.id, { title }), 'Renamed.');
  };
  const renumber = async () => {
    const v = await promptDialog({ title: `Renumber Unit ${unit.no}`, label: 'Unit number', value: String(unit.no) });
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
    el('span', { class: 'tree-no' }, String(unit.no).padStart(2, '0')),
    el('span', { class: 'tree-name' }, unit.title),
    el('span', { class: 'row-actions' },
      iconBtn('edit', 'Rename unit', rename),
      textBtn('No.', 'Change unit number', renumber),
      iconBtn('trash', 'Delete unit', remove),
    ),
  );
}

function iconBtn(name, label, fn) {
  return el('button', {
    class: 'btn btn-sm btn-ghost btn-icon', type: 'button',
    title: label, 'aria-label': label, onclick: fn,
  }, icon(name, { size: 14 }));
}

function textBtn(text, label, fn) {
  return el('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', title: label, onclick: fn,
  }, text);
}

/** Up/down reordering. Normalises positions to the visible order. */
function moveButtons(item, siblings, apply) {
  const ordered = siblings.slice().sort(byPosition);
  const i = ordered.findIndex((s) => s.id === item.id);

  const move = (delta) => {
    if (!ordered[i + delta]) return;
    Promise.all(
      ordered.map((s, idx) => {
        const want = idx === i ? i + delta : idx === i + delta ? i : idx;
        return s.position === want ? null : apply(s.id, want);
      }).filter(Boolean),
    );
  };

  return [
    el('button', {
      class: 'btn btn-sm btn-ghost btn-icon', type: 'button',
      title: 'Move up', 'aria-label': 'Move up',
      disabled: i <= 0, onclick: () => move(-1),
    }, '↑'),
    el('button', {
      class: 'btn btn-sm btn-ghost btn-icon', type: 'button',
      title: 'Move down', 'aria-label': 'Move down',
      disabled: i < 0 || i >= ordered.length - 1, onclick: () => move(1),
    }, '↓'),
  ];
}

function byPosition(a, b) {
  return (a.position ?? 0) - (b.position ?? 0)
    || String(a.name ?? a.label).localeCompare(String(b.name ?? b.label));
}

function slugify(s) {
  const base = String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base || `x${Date.now().toString(36)}`;
}

// ── data ────────────────────────────────────────────────────────────────────

function dataSection(navigate) {
  return el('div', {},
    sectionHead('Trash', `Deleted cards keep their schedule and stay restorable for ${DEFAULTS.trashPurgeDays} days. After that the app hard-deletes them on the next launch — there is no scheduled job, because Remento is opened daily by definition.`),
    el('div', { class: 'row-actions' },
      el('button', {
        class: 'btn', type: 'button', onclick: () => navigate('browse', { trash: true }),
      }, icon('trash', { size: 14 }), 'Open trash'),
    ),
    el('hr', { class: 'divider' }),
    sectionHead('Images', 'Card images are compressed to WebP at 1600px before they leave this device, and live in a private bucket served through signed URLs. They are referenced by an export, not included in one.'),
  );
}

// ── account ─────────────────────────────────────────────────────────────────

function accountSection(state) {
  return el('div', {},
    sectionHead('Account', 'Magic link only — there is no password to lose.'),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Signed in as'),
      el('dd', {}, state.user?.email ?? 'unknown'),
    ),
    el('div', { class: 'row-actions', style: 'margin-top:24px' },
      el('button', { class: 'btn', type: 'button', onclick: () => doSignOut() }, 'Sign out'),
    ),
    el('p', { class: 'hint', style: 'margin-top:12px' },
      'Signing out clears this device only. Your cards and schedule live in Postgres.'),
  );
}

function sectionHead(title, blurb) {
  return el('div', { class: 'settings-section-head' },
    el('h2', { class: 'settings-section-title' }, title),
    blurb ? el('p', { class: 'hint' }, blurb) : null,
  );
}
