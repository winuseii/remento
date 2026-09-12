// Render helpers, sanitising, KaTeX, toasts, modals.
// No Supabase in here — this file knows about the DOM and nothing else.

// ── tiny DOM helpers ────────────────────────────────────────────────────────
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** el('div', { class: 'x', onclick: fn }, child, child) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── sanitising ──────────────────────────────────────────────────────────────
// Card content is authored HTML, but it round-trips through third-party AI
// output, so it is untrusted. Whitelist tags; allow no attributes at all,
// which removes on* handlers and javascript: URLs by construction.

const ALLOWED_TAGS = new Set([
  'STRONG', 'B', 'EM', 'I', 'U', 'BR', 'UL', 'OL', 'LI',
  'CODE', 'SUP', 'SUB', 'P', 'SPAN', 'SMALL', 'MARK',
]);
const DROP_ENTIRELY = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META',
  'FORM', 'INPUT', 'BUTTON', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT',
]);

/**
 * Sanitise authored HTML into a DocumentFragment.
 * Disallowed-but-harmless elements are unwrapped, keeping their text;
 * script-like elements are dropped with their contents.
 */
export function sanitiseHtml(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const out = document.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) out.append(cleanNode(child));
  return out;
}

function cleanNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');

  if (DROP_ENTIRELY.has(node.tagName)) return document.createTextNode('');

  const kids = document.createDocumentFragment();
  for (const child of Array.from(node.childNodes)) kids.append(cleanNode(child));

  if (!ALLOWED_TAGS.has(node.tagName)) return kids;   // unwrap, keep the text

  const clean = document.createElement(node.tagName.toLowerCase());
  clean.append(kids);                                  // no attributes copied
  return clean;
}

/** Sanitise `html` into `node`, replacing whatever was there. */
export function setHtml(node, html) {
  clear(node);
  node.append(sanitiseHtml(html));
  return node;
}

/** Sanitised HTML plus KaTeX, in that order. Use for anything card-authored. */
export function setRich(node, html) {
  setHtml(node, html);
  renderMath(node);
  return node;
}

/** Strip all tags and collapse whitespace — for table cells and previews. */
export function plainText(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  for (const bad of doc.body.querySelectorAll('script, style')) bad.remove();
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

// ── KaTeX ───────────────────────────────────────────────────────────────────
// Loaded lazily so the sign-in screen does not pay for it.

let katexPromise = null;
function loadKatex() {
  katexPromise ??= Promise.all([
    import('https://cdn.jsdelivr.net/npm/katex@0/dist/katex.mjs'),
    import('https://cdn.jsdelivr.net/npm/katex@0/dist/contrib/auto-render.mjs'),
  ]).then(([katex, auto]) => ({
    katex: katex.default ?? katex,
    renderMathInElement: auto.default ?? auto,
  })).catch((e) => {
    katexPromise = null;               // let a later card retry
    console.warn('KaTeX failed to load:', e);
    return null;
  });
  return katexPromise;
}

/** Warm the KaTeX cache once a session exists. */
export function primeMath() { loadKatex(); }

const DELIMS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '$', right: '$', display: false },
  { left: '\\(', right: '\\)', display: false },
];

/**
 * Render $...$ and $$...$$ inside `node`, in place.
 * throwOnError is false on purpose: a malformed formula degrades to raw text
 * rather than blanking the card you are trying to answer.
 */
export function renderMath(node) {
  if (!node || !/[$\\]/.test(node.textContent || '')) return;
  loadKatex().then((k) => {
    if (!k || !node.isConnected) return;
    try {
      k.renderMathInElement(node, {
        delimiters: DELIMS,
        throwOnError: false,
        errorColor: '#F2555A',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'option'],
      });
    } catch (e) { console.warn('KaTeX render failed:', e); }
  });
}

/** Render one LaTeX string into a fresh element. */
export function mathBlock(latex, display = true) {
  const node = el('div', { class: display ? 'math-display' : 'math-inline' });
  node.textContent = latex;   // visible until KaTeX lands, and if it never does
  loadKatex().then((k) => {
    if (!k || !node.isConnected) return;
    try {
      k.katex.render(String(latex ?? ''), node, {
        displayMode: display, throwOnError: false, errorColor: '#F2555A',
      });
    } catch { node.textContent = latex; }
  });
  return node;
}

