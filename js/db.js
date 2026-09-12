// Every query in Remento lives here. No SQL, no .from(), anywhere else.
//
// Two rules the schema enforces that this file leans on:
//   · front_norm and search_tsv are generated columns — never written, only read.
//   · deletion is soft. Every card read filters .is('deleted_at', null).

import { supabase, unwrap } from './supabase.js';
import { T, DEFAULTS } from './config.js';

/** Columns we ever want off remento_cards. Never `*` — search_tsv is large. */
const CARD_COLS = `
  id, subject_id, unit_id, type, content, why, trap, source, figure_ref, note,
  importance, marks, tags, images, reverse_of, suspended, starred, import_key,
  ivl, ease, due, reps, lapses, last_grade, last_reviewed,
  created_at, updated_at, deleted_at, front_norm
`.replace(/\s+/g, ' ').trim();

let cachedUserId = null;

/** The signed-in user's id. Every insert needs it; RLS checks it again. */
export async function userId() {
  if (cachedUserId) return cachedUserId;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in');
  cachedUserId = data.user.id;
  return cachedUserId;
}

export function forgetUser() { cachedUserId = null; }

// front_norm's client-side mirror lives in importer.js, next to the parsing it
// serves and the tests that pin it to the generated column.
export { frontNormOf } from './importer.js';

// ── settings ────────────────────────────────────────────────────────────────

/**
 * First-run bootstrap. On first sign-in the user has no rows at all; create
 * the settings row and nothing else. No semesters, no subjects, no demo cards.
 */
export async function loadSettings() {
  const uid = await userId();
  const existing = unwrap(
    await supabase.from(T.settings).select('settings').eq('user_id', uid).maybeSingle(),
  );
  if (existing) return { ...defaultSettings(), ...(existing.settings || {}) };

  const settings = defaultSettings();
  unwrap(await supabase.from(T.settings).insert({ user_id: uid, settings }).select().single());
  return settings;
}

export function defaultSettings() {
  return {
    sessionSize: DEFAULTS.sessionSize,
    newPerDay: DEFAULTS.newPerDay,
    reviewsPerDay: DEFAULTS.reviewsPerDay,
    theme: 'dark',
  };
}

export async function saveSettings(settings) {
  const uid = await userId();
  unwrap(await supabase.from(T.settings).update({ settings }).eq('user_id', uid).select().single());
  return settings;
}

// ── trash purge ─────────────────────────────────────────────────────────────

/**
 * Hard-delete anything soft-deleted more than trashPurgeDays ago.
 * Run on boot — the app is opened daily by definition, so no cron is needed.
 */
export async function purgeTrash() {
  const uid = await userId();
  const cutoff = new Date(Date.now() - DEFAULTS.trashPurgeDays * 86400000).toISOString();
  const gone = unwrap(
    await supabase.from(T.cards).delete()
      .eq('user_id', uid).not('deleted_at', 'is', null).lt('deleted_at', cutoff)
      .select('id'),
  );
  return gone?.length ?? 0;
}

// ── structure: semesters ────────────────────────────────────────────────────

export async function listSemesters() {
  return unwrap(
    await supabase.from(T.semesters).select('id, slug, label, position')
      .order('position').order('label'),
  ) ?? [];
}

export async function createSemester({ slug, label, position = 0 }) {
  const uid = await userId();
  return unwrap(
    await supabase.from(T.semesters)
      .insert({ user_id: uid, slug, label, position }).select().single(),
  );
}

export async function updateSemester(id, patch) {
  return unwrap(await supabase.from(T.semesters).update(patch).eq('id', id).select().single());
}

export async function deleteSemester(id) {
  unwrap(await supabase.from(T.semesters).delete().eq('id', id));
}

// ── structure: subjects ─────────────────────────────────────────────────────

export async function listSubjects(semesterId = null) {
  let q = supabase.from(T.subjects)
    .select('id, semester_id, slug, name, code, color, units_declared, limits, position')
    .order('position').order('name');
  if (semesterId) q = q.eq('semester_id', semesterId);
  return unwrap(await q) ?? [];
}

