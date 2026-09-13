// Settings — sectioned, the way a mature application settings screen is.
//
// Desktop puts the section list beside the content; phone shows the list and
// replaces it on choice. The sections are the ones that exist — a settings
// menu that leads nowhere is worse than a shorter menu.

import {
  el, clear, toast, toastError, confirmDialog, promptDialog, pluralise,
} from '../ui.js';
import { icon } from '../icons.js';
import * as db from '../db.js';
import { DEFAULTS } from '../config.js';
import { doSignOut } from '../app.js';

const SECTIONS = [
  { id: 'profile', label: 'Profile', blurb: 'Your name and how Remento greets you.' },
  { id: 'study', label: 'Study', blurb: 'Session size and the daily caps.' },
  { id: 'structure', label: 'Structure', blurb: 'Semesters, subjects and units.' },
  { id: 'privacy', label: 'Privacy & data', blurb: 'What is stored, where, and what is not.' },
  { id: 'faq', label: 'FAQ', blurb: 'How the scheduling and the modes actually work.' },
  { id: 'account', label: 'Account', blurb: 'Sign out and delete your data.' },
];

export async function render(panel, ctx) {
  const { state, refreshStructure, setHeader, navigate } = ctx;

  const root = el('div', { class: 'wrap' });
  panel.append(root);

  let current = window.matchMedia('(max-width: 900px)').matches ? null : 'profile';

  const draw = () => {
    clear(root);
    const section = SECTIONS.find((s) => s.id === current);
    setHeader({ crumb: section ? ['Settings', section.label] : ['Settings'], actions: [] });

    root.append(el('div', { class: current ? 'settings-shell has-detail' : 'settings-shell' },
      sectionNav(),
      current ? el('div', { class: 'settings-detail' }, body(section)) : null,
    ));
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
      case 'study': return studySection(state);
      case 'structure': return structureSection(state, refreshStructure, draw);
      case 'privacy': return privacySection(navigate);
      case 'faq': return faqSection();
      case 'account': return accountSection(state);
      case 'profile':
      default: return profileSection(state, draw);
    }
  }

  draw();
  return { teardown() { clear(root); } };
}

// ── profile ─────────────────────────────────────────────────────────────────

function profileSection(state, redraw) {
  const s = state.settings ?? db.defaultSettings();
  const email = state.user?.email ?? '';
  const name = s.displayName || '';
  const initial = (name || email || '?').trim()[0]?.toUpperCase() ?? '?';

  const nameInput = el('input', {
    class: 'input', type: 'text', value: name, id: 'set-name',
    placeholder: 'Vinu', autocomplete: 'name', maxlength: 40,
  });
  const courseInput = el('input', {
    class: 'input', type: 'text', value: s.course ?? '', id: 'set-course',
    placeholder: 'BTech Mechanical Engineering', maxlength: 80,
  });
  const instInput = el('input', {
    class: 'input', type: 'text', value: s.institution ?? '', id: 'set-inst',
    placeholder: 'Amrita Vishwa Vidyapeetham', maxlength: 80,
  });

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save profile');
  const form = el('form', { class: 'settings-grid' },
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'set-name' }, 'Display name'),
      nameInput, el('span', { class: 'hint' }, 'Used to greet you on the drill screen.')),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'set-course' }, 'Course'),
      courseInput, el('span', { class: 'hint' }, 'Shown nowhere yet — kept for your own records.')),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'set-inst' }, 'Institution'),
      instInput, el('span', { class: 'hint' }, 'Same.')),
    el('div', { class: 'settings-actions' }, save),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving…';
    try {
      state.settings = await db.saveSettings({
        ...s,
        displayName: nameInput.value.trim(),
        course: courseInput.value.trim(),
        institution: instInput.value.trim(),
      });
      toast('Profile saved.', 'ok');
      redraw();
    } catch (err) {
      toastError('Could not save your profile', err);
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  });

  return el('div', {},
    el('section', { class: 'card-panel' },
      el('div', { class: 'profile-head' },
        el('div', { class: 'profile-avatar', 'aria-hidden': 'true' }, initial),
        el('div', { class: 'profile-meta' },
          el('div', { class: 'profile-name' }, name || 'No name set'),
          el('div', { class: 'profile-email' }, email),
        ),
      ),
      form,
    ),
    el('section', { class: 'card-panel' },
      sectionHead('Profile pictures', 'There are none, on purpose. Remento has one user — you — so an avatar would be decoration with a storage bill attached. The initial above is generated from your name.'),
    ),
  );
}

