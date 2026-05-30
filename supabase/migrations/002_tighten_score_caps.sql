-- Flightly — tighten the score cap from a flat 5000 to per-mode ceilings
-- calibrated to plausible top scores.
--
-- Background: the v1 cap (5000 across the board) was generous enough that
-- a forged Simple-tier score of 4900 would still pass and dominate that
-- leaderboard, even though a real Simple top score is around 1,200. The
-- new check is mode-aware:
--
--   Simple   ★          ≤ 1,500
--   Easy     ★★         ≤ 2,000
--   Medium   ★★★        ≤ 3,000
--   Hard     ★★★★       ≤ 4,000
--   Extreme  ★★★★★      ≤ 5,500
--   Global / Continents / Cryptic (mixed)
--                       ≤ 3,500
--
-- Derivation: star_base × best_path_bonus = max points per solve
-- (1★ 50→100, 2★ 80→160, 3★ 120→240, 4★ 180→360, 5★ 260→520). A
-- speedrun is 90 seconds; a god-tier player solves at most ~12 puzzles.
-- Per-mode cap = (max_per_solve × 12) padded ~15% for headroom.
--
-- Safe to re-run: drops the old constraint first, then re-creates the new
-- one. The old constraint was column-level (auto-named scores_points_check);
-- the new one is table-level because it references both `mode` and `points`.

alter table public.scores
  drop constraint if exists scores_points_check;
alter table public.scores
  drop constraint if exists scores_points_per_mode_check;

alter table public.scores
  add constraint scores_points_per_mode_check
  check (
    points >= 0 and
    case mode
      when 'speedrun-simple'  then points <= 1500
      when 'speedrun-easy'    then points <= 2000
      when 'speedrun-medium'  then points <= 3000
      when 'speedrun-hard'    then points <= 4000
      when 'speedrun-extreme' then points <= 5500
      else points <= 3500
    end
  );

-- Verify: any existing rows above their tier's cap will block the ALTER.
-- If that happens (shouldn't with our scoring), the cleanest fix is to
-- delete those rows manually before re-running:
--   delete from public.scores where points > 5500;