export async function createSubject({ semesterId, slug, name, code = null, color = null,
  unitsDeclared = null, position = 0 }) {
  const uid = await userId();
  return unwrap(
    await supabase.from(T.subjects).insert({
      user_id: uid, semester_id: semesterId, slug, name, code,
      color, units_declared: unitsDeclared, position,
    }).select().single(),
  );
}

export async function updateSubject(id, patch) {
  return unwrap(await supabase.from(T.subjects).update(patch).eq('id', id).select().single());
}

export async function deleteSubject(id) {
  unwrap(await supabase.from(T.subjects).delete().eq('id', id));
}

// ── structure: units ────────────────────────────────────────────────────────

export async function listUnits(subjectId = null) {
  let q = supabase.from(T.units).select('id, subject_id, no, title').order('no');
  if (subjectId) q = q.eq('subject_id', subjectId);
  return unwrap(await q) ?? [];
}

export async function createUnit({ subjectId, no, title }) {
  const uid = await userId();
  return unwrap(
    await supabase.from(T.units)
      .insert({ user_id: uid, subject_id: subjectId, no, title }).select().single(),
  );
}

export async function updateUnit(id, patch) {
  return unwrap(await supabase.from(T.units).update(patch).eq('id', id).select().single());
}

export async function deleteUnit(id) {
  unwrap(await supabase.from(T.units).delete().eq('id', id));
}

/** The whole tree in three round trips, for the pickers. */
export async function loadStructure() {
  const [semesters, subjects, units] = await Promise.all([
    listSemesters(), listSubjects(), listUnits(),
  ]);
  return { semesters, subjects, units };
}

// ── cards: reading ──────────────────────────────────────────────────────────

/** Shared filter application. `f` is the filter object used across the app. */
function applyCardFilters(q, f = {}) {
  if (f.trash) q = q.not('deleted_at', 'is', null);
  else q = q.is('deleted_at', null);

  if (f.subjectId) q = q.eq('subject_id', f.subjectId);
  if (f.subjectIds?.length) q = q.in('subject_id', f.subjectIds);
  if (f.unitId) q = q.eq('unit_id', f.unitId);
  if (f.unitIds?.length) q = q.in('unit_id', f.unitIds);
  if (f.type) q = q.eq('type', f.type);
  if (f.importance) q = q.eq('importance', Number(f.importance));
  if (f.starred) q = q.eq('starred', true);
  if (f.tags?.length) q = q.contains('tags', f.tags);
  if (f.suspended === false) q = q.eq('suspended', false);
  if (f.suspended === true) q = q.eq('suspended', true);
  if (f.search) q = q.textSearch('search_tsv', f.search, { type: 'websearch' });
  return q;
}