// ── study ───────────────────────────────────────────────────────────────────

function studySection(state) {
  const s = state.settings ?? db.defaultSettings();

  const mk = (key, label, desc, value, min, max) => {
    const input = el('input', {
      class: 'input', type: 'number', min, max, step: 1, value,
      inputmode: 'numeric', id: `set-${key}`, style: 'width:110px',
    });
    return {
      key, input,
      node: el('div', { class: 'set-row' },
        el('div', { class: 'set-main' },
          el('label', { class: 'set-label', for: `set-${key}` }, label),
          el('span', { class: 'set-desc' }, desc)),
        el('div', { class: 'set-ctl' }, input)),
    };
  };

  const fields = [
    mk('sessionSize', 'Session size', 'Cards before the finish line. A visible end is what makes a session start at all.', s.sessionSize, 1, 500),
    mk('newPerDay', 'New cards per day', 'How many unseen cards enter the rotation daily. Higher means faster coverage and a heavier queue in a week.', s.newPerDay, 0, 500),
    mk('reviewsPerDay', 'Reviews per day', 'Cap on scheduled reviews. Drill fills reviews before new cards, so a backlog is never buried under fresh material.', s.reviewsPerDay, 0, 2000),
  ];

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save limits');
  const form = el('form', { style: 'display:grid; gap:12px' },
    fields.map((f) => f.node),
    el('div', { style: 'margin-top:8px' }, save));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving…';
    try {
      state.settings = await db.saveSettings({
        ...s,
        sessionSize: clampInt(fields[0].input.value, 1, 500, DEFAULTS.sessionSize),
        newPerDay: clampInt(fields[1].input.value, 0, 500, DEFAULTS.newPerDay),
        reviewsPerDay: clampInt(fields[2].input.value, 0, 2000, DEFAULTS.reviewsPerDay),
      });
      toast('Limits saved.', 'ok');
    } catch (err) {
      toastError('Could not save limits', err);
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  });

  return el('div', {},
    el('section', { class: 'card-panel' },
      sectionHead('Daily limits', 'These apply across every subject.'),
      form),
    el('section', { class: 'card-panel' },
      sectionHead('Scheduling', 'Remento uses an SM-2 variant. The constants are deliberate and are not exposed as settings — tuning them per-session is how a schedule stops meaning anything.'),
      el('div', { class: 'kv' },
        el('dt', {}, 'Again'), el('dd', {}, 'Back this session. Ease drops 0.20, lapses +1.'),
        el('dt', {}, 'Hard'), el('dd', {}, 'Interval × 1.2. Ease drops 0.15.'),
        el('dt', {}, 'Good'), el('dd', {}, 'Interval × ease. Ease unchanged.'),
        el('dt', {}, 'Easy'), el('dd', {}, 'Interval × ease × 1.3. Ease rises 0.15.'),
        el('dt', {}, 'Ceiling'), el('dd', {}, '365 days. Leech at 6 lapses.'),
      )),
  );
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── privacy & data ──────────────────────────────────────────────────────────

