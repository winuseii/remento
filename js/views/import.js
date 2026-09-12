// Import — paste or drop a payload, confirm where it goes, see exactly what
// will happen to every card, then land it.
//
// Two rules from the spec drive this screen:
//   · The payload's `target` suggests. You confirm.
//   · Units are never created silently.

import {
  el, clear, toast, toastError, plainText, pluralise, errorBlock,
} from '../ui.js';
import { parse, summarise, frontTextOf, planImport, cardToRow } from '../importer.js';
import * as db from '../db.js';

const TYPE_LABEL = {
  qa: 'Q&A', formula: 'Formula', list: 'List',
  cloze: 'Cloze', numerical: 'Numerical', image: 'Image',
};

export async function render(panel, ctx) {
  const { state, refreshStructure } = ctx;

  const root = el('div', { class: 'wrap' });
  panel.append(root);

  /** Everything the screen is currently holding. */
  const view = {
    raw: '',
    parsed: null,     // { format, target, defaults, cards, errors }
    plan: null,       // { rows, counts } once a destination is chosen
    dest: { semesterId: null, subjectId: null, unitId: null, newUnit: null },
    onDuplicate: 'skip',
    onUpdate: 'update',
  };

  const sourceBox = el('div');
  const previewBox = el('div');

  const draw = () => {
    clear(root);
    root.append(
      el('div', { class: 'page-head' },
        el('h2', { class: 'page-title' }, 'Import'),
        el('p', { class: 'page-sub' },
          view.parsed ? `${view.parsed.format} payload` : 'JSON or text'),
      ),
      sourceBox, previewBox,
    );
  };

  // ── source ────────────────────────────────────────────────────────────────

  const textarea = el('textarea', {
    class: 'textarea', spellcheck: 'false',
    placeholder: 'Paste a JSON payload or a text block here, or drop a .json / .txt file anywhere on this panel.',
  });

  const parseBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Parse');
  const clearBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Clear');
  const promptBtn = el('button', { class: 'btn', type: 'button' }, 'Copy AI prompt');

  const doParse = () => {
    view.raw = textarea.value;
    if (!view.raw.trim()) { toast('Nothing pasted yet.', 'warn'); return; }
    view.parsed = parse(view.raw);
    seedDestination(view, state);
    view.plan = null;
    draw();
    renderPreview();
    previewBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  parseBtn.addEventListener('click', doParse);
  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    view.parsed = null; view.plan = null;
    draw(); renderPreview();
  });
  promptBtn.addEventListener('click', () => copyAiPrompt(view, state));

  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doParse(); }
  });

  const drop = el('div', { class: 'dropzone' },
    el('span', {}, 'Drop a .json or .txt file'),
  );
  const fileInput = el('input', {
    type: 'file', accept: '.json,.txt,application/json,text/plain', class: 'visually-hidden',
  });
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) readFile(fileInput.files[0]);
  });

  const readFile = async (file) => {
    try {
      textarea.value = await file.text();
      toast(`Loaded ${file.name} (${Math.round(file.size / 1024)} KB).`, 'ok');
      doParse();
    } catch (err) {
      toastError('Could not read that file', err);
    }
  };

  const onDragOver = (e) => { e.preventDefault(); drop.classList.add('is-over'); };
  const onDragLeave = () => drop.classList.remove('is-over');
  const onDrop = (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) readFile(file);
  };
  panel.addEventListener('dragover', onDragOver);
  panel.addEventListener('dragleave', onDragLeave);
  panel.addEventListener('drop', onDrop);

  sourceBox.append(
    el('section', { class: 'card-panel' },
      el('div', { class: 'panel-head' },
        el('h3', { class: 'panel-title' }, 'Payload'),
        el('div', { class: 'row-actions' }, promptBtn),
      ),
      textarea,
      el('div', { class: 'import-source-actions' },
        parseBtn, clearBtn, drop, fileInput,
      ),
    ),
  );

  // ── preview ───────────────────────────────────────────────────────────────

  function renderPreview() {
    clear(previewBox);
    if (!view.parsed) return;

    const { cards, errors } = view.parsed;
    previewBox.append(destinationPanel(view, state, refreshStructure, rebuildPlan));

    if (!view.dest.subjectId) {
      previewBox.append(el('section', { class: 'card-panel' },
        el('div', { class: 'state' }, 'Choose a subject to see what will happen to these cards.')));
      return;
    }

    if (!view.plan) {
      previewBox.append(el('section', { class: 'card-panel' },
        el('div', { class: 'state' }, el('span', { class: 'spinner' }), 'Checking for duplicates…')));
      rebuildPlan();
      return;
    }

    previewBox.append(countsPanel(view, cards, errors, () => renderPreview(), commit));
    previewBox.append(rowsPanel(view));
    if (errors.length) previewBox.append(errorsPanel(errors));
  }

  /** Classify every parsed card against what is already in the subject. */
  async function rebuildPlan() {
    if (!view.dest.subjectId || !view.parsed) { renderPreview(); return; }
    try {
      const existing = await db.existingForImport(view.dest.subjectId);
      view.plan = planImport(view.parsed.cards, existing);
      renderPreview();
    } catch (err) {
      clear(previewBox);
      previewBox.append(errorBlock(err, rebuildPlan));
    }
  }

  // ── commit ────────────────────────────────────────────────────────────────

  async function commit(button) {
    const { rows } = view.plan;
    const dest = view.dest;

    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Importing…';

    try {
      // Units are never created silently: this only runs because you ticked it.
      let unitId = dest.unitId;
      if (dest.newUnit) {
        const unit = await db.createUnit({
          subjectId: dest.subjectId, no: dest.newUnit.no, title: dest.newUnit.title,
        });
        unitId = unit.id;
        dest.unitId = unitId;
        dest.newUnit = null;
        await refreshStructure();
      }

      const inserts = [];
      const updates = [];

      for (const row of rows) {
        if (row.status === 'duplicate' && view.onDuplicate === 'skip') continue;
        if (row.status === 'update' && view.onUpdate === 'skip') continue;

        if (row.status === 'update') {
          updates.push({
            id: row.existing.id,
            // Every schedule column is carried straight over from the stored
            // row, so a typo fix on a card reviewed nine times keeps its place.
            row: {
              ...cardToRow(row.card, dest.subjectId, unitId),
              ivl: row.existing.ivl,
              ease: row.existing.ease,
              due: row.existing.due,
              reps: row.existing.reps,
              lapses: row.existing.lapses,
            },
          });
        } else {
          inserts.push(cardToRow(row.card, dest.subjectId, unitId));
        }
      }

      if (!inserts.length && !updates.length) {
        toast('Nothing selected to import.', 'warn');
        return;
      }

      const res = await db.commitImport({ inserts, updates });
      const parts = [];
      if (res.inserted) parts.push(`${pluralise(res.inserted, 'card')} added`);
      if (res.updated) parts.push(`${pluralise(res.updated, 'card')} updated`);
      toast(`${parts.join(', ')}.`, 'ok');

      textarea.value = '';
      view.parsed = null;
      view.plan = null;
      draw();
      renderPreview();
    } catch (err) {
      toastError('Import failed — nothing was added', err);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  draw();
  return {
    teardown() {
      panel.removeEventListener('dragover', onDragOver);
      panel.removeEventListener('dragleave', onDragLeave);
      panel.removeEventListener('drop', onDrop);
      clear(root);
    },
  };
}

// ── destination ─────────────────────────────────────────────────────────────

/** Pre-select from the payload's target where a match already exists. */
function seedDestination(view, state) {
  const t = view.parsed?.target ?? {};
  const d = view.dest;

  const sem = state.semesters.find(
    (s) => s.slug === t.semesterSlug || s.label.toLowerCase() === String(t.semesterLabel).toLowerCase(),
  ) ?? state.semesters.find((s) => s.id === state.focus.semesterId);
  d.semesterId = sem?.id ?? d.semesterId ?? state.semesters[0]?.id ?? null;

  const subs = state.subjects.filter((s) => s.semester_id === d.semesterId);
  const sub = subs.find((s) => s.name.toLowerCase() === String(t.subject).toLowerCase())
    ?? subs.find((s) => s.id === d.subjectId);
  d.subjectId = sub?.id ?? null;

  d.unitId = null;
  d.newUnit = null;
  if (d.subjectId && t.unitNo != null) {
    const unit = state.units.find((u) => u.subject_id === d.subjectId && u.no === t.unitNo);
    if (unit) d.unitId = unit.id;
    else d.newUnit = { no: t.unitNo, title: t.unitTitle || `Unit ${t.unitNo}`, confirmed: false };
  }
}

function destinationPanel(view, state, refreshStructure, onChange) {
  const d = view.dest;
  const t = view.parsed?.target ?? {};

  const semSel = el('select', { class: 'select' },
    el('option', { value: '' }, '— semester —'),
    state.semesters.map((s) => el('option', { value: s.id, selected: s.id === d.semesterId }, s.label)),
  );
  semSel.addEventListener('change', () => {
    d.semesterId = semSel.value || null;
    d.subjectId = null; d.unitId = null; d.newUnit = null;
    view.plan = null;
    onChange();
  });

  const subs = state.subjects.filter((s) => s.semester_id === d.semesterId);
  const subSel = el('select', { class: 'select' },
    el('option', { value: '' }, '— subject —'),
    subs.map((s) => el('option', { value: s.id, selected: s.id === d.subjectId }, s.name)),
  );
  subSel.addEventListener('change', () => {
    d.subjectId = subSel.value || null;
    d.unitId = null; d.newUnit = null;
    view.plan = null;
    // Re-seed the unit suggestion against the newly chosen subject.
    if (d.subjectId && t.unitNo != null) {
      const unit = state.units.find((u) => u.subject_id === d.subjectId && u.no === t.unitNo);
      if (unit) d.unitId = unit.id;
      else d.newUnit = { no: t.unitNo, title: t.unitTitle || `Unit ${t.unitNo}`, confirmed: false };
    }
    onChange();
  });

  const units = state.units.filter((u) => u.subject_id === d.subjectId).sort((a, b) => a.no - b.no);
  const unitSel = el('select', { class: 'select' },
    el('option', { value: '' }, '— subject level (no unit) —'),
    units.map((u) => el('option', { value: u.id, selected: u.id === d.unitId }, `Unit ${u.no} — ${u.title}`)),
  );
  unitSel.addEventListener('change', () => {
    d.unitId = unitSel.value || null;
    d.newUnit = null;
    onChange();
  });

  const suggestion = [
    t.semesterLabel && `semester "${t.semesterLabel}"`,
    t.subject && `subject "${t.subject}"`,
    t.unitNo != null && `unit ${t.unitNo}${t.unitTitle ? ` — ${t.unitTitle}` : ''}`,
  ].filter(Boolean).join(' · ');

  const body = el('div', { class: 'dest-grid' },
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Semester'), semSel),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Subject'), subSel),
    el('label', { class: 'field' }, el('span', { class: 'label' }, 'Unit'), unitSel),
  );

  const notes = el('div', { class: 'dest-notes' });

  if (suggestion) {
    notes.append(el('p', { class: 'hint' }, `The payload suggests ${suggestion}. It is a suggestion; what you pick here wins.`));
  }

  if (!state.semesters.length) {
    notes.append(el('p', { class: 'warn-line' },
      'No semesters exist yet. Create one in Settings before importing.'));
  } else if (d.semesterId && !subs.length) {
    notes.append(el('p', { class: 'warn-line' },
      'This semester has no subjects. Create one in Settings before importing.'));
  }

  // Units are never created silently — this is the explicit tick.
  if (d.newUnit) {
    const check = el('input', { type: 'checkbox', checked: d.newUnit.confirmed });
    check.addEventListener('change', () => { d.newUnit.confirmed = check.checked; onChange(); });
    notes.append(el('label', { class: 'confirm-line' }, check,
      el('span', {}, `Unit ${d.newUnit.no} — ${d.newUnit.title} does not exist yet. Create it and import into it.`)));
  }

  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, 'Destination'),
    body, notes,
  );
}

