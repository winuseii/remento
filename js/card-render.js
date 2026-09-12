// Rendering one card's front and back, for all six types.
// Shared by Drill and by the Browse row expander.
//
// Everything that comes out of `content` is authored HTML that round-tripped
// through an AI, so it goes through setRich(): sanitise first, then KaTeX.

import { el, setRich, mathBlock } from './ui.js';
import { clozeParts } from './importer.js';
import { signedImageUrl } from './images.js';

/**
 * The front of a card — the question, before you reveal anything.
 * @param {object} card
 * @returns {HTMLElement}
 */
export function renderFront(card) {
  const c = card.content ?? {};

  switch (card.type) {
    case 'formula':
      return el('div', { class: 'card-front' }, question(c.prompt));

    case 'list':
      return el('div', { class: 'card-front' },
        question(c.prompt),
        // The front shows the prompt AND the count. A list card that hides its
        // count is a different, easier question.
        el('p', { class: 'count-line' }, `${(c.items ?? []).length} items`),
      );

    case 'cloze':
      return el('div', { class: 'card-front' }, clozeFront(c.text));

    case 'numerical':
      return el('div', { class: 'card-front' }, question(c.prompt));

    case 'image':
      return el('div', { class: 'card-front' }, question(c.front), imageStrip(card));

    case 'qa':
    default:
      return el('div', { class: 'card-front' }, question(c.front), imageStrip(card));
  }
}

/**
 * The back — everything revealed, including the annotation.
 * `onTick` is called with (ticked, total) whenever a tick box changes, so the
 * drill can suggest a grade.
 */
export function renderBack(card, { onTick } = {}) {
  const c = card.content ?? {};
  const box = el('div', { class: 'card-back' });

  switch (card.type) {
    case 'formula': {
      box.append(mathBlock(c.latex, true));
      if (c.symbols?.length) box.append(symbolTable(c.symbols));
      if (c.note) box.append(setRich(el('p', { class: 'answer-note' }), c.note));
      break;
    }

    case 'list': {
      const items = c.items ?? [];
      box.append(tickList(items.map((t) => ({ text: t })), {
        ordered: Boolean(c.ordered), onTick,
      }));
      break;
    }

    case 'cloze': {
      const parts = clozeParts(c.text ?? '');
      const blanks = parts.filter((p) => p.blank);
      box.append(clozeBack(parts));
      box.append(tickList(blanks.map((b) => ({ text: b.text })), { ordered: false, onTick }));
      break;
    }

    case 'numerical': {
      box.append(setRich(el('div', { class: 'answer-value' }), c.value));
      if (c.context) box.append(setRich(el('p', { class: 'answer-note' }), c.context));
      break;
    }

    case 'image':
    case 'qa':
    default: {
      if (c.back) box.append(setRich(el('div', { class: 'answer-body' }), c.back));
      break;
    }
  }

  box.append(annotations(card));
  return box;
}

// ── pieces ──────────────────────────────────────────────────────────────────

/** The serif question line. This is the calm surface; keep it uncluttered. */
function question(html) {
  return setRich(el('div', { class: 'card-question' }), html ?? '');
}

/** Front of a cloze: every blank hidden, sized so the sentence still reads. */
function clozeFront(text) {
  const wrap = el('div', { class: 'card-question' });
  for (const part of clozeParts(text ?? '')) {
    if (part.blank) {
      wrap.append(el('span', { class: 'cloze-gap', 'aria-label': 'blank' },
        ' '.repeat(Math.min(18, Math.max(6, Math.round(part.text.length / 2))))));
    } else {
      const span = el('span');
      setRich(span, part.text);
      wrap.append(span);
    }
  }
  return wrap;
}

/** Back of a cloze: the same sentence with the blanks filled and marked. */
function clozeBack(parts) {
  const wrap = el('div', { class: 'card-question cloze-filled' });
  for (const part of parts) {
    const span = el('span', part.blank ? { class: 'cloze-fill' } : {});
    setRich(span, part.text);
    wrap.append(span);
  }
  return wrap;
}

/**
 * Tick boxes for list and cloze cards.
 * The fraction is reported on every change and is stored on the review row
 * whatever grade you actually press, so the stats can tell "I pressed Good"
 * from "I got 4 of 5".
 */
function tickList(items, { ordered, onTick }) {
  const boxes = [];
  const list = el(ordered ? 'ol' : 'ul', { class: 'tick-list' });

  const report = () => onTick?.(boxes.filter((b) => b.checked).length, boxes.length);

  items.forEach((item, i) => {
    const box = el('input', { type: 'checkbox', class: 'tick-box' });
    box.addEventListener('change', report);
    boxes.push(box);

    const text = el('span', { class: 'tick-text' });
    setRich(text, item.text);

    list.append(el('li', { class: 'tick-item' },
      el('label', { class: 'tick-label' },
        box,
        ordered ? el('span', { class: 'tick-no num' }, `${i + 1}.`) : null,
        text,
      ),
    ));
  });

  const all = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Tick all');
  all.addEventListener('click', () => {
    const target = !boxes.every((b) => b.checked);
    for (const b of boxes) b.checked = target;
    report();
  });

  report();
  return el('div', { class: 'tick-wrap' }, list,
    el('div', { class: 'tick-actions' }, all,
      el('span', { class: 'hint' }, 'Tick what you actually got. The fraction is recorded.')));
}

function symbolTable(symbols) {
  return el('table', { class: 'sym-table' },
    el('tbody', {},
      symbols.map((s) => el('tr', {},
        el('td', { class: 'sym-sym' }, mathBlock(s.sym, false)),
        el('td', { class: 'sym-means' }, s.means ?? ''),
        el('td', { class: 'sym-unit num' }, s.unit ?? ''),
      )),
    ),
  );
}

/** why / trap / source / figure_ref / marks — the annotation block. */
function annotations(card) {
  const box = el('div', { class: 'annot' });

  if (card.why) box.append(annot('Why', card.why, 'why'));
  if (card.trap) box.append(annot('Trap', card.trap, 'trap'));
  if (card.figure_ref) box.append(annot('Figure', card.figure_ref, 'fig'));
  if (card.note) box.append(annot('Note', card.note, 'note'));

  const meta = [];
  if (card.source) meta.push(card.source);
  if (card.marks) meta.push(`${card.marks} marks`);
  if (card.tags?.length) meta.push(card.tags.map((t) => `#${t}`).join(' '));
  if (meta.length) box.append(el('p', { class: 'annot-meta' }, meta.join('  ·  ')));

  return box;
}

function annot(label, html, kind) {
  return el('div', { class: `annot-row annot-${kind}` },
    el('span', { class: 'annot-label' }, label),
    setRich(el('div', { class: 'annot-body' }), html),
  );
}

/** Images from the private bucket, fetched through signed URLs. */
function imageStrip(card) {
  const paths = (card.images ?? []).map((i) => (typeof i === 'string' ? i : i?.path)).filter(Boolean);
  if (!paths.length) return null;

  const strip = el('div', { class: 'img-strip' });
  for (const path of paths) {
    const img = el('img', { alt: '', loading: 'lazy' });
    strip.append(img);
    signedImageUrl(path)
      .then((url) => { img.src = url; })
      .catch((e) => {
        img.replaceWith(el('div', { class: 'img-missing' }, `Image unavailable: ${e.message}`));
      });
  }
  return strip;
}
