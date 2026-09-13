// Drill — the 95% screen. Calm, paper-like, almost no chrome.
//
// Also hosts Cram and Weak, because they are the same loop with different
// queues and one difference that matters: cram writes no schedule.

import {
  el, clear, toast, toastError, loadingBlock, errorBlock,
  fmtInterval, pluralise,
} from '../ui.js';
import * as db from '../db.js';
import {
  GRADES, WRITES_SCHEDULE, schedule, previews, suggestedGrade,
  orderQueue, applyDailyLimits,
} from '../scheduler.js';
import { renderFront, renderBack } from '../card-render.js';
import { editCard } from '../card-editor.js';
import { icon } from '../icons.js';

const MODES = [
  { key: 'drill', label: 'Drill', short: 'Due cards, schedules' },
  { key: 'cram', label: 'Cram', short: 'Everything, no schedule' },
  { key: 'weak', label: 'Weak', short: 'Leeches and starred' },
];

export async function render(panel, ctx) {
  const { state, onStateChange, setHeader, navigate } = ctx;

  const root = el('div', { class: 'wrap-narrow drill-root' });
  panel.append(root);

  /** null until a session starts; the setup screen is shown meanwhile. */
  let session = null;
  let keyHandler = null;

  const unsub = onStateChange((what) => {
    if (what === 'editMode' && session) drawCard();
  });

  // ── setup ─────────────────────────────────────────────────────────────────

  const setup = {
    mode: 'drill',
    semesterId: state.focus.semesterId ?? state.semesters[0]?.id ?? null,
    subjectId: state.focus.subjectId ?? null,
    unitId: state.focus.unitId ?? null,
    size: state.settings?.sessionSize ?? 25,
  };

  async function drawSetup() {
    clear(root);

    if (!state.subjects.length) {
      setHeader({ crumb: ['Drill'] });
      root.append(el('div', { class: 'empty' },
        el('p', { class: 'empty-title' }, 'Nothing to drill yet'),
        el('p', {}, 'Create a semester and a subject in Settings, then import some cards.'),
      ));
      return;
    }

    // Always a real subject. "All subjects in this semester" was an option
    // nobody wants: an exam is one subject, and a queue mixed across syllabi
    // makes the interval previews mean nothing.
    if (!setup.subjectId || !state.subjects.some((x) => x.id === setup.subjectId)) {
      setup.subjectId = state.subjects[0].id;
      setup.semesterId = state.subjects[0].semester_id;
      setup.unitId = null;
    }
    setHeader({ crumb: ['Drill'], actions: [] });

    const statsRow = el('div', { class: 'stats-row' });
    const cta = el('div', { class: 'dash-cta' });
    const subjects = el('div', {}, loadingBlock('Counting what is waiting...'));

    root.append(el('div', { class: 'dash' },
      el('section', { class: 'dash-hero' },
        el('div', { class: 'dash-greet' },
          el('h1', { class: 'dash-title' }, greeting()),
          el('span', { class: 'dash-date' }, longDate()),
        ),
        statsRow, cta,
      ),
      el('section', { class: 'card-panel' },
        el('h2', { class: 'panel-title' }, 'What is waiting'),
        subjects,
      ),
      el('section', { class: 'card-panel' },
        el('h2', { class: 'panel-title' }, 'Session'),
        modeRow(),
        el('div', { class: 'setup-grid', style: 'margin-top:16px' },
          labelled('Unit', unitSelect()),
          labelled('Session size', sizeInput()),
        ),
      ),
    ));

    try {
      const [work, done] = await Promise.all([db.workload(), db.todayCounts()]);
      paintStats(statsRow, cta, work, done);
      paintSubjects(subjects, work);
    } catch (err) {
      clear(subjects);
      subjects.append(errorBlock(err, () => drawSetup()));
    }
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Still up';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function longDate() {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }

  function labelled(label, control) {
    return el('label', { class: 'field' }, el('span', { class: 'label' }, label), control);
  }

  function tile(n, label, kind, foot) {
    return el('div', { class: kind ? `stat stat-${kind}` : 'stat' },
      el('div', { class: 'stat-n num' }, String(n)),
      el('div', { class: 'stat-label' }, label),
      foot ? el('div', { class: 'stat-foot' }, foot) : null,
    );
  }

  function paintStats(statsRow, cta, work, done) {
    clear(statsRow);
    clear(cta);

    const settings = state.settings ?? {};
    const revLeft = Math.max(0, (settings.reviewsPerDay ?? 0) - done.reviews);
    const newLeft = Math.max(0, (settings.newPerDay ?? 0) - done.newCards);

    statsRow.append(
      tile(work.due, 'due now', work.due ? 'accent' : 'good',
        work.due ? 'across every subject' : 'queue is clear'),
      tile(done.total, 'done today', '', `${done.reviews} scheduled`),
      tile(revLeft, 'reviews left', revLeft ? '' : 'warn', `cap ${settings.reviewsPerDay ?? '-'}/day`),
      tile(newLeft, 'new left', newLeft ? '' : 'warn', `cap ${settings.newPerDay ?? '-'}/day`),
    );

    const subject = state.subjects.find((x) => x.id === setup.subjectId);
    const scoped = setup.unitId
      ? (work.byUnit.get(setup.unitId)?.due ?? 0)
      : (work.bySubject.get(setup.subjectId)?.due ?? 0);

    const start = el('button', { class: 'btn btn-primary btn-lg', type: 'button' },
      scoped ? `Start \u00b7 ${pluralise(Math.min(scoped, setup.size), 'card')}` : 'Start session');
    start.addEventListener('click', () => startSession(start));
    cta.append(start);

    if (!scoped && setup.mode === 'drill') {
      cta.append(el('span', { class: 'hint' },
        `Nothing due in ${subject?.name ?? 'this subject'} right now. Cram drills it anyway.`));
    }
  }

  /** Every subject, and the units inside the one you have chosen. */
  function paintSubjects(host, work) {
    clear(host);
    const list = el('div', { class: 'rec-list' });

    for (const sub of state.subjects) {
      const w = work.bySubject.get(sub.id) ?? { total: 0, due: 0, fresh: 0 };
      const active = sub.id === setup.subjectId;

      const row = el('button', { class: 'rec', type: 'button', 'aria-pressed': String(active) },
        el('span', { class: 'nav-icon' }, icon('subject', { size: 16 })),
        el('span', { class: 'rec-main' },
          el('span', { class: 'rec-title' }, sub.name),
          el('span', { class: 'rec-sub' },
            [sub.code, `${w.total} cards`, w.fresh ? `${w.fresh} new` : null]
              .filter(Boolean).join('  \u00b7  ')),
        ),
        active ? el('span', { class: 'badge badge-imp' }, 'selected') : null,
        el('span', { class: w.due ? 'rec-due' : 'rec-due is-clear' }, w.due ? `${w.due} due` : '-'),
      );
      row.addEventListener('click', () => {
        setup.subjectId = sub.id;
        setup.semesterId = sub.semester_id;
        setup.unitId = null;
        drawSetup();
      });
      list.append(row);

      if (!active) continue;
      const units = state.units.filter((u) => u.subject_id === sub.id).sort((a, b) => a.no - b.no);
      for (const unit of units) {
        const uw = work.byUnit.get(unit.id) ?? { total: 0, due: 0 };
        const chosen = setup.unitId === unit.id;
        const urow = el('button', {
          class: 'rec', type: 'button', style: 'padding-left:44px',
          'aria-pressed': String(chosen),
        },
          el('span', { class: 'rec-no' }, String(unit.no).padStart(2, '0')),
          el('span', { class: 'rec-main' },
            el('span', { class: 'rec-title' }, unit.title),
            el('span', { class: 'rec-sub' }, `${uw.total} cards`),
          ),
          chosen ? el('span', { class: 'badge badge-imp' }, 'only this') : null,
          el('span', { class: uw.due ? 'rec-due' : 'rec-due is-clear' }, uw.due ? `${uw.due} due` : '-'),
        );
        urow.addEventListener('click', () => {
          setup.unitId = chosen ? null : unit.id;
          drawSetup();
        });
        list.append(urow);
      }
    }
    host.append(list);
  }

  function modeRow() {
    return el('div', { class: 'mode-row' },
      MODES.map((m) => {
        const on = m.key === setup.mode;
        const btn = el('button', {
          class: on ? 'btn mode-btn is-on' : 'btn mode-btn', type: 'button',
          'aria-pressed': String(on),
        },
          el('span', { class: 'mode-name' }, m.label),
          el('span', { class: 'mode-blurb' }, m.short),
        );
        btn.addEventListener('click', () => { setup.mode = m.key; drawSetup(); });
        return btn;
      }),
    );
  }

  function unitSelect() {
    const units = state.units.filter((u) => u.subject_id === setup.subjectId)
      .sort((a, b) => a.no - b.no);
    const sel = el('select', { class: 'select', disabled: !units.length },
      el('option', { value: '' }, units.length ? 'Mix all units' : 'No units yet'),
      units.map((u) => el('option', {
        value: u.id, selected: u.id === setup.unitId,
      }, `Unit ${String(u.no).padStart(2, '0')} - ${u.title}`)),
    );
    sel.addEventListener('change', () => { setup.unitId = sel.value || null; drawSetup(); });
    return sel;
  }

  function sizeInput() {
    const input = el('input', {
      class: 'input', type: 'number', min: 1, max: 500, value: setup.size, inputmode: 'numeric',
    });
    input.addEventListener('change', () => {
      setup.size = Math.min(500, Math.max(1, Math.round(Number(input.value)) || 25));
    });
    return input;
  }

  // ── session ───────────────────────────────────────────────────────────────

  async function startSession(button) {
    button.disabled = true;
    button.textContent = 'Building queue…';

    const filters = {
      subjectId: setup.subjectId,
      ...(setup.unitId ? { unitId: setup.unitId } : {}),
    };

    try {
      let queue;
      if (setup.mode === 'cram') {
        queue = await db.cramQueue({ filters, limit: setup.size });
      } else if (setup.mode === 'weak') {
        queue = (await db.weakQueue({ filters, limit: setup.size * 3 })).slice(0, setup.size);
      } else {
        const due = await db.dueQueue({ filters, limit: 500 });
        const done = await db.todayCounts();
        queue = applyDailyLimits(orderQueue(due), state.settings ?? {}, done).slice(0, setup.size);
      }

      if (!queue.length) {
        toast(setup.mode === 'drill'
          ? 'Nothing due in that scope. Try Cram, or widen the filter.'
          : 'No cards match that scope.', 'warn');
        return;
      }

      state.focus = { semesterId: setup.semesterId, subjectId: setup.subjectId, unitId: setup.unitId };
      session = {
        mode: setup.mode,
        queue,
        // The finish line is fixed at what you started with. Cards sent back
        // by Again are extra work, not a moving target — §4.2 says a visible
        // finish line is what makes a phone session start at all, and a
        // denominator that grows every time you press Again is not one.
        size: queue.length,
        index: 0,
        revealed: false,
        ticks: null,
        checked: null,
        cardStart: Date.now(),
        graded: 0,
        tally: { again: 0, hard: 0, good: 0, easy: 0 },
      };
      bindKeys();
      drawCard();
    } catch (err) {
      toastError('Could not build the queue', err);
    } finally {
      button.disabled = false;
      button.textContent = 'Start';
    }
  }

  function endSession() {
    const done = session;
    session = null;
    unbindKeys();
    drawFinished(done);
  }

  function drawFinished(done) {
    clear(root);
    const t = done.tally;
    root.append(
      el('div', { class: 'page-head' },
        el('h2', { class: 'page-title' }, 'Session finished'),
        el('p', { class: 'page-sub' }, done.mode),
      ),
      el('section', { class: 'card-panel' },
        el('div', { class: 'stats-row' },
          tile(done.graded, 'graded'),
          tile(t.again, 'again', 'bad'),
          tile(t.hard, 'hard', 'warn'),
          tile(t.good + t.easy, 'good or better', 'good'),
        ),
        done.mode === 'cram'
          ? el('p', { class: 'hint' },
            'Cram logged these reviews and left every due date exactly where it was. That is deliberate.')
          : null,
        el('div', { class: 'row-actions', style: 'margin-top:16px' },
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => drawSetup(),
          }, 'Keep going'),
        ),
      ),
    );
  }

  function tile(n, label, kind) {
    return el('div', { class: `stat ${kind ? `stat-${kind}` : ''}`.trim() },
      el('div', { class: 'stat-n num' }, String(n)),
      el('div', { class: 'stat-label' }, label));
  }

  // ── the card ──────────────────────────────────────────────────────────────

  function current() { return session?.queue[session.index]; }

  function drawCard() {
    if (!session) return;
    const card = current();
    if (!card) { endSession(); return; }

    clear(root);

    const size = session.size;
    const done = Math.min(session.index, size);
    // Cards past the original queue length are Again requeues being re-shown.
    const redo = session.queue.length - Math.max(session.index, size);
    const pct = Math.round((done / size) * 100);
    const bar = el('div', { class: 'progress-block' },
      el('div', {
        class: 'progress', role: 'progressbar',
        'aria-valuenow': String(done), 'aria-valuemin': '0', 'aria-valuemax': String(size),
        'aria-label': `${done} of ${size} cards graded`,
      }, el('div', { class: 'progress-fill', style: `width:${pct}%` })),
      el('span', { class: 'progress-pct' }, `${pct}%`));

    const subject = state.subjects.find((s) => s.id === card.subject_id);
    const unit = state.units.find((u) => u.id === card.unit_id);

    setHeader({
      crumb: [subject?.name ?? 'All subjects', unit ? `Unit ${String(unit.no).padStart(2, '0')}` : 'All units'],
      actions: [
        session.mode !== 'drill' ? el('span', { class: 'badge badge-mode' }, session.mode) : null,
        el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: () => endSession(),
        }, 'End session'),
      ].filter(Boolean),
    });

    // Location lives in the contextual header now, so the card carries only
    // the counter. Saying "Thermodynamics · Unit 1" twice on a 375px screen
    // is chrome competing with the question.
    const head = el('div', { class: 'drill-head' },
      el('span', { class: 'drill-count num' },
        session.index < size ? `${session.index + 1} / ${size}` : `${size} / ${size}`),
      redo > 0 ? el('span', { class: 'drill-redo num' }, `+${redo} to redo`) : null,
      el('span', { class: 'drill-where' }),
      el('span', { class: 'row-actions' },
        state.editMode
          ? el('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', title: 'Edit this card (e)',
            onclick: () => openEditor(card),
          }, '✎') : null,
      ),
    );

    const body = el('div', { class: 'drill-card' }, renderFront(card));
    const foot = el('div', { class: 'drill-foot' });

    if (!session.revealed) {
      // The one filled scarlet control on this screen.
      const show = el('button', { class: 'btn btn-primary btn-block btn-reveal', type: 'button' },
        'Show answer');
      show.addEventListener('click', reveal);
      foot.append(show,
        el('p', { class: 'kbd-hint' }, 'space or enter'));
    } else {
      body.append(el('hr', { class: 'card-rule' }));
      body.append(renderBack(card, { onTick, checked: session.checked ?? [] }));
      foot.append(gradeRow(card));
    }

    root.append(bar, head, body, foot);
  }

  function reveal() {
    if (!session || session.revealed) return;
    session.revealed = true;
    drawCard();
  }

  function onTick(ticked, total, boxes) {
    if (!session) return;
    session.ticks = { ticked, total };
    session.checked = boxes;
    const suggested = suggestedGrade(ticked, total);
    for (const btn of root.querySelectorAll('.grade-btn')) {
      btn.classList.toggle('is-suggested', Number(btn.dataset.grade) === suggested);
    }
    const note = root.querySelector('.grade-suggestion');
    if (note) {
      note.textContent = total
        ? `${ticked} of ${total} · suggests ${GRADES[suggested]?.label ?? '—'}`
        : '';
    }
  }

  /** Four outline buttons with a coloured left edge, and their next intervals. */
  function gradeRow(card) {
    const writes = WRITES_SCHEDULE[session.mode];
    const preview = previews(card);

    const row = el('div', { class: 'grade-row' },
      preview.map((p) => {
        const btn = el('button', {
          class: 'btn grade-btn', type: 'button',
          style: `--grade-color: var(${p.token})`,
          dataset: { grade: String(p.grade) },
        },
          el('span', { class: 'grade-key num' }, String(p.grade + 1)),
          el('span', { class: 'grade-label' }, p.label),
          el('span', { class: 'grade-ivl num' }, writes ? fmtInterval(p.ivl) : '—'),
        );
        btn.addEventListener('click', () => grade(p.grade));
        return btn;
      }),
    );

    return el('div', {}, row,
      el('p', { class: 'grade-suggestion hint' }, ''),
      el('p', { class: 'kbd-hint' },
        writes ? '1–4 to grade' : 'Cram: graded for the record, due dates untouched'),
    );
  }

  async function grade(g) {
    if (!session || !session.revealed) return;
    const card = current();
    const writes = WRITES_SCHEDULE[session.mode];

    const next = writes ? schedule(card, g) : null;
    const fraction = session.ticks?.total ? session.ticks.ticked / session.ticks.total : null;
    const ms = Date.now() - session.cardStart;

    // Read the interval before anything mutates the card. The review row's
    // ivl_before is what marks a review as a card's first — todayCounts()
    // counts new cards with it — so it has to be the stored value, not the
    // one we are about to write.
    const ivlBefore = card.ivl ?? 0;

    // Advance the UI immediately; the write follows. A slow network must not
    // make the next card wait.
    session.graded += 1;
    session.tally[GRADES[g].key] += 1;

    if (next) Object.assign(card, {
      ivl: next.ivl, ease: next.ease, due: next.due, reps: next.reps, lapses: next.lapses,
    });

    // Again puts the card back at the end of this session, as §4.3 asks.
    if (g === 0) session.queue.push({ ...card });

    session.index += 1;
    session.revealed = false;
    session.ticks = null;
    session.checked = null;
    session.cardStart = Date.now();
    drawCard();

    try {
      await db.recordReview({ card, grade: g, next, mode: session.mode, fraction, ms, ivlBefore });
      if (next?.isLeech) toast('That card is now a leech — Weak mode collects it.', 'warn');
    } catch (err) {
      toastError('Review not saved', err);
    }
  }

  async function openEditor(card) {
    const saved = await editCard(card, { structure: state });
    if (!saved) return;
    Object.assign(card, saved);
    drawCard();
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  function bindKeys() {
    unbindKeys();
    keyHandler = (e) => {
      if (!session || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement
        && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (!document.getElementById('modal-root').hidden) return;

      if (!session.revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault(); reveal(); return;
      }
      if (session.revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault(); grade(Number(e.key) - 1); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); endSession(); }
    };
    document.addEventListener('keydown', keyHandler);
  }

  function unbindKeys() {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }

  // ── go ────────────────────────────────────────────────────────────────────

  root.append(loadingBlock('Loading…'));
  try {
    await drawSetup();
  } catch (err) {
    clear(root);
    root.append(errorBlock(err, () => drawSetup()));
  }

  return {
    teardown() {
      unbindKeys();
      unsub();
      clear(root);
    },
  };
}