// ── counts and actions ──────────────────────────────────────────────────────

function countsPanel(view, cards, errors, redraw, commit) {
  const c = view.plan.counts;
  const d = view.dest;

  const willImport =
    c.new
    + (view.onDuplicate === 'import' ? c.duplicate : 0)
    + (view.onUpdate === 'update' ? c.update : 0);

  const blockedByUnit = d.newUnit && !d.newUnit.confirmed;

  const choice = (label, value, current, set) => {
    const btn = el('button', {
      class: value === current ? 'btn btn-sm is-on' : 'btn btn-sm btn-ghost',
      type: 'button',
      onclick: () => { set(value); redraw(); },
    }, label);
    return btn;
  };

  const stat = (n, label, kind) => el('div', { class: `stat ${kind ? `stat-${kind}` : ''}`.trim() },
    el('div', { class: 'stat-n num' }, String(n)),
    el('div', { class: 'stat-label' }, label),
  );

  const go = el('button', {
    class: 'btn btn-primary', type: 'button',
    disabled: willImport === 0 || blockedByUnit || !d.subjectId,
  }, `Import ${pluralise(willImport, 'card')}`);
  go.addEventListener('click', () => commit(go));

  const rows = el('div', { class: 'counts-rows' });

  if (c.duplicate) {
    rows.append(el('div', { class: 'counts-row' },
      el('span', {}, `${pluralise(c.duplicate, 'duplicate')} — same front text already in this subject`),
      el('span', { class: 'row-actions' },
        choice('Skip', 'skip', view.onDuplicate, (v) => { view.onDuplicate = v; }),
        choice('Import anyway', 'import', view.onDuplicate, (v) => { view.onDuplicate = v; }),
      ),
    ));
  }
  if (c.update) {
    rows.append(el('div', { class: 'counts-row' },
      el('span', {}, `${pluralise(c.update, 'update')} — matched on id, schedule preserved`),
      el('span', { class: 'row-actions' },
        choice('Update', 'update', view.onUpdate, (v) => { view.onUpdate = v; }),
        choice('Skip', 'skip', view.onUpdate, (v) => { view.onUpdate = v; }),
      ),
    ));
  }
  if (c.reverse) {
    rows.append(el('div', { class: 'counts-row' },
      el('span', { class: 'dim' },
        `${pluralise(c.reverse, 'card')} asks for a reverse. Reverse cards are not generated in v1 — the flag is kept in the payload, not the database.`),
    ));
  }
  if (blockedByUnit) {
    rows.append(el('div', { class: 'counts-row warn-line' },
      el('span', {}, 'Tick the unit confirmation above before importing.')));
  }

  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, 'Preview'),
    el('div', { class: 'stats-row' },
      stat(c.new, 'new', 'good'),
      stat(c.duplicate, 'duplicate', c.duplicate ? 'warn' : ''),
      stat(c.update, 'update', c.update ? 'info' : ''),
      stat(errors.length, 'malformed', errors.length ? 'bad' : ''),
    ),
    rows,
    el('div', { class: 'import-go' }, go,
      el('span', { class: 'hint' },
        `${summariseTypes(cards)} · ${pluralise(cards.length, 'card')} parsed`)),
  );
}

