// Boot, the session guard, tab switching, and the small amount of global state
// the five views share.

import { $, $$, clear, toast, toastError, errorBlock, primeMath } from './ui.js';
import { signIn, signOut, getSession, onAuthChange, scrubAuthFromUrl } from './auth.js';
import * as db from './db.js';

// ── global state ────────────────────────────────────────────────────────────
// One object, passed to every view. Views read it; only app.js and the
// settings view write to it.

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

/** Subscribe to structure/settings changes. Returns an unsubscribe function. */
export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitStateChange(what = 'structure') {
  for (const fn of listeners) {
    try { fn(what, state); } catch (e) { console.error('state listener failed', e); }
  }
}

/** Re-read the semester/subject/unit tree after the settings view edits it. */
export async function refreshStructure() {
  const { semesters, subjects, units } = await db.loadStructure();
  Object.assign(state, { semesters, subjects, units });
  emitStateChange('structure');
}

// ── view registry ───────────────────────────────────────────────────────────
// Views are lazy: Browse and Stats are not parsed until you open them.

const VIEWS = {
  drill: () => import('./views/drill.js'),
  browse: () => import('./views/browse.js'),
  import: () => import('./views/import.js'),
  stats: () => import('./views/stats.js'),
  settings: () => import('./views/settings.js'),
};

const mounted = new Map();   // tab -> { teardown }

async function showTab(tab) {
  if (!VIEWS[tab]) tab = 'drill';
  state.tab = tab;

  for (const btn of $$('[data-tab]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  }
  for (const panel of $$('.panel')) {
    panel.hidden = panel.id !== `panel-${tab}`;
  }

  const panel = $(`#panel-${tab}`);
  if (!panel) return;

  // Views re-render on every visit; they are cheap and the data moves.
  mounted.get(tab)?.teardown?.();
  mounted.delete(tab);
  clear(panel);

  try {
    const mod = await VIEWS[tab]();
    const handle = await mod.render(panel, { state, refreshStructure, onStateChange });
    if (handle) mounted.set(tab, handle);
  } catch (err) {
    clear(panel);
    panel.append(errorBlock(err, () => showTab(tab)));
    console.error(`[${tab}] failed to render`, err);
  }

  try { history.replaceState(null, '', `#${tab}`); } catch { /* file:// */ }
}

function wireTabs() {
  for (const btn of $$('[data-tab]')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }

  const toggle = $('#edit-toggle');
  toggle.addEventListener('change', () => {
    state.editMode = toggle.checked;
    emitStateChange('editMode');
  });

  // Keyboard on desktop. Every shortcut also has a visible control;
  // the drill view binds space / enter / 1-4 itself.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement &&
        (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    if (!$('#modal-root').hidden) return;

    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      toggle.checked = !toggle.checked;
      toggle.dispatchEvent(new Event('change'));
    }
  });
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
    // First-run bootstrap creates the settings row and nothing else.
    state.settings = await db.loadSettings();
    await refreshStructure();
    showScreen('app');
    primeMath();

    const tab = (location.hash || '').replace('#', '');
    await showTab(VIEWS[tab] ? tab : 'drill');

    // Housekeeping, after the UI is up so it never delays first paint.
    db.purgeTrash()
      .then((n) => { if (n) console.info(`Purged ${n} card(s) from trash.`); })
      .catch((e) => console.warn('Trash purge failed:', e.message));
  } catch (err) {
    // A stored session that the server no longer accepts — an expired refresh
    // token after a long gap is the normal cause. Stranding the user on the
    // app shell behind a Retry button they can never satisfy is the wrong
    // answer; drop them back to sign-in and say why.
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
    panel.append(errorBlock(err, () => { starting = false; startApp(session); }));
    toastError('Could not load your account', err);
  } finally {
    starting = false;
  }
}

/** Does this error mean the session is no longer good? */
function isAuthFailure(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('not signed in')
    || msg.includes('jwt')
    || msg.includes('token')
    || msg.includes('session')
    || err?.status === 401
    || err?.status === 403;
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
  wireTabs();

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
