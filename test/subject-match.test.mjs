// subject-match.js tests: which Remento subject a PATHS course means.
//   node test/subject-match.test.mjs
import assert from 'node:assert/strict';
import { matchSubject } from '../js/subject-match.js';

const subjects = [
  { id: 'th', name: 'Thermodynamics', code: null, slug: 'thermodynamics' },
  { id: 'mos', name: 'Mechanics of Solids', code: '23MEE201', slug: 'mos' },
  { id: 'em', name: 'Engineering Mechanics', code: null, slug: 'engineering-mechanics' },
];

// Certain matches: the code first, then the exact name or slug.
assert.equal(matchSubject(subjects, { name: 'Anything', code: '23mee201' })?.id, 'mos');
assert.equal(matchSubject(subjects, { name: 'thermodynamics' })?.id, 'th');
assert.equal(matchSubject(subjects, { name: 'Engineering-Mechanics' })?.id, 'em');
assert.equal(matchSubject(subjects, {}), null);
assert.equal(matchSubject(subjects, { name: 'Fluid Mechanics' }), null);

console.log('subject-match: ok');