function summariseTypes(cards) {
  const { byType } = summarise(cards);
  return Object.entries(byType).map(([t, n]) => `${n} ${TYPE_LABEL[t] ?? t}`).join(', ') || 'nothing';
}

// ── the row list ────────────────────────────────────────────────────────────

function rowsPanel(view) {
  const list = el('div', { class: 'import-rows' });

  for (const row of view.plan.rows) {
    const skipped =
      (row.status === 'duplicate' && view.onDuplicate === 'skip')
      || (row.status === 'update' && view.onUpdate === 'skip');

    const front = plainText(frontTextOf(row.card.content));
    const details = el('div', { class: 'import-row-detail' });
    let open = false;

    const head = el('button', {
      class: `import-row ${skipped ? 'is-skipped' : ''}`.trim(), type: 'button',
    },
      el('span', { class: `badge badge-${row.status}` }, row.status),
      el('span', { class: 'badge badge-type' }, TYPE_LABEL[row.card.type] ?? row.card.type),
      el('span', { class: 'import-row-front' }, front || '(no front text)'),
      row.card.importance === 3 ? el('span', { class: 'badge badge-imp' }, '★★★') : null,
    );

    head.addEventListener('click', () => {
      open = !open;
      details.hidden = !open;
      if (open && !details.childElementCount) details.append(cardDetail(row));
    });
    details.hidden = true;

    list.append(el('div', { class: 'import-row-wrap' }, head, details));
  }

  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, 'Cards'),
    list,
  );
}

