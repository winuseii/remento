// Supabase connection. Safe to commit: the publishable key grants nothing
// without a signed-in session, because every table has row-level security
// restricting rows to user_id = auth.uid().
export const SUPABASE_URL = 'https://sxnlfevqdstaraidjpwj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_9g6bQulrrLfKvi_9Kfx77Q_PMnuSfy5';

// Storage bucket for card images (private).
export const IMAGE_BUCKET = 'remento-images';

// Table names. This Supabase project also hosts another application —
// never touch a table without the remento_ prefix.
export const T = {
  settings:  'remento_settings',
  semesters: 'remento_semesters',
  subjects:  'remento_subjects',
  units:     'remento_units',
  cards:     'remento_cards',
  reviews:   'remento_reviews',
};

export const DEFAULTS = {
  sessionSize:    25,
  newPerDay:      20,
  reviewsPerDay:  120,
  trashPurgeDays: 10,
  image: { maxEdge: 1600, type: 'image/webp', quality: 0.82 },
};
