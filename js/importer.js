// Parsing for both import formats: canonical JSON and the plain-text block
// format. Pure — no DOM, no network, no Supabase. Call it with a string and
// assert on what comes back.
//
// The contract: one malformed card is a row in `errors`, never a thrown
// exception. A payload of 40 cards with one typo imports 39 and shows you the
// one that broke, because the alternative is losing the other 39 at 1 a.m.

export const CARD_TYPES = ['qa', 'cloze', 'formula', 'list', 'numerical', 'image'];

/** Type markers in the text format. */
const TYPE_BY_MARKER = {
  Q: 'qa', F: 'formula', L: 'list', C: 'cloze', N: 'numerical', I: 'image',
};

const MODIFIERS = new Set(['A', 'why', 'trap', 'src', 'fig', 'imp', 'marks', 'tags', 'rev', 'sym', 'ord', 'note']);

/**
 * Mirror of the front_norm generated column in supabase/schema.sql:
 *   regexp_replace(lower(coalesce(front, prompt, text, '')), '[^a-z0-9]+', '', 'g')
 * Duplicate detection compares incoming cards against that stored column, so
 * the two transforms must stay in step. Change one, change the other.
 */
export function frontNormOf(content) {
  const raw = content?.front ?? content?.prompt ?? content?.text ?? '';
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The text a card leads with, for previews and duplicate reporting. */
export function frontTextOf(content) {
  return String(content?.front ?? content?.prompt ?? content?.text ?? '').trim();
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Sniff JSON vs text and parse accordingly.
 * @returns {{format, target, defaults, cards, errors}}
 */
export function parse(input) {
  const text = stripBom(String(input ?? '')).trim();
  if (!text) {
    return { format: null, target: {}, defaults: {}, cards: [], errors: [
      { index: 0, line: 1, message: 'Nothing to import — the input is empty.' },
    ] };
  }
  return looksLikeJson(text) ? parseJson(text) : parseText(text);
}

export function looksLikeJson(text) {
  const t = stripBom(String(text)).trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

function stripBom(s) { return s.replace(/^﻿/, ''); }

// ── JSON ────────────────────────────────────────────────────────────────────

export function parseJson(input) {
  const errors = [];
  let doc;

  if (typeof input === 'string') {
    // AIs reliably wrap JSON in a fence no matter how firmly you ask them not to.
    const body = stripBom(input).trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try {
      doc = JSON.parse(body);
    } catch (e) {
      return {
        format: 'json', target: {}, defaults: {}, cards: [],
        errors: [{ index: 0, line: jsonErrorLine(body, e), message: `Invalid JSON: ${e.message}` }],
      };
    }
  } else {
    doc = input;
  }

  // A bare array of cards is accepted; so is the full envelope.
  const list = Array.isArray(doc) ? doc : doc?.cards;
  if (!Array.isArray(list)) {
    return {
      format: 'json', target: {}, defaults: {}, cards: [],
      errors: [{ index: 0, line: 1, message: 'No "cards" array found in the payload.' }],
    };
  }

  const target = normaliseTarget(Array.isArray(doc) ? {} : (doc.target ?? {}));
  const defaults = Array.isArray(doc) ? {} : (doc.defaults ?? {});

  const cards = [];
  list.forEach((raw, i) => {
    const out = buildCard(raw, defaults, i);
    if (out.error) errors.push({ index: i, line: null, message: out.error, raw });
    else cards.push(out.card);
  });

  return { format: 'json', target, defaults, cards, errors };
}

/** Best-effort line number out of a JSON.parse message, for the error row. */
function jsonErrorLine(body, err) {
  const m = /position (\d+)/.exec(err.message);
  if (!m) return null;
  return body.slice(0, Number(m[1])).split('\n').length;
}

// ── text ────────────────────────────────────────────────────────────────────

export function parseText(input) {
  const src = stripBom(String(input)).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');

  const header = {};
  let i = 0;

  // Header directives run until the first line that is not @key: value.
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = /^@([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) break;
    header[m[1].toLowerCase()] = m[2].trim();
  }

  const target = normaliseTarget({
    semester: header.semester,
    subject: header.subject,
    subject_code: header.code ?? header.subject_code,
    unit: header.unit,
  });

  const defaults = {};
  if (header.tags) defaults.tags = splitTags(header.tags);
  if (header.importance) defaults.importance = clampImportance(header.importance);

  // Blocks are separated by a line of exactly ---.
  const blocks = [];
  let current = { lines: [], start: i + 1 };
  for (; i < lines.length; i++) {
    if (/^-{3,}\s*$/.test(lines[i])) {
      blocks.push(current);
      current = { lines: [], start: i + 2 };
    } else {
      current.lines.push(lines[i]);
    }
  }
  blocks.push(current);

  const cards = [];
  const errors = [];
  let n = 0;

  for (const block of blocks) {
    if (!block.lines.some((l) => l.trim())) continue;   // blank tail after the last ---
    const index = n++;
    const parsed = parseBlock(block.lines);
    if (parsed.error) {
      errors.push({ index, line: block.start, message: parsed.error, raw: block.lines.join('\n') });
      continue;
    }
    const out = buildCard(parsed.raw, defaults, index);
    if (out.error) errors.push({ index, line: block.start, message: out.error, raw: block.lines.join('\n') });
    else cards.push(out.card);
  }

  return { format: 'text', target, defaults, cards, errors };
}

/**
 * One `---`-delimited block into the same shape a JSON card has.
 * Field lines start at column 0; indented lines continue the field above.
 */
function parseBlock(lines) {
  const raw = { content: {} };
  const items = [];
  const symbols = [];
  const latex = [];

  let type = null;
  let head = null;            // the type marker's own text
  let field = null;           // where continuation lines go
  let latexOpen = false;

  const push = (target, key, text) => {
    target[key] = target[key] ? `${target[key]} ${text}`.trim() : text.trim();
  };

  for (const line of lines) {
    const indented = /^\s+\S/.test(line);
    const t = line.trim();

    if (!t) { continue; }                       // blank lines inside a block are allowed

    // Display math. Either $$…$$ on one line, or opened here and closed later.
    if (!indented && t.startsWith('$$')) {
      const one = /^\$\$([\s\S]*)\$\$$/.exec(t);
      if (one && t.length > 4) { latex.push(one[1].trim()); field = null; continue; }
      latexOpen = !latexOpen;
      if (latexOpen) latex.push('');
      field = null;
      continue;
    }
    if (latexOpen) {
      const closed = t.endsWith('$$');
      latex[latex.length - 1] = `${latex[latex.length - 1]} ${closed ? t.slice(0, -2) : t}`.trim();
      if (closed) latexOpen = false;
      continue;
    }

    if (indented && field) { push(field.target, field.key, t); continue; }

    // A type marker: Q: F: L: C: N: I:
    const typeM = /^([QFLCNI]):\s?([\s\S]*)$/.exec(t);
    if (typeM && !type) {
      type = TYPE_BY_MARKER[typeM[1]];
      head = typeM[2].trim();
      field = { target: raw, key: '__head' };
      raw.__head = head;
      continue;
    }

    // List items and the numerical value.
    if (/^-\s+/.test(t)) { items.push(t.replace(/^-\s+/, '').trim()); field = { target: items, key: items.length - 1 }; continue; }
    if (/^=\s*/.test(t)) { push(raw.content, 'value', t.replace(/^=\s*/, '')); field = { target: raw.content, key: 'value' }; continue; }

    const modM = /^([A-Za-z_]+)\s*:\s?([\s\S]*)$/.exec(t);
    if (modM && MODIFIERS.has(modM[1]) ) {
      const key = modM[1];
      const val = modM[2].trim();
      switch (key) {
        case 'A':     push(raw.content, '__back', val); field = { target: raw.content, key: '__back' }; break;
        case 'why':   push(raw, 'why', val);   field = { target: raw, key: 'why' }; break;
        case 'trap':  push(raw, 'trap', val);  field = { target: raw, key: 'trap' }; break;
        case 'note':  push(raw, 'note', val);  field = { target: raw, key: 'note' }; break;
        case 'src':   push(raw, 'source', val); field = { target: raw, key: 'source' }; break;
        case 'fig':   push(raw, 'figure_ref', val); field = { target: raw, key: 'figure_ref' }; break;
        case 'imp':   raw.importance = val; field = null; break;
        case 'marks': raw.marks = val; field = null; break;
        case 'rev':   raw.reverse = /^(y|yes|true|1)$/i.test(val); field = null; break;
        case 'ord':   raw.__ordered = /^(y|yes|true|1)$/i.test(val); field = null; break;
        case 'tags':  raw.__tags = val; field = null; break;
        case 'sym': {
          const [sym, means, unit] = val.split('|').map((s) => s.trim());
          if (sym) symbols.push({ sym, means: means || '', ...(unit ? { unit } : {}) });
          field = null;
          break;
        }
        default: field = null;
      }
      continue;
    }

    // Anything else continues the field above, or starts the head if there is none.
    if (field) { push(field.target, field.key, t); continue; }
    if (!type) return { error: 'No type marker. A block must start with Q: F: L: C: N: or I:' };
    push(raw, '__head', t);
  }

  if (!type) {
    return { error: 'No type marker. A block must start with Q: F: L: C: N: or I:' };
  }

  raw.type = type;
  if (items.length) raw.__items = items;
  if (symbols.length) raw.__symbols = symbols;
  if (latex.length) raw.__latex = latex.filter(Boolean);

  return { raw };
}

// ── shared: raw object -> validated card ────────────────────────────────────

/**
 * Normalise and validate one card from either format.
 * @returns {{card}|{error}}
 */
function buildCard(raw, defaults = {}, index = 0) {
  if (!raw || typeof raw !== 'object') return { error: 'Card is not an object.' };

  const type = String(raw.type ?? '').toLowerCase();
  if (!CARD_TYPES.includes(type)) {
    return { error: `Unknown card type ${JSON.stringify(raw.type ?? null)}. Expected one of ${CARD_TYPES.join(', ')}.` };
  }

  const built = buildContent(type, raw);
  if (built.error) return built;
  const content = built.content;

  const tags = resolveTags(raw, defaults);
  const importance = clampImportance(raw.importance ?? defaults.importance ?? 2);
  const marks = toIntOrNull(raw.marks);

  // The text format has no content.context marker; IMPORT-FORMAT.md shows the
  // same numerical card written with `why:` in text and "context" in JSON, so
  // on a numerical card `why` fills context when context is absent.
  let why = trimOrNull(raw.why);
  if (type === 'numerical' && why && !content.context) {
    content.context = why;
    why = null;
  }

  return {
    card: {
      index,
      importKey: trimOrNull(raw.id ?? raw.import_key),
      type,
      content,
      why,
      trap: trimOrNull(raw.trap),
      source: trimOrNull(raw.source ?? raw.src),
      figure_ref: trimOrNull(raw.figure_ref ?? raw.fig),
      note: trimOrNull(raw.note),
      importance,
      marks,
      tags,
      reverse: raw.reverse === true,
      frontText: frontTextOf(content),
      frontNorm: frontNormOf(content),
    },
  };
}

function buildContent(type, raw) {
  // JSON gives a content object; the text parser leaves __-prefixed scratch.
  const c = (raw.content && typeof raw.content === 'object') ? { ...raw.content } : {};
  const head = trimOrNull(raw.__head);
  const back = trimOrNull(c.__back);
  delete c.__back;

  switch (type) {
    case 'qa':
    case 'image': {
      const front = trimOrNull(c.front) ?? head;
      const answer = trimOrNull(c.back) ?? back;
      if (!front) return { error: 'Missing front text.' };
      if (!answer && type === 'qa') return { error: 'Missing back — a Q: card needs an A:.' };
      return { content: clean({ ...c, front, back: answer ?? '' }) };
    }

    case 'formula': {
      const prompt = trimOrNull(c.prompt) ?? head;
      const tex = trimOrNull(c.latex) ?? joinLatex(raw.__latex);
      if (!prompt) return { error: 'Missing prompt.' };
      if (!tex) return { error: 'Missing latex — a F: card needs a $$…$$ block.' };
      const symbols = normaliseSymbols(c.symbols ?? raw.__symbols);
      return { content: clean({ ...c, prompt, latex: tex, ...(symbols.length ? { symbols } : {}) }) };
    }

    case 'list': {
      const prompt = trimOrNull(c.prompt) ?? head;
      const items = (Array.isArray(c.items) ? c.items : raw.__items ?? [])
        .map((s) => String(s).trim()).filter(Boolean);
      if (!prompt) return { error: 'Missing prompt.' };
      if (!items.length) return { error: 'Missing items — a L: card needs at least one "- item" line.' };
      const ordered = c.ordered ?? raw.__ordered ?? false;
      return { content: clean({ ...c, prompt, ordered: Boolean(ordered), items }) };
    }

    case 'cloze': {
      const text = trimOrNull(c.text) ?? head;
      if (!text) return { error: 'Missing cloze text.' };
      const blanks = countBlanks(text);
      if (!blanks) return { error: 'No {{blanks}} found — a C: card needs at least one.' };
      return { content: clean({ ...c, text, blanks }) };
    }

    case 'numerical': {
      const prompt = trimOrNull(c.prompt) ?? head;
      const value = trimOrNull(c.value);
      if (!prompt) return { error: 'Missing prompt.' };
      if (!value) return { error: 'Missing value — a N: card needs an "= value" line.' };
      return { content: clean({ ...c, prompt, value }) };
    }

    default:
      return { error: `Unhandled type ${type}.` };
  }
}

/**
 * A formula card may carry more than one equation — the SFEE is written in
 * rate form and per unit mass, and both belong on the card. KaTeX renders
 * them as separate lines of one display block.
 */
function joinLatex(blocks) {
  const list = (blocks ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return null;
  return list.length === 1 ? list[0] : list.join(' \\\\ ');
}

function normaliseSymbols(symbols) {
  if (!Array.isArray(symbols)) return [];
  return symbols.map((s) => {
    if (typeof s === 'string') {
      const [sym, means, unit] = s.split('|').map((x) => x.trim());
      return { sym, means: means || '', ...(unit ? { unit } : {}) };
    }
    const out = { sym: String(s?.sym ?? '').trim(), means: String(s?.means ?? '').trim() };
    if (s?.unit) out.unit = String(s.unit).trim();
    return out;
  }).filter((s) => s.sym);
}

export function countBlanks(text) {
  return (String(text).match(/\{\{[\s\S]*?\}\}/g) ?? []).length;
}

/** Split a cloze into its literal and blanked parts, in order. */
export function clozeParts(text) {
  const parts = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(String(text)))) {
    if (m.index > last) parts.push({ blank: false, text: text.slice(last, m.index) });
    parts.push({ blank: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ blank: false, text: text.slice(last) });
  return parts;
}

// ── small helpers ───────────────────────────────────────────────────────────

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('__') || v == null || v === '') continue;
    out[k] = v;
  }
  return out;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toIntOrNull(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

export function clampImportance(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n));
}

export function splitTags(s) {
  return String(s ?? '').split(/[,\s]+/).map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `tags: +x` adds to the header tags; a bare list replaces them.
 * JSON cards merge their own tags with the payload defaults.
 */
function resolveTags(raw, defaults) {
  const base = (defaults.tags ?? []).map((t) => String(t).toLowerCase());

  if (raw.__tags != null) {
    const spec = String(raw.__tags).trim();
    const additive = spec.startsWith('+');
    const list = splitTags(spec.replace(/(^|[,\s])\+/g, '$1'));
    return dedupe(additive ? [...base, ...list] : list);
  }

  if (Array.isArray(raw.tags)) {
    return dedupe([...base, ...raw.tags.map((t) => String(t).toLowerCase().trim())].filter(Boolean));
  }
  if (typeof raw.tags === 'string') {
    return dedupe([...base, ...splitTags(raw.tags)]);
  }
  return dedupe(base);
}

function dedupe(list) { return [...new Set(list.filter(Boolean))]; }

/** `target` is only a suggestion — the import preview makes you confirm it. */
function normaliseTarget(t = {}) {
  const out = {};
  if (t.semester != null && String(t.semester).trim()) {
    // '3', 's3' and 'Semester 3' all mean the same semester.
    const raw = String(t.semester).trim();
    const n = /^s?\s*(\d+)$/i.exec(raw)?.[1] ?? /^semester\s+(\d+)$/i.exec(raw)?.[1];
    out.semesterSlug = n ? `s${n}` : raw.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.semesterLabel = n ? `Semester ${n}` : raw;
  }
  if (t.subject != null && String(t.subject).trim()) out.subject = String(t.subject).trim();
  if (t.subject_code) out.subjectCode = String(t.subject_code).trim();

  const u = t.unit;
  if (u && typeof u === 'object') {
    if (u.no != null) out.unitNo = toIntOrNull(u.no);
    if (u.title) out.unitTitle = String(u.title).trim();
  } else if (typeof u === 'string' && u.trim()) {
    // '2 — Second Law and Entropy'
    const m = /^\s*(\d+)\s*(?:[—–:-]\s*)?([\s\S]*)$/.exec(u.trim());
    if (m) {
      out.unitNo = toIntOrNull(m[1]);
      if (m[2].trim()) out.unitTitle = m[2].trim();
    } else {
      out.unitTitle = u.trim();
    }
  }
  return out;
}

// ── summary, for the preview header ─────────────────────────────────────────

/** Counts by type, for the preview. */
export function summarise(cards) {
  const byType = {};
  for (const c of cards) byType[c.type] = (byType[c.type] ?? 0) + 1;
  return { total: cards.length, byType };
}

// ── planning ────────────────────────────────────────────────────────────────

/**
 * Match on import_key first, then on the front_norm generated column within
 * the same subject — the order the spec asks for.
 */
export function planImport(cards, existing) {
  const rows = [];
  const counts = { new: 0, duplicate: 0, update: 0, reverse: 0 };
  const seenNorm = new Set();

  for (const card of cards) {
    let status = 'new';
    let match = null;

    if (card.importKey && existing.byKey.has(card.importKey)) {
      status = 'update';
      match = existing.byKey.get(card.importKey);
    } else if (card.frontNorm && existing.byFront.has(card.frontNorm)) {
      status = 'duplicate';
      match = existing.byFront.get(card.frontNorm);
    } else if (card.frontNorm && seenNorm.has(card.frontNorm)) {
      // A payload can repeat itself, too.
      status = 'duplicate';
    }

    if (card.frontNorm) seenNorm.add(card.frontNorm);
    if (card.reverse) counts.reverse += 1;
    counts[status] += 1;
    rows.push({ card, status, existing: match });
  }

  return { rows, counts };
}

/** A parsed card into a remento_cards row. */
export function cardToRow(card, subjectId, unitId) {
  return {
    subject_id: subjectId,
    unit_id: unitId ?? null,
    type: card.type,
    content: card.content,
    why: card.why,
    trap: card.trap,
    source: card.source,
    figure_ref: card.figure_ref,
    note: card.note,
    importance: card.importance,
    marks: card.marks,
    tags: card.tags,
    import_key: card.importKey,
  };
}