function cardDetail(row) {
  const c = row.card;
  const out = el('dl', { class: 'kv' });
  const add = (k, v) => {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
    out.append(el('dt', {}, k), el('dd', {}, Array.isArray(v) ? v.join(', ') : String(v)));
  };

  for (const [k, v] of Object.entries(c.content)) {
    add(k, Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)) : v);
  }
  add('why', c.why);
  add('trap', c.trap);
  add('source', c.source);
  add('figure_ref', c.figure_ref);
  add('importance', c.importance);
  add('marks', c.marks);
  add('tags', c.tags);
  add('id', c.importKey);
  if (row.existing) add('matches', `existing card ${row.existing.id.slice(0, 8)} · ${row.existing.reps} reps · due ${row.existing.due}`);

  return out;
}

function errorsPanel(errors) {
  return el('section', { class: 'card-panel' },
    el('h3', { class: 'panel-title' }, `Malformed — ${pluralise(errors.length, 'card')}`),
    el('div', { class: 'import-rows' },
      errors.map((e) => el('div', { class: 'import-error' },
        el('div', { class: 'import-error-msg' },
          e.line ? el('span', { class: 'badge badge-bad' }, `line ${e.line}`) : null,
          el('span', {}, e.message),
        ),
        e.raw ? el('pre', { class: 'import-error-raw' }, String(e.raw).slice(0, 600)) : null,
      )),
    ),
  );
}

