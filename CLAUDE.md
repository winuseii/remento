# CLAUDE.md — build brief for Remento

You are building **Remento**, a spaced-repetition flashcard app for a mechanical engineering
student's coursework. Read `docs/SPEC.md` before writing any code — it is the authority on what
the app does. This file is the authority on *how* to build it.

The database already exists. The schema in `supabase/schema.sql` has been applied to the live
project. Do not re-create it, and do not change it without saying so explicitly in your reply.

---

## Non-negotiables

1. **No build step.** Plain ES modules, loaded directly by the browser. GitHub Pages serves this
   folder as-is. Do not add Vite, Webpack, Rollup, Parcel, or a `package.json` build script.
2. **No framework.** No React, Vue, Svelte, Preact, Alpine. Vanilla JS with small render functions.
   The app has five screens; a framework costs more than it saves and adds a build step.
3. **No CSS framework.** No Tailwind, no Bootstrap. The design tokens are in `css/tokens.css` and
   they are the palette — do not invent colours.
4. **No TypeScript.** Plain `.js` with JSDoc comments where a type is genuinely unclear.
5. **Table names are prefixed `remento_`.** This Supabase project hosts another application.
   Never query, alter, or drop a table without that prefix.
6. **Do not implement the deferred list** (§9.1 of the spec): quiz mode, review heatmap, readiness
   score, reverse-card editor UI, Google sign-in, offline data. The schema supports them; the UI
   does not get them in v1.

Dependencies come from jsDelivr as ES modules, pinned to a major version:

```js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
```

KaTeX is loaded the same way, with its stylesheet via `<link>` from jsDelivr.

---

## Stack

| Layer | Choice |
|---|---|
| Hosting | GitHub Pages, public repo `winuseii/remento` |
| Backend | Supabase — Postgres, Auth, Storage |
| Client | Vanilla ES modules, no bundler |
| Math | KaTeX |
| Install | PWA — manifest + service worker caching the app shell only |

Project URL and publishable key are in `js/config.js`. They are safe to commit: row-level security
means the key can read nothing without a signed-in session.

---

## File layout

```
index.html                 single page, five tab panels, no router
manifest.webmanifest
sw.js                      caches the app shell only — never card data
icons/                     icon-192.png, icon-512.png, apple-touch-icon.png
css/
  tokens.css               palette, type scale, spacing — DO NOT invent values
  app.css                  everything else
js/
  config.js                Supabase URL + publishable key      [written]
  supabase.js              client singleton, session handling
  auth.js                  magic-link sign in / sign out / session guard
  db.js                    every query lives here. No SQL anywhere else.
  scheduler.js             SM-2 — pure functions, no DOM, no db
  importer.js              JSON + text parsing → card objects. Pure, testable.
  ui.js                    render helpers, KaTeX, toast, modal
  app.js                   boot, tab switching, global state
  views/
    drill.js
    browse.js
    import.js
    stats.js
    settings.js
docs/
  SPEC.md                  what the app does
  IMPORT-FORMAT.md         the AI-facing card format
data/
  thermo-unit1.json        36 real cards — use these to test import
  thermo-unit2.txt         7 real cards in the text format
supabase/
  schema.sql               already applied; reference only
```

**`scheduler.js` and `importer.js` must be pure** — no DOM, no network, no Supabase import. They
are the two pieces of real logic in the app and they must be testable by calling them with data.

---

## Database

Tables: `remento_settings`, `remento_semesters`, `remento_subjects`, `remento_units`,
`remento_cards`, `remento_reviews`. Full DDL in `supabase/schema.sql`.

Things the schema does for you — do not reimplement them in JS:

- `front_norm` is a generated column (normalised front text). **Use it for duplicate detection**
  on import; do not normalise strings client-side.
- `search_tsv` is a generated tsvector. Search with
  `.textSearch('search_tsv', query, { type: 'websearch' })`.
- `tags` are **not** in `search_tsv` (Postgres rejects `array_to_string` in a generated column).
  Tag filtering uses `.contains('tags', [...])`, which hits the GIN index.
- `updated_at` is maintained by a trigger.
- `import_key` is unique per user. Set it from the `id` field in an import payload so a re-import
  of a corrected card updates rather than duplicates.
- `remento_retention_by_tag(days)` is an RPC returning retention per tag. Call it with
  `supabase.rpc('remento_retention_by_tag', { days: 30 })`.

Deletion is **soft**: set `deleted_at`. Every card query must filter `.is('deleted_at', null)`.
On app boot, hard-delete rows where `deleted_at < now() - 10 days`.

Images live in the private `remento-images` bucket under `{user_id}/{card_id}/{uuid}.webp`.
Compress client-side before upload — longest edge 1600 px, WebP, quality 0.82 — then store the
path in `cards.images`. Display via `createSignedUrl`.

### Auth

