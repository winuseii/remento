// Magic-link sign in, sign out, and the session guard.
// The whole app is behind hasSession(): no session, one panel and nothing else.

import { supabase } from './supabase.js';

/** Where the magic link should come back to. Works on Pages and on file/localhost. */
export function redirectTo() {
  const { origin, pathname } = window.location;
  return origin + pathname.replace(/index\.html$/, '');
}

export async function signIn(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo() },
  });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  return data.session ?? null;
}

/** Fires on SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED. */
export function onAuthChange(fn) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => fn(event, session));
  return () => data.subscription.unsubscribe();
}

/**
 * Strip the magic-link tokens out of the address bar once the client has
 * consumed them, so a reload or a shared URL carries no credentials.
 */
export function scrubAuthFromUrl() {
  const { hash, search } = window.location;
  const dirty = /access_token=|refresh_token=|[?&]code=|error_description=/.test(hash + search);
  if (dirty) history.replaceState(null, '', redirectTo());
}
