// The card editor, shared by Drill (the pencil, mid-review) and Browse.
// Behind the Edit toggle in both places.

import { el, openModal, toast, toastError, clear } from './ui.js';
import * as db from './db.js';
import { countBlanks } from './importer.js';
import { uploadImage, signedImageUrl, deleteImages } from './images.js';

/** The text fields each card type actually has, in the order they are shown. */
const FIELDS = {
  qa: [['front', 'Front', 'area'], ['back', 'Back', 'area']],
  image: [['front', 'Front', 'area'], ['back', 'Back', 'area']],
  formula: [['prompt', 'Prompt', 'area'], ['latex', 'LaTeX', 'area'], ['note', 'Note', 'line']],
  list: [['prompt', 'Prompt', 'area']],
  cloze: [['text', 'Text (wrap blanks in {{ }})', 'area']],
  numerical: [['prompt', 'Prompt', 'area'], ['value', 'Value', 'line'], ['context', 'Context', 'line']],
};

/**
 * Open the editor for one card.
 * @returns {Promise<object|null>} the saved card, or null if cancelled.
 */
export function editCard(card, { structure } = {}) {
  return new Promise((resolve) => {
    const inputs = new Map();
    const body = el('div', { class: 'editor' });

    const field = (key, label, kind, value) => {
      const node = kind === 'area'
        ? el('textarea', { class: 'textarea editor-area', spellcheck: 'false' })
        : el('input', { class: 'input', type: 'text' });
      node.value = value ?? '';
      inputs.set(key, node);
      return el('label', { class: 'field' }, el('span', { class: 'label' }, label), node);
    };

    // ── type-specific content ────────────────────────────────────────────
    for (const [key, label, kind] of FIELDS[card.type] ?? FIELDS.qa) {
      body.append(field(`content.${key}`, label, kind, card.content?.[key]));
    }

    // List items get one line each, which is how they are read and graded.
    if (card.type === 'list') {
      const items = el('textarea', { class: 'textarea editor-area', spellcheck: 'false' });
      items.value = (card.content?.items ?? []).join('\n');
      inputs.set('content.items', items);
      body.append(el('label', { class: 'field' },
        el('span', { class: 'label' }, 'Items — one per line'), items));

      const ordered = el('input', { type: 'checkbox' });
      ordered.checked = Boolean(card.content?.ordered);
      inputs.set('content.ordered', ordered);
      body.append(el('label', { class: 'check-line' }, ordered,
        el('span', {}, 'Order matters — the items must be recalled in sequence')));
    }

    // ── annotation, shared by every type ─────────────────────────────────
    body.append(el('hr', { class: 'divider' }));
    body.append(field('why', 'Why it matters', 'area', card.why));
    body.append(field('trap', 'Trap', 'area', card.trap));
    body.append(field('source', 'Source', 'line', card.source));
    if (card.type === 'image' || card.figure_ref) {
      body.append(field('figure_ref', 'Figure reference', 'area', card.figure_ref));
    }

    const imp = el('select', { class: 'select' },
      [1, 2, 3].map((n) => el('option', { value: n, selected: (card.importance ?? 2) === n },
        `${'★'.repeat(n)}  ${['recognise it', 'know it', 'load-bearing'][n - 1]}`)),
    );
    inputs.set('importance', imp);

    const tags = el('input', { class: 'input', type: 'text', value: (card.tags ?? []).join(', ') });
    inputs.set('tags', tags);

    const marks = el('input', { class: 'input', type: 'number', min: 0, value: card.marks ?? '' });
    inputs.set('marks', marks);

    body.append(el('div', { class: 'editor-row' },
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Importance'), imp),
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'Marks'), marks),
    ));
    body.append(el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Tags — comma separated'), tags));

    // ── destination, when the caller passed the tree ─────────────────────
    let unitSel = null;
    if (structure) {
      const units = structure.units.filter((u) => u.subject_id === card.subject_id)
        .sort((a, b) => a.no - b.no);
      unitSel = el('select', { class: 'select' },
        el('option', { value: '' }, '— subject level —'),
        units.map((u) => el('option', { value: u.id, selected: u.id === card.unit_id },
          `Unit ${u.no} — ${u.title}`)),
      );
      body.append(el('label', { class: 'field' }, el('span', { class: 'label' }, 'Unit'), unitSel));
    }

    // ── images ────────────────────────────────────────────────────────────
    // Any card type can carry images; `image` as a type just means the picture
    // is the question. Files are compressed and uploaded on save, not on pick,
    // so cancelling the editor leaves nothing behind in the bucket.
    const images = imagePicker(card);
    body.append(el('hr', { class: 'divider' }), images.node);

    const status = el('p', { class: 'hint editor-status' });

    openModal({
      title: `Edit ${card.type} card`,
      body: el('div', {}, body, status),
      wide: true,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
      onDone: async (v) => {
        if (v !== 'save') { resolve(null); return; }
        try {
          const patch = buildPatch(card, inputs, unitSel);
          patch.images = await images.commit(card.id);
          const saved = await db.updateCard(card.id, patch);
          toast('Card saved.', 'ok');
          resolve(saved);
        } catch (err) {
          toastError('Could not save the card', err);
          resolve(null);
        }
      },
    });
  });
}