function privacySection(navigate) {
  const row = (label, desc) => el('div', { class: 'set-row' },
    el('div', { class: 'set-main' },
      el('span', { class: 'set-label' }, label),
      el('span', { class: 'set-desc' }, desc)));

  return el('div', {},
    el('section', { class: 'card-panel' },
      sectionHead('Cookies and tracking',
        'Remento sets no cookies and runs no analytics. There is no tracking pixel, no session recording and no advertising identifier, because there is nobody to sell any of it to — this is a study tool with one user.'),
      el('div', { style: 'display:grid; gap:12px' },
        row('Browser storage',
          'One localStorage entry, remento.auth, holding your Supabase session so you stay signed in. Signing out deletes it. Nothing else is written to your device.'),
        row('Third-party requests',
          'Three, all for code and fonts: Supabase for your data, jsDelivr for the KaTeX maths renderer, Google Fonts for the typefaces. None of them receives your cards.'),
        row('Analytics',
          'None. No Google Analytics, no Plausible, no Sentry.'),
      )),

    el('section', { class: 'card-panel' },
      sectionHead('Where your data lives',
        'A Postgres database in Supabase’s ap-south-1 region, Mumbai. Row-level security restricts every table to user_id = auth.uid(), so the publishable key shipped in this page can read nothing without your session.'),
      el('div', { class: 'kv' },
        el('dt', {}, 'Cards'), el('dd', {}, 'Postgres, encrypted at rest.'),
        el('dt', {}, 'Images'), el('dd', {}, 'A private storage bucket, served through signed URLs that expire.'),
        el('dt', {}, 'History'), el('dd', {}, 'Every grade you have ever pressed, kept indefinitely so the stats mean something.'),
        el('dt', {}, 'Session'), el('dd', {}, 'localStorage on this device only.'),
      )),

    el('section', { class: 'card-panel' },
      sectionHead('Deletion', `Deleted cards keep their schedule and stay restorable for ${DEFAULTS.trashPurgeDays} days, then the app hard-deletes them on its next launch. There is no scheduled job — Remento is opened daily by definition.`),
      el('div', { class: 'row-actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => navigate('browse', { trash: true }) },
          icon('trash', { size: 14 }), 'Open trash'))),
  );
}

// ── FAQ ─────────────────────────────────────────────────────────────────────

const FAQ = [
  ['Why did a card come back straight away?',
   'You pressed Again. That sets the interval to zero and pushes the card to the end of the current session, so you see it once more before you finish. It also costs the card 0.20 of ease and adds a lapse.'],
  ['What does Cram do differently?',
   'Cram loads everything in scope — due or not, shuffled — and logs every grade, but never writes a due date. A week of cramming leaves your queue exactly where it was. That will feel wrong and it is correct: cramming is not evidence you will still know something in three weeks.'],
  ['What is a leech?',
   'A card you have failed six times. Weak mode collects them along with anything you have starred. A leech is usually a sign the card is badly written rather than that you are bad at it — two facts on one card, or a front that cannot be answered without seeing the back.'],
  ['Why is my readiness greyed out?',
   'Because the subject has no declared unit count, so coverage has no denominator. Readiness measures how well you know the cards you made; it knows nothing about your syllabus. Set the unit count in Structure and the figure becomes meaningful.'],
  ['Why does the session say 3 cards when 40 are due?',
   'Your daily review cap. Drill fills scheduled reviews before new cards and stops at the limit, which is what keeps a backlog from compounding. Raise it in Study.'],
  ['What happens if I edit a card I have been reviewing?',
   'Nothing to its schedule. Interval, ease, reps and lapses are untouched by an edit, and re-importing a card with the same id updates it rather than duplicating it. A typo fix on a card reviewed nine times does not send it back to the start.'],
  ['Does Remento work offline?',
   'It opens offline and then has nothing to show. The service worker caches the app shell only, never your cards — a stale card is worse than no card. An offline deck is planned and is the largest thing the architecture is still missing.'],
  ['Can I get my data out?',
   'Not yet, and that is a real gap. The spec describes a JSON backup and a Markdown export; neither is built. Until then your data is in Postgres and reachable through the Supabase dashboard.'],
];

function faqSection() {
  const list = el('div', { class: 'faq' });

  for (const [q, a] of FAQ) {
    const answer = el('div', { class: 'faq-a' }, a);
    answer.hidden = true;

    const item = el('div', { class: 'faq-item' });
    const btn = el('button', {
      class: 'faq-q', type: 'button', 'aria-expanded': 'false',
    },
      el('span', {}, q),
      el('span', { class: 'faq-chev', 'aria-hidden': 'true' }, icon('chevron', { size: 15 })),
    );
    btn.addEventListener('click', () => {
      const open = answer.hidden;
      answer.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      item.classList.toggle('is-open', open);
    });
    item.append(btn, answer);
    list.append(item);
  }

  return el('div', {},
    el('section', { class: 'card-panel' },
      sectionHead('Frequently asked', 'Mostly about why the scheduler did something surprising.'),
      list),
  );
}

// ── account ─────────────────────────────────────────────────────────────────

