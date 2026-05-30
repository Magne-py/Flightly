-- Flightly — dynamic difficulty tracking.
--
-- Records every puzzle attempt (one row per browser_id × puzzle_key) and
-- maintains a per-puzzle aggregate in puzzle_stats. The frontend reads
-- puzzle_stats + a baked prior_p to compute a posterior completion rate
-- that drives the live difficulty display.
--
-- Identity rules:
--   - puzzle_key = `${start}-${dest}` (six uppercase letters with a dash).
--     Continent variants of the same start/dest share stats; that's a
--     deliberate simplification — the % displayed reflects "people in
--     the game completing this start→dest" across all modes that present
--     it. If we ever want per-mode rates we can add a discriminator
--     column without breaking the current schema.
--   - browser_id is a long-lived UUID stored in localStorage on first
--     visit. user_id is captured when the player is also signed in but
--     it's optional; the browser_id is the credential.
--
-- Anti-abuse posture:
--   - UNIQUE (browser_id, puzzle_key) means a browser can only vote
--     once per puzzle. Clearing localStorage or switching browsers
--     resets that bound; we accept that as the cost of letting
--     unauthenticated visitors influence the rate.
--   - puzzle_stats writes are gated to the trigger — there is no INSERT
--     policy on puzzle_stats itself, so callers can't push aggregates
--     directly.
--
-- Safe to re-run: every table / function / policy creation is
-- idempotent.

-- ---------------------------------------------------------------------------
-- 1. puzzle_attempts — append-only log of individual outcomes.
-- ---------------------------------------------------------------------------
create table if not exists public.puzzle_attempts (
  id          bigint generated always as identity primary key,
  browser_id  text   not null check (char_length(browser_id) between 8 and 64),
  user_id     uuid   references public.profiles(id) on delete set null,
  puzzle_key  text   not null check (puzzle_key ~ '^[A-Z]{3}-[A-Z]{3}$'),
  success     boolean not null,
  played_at   timestamptz not null default now(),
  unique (browser_id, puzzle_key)
);

create index if not exists puzzle_attempts_key_idx
  on public.puzzle_attempts (puzzle_key);

-- ---------------------------------------------------------------------------
-- 2. puzzle_stats — aggregated counts per puzzle. Maintained by trigger.
-- ---------------------------------------------------------------------------
create table if not exists public.puzzle_stats (
  puzzle_key  text primary key check (puzzle_key ~ '^[A-Z]{3}-[A-Z]{3}$'),
  attempts    integer     not null default 0 check (attempts >= 0),
  successes   integer     not null default 0 check (successes >= 0 and successes <= attempts),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Trigger: bump the aggregate when a new attempt lands.
-- ---------------------------------------------------------------------------
create or replace function public.bump_puzzle_stats()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
begin
  insert into public.puzzle_stats (puzzle_key, attempts, successes, updated_at)
  values (new.puzzle_key, 1, case when new.success then 1 else 0 end, now())
  on conflict (puzzle_key) do update
    set attempts   = puzzle_stats.attempts  + 1,
        successes  = puzzle_stats.successes + (case when new.success then 1 else 0 end),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_puzzle_attempt_insert on public.puzzle_attempts;
create trigger on_puzzle_attempt_insert
  after insert on public.puzzle_attempts
  for each row execute function public.bump_puzzle_stats();

-- ---------------------------------------------------------------------------
-- 4. RLS — anyone can insert an attempt (anonymous-friendly), nobody can
-- read individual attempt rows, anyone can read aggregates.
-- ---------------------------------------------------------------------------
alter table public.puzzle_attempts enable row level security;
alter table public.puzzle_stats    enable row level security;

drop policy if exists "attempts insert anyone" on public.puzzle_attempts;
create policy "attempts insert anyone"
  on public.puzzle_attempts for insert
  with check (true);

-- No SELECT policy on puzzle_attempts → no one can read raw attempts,
-- which keeps the browser_id ↔ outcome mapping private.

drop policy if exists "stats are public" on public.puzzle_stats;
create policy "stats are public"
  on public.puzzle_stats for select
  using (true);
-- No INSERT / UPDATE policy on puzzle_stats → callers can't write aggregates
-- directly; the trigger (which runs as the table owner) is the only writer.
