// Subject — the academic index for one subject (§26).
//
// The unit list is a syllabus, not six cards. Readiness sits beside coverage
// and never appears without it: §6.3 is explicit that a deck holding two of
// five units can report 94%, and that is the failure mode this screen exists
// to prevent.

import {
  el, clear, toastError, loadingBlock, errorBlock, pluralise,
} from '../ui.js';
import { icon } from '../icons.js';
import * as db from '../db.js';
import { readiness } from '../scheduler.js';

export async function render(panel, ctx) {
  const { state, args, setHeader, navigate } = ctx;

  const subject = state.subjects.find((s) => s.id === args?.subjectId)
    ?? state.subjects.find((s) => s.id === state.focus.subjectId)
    ?? state.subjects[0];

  const root = el('div', { class: 'wrap' });
  panel.append(root);

  if (!subject) {
    root.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-title' }, 'No subjects yet'),
      el('p', {}, 'Create a semester and a subject in Settings, then import some cards.'),
    ));
    return { teardown() { clear(root); } };
  }

  const semester = state.semesters.find((s) => s.id === subject.semester_id);
  setHeader({
    crumb: [semester?.label ?? '—', subject.name],
    actions: [
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => navigate('import'),
      }, icon('import', { size: 14 }), 'Import'),
      el('button', {
        class: 'btn btn-sm btn-primary', type: 'button',
        onclick: () => { state.focus = { ...state.focus, subjectId: subject.id, unitId: null }; navigate('drill'); },
      }, 'Mix all units'),
    ],
  });

  root.append(loadingBlock('Loading subject…'));

  try {
    const units = state.units.filter((u) => u.subject_id === subject.id).sort((a, b) => a.no - b.no);
    const [counts, ret, allCards, dueByUnit] = await Promise.all([
      db.coverageByUnit(subject.id),
      db.retention({ days: 30, subjectId: subject.id }),
      db.listCards({ filters: { subjectId: subject.id }, pageSize: 1000 }).then((r) => r.rows),
      dueCounts(subject.id, units),
    ]);

    const r = readiness({
      cards: allCards, retentionPct: ret.pct, unitsDeclared: subject.units_declared,
    });

    clear(root);
    root.append(
      hero(subject, r, units, counts),
      unitIndex(subject, units, counts, dueByUnit, state, navigate),
    );
  } catch (err) {
    clear(root);
    root.append(errorBlock(err, () => render(panel, ctx)));
    toastError('Could not load the subject', err);
  }

  return { teardown() { clear(root); } };
}

/** Due card count per unit, in one query rather than one per unit. */
async function dueCounts(subjectId, units) {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await db.listCards({
    filters: { subjectId, suspended: false }, pageSize: 1000,
  });
  const map = new Map(units.map((u) => [u.id, 0]));
  let loose = 0;
  for (const c of rows) {
    if (String(c.due) > today) continue;
    if (c.unit_id && map.has(c.unit_id)) map.set(c.unit_id, map.get(c.unit_id) + 1);
    else loose += 1;
  }
  map.set(null, loose);
  return map;
}

function hero(subject, r, units, counts) {
  const declared = subject.units_declared;
  const withCards = units.filter((u) => (counts.get(u.id) ?? 0) > 0).length;

  const coverageText = declared == null
    ? 'Undeclared'
    : `${withCards} / ${declared} units`;

  const score = el('div', {
    class: r.honest && r.score != null ? 'readiness-n num' : 'readiness-n num is-greyed',
  }, r.score == null ? '—' : `${r.score}%`);

  return el('section', { class: 'subject-hero' },
    el('h1', { class: 'subject-name' }, subject.name),
    subject.code ? el('div', { class: 'subject-code' }, subject.code) : null,

    el('div', { class: 'readiness' },
      el('div', { class: 'readiness-fig' }, score,
        el('div', { class: 'readiness-label' }, 'Readiness')),
      el('div', { class: 'readiness-fig' },
        el('div', { class: 'readiness-n num' }, coverageText),
        el('div', { class: 'readiness-label' }, 'Coverage')),
    ),

    el('p', { class: 'readiness-caveat' }, caveat(r, declared, units, counts)),
  );
}

/**
 * The sentence that keeps readiness honest. It always says what the number
 * does not know.
 */
function caveat(r, declared, units, counts) {
  if (declared == null) {
    return 'Readiness is greyed out because this subject has no declared unit count, so there is no denominator for coverage. Set one in Settings and the figure becomes meaningful.';
  }
  if (r.score == null) {
    return 'No scheduled reviews yet, so there is nothing to measure recall against. Readiness appears once you have drilled these cards.';
  }
  const empty = [];
  for (let n = 1; n <= declared; n++) {
    const unit = units.find((u) => u.no === n);
    if (!unit || !(counts.get(unit.id) ?? 0)) empty.push(n);
  }
  const base = 'Readiness measures how well you know the cards you have made. It knows nothing about your syllabus.';
  return empty.length
    ? `${base} ${empty.length === 1 ? 'Unit' : 'Units'} ${empty.join(', ')} ${empty.length === 1 ? 'has' : 'have'} no cards at all.`
    : base;
}

function unitIndex(subject, units, counts, dueByUnit, state, navigate) {
  const declared = subject.units_declared;
  const upTo = declared ?? (units.length ? Math.max(...units.map((u) => u.no)) : 0);

  const slots = [];
  for (let n = 1; n <= upTo; n++) {
    slots.push({ no: n, unit: units.find((u) => u.no === n) });
  }
  for (const u of units) if (u.no > upTo) slots.push({ no: u.no, unit: u });

  const looseCount = counts.get(null) ?? 0;

  const list = el('div', { class: 'unit-list' },
    slots.map(({ no, unit }) => {
      const n = unit ? (counts.get(unit.id) ?? 0) : 0;
      const due = unit ? (dueByUnit.get(unit.id) ?? 0) : 0;

      const row = el('button', {
        class: unit ? 'unit-row' : 'unit-row is-missing',
        type: 'button', disabled: !unit || !n,
      },
        el('span', { class: 'unit-no' }, String(no).padStart(2, '0')),
        el('span', { class: 'unit-title' }, unit ? unit.title : 'Not created'),
        el('span', { class: 'unit-count' }, n ? pluralise(n, 'card') : '—'),
        el('span', { class: due ? 'unit-due' : 'unit-due is-clear' }, due ? `${due} due` : '—'),
      );

      if (unit && n) {
        row.addEventListener('click', () => {
          state.focus = { semesterId: subject.semester_id, subjectId: subject.id, unitId: unit.id };
          navigate('drill');
        });
      }
      return row;
    }),

    looseCount
      ? el('div', { class: 'unit-row' },
        el('span', { class: 'unit-no' }, '—'),
        el('span', { class: 'unit-title' }, 'Subject level'),
        el('span', { class: 'unit-count' }, pluralise(looseCount, 'card')),
        el('span', { class: 'unit-due is-clear' }, '—'))
      : null,
  );

  return el('section', { class: 'section' },
    el('h2', { class: 'panel-title' }, 'Units'),
    list);
}