/**
 * Attach and remove card images.
 *
 * Nothing touches the network until commit(): picked files are held, removals
 * are marked, and both are applied on save. Cancelling the editor therefore
 * leaves the bucket exactly as it was.
 */
function imagePicker(card) {
  const existing = (card.images ?? [])
    .map((i) => (typeof i === 'string' ? { path: i } : i))
    .filter((i) => i?.path);

  const keep = new Set(existing.map((i) => i.path));
  const pending = [];                    // File objects, not yet compressed
  const strip = el('div', { class: 'img-picker' });

  const input = el('input', {
    type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden',
  });
  const add = el('button', { class: 'btn btn-sm', type: 'button' }, '+ Add image');
  add.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    for (const f of input.files ?? []) pending.push(f);
    input.value = '';
    redraw();
  });

  function redraw() {
    clear(strip);

    for (const img of existing) {
      if (!keep.has(img.path)) continue;
      const thumb = el('div', { class: 'img-thumb' });
      const pic = el('img', { alt: '', loading: 'lazy' });
      signedImageUrl(img.path)
        .then((url) => { pic.src = url; })
        .catch(() => { thumb.append(el('span', { class: 'img-missing' }, 'unavailable')); });
      thumb.append(pic, el('button', {
        class: 'img-x', type: 'button', title: 'Remove',
        onclick: () => { keep.delete(img.path); redraw(); },
      }, '×'));
      strip.append(thumb);
    }

    pending.forEach((file, i) => {
      const thumb = el('div', { class: 'img-thumb is-pending' });
      const pic = el('img', { alt: '', src: URL.createObjectURL(file) });
      thumb.append(pic,
        el('span', { class: 'img-tag' }, 'new'),
        el('button', {
          class: 'img-x', type: 'button', title: 'Remove',
          onclick: () => { pending.splice(i, 1); redraw(); },
        }, '×'));
      strip.append(thumb);
    });

    if (!strip.childElementCount) {
      strip.append(el('p', { class: 'hint' }, 'No images. Screenshots are compressed to WebP, longest edge 1600px, before they leave this device.'));
    }
  }
  redraw();

  return {
    node: el('div', { class: 'field' },
      el('span', { class: 'label' }, 'Images'),
      strip,
      el('div', { class: 'row-actions' }, add, input),
    ),

    /** Upload the new files, drop the removed ones, return the new column. */
    async commit(cardId) {
      const kept = existing.filter((i) => keep.has(i.path));
      const uploaded = [];
      for (const file of pending) {
        uploaded.push(await uploadImage(file, cardId));
      }

      const removed = existing.filter((i) => !keep.has(i.path)).map((i) => i.path);
      if (removed.length) {
        // A failed delete must not lose the edit — the row is already correct,
        // and an orphaned object costs storage, not correctness.
        deleteImages(removed).catch((e) => console.warn('image delete failed:', e.message));
      }

      return [...kept, ...uploaded];
    },
  };
}

/** Collect the inputs into a patch, leaving the schedule columns alone. */
function buildPatch(card, inputs, unitSel) {
  const content = { ...card.content };
  const patch = {};

  for (const [key, node] of inputs) {
    const raw = node.type === 'checkbox' ? node.checked : node.value;

    if (key.startsWith('content.')) {
      const k = key.slice(8);
      if (k === 'items') {
        content.items = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
      } else if (k === 'ordered') {
        content.ordered = Boolean(raw);
      } else {
        const v = String(raw).trim();
        if (v) content[k] = v; else delete content[k];
      }
      continue;
    }

    if (key === 'importance') patch.importance = Number(raw);
    else if (key === 'marks') patch.marks = raw === '' ? null : Number(raw);
    else if (key === 'tags') {
      patch.tags = String(raw).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    } else {
      const v = String(raw).trim();
      patch[key] = v || null;
    }
  }

  // blanks is derived, never typed.
  if (card.type === 'cloze') content.blanks = countBlanks(content.text ?? '');

  patch.content = content;
  if (unitSel) patch.unit_id = unitSel.value || null;
  return patch;
}
