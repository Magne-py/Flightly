-- Flightly — initial leaderboard schema
--
-- Run this in Supabase's SQL Editor (Project → SQL Editor → New query → paste →
-- Run). Safe to re-run: every statement is idempotent via "if exists" / "or
-- replace" / drop-then-create patterns, so re-applying after a tweak won't
-- explode.
--
-- What this creates:
--   1. public.profiles  — one row per signed-up user. Holds the username
--                         that shows on the leaderboard. Linked 1:1 to
--                         auth.users (the table Supabase Auth manages for
--                         email + password).
--   2. public.scores    — one row per finished speedrun. Holds the points,
--                         solves, mode, and timestamp.
--   3. A trigger that auto-creates a profile row whenever a new auth user
--      signs up. The username comes from the signup metadata (the client
--      passes it via supabase.auth.signUp({ options: { data: { username }}}).
--   4. Row-Level Security policies:
--      - profiles: everyone can read, owner can update.
--      - scores:   everyone can read (public leaderboard), authenticated
--                  users can insert ONLY rows whose user_id matches their
--                  own auth.uid().
--
-- Anti-cheat note: the points column has a sanity check (0..5000) — a 90s
-- speedrun at max scoring (~520 pts per puzzle × ~10 solves) tops out
-- comfortably below that. Outright forged scores beyond the cap will be
-- rejected at the database level. Determined attackers can still submit
-- "plausible" fake scores; that's a separate problem for later (full
-- server-side validation of every solve).

-- ---------------------------------------------------------------------------
-- 1. profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  username    text        unique not null
              check (char_length(username) between 3 and 24
                  and username ~ '^[A-Za-z0-9_-]+$'),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. scores
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  mode        text        not null
              check (mode in (
                'speedrun-global',
                'speedrun-simple', 'speedrun-easy', 'speedrun-medium',
                'speedrun-hard', 'speedrun-extreme',
                'speedrun-africa', 'speedrun-europe', 'speedrun-north-america',
                'speedrun-south-america', 'speedrun-asia', 'speedrun-oceania',
                'speedrun-cryptic'
              )),
  points      integer     not null check (points between 0 and 5000),
  solves      integer     not null check (solves between 0 and 60),
  played_at   timestamptz not null default now()
);

-- Leaderboard query: scores for mode X ordered by points desc. The
-- composite index makes this an index-only scan up to LIMIT N.
create index if not exists scores_mode_points_idx
  on public.scores (mode, points desc);

-- "My runs" / personal-history queries.
create index if not exists scores_user_idx
  on public.scores (user_id, played_at desc);

-- ---------------------------------------------------------------------------
-- 3. Auto-create profile on signup
-- ---------------------------------------------------------------------------
-- When a new auth.users row appears, copy its id + the requested username
-- (passed via signUp metadata) into public.profiles. If no username was
-- supplied — shouldn't happen with our client, but be defensive — fall
-- back to a derived placeholder so the FK from scores never breaks.
create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
declare
  candidate text;
begin
  candidate := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    'user_' || substr(new.id::text, 1, 8)
  );
  insert into public.profiles (id, username) values (new.id, candidate);
  return new;
exception when unique_violation then
  -- Username collision (rare). Append a short suffix and try once.
  insert into public.profiles (id, username)
  values (new.id, candidate || '_' || substr(new.id::text, 1, 4));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 4. Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.scores   enable row level security;

-- profiles: world-readable, self-writable (so users can rename themselves).
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public"
  on public.profiles for select
  using (true);

drop policy if exists "profiles owner can update" on public.profiles;
create policy "profiles owner can update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- scores: world-readable, authenticated insert restricted to own user_id.
drop policy if exists "scores are public" on public.scores;
create policy "scores are public"
  on public.scores for select
  using (true);

drop policy if exists "scores insert own" on public.scores;
create policy "scores insert own"
  on public.scores for insert
  to authenticated
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Done. Verify with a quick read of the catalog:
--   select table_name from information_schema.tables
--     where table_schema = 'public' and table_name in ('profiles', 'scores');
-- ---------------------------------------------------------------------------