// ── copy AI prompt ──────────────────────────────────────────────────────────

/**
 * Builds the instruction block from IMPORT-FORMAT.md with the destination and
 * the existing fronts filled in, so the AI cannot repeat cards you already have.
 */
async function copyAiPrompt(view, state) {
  const d = view.dest;
  const sub = state.subjects.find((s) => s.id === d.subjectId);
  const unit = state.units.find((u) => u.id === d.unitId);

  if (!sub) { toast('Pick a subject first — the prompt needs a destination.', 'warn'); return; }

  let fronts = [];
  try {
    const { rows } = await db.listCards({
      filters: { subjectId: sub.id, ...(unit ? { unitId: unit.id } : {}) },
      pageSize: 500,
    });
    fronts = rows.map((r) => plainText(frontTextOf(r.content))).filter(Boolean);
  } catch (err) {
    toastError('Could not read existing fronts', err);
    return;
  }

  const where = unit ? `${sub.name} — Unit ${unit.no}: ${unit.title}` : sub.name;
  const text = [
    'Read the attached format reference (docs/IMPORT-FORMAT.md). Using the attached',
    `course material, produce flashcards for ${where}.`,
    '',
    'Return JSON only, in a single code block, conforming to the schema in the reference.',
    'Aim for 30-40 cards. Follow every rule in the "Writing rules" section.',
    'Prefer qa, formula and list. Set importance honestly. Never invent a number.',
    '',
    'Use this target block:',
    JSON.stringify({
      remento: 1,
      target: {
        semester: state.semesters.find((s) => s.id === d.semesterId)?.slug ?? '',
        subject: sub.name,
        ...(sub.code ? { subject_code: sub.code } : {}),
        ...(unit ? { unit: { no: unit.no, title: unit.title } } : {}),
      },
      defaults: { tags: [], importance: 2 },
      cards: [],
    }, null, 2),
    '',
    fronts.length
      ? `Do not repeat any of these ${fronts.length} fronts, which already exist:\n${fronts.map((f) => `- ${f}`).join('\n')}`
      : 'This unit is empty — there are no existing fronts to avoid.',
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
    toast(`Prompt copied — ${pluralise(fronts.length, 'existing front')} listed.`, 'ok');
  } catch {
    // Clipboard is blocked outside a user gesture or over http on some browsers.
    const ta = el('textarea', { class: 'textarea', style: 'min-height:280px' });
    ta.value = text;
    clear(document.querySelector('#modal-root'));
    const { openModal } = await import('../ui.js');
    openModal({ title: 'Copy this prompt', body: ta, wide: true, actions: [{ label: 'Done', value: true }] });
    ta.select();
  }
}
