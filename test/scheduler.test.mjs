// scheduler.test.mjs — the SM-2 variant from docs/SPEC.md §4.3, asserted
// against the spec text line by line.
//   node test/scheduler.test.mjs
//
// These constants are deliberate. If a change to scheduler.js makes a test here
// fail, the question is whether the spec changed — not whether the test is
// inconvenient.

import {
  schedule, previews, suggestedGrade, maturity, isLeech,
  orderQueue, applyDailyLimits, addDays, toIso,
  MAX_IVL, LEECH_AT, MIN_EASE, GRADES, WRITES_SCHEDULE,
} from '../js/scheduler.js';

let failed = 0;
const check = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`);
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const TODAY = new Date(2026, 8, 13);          // 13 Sep 2026, local
const at = (card, grade) => schedule(card, grade, { today: TODAY });
const fresh = { ivl: 0, ease: 2.5, reps: 0, lapses: 0 };

// ── a brand new card ────────────────────────────────────────────────────────
console.log('\n── new card (ivl 0, ease 2.5) ─────────────────────────────');
eq('Again -> ivl 0, ease 2.30, lapses 1',
  pick(at(fresh, 0)), { ivl: 0, ease: 2.3, reps: 1, lapses: 1 });
eq('Hard  -> ivl 1, ease 2.35',
  pick(at(fresh, 1)), { ivl: 1, ease: 2.35, reps: 1, lapses: 0 });
eq('Good  -> ivl 1, ease unchanged',
  pick(at(fresh, 2)), { ivl: 1, ease: 2.5, reps: 1, lapses: 0 });
eq('Easy  -> ivl 4, ease 2.65',
  pick(at(fresh, 3)), { ivl: 4, ease: 2.65, reps: 1, lapses: 0 });

// ── a card with history ─────────────────────────────────────────────────────
console.log('\n── seen card (ivl 10, ease 2.5, reps 4) ───────────────────');
const seen = { ivl: 10, ease: 2.5, reps: 4, lapses: 1 };
eq('Again -> ivl 0, back this session, lapses++',
  pick(at(seen, 0)), { ivl: 0, ease: 2.3, reps: 5, lapses: 2 });
eq('Hard  -> round(10 x 1.2) = 12',
  pick(at(seen, 1)), { ivl: 12, ease: 2.35, reps: 5, lapses: 1 });
eq('Good  -> round(10 x 2.5) = 25, ease unchanged',
  pick(at(seen, 2)), { ivl: 25, ease: 2.5, reps: 5, lapses: 1 });
// The spec raises ease before using it on Easy, so 10 x 2.65 x 1.3 = 34.45 -> 34.
eq('Easy  -> round(10 x 2.65 x 1.3) = 34, using the raised ease',
  pick(at(seen, 3)), { ivl: 34, ease: 2.65, reps: 5, lapses: 1 });

// ── due dates ───────────────────────────────────────────────────────────────
console.log('\n── due dates ──────────────────────────────────────────────');
eq('Again is due today', at(seen, 0).due, '2026-09-13');
eq('Good  is due 25 days out', at(seen, 2).due, '2026-10-08');
eq('addDays crosses a month boundary', addDays(TODAY, 25), '2026-10-08');
eq('toIso uses the local calendar date, not UTC', toIso(new Date(2026, 0, 1, 23, 30)), '2026-01-01');

// ── the ease floor ──────────────────────────────────────────────────────────
console.log('\n── ease floor of 1.3 ──────────────────────────────────────');
let card = { ivl: 5, ease: 1.4, reps: 3, lapses: 0 };
eq('Again cannot push ease below 1.3', at(card, 0).ease, MIN_EASE);
eq('Hard cannot push ease below 1.3', at({ ...card, ease: 1.35 }, 1).ease, MIN_EASE);
eq('…and it stays there', at({ ...card, ease: MIN_EASE }, 0).ease, MIN_EASE);
check('ease has no ceiling — Easy keeps raising it',
  at({ ivl: 1, ease: 4.0, reps: 9, lapses: 0 }, 3).ease === 4.15);

// ── the 365-day cap ─────────────────────────────────────────────────────────
console.log('\n── interval cap ───────────────────────────────────────────');
eq('Good on a 200-day card caps at 365', at({ ivl: 200, ease: 2.5, reps: 9 }, 2).ivl, MAX_IVL);
eq('Easy on a 300-day card caps at 365', at({ ivl: 300, ease: 2.5, reps: 9 }, 3).ivl, MAX_IVL);
eq('an already-capped card stays capped', at({ ivl: MAX_IVL, ease: 2.5, reps: 9 }, 2).ivl, MAX_IVL);
eq('the cap reaches the due date too', at({ ivl: 300, ease: 2.5, reps: 9 }, 3).due, addDays(TODAY, 365));

// ── leeches ─────────────────────────────────────────────────────────────────
console.log('\n── leeches (lapses >= 6) ──────────────────────────────────');
eq('the sixth lapse flags a leech', at({ ivl: 3, ease: 2.0, reps: 20, lapses: 5 }, 0).isLeech, true);
eq('the fifth does not', at({ ivl: 3, ease: 2.0, reps: 20, lapses: 4 }, 0).isLeech, false);
eq('LEECH_AT is 6', LEECH_AT, 6);
eq('isLeech reads a stored card', [isLeech({ lapses: 6 }), isLeech({ lapses: 5 })], [true, false]);

// ── Hard never stalls ───────────────────────────────────────────────────────
console.log('\n── Hard on a 1-day card ───────────────────────────────────');
// round(1 x 1.2) = 1, and max(1, ...) keeps it from ever being 0.
eq('Hard on a 1-day card stays at 1, not 0', at({ ivl: 1, ease: 2.5, reps: 2 }, 1).ivl, 1);

// ── previews match what grading does ────────────────────────────────────────
console.log('\n── interval previews ──────────────────────────────────────');
const p = previews(seen, { today: TODAY });
eq('four previews, in Again/Hard/Good/Easy order', p.map((x) => x.key), ['again', 'hard', 'good', 'easy']);
eq('preview intervals match schedule()', p.map((x) => x.ivl),
  [0, 1, 2, 3].map((g) => at(seen, g).ivl));
eq('GRADES carries a colour token per grade', GRADES.map((g) => g.token),
  ['--g-again', '--g-hard', '--g-good', '--g-easy']);

// ── suggested grade from tick boxes ─────────────────────────────────────────
console.log('\n── suggested grade from ticks ─────────────────────────────');
eq('4 of 4 -> Good', suggestedGrade(4, 4), 2);
eq('3 of 4 (75%) -> Hard', suggestedGrade(3, 4), 1);
eq('exactly 60% -> Hard', suggestedGrade(3, 5), 1);
eq('2 of 4 (50%) -> Again', suggestedGrade(2, 4), 0);
eq('0 of 4 -> Again', suggestedGrade(0, 4), 0);
eq('no items -> no suggestion', suggestedGrade(0, 0), null);

// ── maturity buckets ────────────────────────────────────────────────────────
console.log('\n── maturity ───────────────────────────────────────────────');
eq('never reviewed -> new', maturity({ reps: 0, ivl: 0 }), 'new');
eq('ivl 3 -> learning', maturity({ reps: 1, ivl: 3 }), 'learning');
eq('ivl 14 -> young', maturity({ reps: 5, ivl: 14 }), 'young');
eq('ivl 30 -> mature', maturity({ reps: 9, ivl: 30 }), 'mature');

// ── cram writes no schedule ─────────────────────────────────────────────────
console.log('\n── modes ──────────────────────────────────────────────────');
eq('drill and weak advance the schedule',
  [WRITES_SCHEDULE.drill, WRITES_SCHEDULE.weak], [true, true]);
eq('cram and quiz do not — by design, and it will feel wrong',
  [WRITES_SCHEDULE.cram, WRITES_SCHEDULE.quiz], [false, false]);

// ── queue ordering and daily caps ───────────────────────────────────────────
console.log('\n── queue ──────────────────────────────────────────────────');
const queue = [
  { id: 'new-low', reps: 0, ivl: 0, importance: 1 },
  { id: 'due-today', reps: 3, ivl: 5, due: '2026-09-13', lapses: 0 },
  { id: 'new-high', reps: 0, ivl: 0, importance: 3 },
  { id: 'overdue', reps: 7, ivl: 9, due: '2026-09-01', lapses: 2 },
  { id: 'overdue-leech', reps: 7, ivl: 9, due: '2026-09-01', lapses: 8 },
];
eq('reviews before new, most overdue first, leeches first within a day',
  orderQueue(queue).map((c) => c.id),
  ['overdue-leech', 'overdue', 'due-today', 'new-high', 'new-low']);

const capped = applyDailyLimits(orderQueue(queue), { newPerDay: 1, reviewsPerDay: 2 },
  { newCards: 0, reviews: 0 });
eq('caps cut new and reviews separately',
  capped.map((c) => c.id), ['overdue-leech', 'overdue', 'new-high']);

eq('work already done today counts against the cap',
  applyDailyLimits(orderQueue(queue), { newPerDay: 20, reviewsPerDay: 3 }, { newCards: 20, reviews: 2 })
    .map((c) => c.id), ['overdue-leech']);

// ── bad input ───────────────────────────────────────────────────────────────
console.log('\n── bad input ──────────────────────────────────────────────');
check('an unknown grade throws rather than silently scheduling',
  (() => { try { at(fresh, 7); return false; } catch { return true; } })());
eq('a card missing every field is treated as new',
  pick(at({}, 2)), { ivl: 1, ease: 2.5, reps: 1, lapses: 0 });

function pick(s) { return { ivl: s.ivl, ease: s.ease, reps: s.reps, lapses: s.lapses }; }

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}  —  scheduler.js\n`);
process.exit(failed ? 1 : 0);
