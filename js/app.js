// Boot, the session guard, navigation, the contextual header, and the small
// amount of global state the views share.

import { $, $$, clear, toast, toastError, errorBlock, primeMath, el } from './ui.js';
import { signIn, signOut, getSession, onAuthChange, scrubAuthFromUrl } from './auth.js';
import { icon } from './icons.js';
import * as db from './db.js';

// ── global state ────────────────────────────────────────────────────────────

export const state = {
  user: null,
  settings: null,
  semesters: [],
  subjects: [],
  units: [],
  /** Last-used destination, so Drill and Import reopen where you left off. */
  focus: { semesterId: null, subjectId: null, unitId: null },
  editMode: false,
  tab: 'drill',
};

const listeners = new Set();

export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitStateChange(what = 'structure') {
  for (const fn of listeners) {
    try { fn(what, state); } catch (e) { console.error('state listener failed', e); }
  }
}

export async function refreshStructure() {
  const { semesters, subjects, units } = await db.loadStructure();
  Object.assign(state, { semesters, subjects, units });
  emitStateChange('structure');
}

// ── contextual header ───────────────────────────────────────────────────────
// Each screen owns its own chrome. Drill wants almost none; Browse wants
// search; Import wants a destination. Forcing one bar onto all of them is what
// makes an app feel like a template.

/**
 * @param {{crumb?: (string|Node)[], actions?: Node[]}} spec
 */
export function setHeader({ crumb = [], actions = [] } = {}) {
  const crumbEl = $('#crumb');
  const actionsEl = $('#header-actions');
  clear(crumbEl);
  clear(actionsEl);

  crumb.forEach((part, i) => {
    if (i) crumbEl.append(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    const last = i === crumb.length - 1;
    crumbEl.append(
      part instanceof Node ? part
        : el('span', { class: last ? 'crumb-part is-current' : 'crumb-part' }, part),
    );
  });

  for (const a of actions) actionsEl.append(a);
}

// ── view registry ───────────────────────────────────────────────────────────

const VIEWS = {
  drill: () => import('./views/drill.js'),
  subject: () => import('./views/subject.js'),
  browse: () => import('./views/browse.js'),
  import: () => import('./views/import.js'),
  stats: () => import('./views/stats.js'),
  settings: () => import('./views/settings.js'),
};

/** Which nav entry lights up for a given view. Subject lives under Browse. */
const NAV_FOR = { drill: 'drill', subject: 'browse', browse: 'browse', import: 'import', stats: 'stats', settings: 'settings' };

const mounted = new Map();
let navArgs = null;

/** Navigate. `args` is handed to the view's render as ctx.args. */
export async function showTab(tab, args = null) {
  if (!VIEWS[tab]) tab = 'drill';
  state.tab = tab;
  navArgs = args;

  const navKey = NAV_FOR[tab];
  for (const btn of $$('[data-tab]')) {
    const on = btn.dataset.tab === navKey;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const panel of $$('.panel')) panel.hidden = panel.id !== `panel-${tab}`;

  closeDrawer();
  const panel = $(`#panel-${tab}`);
  if (!panel) return;

  mounted.get(tab)?.teardown?.();
  mounted.delete(tab);
  clear(panel);
  setHeader();

  try {
    const mod = await VIEWS[tab]();
    const handle = await mod.render(panel, {
      state, args, refreshStructure, onStateChange, setHeader, navigate: showTab,
    });
    if (handle) mounted.set(tab, handle);
  } catch (err) {
    clear(panel);
    panel.append(el('div', { class: 'wrap' }, errorBlock(err, () => showTab(tab, args))));
    console.error(`[${tab}] failed to render`, err);
  }

  try { history.replaceState(null, '', `#${tab}`); } catch { /* file:// */ }
  $('#main')?.scrollTo?.({ top: 0 });
}

// ── chrome wiring ───────────────────────────────────────────────────────────

function mountIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    if (slot.firstChild) continue;
    slot.append(icon(slot.dataset.icon, { size: Number(slot.dataset.size) || 17 }));
  }
}

function openDrawer() { $('#app').classList.add('drawer-open'); }
function closeDrawer() { $('#app')?.classList.remove('drawer-open'); }

