// Which Remento subject a PATHS course means. PATHS names courses the way the
// course book does ("Engineering Thermodynamics", 23MEE202); a subject made in
// Remento earlier may be named differently ("Thermodynamics", no code).
// Used by links from PATHS (app.js) and by Import's destination (import.js).
// Pure: no DOM, no database.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @param {{name: string, code?: string|null, slug?: string}[]} subjects  candidates (one semester's, ideally)
 * @param {{name?: string, code?: string}} want
 * @returns the subject, or null
 */
export function matchSubject(subjects, { name = '', code = '' } = {}) {
  const n = norm(name), c = norm(code);
  if (!n && !c) return null;
  // Certain matches first: the code, then the exact name or slug.
  return (c && subjects.find((s) => norm(s.code) === c))
    || (n && subjects.find((s) => norm(s.name) === n || norm(s.slug) === n))
    // Then a looser one, for names that differ a little.
    || (n && subjects.find((s) => looseMatch(norm(s.name), n)))
    || null;
}

/**
 * Do two normalised subject names ("engineering thermodynamics",
 * "thermodynamics") mean the same course?
 */
export function looseMatch(a, b) {
  // TODO(human)
  return false;
}
