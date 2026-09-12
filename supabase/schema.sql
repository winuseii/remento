-- ============================================================================
-- Remento — database schema
-- Project: sxnlfevqdstaraidjpwj (ap-south-1)
-- Tables are prefixed remento_* because this project also hosts another app.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

-- ── settings ────────────────────────────────────────────────────────────────
create table if not exists remento_settings (
  user_id    uuid primary key references auth.users on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── structure ───────────────────────────────────────────────────────────────
create table if not exists remento_semesters (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  slug       text not null,
  label      text not null,
  position   int  not null default 0,
  created_at timestamptz default now(),
  unique (user_id, slug)
);

create table if not exists remento_subjects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  semester_id    uuid not null references remento_semesters on delete cascade,
  slug           text not null,
  name           text not null,
  code           text,
  color          text,
  units_declared int,
  limits         jsonb not null default '{}'::jsonb,
  position       int  not null default 0,
  created_at     timestamptz default now(),
  unique (user_id, semester_id, slug)
);

create table if not exists remento_units (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  subject_id uuid not null references remento_subjects on delete cascade,
  no         int  not null,
  title      text not null,
  created_at timestamptz default now(),
  unique (subject_id, no)
);

-- ── cards ───────────────────────────────────────────────────────────────────
create table if not exists remento_cards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  subject_id uuid not null references remento_subjects on delete cascade,
  unit_id    uuid references remento_units on delete set null,
  type       text not null check (type in ('qa','cloze','formula','list','numerical','image')),

  content    jsonb not null,
  why        text,
  trap       text,
  source     text,
  figure_ref text,
  note       text,
  importance smallint default 2 check (importance between 1 and 3),
  marks      int,
  tags       text[] not null default '{}',
  images     jsonb  not null default '[]'::jsonb,

  reverse_of uuid references remento_cards on delete cascade,
  suspended  boolean not null default false,
  starred    boolean not null default false,
  import_key text,

  -- schedule, inline: grading a card is one write
  ivl           int      not null default 0,
  ease          real     not null default 2.5,
  due           date     not null default current_date,
  reps          int      not null default 0,
  lapses        int      not null default 0,
  last_grade    smallint,
  last_reviewed timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz,

  -- normalised front text for duplicate detection
  front_norm text generated always as (
    regexp_replace(
      lower(coalesce(content->>'front', content->>'prompt', content->>'text', '')),
      '[^a-z0-9]+', '', 'g')
  ) stored,

  -- full-text search across every text-bearing field
  search_tsv tsvector generated always as (
    to_tsvector('english'::regconfig,
      coalesce(content->>'front','')  || ' ' ||
      coalesce(content->>'back','')   || ' ' ||
      coalesce(content->>'prompt','') || ' ' ||
      coalesce(content->>'text','')   || ' ' ||
      coalesce(content->>'latex','')  || ' ' ||
      coalesce(content->>'value','')  || ' ' ||
      coalesce(content->>'note','')   || ' ' ||
      coalesce(content->>'items','')  || ' ' ||
      coalesce(content->>'symbols','')|| ' ' ||
      coalesce(why,'')   || ' ' ||
      coalesce(trap,'')  || ' ' ||
      coalesce(source,'')|| ' ' ||
      coalesce(note,'')
    )
  ) stored
);

create index if not exists remento_cards_due_idx on remento_cards (user_id, due)
  where deleted_at is null and suspended = false;
create index if not exists remento_cards_subject_idx on remento_cards (user_id, subject_id)
  where deleted_at is null;
create index if not exists remento_cards_unit_idx on remento_cards (unit_id)
  where deleted_at is null;
create index if not exists remento_cards_tags_idx on remento_cards using gin (tags);
create index if not exists remento_cards_fts_idx  on remento_cards using gin (search_tsv);
create index if not exists remento_cards_dupe_idx on remento_cards (user_id, subject_id, front_norm);
create index if not exists remento_cards_trash_idx on remento_cards (user_id, deleted_at)
  where deleted_at is not null;
create unique index if not exists remento_cards_import_key_idx
  on remento_cards (user_id, import_key) where import_key is not null;

-- ── review history ──────────────────────────────────────────────────────────
create table if not exists remento_reviews (
  id          bigserial primary key,
  user_id     uuid not null references auth.users on delete cascade,
  card_id     uuid not null references remento_cards on delete cascade,
  reviewed_at timestamptz not null default now(),
  grade       smallint not null check (grade between 0 and 3),
  mode        text not null check (mode in ('drill','cram','weak','quiz')),
  fraction    real,
  ivl_before  int,
  ivl_after   int,
  ms          int
);

create index if not exists remento_reviews_user_time_idx on remento_reviews (user_id, reviewed_at desc);
create index if not exists remento_reviews_card_idx on remento_reviews (card_id);

-- ── updated_at trigger ──────────────────────────────────────────────────────
create or replace function remento_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists remento_cards_touch on remento_cards;
create trigger remento_cards_touch before update on remento_cards
  for each row execute function remento_touch_updated_at();

drop trigger if exists remento_settings_touch on remento_settings;
create trigger remento_settings_touch before update on remento_settings
  for each row execute function remento_touch_updated_at();

-- ── row level security ──────────────────────────────────────────────────────
alter table remento_settings  enable row level security;
alter table remento_semesters enable row level security;
alter table remento_subjects  enable row level security;
alter table remento_units     enable row level security;
alter table remento_cards     enable row level security;
alter table remento_reviews   enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'remento_settings','remento_semesters','remento_subjects',
    'remento_units','remento_cards','remento_reviews'
  ] loop
    execute format('drop policy if exists remento_own on %I', t);
    execute format(
      'create policy remento_own on %I for all to authenticated
       using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ── image storage ───────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('remento-images', 'remento-images', false)
on conflict (id) do nothing;

drop policy if exists remento_images_own on storage.objects;
create policy remento_images_own on storage.objects for all to authenticated
  using (
    bucket_id = 'remento-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'remento-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- NOTE: tags are deliberately NOT in search_tsv — array_to_string is only STABLE,
-- not IMMUTABLE, so Postgres rejects it in a generated column. Tag search goes
-- through remento_cards_tags_idx (GIN on tags) instead.

-- ── stats helper: retention by tag ──────────────────────────────────────────
create or replace function remento_retention_by_tag(days int default 30)
returns table (tag text, reviews bigint, recalled bigint, retention numeric)
language sql stable security invoker as $$
  select t.tag,
         count(*)                                             as reviews,
         count(*) filter (where r.grade >= 1)                  as recalled,
         round(100.0 * count(*) filter (where r.grade >= 1) / nullif(count(*),0), 1) as retention
  from remento_reviews r
  join remento_cards c on c.id = r.card_id
  cross join lateral unnest(c.tags) as t(tag)
  where r.user_id = (select auth.uid())
    and r.reviewed_at > now() - (days || ' days')::interval
  group by t.tag
  order by retention asc nulls last;
$$;