function wireChrome() {
  mountIcons();

  for (const btn of $$('[data-tab]')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }

  $('#header-menu').addEventListener('click', () => {
    $('#app').classList.toggle('drawer-open');
  });

  const toggle = $('#edit-toggle');
  toggle.addEventListener('change', () => {
    state.editMode = toggle.checked;
    emitStateChange('editMode');
  });

  $('#palette-cue').addEventListener('click', () => openPalette());

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement
      && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing || !$('#modal-root').hidden || !$('#palette-root').hidden) return;

    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      toggle.checked = !toggle.checked;
      toggle.dispatchEvent(new Event('change'));
    }
    if (e.key === 'Escape') closeDrawer();
  });
}

async function openPalette() {
  const { openPalette: open } = await import('./command-palette.js');
  open({ state, navigate: showTab, setEdit: (on) => {
    const t = $('#edit-toggle');
    t.checked = on;
    t.dispatchEvent(new Event('change'));
  } });
}

// ── sign in ─────────────────────────────────────────────────────────────────

function wireSignIn() {
  const form = $('#signin-form');
  const input = $('#signin-email');
  const btn = $('#signin-btn');
  const msg = $('#signin-msg');

  const say = (text, kind = '') => {
    msg.textContent = text;
    msg.className = `signin-msg ${kind}`.trim();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email || !email.includes('@')) { say('Enter a valid email address.', 'is-err'); return; }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending…';
    say('');

    try {
      await signIn(email);
      say(`Link sent to ${email}. Open it on this device or any other — it signs you in either way.`, 'is-ok');
      form.reset();
    } catch (err) {
      say(err.message || 'Could not send the link.', 'is-err');
      console.error('sign-in failed', err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

// ── session ─────────────────────────────────────────────────────────────────

function showScreen(which) {
  $('#boot').hidden = which !== 'boot';
  $('#signin').hidden = which !== 'signin';
  $('#app').hidden = which !== 'app';
}

let starting = false;

async function startApp(session) {
  if (starting) return;
  starting = true;
  db.forgetUser();
  state.user = session.user;

  try {
    state.settings = await db.loadSettings();
    await refreshStructure();
    showScreen('app');
    primeMath();

    const email = state.user?.email ?? '';
    const user = $('#sidebar-user');
    clear(user);
    user.append(
      el('span', { class: 'user-dot', 'aria-hidden': 'true' }, (email[0] ?? '?').toUpperCase()),
      el('span', { class: 'user-email' }, email),
    );

    const tab = (location.hash || '').replace('#', '');
    await showTab(VIEWS[tab] ? tab : 'drill');

    db.purgeTrash()
      .then((n) => { if (n) console.info(`Purged ${n} card(s) from trash.`); })
      .catch((e) => console.warn('Trash purge failed:', e.message));
  } catch (err) {
    if (isAuthFailure(err)) {
      starting = false;
      await signOut().catch(() => {});
      stopApp();
      const msg = $('#signin-msg');
      msg.textContent = 'Your session expired. Send yourself a new link to sign back in.';
      msg.className = 'signin-msg is-err';
      return;
    }
    showScreen('app');
    const panel = $('#panel-drill');
    clear(panel);
    panel.append(el('div', { class: 'wrap' }, errorBlock(err, () => { starting = false; startApp(session); })));
    toastError('Could not load your account', err);
  } finally {
    starting = false;
  }
}

/** Does this error mean the stored session is no longer good? */
function isAuthFailure(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('not signed in') || msg.includes('jwt') || msg.includes('token')
    || msg.includes('session') || err?.status === 401 || err?.status === 403;
}

function stopApp() {
  state.user = null;
  state.settings = null;
  db.forgetUser();
  mounted.forEach((h) => h.teardown?.());
  mounted.clear();
  for (const panel of $$('.panel')) clear(panel);
  showScreen('signin');
}

export async function doSignOut() {
  try {
    await signOut();
    toast('Signed out.', 'ok');
  } catch (err) {
    toastError('Sign out failed', err);
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  wireSignIn();
  wireChrome();

  onAuthChange((event, session) => {
    if (event === 'SIGNED_IN' && session && !state.user) { scrubAuthFromUrl(); startApp(session); }
    else if (event === 'SIGNED_OUT') stopApp();
  });

  try {
    const session = await getSession();
    scrubAuthFromUrl();
    if (session) await startApp(session);
    else showScreen('signin');
  } catch (err) {
    console.error('boot failed', err);
    showScreen('signin');
    $('#signin-msg').textContent = err.message || 'Could not reach Supabase.';
    $('#signin-msg').className = 'signin-msg is-err';
  }
}

// The service worker caches the app shell only — never card data.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed:', e));
  });
}

boot();