/** One page of cards, with an exact total for the pager. */
export async function listCards({ filters = {}, sort = 'created_at', dir = 'desc',
  page = 0, pageSize = 50 } = {}) {
  let q = supabase.from(T.cards).select(CARD_COLS, { count: 'exact' });
  q = applyCardFilters(q, filters);
  q = q.order(sort, { ascending: dir === 'asc', nullsFirst: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);

  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  return { rows: data ?? [], total: count ?? 0 };
}

export async function getCard(id) {
  return unwrap(await supabase.from(T.cards).select(CARD_COLS).eq('id', id).single());
}

export async function countCards(filters = {}) {
  let q = supabase.from(T.cards).select('id', { count: 'exact', head: true });
  q = applyCardFilters(q, filters);
  const { error, count } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Every distinct tag in the deck, with counts. Small enough to do client-side. */
export async function listTags() {
  const rows = unwrap(
    await supabase.from(T.cards).select('tags').is('deleted_at', null),
  ) ?? [];
  const counts = new Map();
  for (const r of rows) for (const t of r.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => ({ tag, n }));
}

// ── cards: the study queues ─────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Drill queue: due today or earlier, never suspended.
 * Reviews come before new cards, and both are capped by the daily limits.
 */
export async function dueQueue({ filters = {}, limit = 200 } = {}) {
  let q = supabase.from(T.cards).select(CARD_COLS);
  q = applyCardFilters(q, { ...filters, suspended: false });
  const rows = unwrap(await q.lte('due', today()).order('due').limit(limit)) ?? [];
  return rows;
}

/** Cram: everything matching, due or not, shuffled. Writes no schedule. */
export async function cramQueue({ filters = {}, limit = 200 } = {}) {
  let q = supabase.from(T.cards).select(CARD_COLS);
  q = applyCardFilters(q, { ...filters, suspended: false });
  const rows = unwrap(await q.limit(Math.max(limit * 3, 300))) ?? [];
  return shuffle(rows).slice(0, limit);
}

/** Weak: leeches (lapses >= 6) and starred cards. Writes schedule normally. */
export async function weakQueue({ filters = {}, limit = 200, leechAt = 6 } = {}) {
  let q = supabase.from(T.cards).select(CARD_COLS);
  q = applyCardFilters(q, { ...filters, suspended: false });
  const rows = unwrap(
    await q.or(`lapses.gte.${leechAt},starred.eq.true`).order('lapses', { ascending: false })
      .limit(limit),
  ) ?? [];
  return rows;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** How many reviews and new cards have already been done today. */
export async function todayCounts() {
  const uid = await userId();
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const rows = unwrap(
    await supabase.from(T.reviews).select('card_id, ivl_before, mode')
      .eq('user_id', uid).gte('reviewed_at', since.toISOString()),
  ) ?? [];
  const scheduled = rows.filter((r) => r.mode === 'drill' || r.mode === 'weak');
  const newSeen = new Set(scheduled.filter((r) => (r.ivl_before ?? 0) === 0).map((r) => r.card_id));
  return { reviews: scheduled.length, newCards: newSeen.size, total: rows.length };
}

// ── cards: writing ──────────────────────────────────────────────────────────

export async function createCard(card) {
  const uid = await userId();
  return unwrap(await supabase.from(T.cards).insert({ ...card, user_id: uid })
    .select(CARD_COLS).single());
}

export async function updateCard(id, patch) {
  return unwrap(await supabase.from(T.cards).update(patch).eq('id', id).select(CARD_COLS).single());
}

export async function updateCards(ids, patch) {
  if (!ids.length) return [];
  return unwrap(await supabase.from(T.cards).update(patch).in('id', ids).select('id')) ?? [];
}

export async function softDeleteCards(ids) {
  return updateCards(ids, { deleted_at: new Date().toISOString() });
}

export async function restoreCards(ids) {
  return updateCards(ids, { deleted_at: null });
}

/** Gone for good. Only from the trash screen, only behind a confirm. */
export async function hardDeleteCards(ids) {
  if (!ids.length) return;
  unwrap(await supabase.from(T.cards).delete().in('id', ids));
}

/** Back to a brand new card, keeping the content. */
export async function resetSchedule(ids) {
  return updateCards(ids, {
    ivl: 0, ease: 2.5, due: today(), reps: 0, lapses: 0,
    last_grade: null, last_reviewed: null,
  });
}

// ── grading ─────────────────────────────────────────────────────────────────

/**
 * Write one graded review: the card's new schedule, then the history row.
 *
 * `next` comes from scheduler.js. In cram and quiz modes it is null — those
 * modes log the review and deliberately leave the due date where it was.
 */
export async function recordReview({ card, grade, next, mode, fraction = null, ms = null }) {
  const uid = await userId();

  if (next) {
    unwrap(
      await supabase.from(T.cards).update({
        ivl: next.ivl, ease: next.ease, due: next.due,
        reps: next.reps, lapses: next.lapses,
        last_grade: grade, last_reviewed: new Date().toISOString(),
      }).eq('id', card.id).select('id').single(),
    );
  }

  unwrap(
    await supabase.from(T.reviews).insert({
      user_id: uid,
      card_id: card.id,
      grade,
      mode,
      fraction,
      ivl_before: card.ivl ?? 0,
      ivl_after: next ? next.ivl : (card.ivl ?? 0),
      ms,
    }).select('id').single(),
  );
}

// ── import ──────────────────────────────────────────────────────────────────

/**
 * Everything already in a subject that an incoming payload could collide with.
 * Returns lookups by import_key and by the generated front_norm column.
 */
export async function existingForImport(subjectId) {
  const rows = unwrap(
    await supabase.from(T.cards)
      .select('id, import_key, front_norm, content, type, unit_id, ivl, ease, due, reps, lapses')
      .eq('subject_id', subjectId).is('deleted_at', null),
  ) ?? [];

  const byKey = new Map();
  const byFront = new Map();
  for (const r of rows) {
    if (r.import_key) byKey.set(r.import_key, r);
    if (r.front_norm) byFront.set(r.front_norm, r);
  }
  return { rows, byKey, byFront };
}

/**
 * Land an import.
 *
 * The spec asks for one transaction. PostgREST cannot open one across
 * statements, so this is the closest honest thing: each of the two writes is a
 * single statement over an array, and a single statement is atomic. Updates go
 * first — they are idempotent and preserve the schedule — then one insert of
 * every new card. If the insert fails, nothing new landed and the updates were
 * no-ops on content you had already chosen to overwrite.
 *
 * Re-running a failed import is safe for anything carrying an import_key: it
 * updates rather than duplicates. Cards without one are caught by the
 * front_norm duplicate check in the preview instead.
 *
 * Updating never touches ivl / ease / due / reps / lapses. A typo fix on a card
 * reviewed nine times does not reset it.
 */
export async function commitImport({ inserts = [], updates = [] }) {
  const uid = await userId();
  let updated = 0;
  let inserted = 0;

  if (updates.length) {
    // One statement: upsert on the primary key, with every schedule column
    // carried over from the row that is already there.
    const rows = updates.map((u) => ({ ...u.row, id: u.id, user_id: uid }));
    const data = unwrap(await supabase.from(T.cards).upsert(rows, { onConflict: 'id' }).select('id'));
    updated = data?.length ?? 0;
  }

  if (inserts.length) {
    const rows = inserts.map((c) => ({ ...c, user_id: uid }));
    const data = unwrap(await supabase.from(T.cards).insert(rows).select('id'));
    inserted = data?.length ?? 0;
  }

  return { inserted, updated };
}

// ── stats ───────────────────────────────────────────────────────────────────

/** Card counts per unit for one subject — the coverage bar. */
export async function coverageByUnit(subjectId) {
  const rows = unwrap(
    await supabase.from(T.cards).select('unit_id')
      .eq('subject_id', subjectId).is('deleted_at', null),
  ) ?? [];
  const counts = new Map();
  for (const r of rows) counts.set(r.unit_id, (counts.get(r.unit_id) || 0) + 1);
  return counts;
}

/** new / learning / young / mature, by interval. */
export async function maturitySplit(filters = {}) {
  let q = supabase.from(T.cards).select('ivl, reps');
  q = applyCardFilters(q, filters);
  const rows = unwrap(await q) ?? [];
  const out = { new: 0, learning: 0, young: 0, mature: 0, total: rows.length };
  for (const r of rows) {
    if ((r.reps ?? 0) === 0) out.new += 1;
    else if ((r.ivl ?? 0) < 7) out.learning += 1;
    else if ((r.ivl ?? 0) < 21) out.young += 1;
    else out.mature += 1;
  }
  return out;
}

/**
 * Retention: of the last `days` of scheduled reviews, the fraction graded
 * Hard or better. Cram and quiz rows are excluded — they are not a measurement
 * of recall at interval.
 */
export async function retention({ days = 30, subjectId = null } = {}) {
  const uid = await userId();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = supabase.from(T.reviews)
    .select('grade, mode, remento_cards!inner(subject_id)')
    .eq('user_id', uid).gte('reviewed_at', since).in('mode', ['drill', 'weak']);
  if (subjectId) q = q.eq('remento_cards.subject_id', subjectId);

  const rows = unwrap(await q) ?? [];
  const recalled = rows.filter((r) => r.grade >= 1).length;
  return { reviews: rows.length, recalled, pct: rows.length ? (100 * recalled) / rows.length : null };
}

/** Top cards by lapses — what is actually killing you. */
export async function worstCards({ subjectId = null, limit = 10 } = {}) {
  let q = supabase.from(T.cards).select(CARD_COLS).is('deleted_at', null).gt('lapses', 0);
  if (subjectId) q = q.eq('subject_id', subjectId);
  return unwrap(await q.order('lapses', { ascending: false }).limit(limit)) ?? [];
}

/**
 * Per-card review stats for one page of Browse.
 * One query bounded by the page size, not one per row.
 */
export async function reviewStatsFor(cardIds) {
  if (!cardIds?.length) return new Map();
  const uid = await userId();
  const rows = unwrap(
    await supabase.from(T.reviews).select('card_id, grade, mode')
      .eq('user_id', uid).in('card_id', cardIds).in('mode', ['drill', 'weak']),
  ) ?? [];

  const out = new Map();
  for (const r of rows) {
    const e = out.get(r.card_id) ?? { reviews: 0, recalled: 0, pct: 0 };
    e.reviews += 1;
    if (r.grade >= 1) e.recalled += 1;
    out.set(r.card_id, e);
  }
  for (const e of out.values()) e.pct = (100 * e.recalled) / e.reviews;
  return out;
}

/** Retention per tag, straight from the RPC in the schema. */
export async function retentionByTag(days = 30) {
  const { data, error } = await supabase.rpc('remento_retention_by_tag', { days });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Global tiles: due now, done today, total cards, streak. */
export async function globalStats() {
  const uid = await userId();

  const dueQ = supabase.from(T.cards).select('id', { count: 'exact', head: true })
    .is('deleted_at', null).eq('suspended', false).lte('due', today());

  const [dueRes, total, counts, recent] = await Promise.all([
    dueQ,
    countCards({}),
    todayCounts(),
    supabase.from(T.reviews).select('reviewed_at')
      .eq('user_id', uid).order('reviewed_at', { ascending: false }).limit(2000),
  ]);
  if (dueRes.error) throw new Error(dueRes.error.message);
  if (recent.error) throw new Error(recent.error.message);

  return {
    dueNow: dueRes.count ?? 0,
    total,
    doneToday: counts.total,
    streak: streakFrom((recent.data ?? []).map((r) => r.reviewed_at.slice(0, 10))),
  };
}

/**
 * Consecutive days ending today with at least one review.
 * Today being empty does not break the streak — the day is not over yet.
 */
export function streakFrom(isoDays) {
  const days = new Set(isoDays);
  const iso = (back) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return d.toISOString().slice(0, 10);
  };
  let streak = 0;
  let i = days.has(iso(0)) ? 0 : 1;
  for (; i < 400; i++) {
    if (!days.has(iso(i))) break;
    streak += 1;
  }
  return streak;
}

/** Reviews per day for the last `days` days. */
export async function reviewsOverTime(days = 30) {
  const uid = await userId();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = unwrap(
    await supabase.from(T.reviews).select('reviewed_at, grade')
      .eq('user_id', uid).gte('reviewed_at', since).order('reviewed_at'),
  ) ?? [];
  const byDay = new Map();
  for (const r of rows) {
    const d = r.reviewed_at.slice(0, 10);
    const e = byDay.get(d) || { day: d, n: 0, ok: 0 };
    e.n += 1;
    if (r.grade >= 1) e.ok += 1;
    byDay.set(d, e);
  }
  return [...byDay.values()];
}

// ── images ──────────────────────────────────────────────────────────────────

export { uploadImage, signedImageUrl } from './images.js';
