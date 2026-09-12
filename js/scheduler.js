// SM-2, exactly as written in docs/SPEC.md §4.3. Pure functions — no DOM, no
// network, no Supabase. Give it a card and a grade, get the next schedule.
//
// The constants are deliberate and are not to be "improved". They are tuned by
// feel against thermodynamics derivations, not fitted to vocabulary, and §10 of
// the spec already says that if the intervals feel wrong after a month, this
// file is what changes — not quietly, and not by guesswork.

/** Cap from §4.3. Nothing schedules further out than a year. */
export const MAX_IVL = 365;

/** lapses >= 6 flags a leech. Weak mode collects them. */
export const LEECH_AT = 6;

export const MIN_EASE = 1.3;

export const GRADES = [
  { grade: 0, key: 'again', label: 'Again', hint: 'No idea', token: '--g-again' },
  { grade: 1, key: 'hard', label: 'Hard', hint: 'Got there slowly', token: '--g-hard' },
  { grade: 2, key: 'good', label: 'Good', hint: 'Knew it', token: '--g-good' },
  { grade: 3, key: 'easy', label: 'Easy', hint: 'Instant', token: '--g-easy' },
];

/** Modes that advance the schedule. Cram and quiz are logged, not scheduled. */
export const WRITES_SCHEDULE = { drill: true, weak: true, cram: false, quiz: false };

/**
 * The next schedule for a card at a given grade.
 *
 *   Again (0):  ease = max(1.3, ease − 0.20);  ivl = 0   → back this session; lapses++
 *   Hard  (1):  ease = max(1.3, ease − 0.15);  ivl = ivl ? max(1, round(ivl × 1.2)) : 1
 *   Good  (2):  ease unchanged;                ivl = ivl ? round(ivl × ease)        : 1
 *   Easy  (3):  ease = ease + 0.15;            ivl = ivl ? round(ivl × ease × 1.3)  : 4
 *
 * On Easy the spec sets the ease before it uses it, so the new ease is what
 * multiplies the interval. That is the order the lines are written in.
 *
 * @param {{ivl?:number, ease?:number, reps?:number, lapses?:number}} card
 * @param {0|1|2|3} grade
 * @returns {{ivl:number, ease:number, due:string, reps:number, lapses:number, isLeech:boolean}}
 */
export function schedule(card, grade, { today = new Date() } = {}) {
  const prevIvl = Math.max(0, Math.round(Number(card?.ivl ?? 0)) || 0);
  const prevEase = Number.isFinite(Number(card?.ease)) ? Number(card.ease) : 2.5;
  const reps = Math.max(0, Math.round(Number(card?.reps ?? 0)) || 0);
  const lapses = Math.max(0, Math.round(Number(card?.lapses ?? 0)) || 0);

  let ease = prevEase;
  let ivl;

  switch (Number(grade)) {
    case 0:
      ease = Math.max(MIN_EASE, prevEase - 0.20);
      ivl = 0;
      break;
    case 1:
      ease = Math.max(MIN_EASE, prevEase - 0.15);
      ivl = prevIvl ? Math.max(1, Math.round(prevIvl * 1.2)) : 1;
      break;
    case 2:
      ivl = prevIvl ? Math.round(prevIvl * ease) : 1;
      break;
    case 3:
      ease = prevEase + 0.15;
      ivl = prevIvl ? Math.round(prevIvl * ease * 1.3) : 4;
      break;
    default:
      throw new Error(`Grade must be 0, 1, 2 or 3 — got ${JSON.stringify(grade)}`);
  }

  ivl = Math.min(MAX_IVL, ivl);
  const nextLapses = grade === 0 ? lapses + 1 : lapses;

  return {
    ivl,
    ease: round2(ease),
    due: addDays(today, ivl),
    reps: reps + 1,
    lapses: nextLapses,
    isLeech: nextLapses >= LEECH_AT,
  };
}

/**
 * What each of the four buttons would do, for the interval previews.
 * @returns {{grade:number, key:string, label:string, ivl:number, token:string}[]}
 */
export function previews(card, opts) {
  return GRADES.map((g) => {
    const next = schedule(card, g.grade, opts);
    return { ...g, ivl: next.ivl, due: next.due };
  });
}

/**
 * Suggested grade from the tick fraction on a list or cloze card (§4.3).
 * Overridable — it is a suggestion, not the grade.
 *
 *   all correct    -> Good
 *   >= 60% correct -> Hard
 *   <  60% correct -> Again
 */
export function suggestedGrade(ticked, total) {
  if (!total) return null;
  const fraction = ticked / total;
  if (fraction >= 1) return 2;
  if (fraction >= 0.6) return 1;
  return 0;
}

/** Maturity bucket, matching the split Stats reports. */
export function maturity(card) {
  if (!(card?.reps > 0)) return 'new';
  const ivl = card.ivl ?? 0;
  if (ivl < 7) return 'learning';
  if (ivl < 21) return 'young';
  return 'mature';
}

export function isLeech(card) { return (card?.lapses ?? 0) >= LEECH_AT; }

/**
 * Order a drill queue: most overdue first, then new cards.
 * Reviews before new is what keeps a backlog from being buried under
 * fresh material you have not earned yet.
 */
export function orderQueue(cards) {
  const seen = [];
  const fresh = [];
  for (const c of cards) ((c.reps ?? 0) > 0 ? seen : fresh).push(c);
  // Oldest due first, and among equally overdue cards the ones that keep
  // lapsing come first.
  seen.sort((a, b) => String(a.due).localeCompare(String(b.due)) || (b.lapses ?? 0) - (a.lapses ?? 0));
  fresh.sort((a, b) => (b.importance ?? 2) - (a.importance ?? 2));
  return [...seen, ...fresh];
}

/**
 * Apply the daily caps to a queue.
 * `done` comes from db.todayCounts(); limits come from settings.
 */
export function applyDailyLimits(queue, { newPerDay, reviewsPerDay }, done = { newCards: 0, reviews: 0 }) {
  const newLeft = Math.max(0, (newPerDay ?? Infinity) - (done.newCards ?? 0));
  const revLeft = Math.max(0, (reviewsPerDay ?? Infinity) - (done.reviews ?? 0));

  let usedNew = 0;
  let usedRev = 0;
  const out = [];
  for (const c of queue) {
    const fresh = (c.reps ?? 0) === 0;
    if (fresh) {
      if (usedNew >= newLeft) continue;
      usedNew += 1;
    } else {
      if (usedRev >= revLeft) continue;
      usedRev += 1;
    }
    out.push(c);
  }
  return out;
}

// ── dates ───────────────────────────────────────────────────────────────────

/** Local calendar date as YYYY-MM-DD, matching the `due` date column. */
export function toIso(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, days) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setDate(d.getDate() + Math.round(days));
  return toIso(d);
}

function round2(n) { return Math.round(n * 100) / 100; }
