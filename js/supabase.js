// The Supabase client, as a singleton. Nothing else constructs one.
//
// The publishable key is committed on purpose: every remento_* table has RLS
// with a single policy, user_id = auth.uid(). Without a signed-in session the
// key reads zero rows and writes zero rows.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The magic link lands back here with its tokens in the URL fragment.
    // Implicit flow rather than PKCE, deliberately: PKCE stores a verifier in
    // the originating browser, so a link requested on the laptop and opened on
    // the phone would fail. Cross-device is the normal case here.
    detectSessionInUrl: true,
    storageKey: 'remento.auth',
  },
});

/**
 * Unwrap a PostgREST response, throwing the real message.
 * Silent failure is the enemy: this app is used the night before an exam.
 */
export function unwrap({ data, error }) {
  if (error) throw new Error(error.message || 'Database error');
  return data;
}