function accountSection(state) {
  return el('div', {},
    el('section', { class: 'card-panel' },
      sectionHead('Account', 'Magic link only — there is no password to lose.'),
      el('div', { class: 'kv' },
        el('dt', {}, 'Signed in as'), el('dd', {}, state.user?.email ?? 'unknown'),
        el('dt', {}, 'Method'), el('dd', {}, 'One-time email link'),
      ),
      el('div', { class: 'row-actions', style: 'margin-top:20px' },
        el('button', { class: 'btn', type: 'button', onclick: () => doSignOut() }, 'Sign out')),
      el('p', { class: 'hint', style: 'margin-top:12px' },
        'Signing out clears this device only. Your cards and schedule stay in Postgres.')),

    el('section', { class: 'card-panel' },
      sectionHead('Deleting your account',
        'There is no button for this, deliberately — an irreversible action behind one click is a bad idea, and this would drop every card, every review and every image. Delete the project from your Supabase dashboard when you want it gone.')),
  );
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

  const addSem = el('button', { class: 'btn btn-sm', type: 'button' }, icon('plus', { size: 14 }), 'Semester');
  addSem.addEventListener('click', async () => {
    const label = await promptDialog({
      title: 'New semester', label: 'Label', placeholder: 'Semester 3', confirmLabel: 'Create',
    });
    if (!label) return;
    busy(() => db.createSemester({ slug: slugify(label), label, position: state.semesters.length }),
      `Created ${label}.`);
  });

  return el('section', { class: 'card-panel' },
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
    const ok = await confirmDialog({
      title: `Delete ${sem.label}?`,
      message: subjects.length
        ? `This deletes ${pluralise(subjects.length, 'subject')} and every card inside them. Cards deleted this way do not go to the trash — they are gone.`
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
        iconBtn('trash', 'Delete semester', remove))),
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
    busy(() => db.updateSubject(sub.id, {
      units_declared: v === '' ? null : clampInt(v, 1, 99, declared),
    }), 'Saved.');
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

  return el('div', { class: 'tree-sub' },
    el('div', { class: 'tree-row' },
      el('span', { class: 'tree-name' }, sub.name),
      sub.code ? el('span', { class: 'tree-code' }, sub.code) : null,
      declared == null
        ? el('span', { class: 'tree-meta dim' }, `${units.length}/? units`)
        : el('span', { class: units.length >= declared ? 'tree-meta' : 'tree-meta is-short' },
          `${units.length}/${declared} units`),
      el('span', { class: 'row-actions' },
        moveButtons(sub, siblings, (id, position) => busy(() => db.updateSubject(id, { position }))),
        iconBtn('edit', 'Rename subject', rename),
        textBtn('Code', 'Set course code', setCode),
        textBtn('Units', 'Set declared unit count', setDeclared),
        iconBtn('plus', 'Add unit', addUnit),
        iconBtn('trash', 'Delete subject', remove))),
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
    if (no !== unit.no) busy(() => db.updateUnit(unit.id, { no }), `Now Unit ${no}.`);
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
      iconBtn('trash', 'Delete unit', remove)),
  );
}

function iconBtn(name, label, fn) {
  return el('button', {
    class: 'btn btn-sm btn-ghost btn-icon', type: 'button',
    title: label, 'aria-label': label, onclick: fn,
  }, icon(name, { size: 14 }));
}

function textBtn(text, label, fn) {
  return el('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: label, onclick: fn }, text);
}

function moveButtons(item, siblings, apply) {
  const ordered = siblings.slice().sort(byPosition);
  const i = ordered.findIndex((s) => s.id === item.id);

  const move = (delta) => {
    if (!ordered[i + delta]) return;
    Promise.all(ordered.map((s, idx) => {
      const want = idx === i ? i + delta : idx === i + delta ? i : idx;
      return s.position === want ? null : apply(s.id, want);
    }).filter(Boolean));
  };

  return [
    el('button', {
      class: 'btn btn-sm btn-ghost btn-icon', type: 'button',
      title: 'Move up', 'aria-label': 'Move up', disabled: i <= 0, onclick: () => move(-1),
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

function sectionHead(title, blurb) {
  return el('div', { class: 'settings-section-head' },
    el('h2', { class: 'settings-section-title' }, title),
    blurb ? el('p', { class: 'hint' }, blurb) : null,
  );
}
