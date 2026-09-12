// importer.js tests. Pure functions, so this is just: call with data, assert.
//   node test/importer.test.mjs
// No test framework and no package.json — there is no build step in Remento
// and there is not going to be one for the tests either.

import { readFileSync } from 'node:fs';
import {
  parse, parseText, parseJson, summarise, clozeParts, frontNormOf,
} from '../js/importer.js';

const R = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, R), 'utf8');
let failed = 0;
const check = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`);
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── the checkpoint: both real payloads, zero errors ─────────────────────────
console.log('\n── real payloads ──────────────────────────────────────────');

const u1 = parse(read('data/thermo-unit1.json'));
const u2 = parse(read('data/thermo-unit2.txt'));

for (const [name, res, n] of [['thermo-unit1.json', u1, 36], ['thermo-unit2.txt', u2, 7]]) {
  check(`${name}: ${n} cards`, res.cards.length === n, `got ${res.cards.length}`);
  check(`${name}: zero errors`, res.errors.length === 0, JSON.stringify(res.errors));
}
console.log('  unit1 types:', JSON.stringify(summarise(u1.cards).byType));
console.log('  unit2 types:', JSON.stringify(summarise(u2.cards).byType));
eq('unit1 target', u1.target, {
  semesterSlug: 's3', semesterLabel: 'Semester 3', subject: 'Thermodynamics',
  subjectCode: '23MEE202', unitNo: 1,
  unitTitle: 'Basic Concepts, Pure Substances and the First Law (Closed Systems)',
});
eq('unit2 target', u2.target, {
  semesterSlug: 's3', semesterLabel: 'Semester 3', subject: 'Thermodynamics',
  unitNo: 2, unitTitle: 'First Law Applied to Open Systems (SFEE)',
});

// ── every card has a usable front and a legal content shape ─────────────────
console.log('\n── content shapes ─────────────────────────────────────────');
const REQUIRED = {
  qa: ['front', 'back'], image: ['front'], formula: ['prompt', 'latex'],
  list: ['prompt', 'items'], cloze: ['text', 'blanks'], numerical: ['prompt', 'value'],
};
let shapeBad = 0;
for (const res of [u1, u2]) {
  for (const c of res.cards) {
    for (const k of REQUIRED[c.type]) {
      if (c.content[k] == null || c.content[k] === '') {
        shapeBad++; console.log(`   missing ${c.type}.${k}:`, c.frontText.slice(0, 60));
      }
    }
    if (!c.frontNorm) { shapeBad++; console.log('   empty front_norm:', c.type); }
  }
}
check('every card has its required content keys and a front_norm', shapeBad === 0);

// ── the two-equation SFEE formula card ──────────────────────────────────────
console.log('\n── multi-equation formula ─────────────────────────────────');
const sfee = u2.cards.find((c) => c.type === 'formula' && /steady flow energy/i.test(c.content.prompt));
check('SFEE card found', !!sfee);
check('SFEE latex joins both equations with \\\\',
  sfee.content.latex.includes('\\dot m h_1') && sfee.content.latex.includes('\\\\') && sfee.content.latex.includes('h_2 +'),
  sfee.content.latex.slice(0, 90) + '…');
eq('SFEE symbol count', sfee.content.symbols.length, 6);
eq('SFEE first symbol', sfee.content.symbols[0], { sym: '\\dot m', means: 'mass flow rate', unit: 'kg/s' });
eq('SFEE reverse', sfee.reverse, true);
eq('SFEE tags (header only)', sfee.tags, ['thermo', 'sfee']);
check('SFEE trap captured across one long line', sfee.trap.startsWith('Dividing by mass flow'));

// ── tag resolution: +x adds, bare list replaces ─────────────────────────────
console.log('\n── tags ───────────────────────────────────────────────────');
const cloze2 = u2.cards.find((c) => c.type === 'cloze');
eq('"tags: +convention" adds to header tags', cloze2.tags, ['thermo', 'sfee', 'convention']);
const t = parseText('@tags: a, b\n\nQ: front\nA: back\ntags: c, d\n---');
eq('bare "tags:" replaces header tags', t.cards[0].tags, ['c', 'd']);

// ── list card ───────────────────────────────────────────────────────────────
console.log('\n── list / cloze ───────────────────────────────────────────');
const list2 = u2.cards.find((c) => c.type === 'list');
eq('list has 2 items', list2.content.items.length, 2);
check('list item text intact', list2.content.items[0].startsWith('Mass transfer:'));
eq('list ordered defaults false in text format', list2.content.ordered, false);
eq('"ord: yes" sets ordered', parseText('L: p\n- a\n- b\nord: yes\n---').cards[0].content.ordered, true);

eq('cloze blanks counted', cloze2.content.blanks, 2);
eq('clozeParts round-trips', clozeParts('a {{b}} c {{d}}').map((p) => (p.blank ? `[${p.text}]` : p.text)).join(''), 'a [b] c [d]');

// ── numerical: why becomes context, per IMPORT-FORMAT.md ────────────────────
console.log('\n── numerical ──────────────────────────────────────────────');
const numT = parseText('N: Triple point of water.\n= 273.16 K, 0.6117 kPa\nwhy: The fixed point that defines the Kelvin.\n---').cards[0];
eq('text "why:" fills numerical context', numT.content.context, 'The fixed point that defines the Kelvin.');
eq('…and why is then not duplicated', numT.why, null);
const numJ = parseJson('{"cards":[{"type":"numerical","content":{"prompt":"p","value":"v","context":"c"},"why":"w"}]}').cards[0];
eq('JSON keeps context and why separate', [numJ.content.context, numJ.why], ['c', 'w']);

// ── continuation lines and blank lines inside a block ───────────────────────
console.log('\n── block parsing ──────────────────────────────────────────');
const cont = parseText(['Q: State the Kelvin-Planck statement.',
  'A: It is impossible for any device operating on a cycle to receive heat',
  '   from a single reservoir and produce a net amount of work.',
  '',
  'trap: "Single reservoir" is the load-bearing phrase.',
  '---'].join('\n')).cards[0];
eq('indented continuation joined', cont.content.back,
  'It is impossible for any device operating on a cycle to receive heat from a single reservoir and produce a net amount of work.');
check('blank line inside a block is allowed', cont.trap.startsWith('"Single reservoir"'));

const multi = parseText('Q: a\nA: b\n---\nQ: c\nA: d\n---\n\n').cards;
eq('trailing --- does not make a phantom card', multi.length, 2);

// ── errors are per-card, never fatal ────────────────────────────────────────
console.log('\n── error handling ─────────────────────────────────────────');
const mixed = parseText(['Q: good one', 'A: yes', '---',
  'Q: no answer here', '---',
  'F: missing its math', '---',
  'L: no items', '---',
  'C: no blanks in this one', '---',
  'N: no value', '---',
  'X: not a type', '---',
  'Q: another good one', 'A: yes', '---'].join('\n'));
eq('2 good cards survive 6 broken ones', mixed.cards.length, 2);
eq('6 errors reported', mixed.errors.length, 6);
for (const e of mixed.errors) console.log(`   card ${e.index} (line ${e.line}): ${e.message}`);
check('errors carry the raw block', mixed.errors.every((e) => typeof e.raw === 'string' && e.raw.length));

const badJson = parseJson('{"cards": [ {"type":"qa"} ] ,}');
eq('invalid JSON is one error, not a throw', badJson.errors.length, 1);
check('invalid JSON error names the problem', /Invalid JSON/.test(badJson.errors[0].message), badJson.errors[0].message);

const fenced = parseJson('```json\n{"cards":[{"type":"qa","content":{"front":"f","back":"b"}}]}\n```');
eq('a fenced code block still parses', fenced.cards.length, 1);

eq('empty input is an error, not a crash', parse('   ').errors.length, 1);
eq('bare array of cards accepted', parseJson('[{"type":"qa","content":{"front":"f","back":"b"}}]').cards.length, 1);

// ── front_norm mirrors the generated column ─────────────────────────────────
console.log('\n── duplicate detection ────────────────────────────────────');
eq('front_norm strips case and punctuation',
  frontNormOf({ front: 'State the Kelvin–Planck statement!' }), 'statethekelvinplanckstatement');
eq('front_norm falls back prompt -> text',
  [frontNormOf({ prompt: 'A b!' }), frontNormOf({ text: 'C d?' })], ['ab', 'cd']);
const u1Norms = new Set(u1.cards.map((c) => c.frontNorm));
eq('no duplicate fronts inside thermo-unit1.json', u1Norms.size, u1.cards.length);

// ── importance / marks ──────────────────────────────────────────────────────
console.log('\n── fields ─────────────────────────────────────────────────');
eq('importance clamps out-of-range', parseText('Q: a\nA: b\nimp: 9\n---').cards[0].importance, 3);
eq('importance defaults from payload defaults', u2.cards[0].importance, 3);
eq('marks parsed as int', parseText('Q: a\nA: b\nmarks: 10\n---').cards[0].marks, 10);
eq('id becomes importKey', u1.cards[0].importKey, 'thermo-u1-001');

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}  —  importer.js\n`);
process.exit(failed ? 1 : 0);