Magic link only. `signInWithOtp({ email })`, with `emailRedirectTo` set to the Pages URL.
Session persists in localStorage via the Supabase client. The whole app is behind a session check:
no session, show a single sign-in panel and nothing else.

**First-run bootstrap:** on first sign-in the user has no rows. Create `remento_settings` with the
defaults below, and nothing else. The user creates semesters and subjects themselves. Do not seed
example data.

```js
{ sessionSize: 25, newPerDay: 20, reviewsPerDay: 120, theme: 'dark' }
```

---

## Design

`css/tokens.css` holds the palette. The rules that matter:

- **Two personalities.** The drill screen is calm: serif question text, generous space, minimal
  chrome. Browse / Import / Stats are instruments: mono, dense, tabular.
- **Scarlet is the brand and the primary action.** The only filled scarlet element on the drill
  screen is **Show answer**.
- **Grade buttons are not filled.** Neutral outline, coloured left edge, coloured label. Again
  `--g-again`, Hard `--g-hard`, Good `--g-good`, Easy `--g-easy`.
- **Dark only.** No light theme, no theme toggle.
- **Phone first.** Tabs bottom-anchored on narrow screens. Grade buttons in the lower third of the
  viewport where the thumb is. Nothing below 44 px tap target.
- Keyboard on desktop: `space`/`enter` reveal, `1`–`4` grade, `e` toggle edit. Every shortcut is
  also a visible clickable control.

---

## Build order

Build in this order and stop at each checkpoint to verify before moving on.

**1 — Shell and auth.** index.html with five empty tab panels, tokens.css, sign-in panel, magic
link round trip, session guard, sign-out.
*Checkpoint: sign in on desktop, reload, still signed in.*

**2 — Structure.** Settings view: create/rename/reorder semesters, subjects, units. Declared unit
count per subject.
*Checkpoint: create Semester 3 → Thermodynamics → Units 1 and 2.*

**3 — Importer (pure).** `importer.js` parses both formats into card objects, with per-card errors
rather than one fatal throw. Test it against `data/thermo-unit1.json` and `data/thermo-unit2.txt`.
*Checkpoint: 36 cards and 7 cards parse with zero errors, printed to console.*

**4 — Import view.** Paste box, file drop, preview screen with new / duplicate / update / malformed
counts, destination confirm, unit creation confirm, single-transaction insert.
*Checkpoint: both test files import; re-importing the same file reports 36 duplicates, not 36 new.*

**5 — Drill.** Card rendering for all six types, KaTeX, reveal, four grades with interval previews,
tick boxes on list and cloze with suggested grade, session counter, `remento_reviews` write.
*Checkpoint: drill 10 Thermo cards; due dates change; reviews rows appear.*

**6 — Browse.** Paginated table, sort, filter, search, edit toggle, inline edit, bulk actions,
trash with restore.
*Checkpoint: find a card by searching "entropy"; edit it; delete it; restore it.*

**7 — Modes.** Cram (no schedule writes), weak cards.
*Checkpoint: cram a unit; confirm due dates are unchanged afterwards.*

**8 — Stats.** Per-subject coverage by unit, maturity split, retention, worst cards, retention by
tag via the RPC.

**9 — PWA.** Manifest, icons, service worker caching the shell. Installable on Android.

---

## Conventions

- Every async call that touches the network gets a visible loading state and a visible error state.
  Silent failure is the enemy — this app is used the night before an exam.
- Errors surface as a toast with the actual message, not "Something went wrong."
- No `alert()`, no `confirm()` except for destructive bulk actions.
- Card content is authored HTML (the import format allows `<strong>`, `<ul>`, `<br>`, `<code>`,
  `<sup>`, `<sub>`). Render it, but **sanitise**: strip `<script>`, `<iframe>`, `on*` attributes and
  `javascript:` URLs before insertion. The data is the user's own, but it round-trips through
  third-party AI output, so treat it as untrusted.
- LaTeX is delimited `$...$` inline and `$$...$$` display. Render with KaTeX after HTML insertion,
  with `throwOnError: false` so a malformed formula degrades to raw text instead of blanking a card.
- Commit in logical chunks with real messages. Do not commit a single "build app" commit.

## What not to do

- Do not add a build step, a framework, or a CSS framework.
- Do not add analytics, telemetry, or any third-party script beyond Supabase and KaTeX.
- Do not change `supabase/schema.sql` silently. If the schema needs a change, say so and explain
  why before applying it.
- Do not seed demo data.
- Do not implement anything on the deferred list.
- Do not "improve" the scheduling constants in §4.3 of the spec. They are deliberate.

---

## Deploy

```
cd Documents\remento
git init
git add -A
git commit -m "Remento: initial build"
gh repo create winuseii/remento --public --source=. --push
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
Live at `https://winuseii.github.io/remento/`.

Finally, add the Pages URL to **Supabase → Authentication → URL Configuration → Redirect URLs**,
or the magic link will bounce.