// ── toasts ──────────────────────────────────────────────────────────────────
/** toast('message', 'err' | 'ok' | 'warn' | 'info', ms) */
export function toast(message, kind = 'info', ms = kind === 'err' ? 9000 : 4000) {
  const root = $('#toasts');
  if (!root) { console.log('[toast]', message); return null; }

  const close = el('button', { class: 'toast-x', 'aria-label': 'Dismiss', type: 'button' }, '×');
  const node = el('div', { class: `toast toast-${kind}` },
    el('div', { class: 'toast-msg' }, message),
    close,
  );
  close.addEventListener('click', () => node.remove());
  root.append(node);
  if (ms) setTimeout(() => node.remove(), ms);
  return node;
}

/** Report a thrown error with its actual message, never "Something went wrong". */
export function toastError(prefix, err) {
  const msg = err?.message || String(err || 'Unknown error');
  console.error(prefix, err);
  return toast(`${prefix}: ${msg}`, 'err');
}

// ── modal ───────────────────────────────────────────────────────────────────
/**
 * openModal({ title, body, actions, wide, onDone }) -> { close }
 * `actions` are { label, kind, value, primary }; clicking resolves onDone.
 */
export function openModal({ title, body, actions = [], wide = false, onDone } = {}) {
  const root = $('#modal-root');
  clear(root);
  root.hidden = false;

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    root.hidden = true;
    clear(root);
    document.removeEventListener('keydown', onKey);
    onDone?.(value);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };

  const foot = el('div', { class: 'modal-foot' },
    actions.map((a) => el('button', {
      class: ['btn', a.primary && 'btn-primary', a.kind === 'danger' && 'btn-danger']
        .filter(Boolean).join(' '),
      type: 'button',
      onclick: () => finish(a.value ?? a.label),
    }, a.label)),
  );

  const modal = el('div', {
    class: wide ? 'modal modal-wide' : 'modal', role: 'dialog', 'aria-modal': 'true',
  },
    title ? el('div', { class: 'modal-head' }, title) : null,
    el('div', { class: 'modal-body' }, body ?? ''),
    actions.length ? foot : null,
  );

  root.append(modal);
  root.addEventListener('click', (e) => { if (e.target === root) finish(null); });
  document.addEventListener('keydown', onKey);
  (modal.querySelector('input, textarea, select, .btn-primary') ?? modal).focus?.();

  return { close: () => finish(null) };
}

/**
 * A real confirm dialog. Used only for destructive bulk actions —
 * window.confirm() is banned.
 */
export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: el('p', { style: 'margin:0; line-height:1.6;' }, message),
      actions: [
        { label: 'Cancel', value: false },
        { label: confirmLabel, value: true, kind: 'danger' },
      ],
      onDone: (v) => resolve(v === true),
    });
  });
}

/**
 * A prompt dialog.
 * Resolves to the trimmed string when confirmed — possibly '' — and to null
 * when cancelled. Callers need that difference to tell "clear this field"
 * from "I changed my mind".
 */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const input = el('input', { class: 'input', value, placeholder, type: 'text' });
    const body = el('div', { class: 'field' },
      label ? el('span', { class: 'label' }, label) : null, input);

    let answer = null;
    const dialog = openModal({
      title, body,
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: confirmLabel, value: 'ok', primary: true },
      ],
      onDone: (v) => resolve(v === 'ok' ? input.value.trim() : answer),
    });

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      answer = input.value.trim();   // Enter confirms, same as the button
      dialog.close();
    });
  });
}

// ── state blocks ────────────────────────────────────────────────────────────
export function loadingBlock(text = 'Loading…') {
  return el('div', { class: 'state' }, el('span', { class: 'spinner' }), text);
}

export function errorBlock(err, onRetry) {
  const msg = err?.message || String(err || 'Unknown error');
  return el('div', { class: 'state state-error' },
    el('div', {}, msg),
    onRetry ? el('button', { class: 'btn btn-sm', type: 'button', onclick: onRetry }, 'Retry') : null,
  );
}

// ── formatting ──────────────────────────────────────────────────────────────
export function fmtInterval(days) {
  if (days == null) return '—';
  if (days <= 0) return 'now';
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${(days / 30).toFixed(days < 90 ? 1 : 0)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function fmtDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(+date)) return '—';
  return date.toISOString().slice(0, 10);
}

/** Days from today to an ISO date string. Negative means overdue. */
export function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const then = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(+then)) return null;
  return Math.round((then - today) / 86400000);
}

export function fmtDue(iso) {
  const n = daysUntil(iso);
  if (n == null) return '—';
  if (n < 0) return `${-n}d over`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `${n}d`;
}

export function pluralise(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }
