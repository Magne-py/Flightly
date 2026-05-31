/* JetSets — dynamic difficulty client.
 *
 * Owns three responsibilities:
 *   1. A long-lived browser identifier (UUID in localStorage) so anonymous
 *      visitors can contribute one vote per puzzle.
 *   2. A local cache of puzzle_stats fetched in bulk from Supabase on load.
 *      Every renderDifficulty() call reads from this cache rather than
 *      round-tripping to the network per puzzle.
 *   3. Submitting one attempt per (browser, puzzle) when a round ends.
 *      Optimistically updates the local cache so the displayed rate
 *      reflects the player's own vote immediately.
 *
 * The Bayesian posterior is:
 *     rate = (PRIOR_N × prior_p + successes) / (PRIOR_N + attempts)
 * with PRIOR_N=20 (tuned per user spec). A puzzle starts at its baked
 * prior_p and converges to its true rate as real attempts accumulate.
 */
(function () {
  "use strict";

  // Beta-Bernoulli weight on the prior. 20 ≈ "needs ~20 real attempts
  // before player behaviour fully overtakes the heuristic seed."
  const PRIOR_N = 20;
  // Below this many real attempts we tag the rate as "estimated" in
  // the UI so the player knows the number is still squishy.
  const LOW_CONFIDENCE_N = 20;
  // Tier-boundary percentiles. The 5 difficulty tiers are anchored to
  // points along the LIVE distribution of completion rates across all
  // puzzles, so the boundaries shift as the empirical distribution
  // becomes known. The split is NOT uniform — we lean on the extremes:
  // only the bottom 5% of puzzles get "Extreme" and only the top 15%
  // get "Simple," so those labels carry real weight. Easy/Medium/Hard
  // absorb the larger middle. Order: p_extreme, p_hard, p_medium, p_easy
  // (low → high — same indices as tierThresholds[]).
  //   Extreme : bottom 5%
  //   Hard    : next 20%   (5–25%)
  //   Medium  : next 25%   (25–50%)
  //   Easy    : next 35%   (50–85%)
  //   Simple  : top 15%    (85–100%)
  const TIER_PERCENTILES = [0.05, 0.25, 0.50, 0.85];
  // Below this many puzzles in the distribution we fall back to the
  // static 20/40/60/80 boundaries — quintiles of < ~50 puzzles are too
  // noisy to label reliably.
  const MIN_PUZZLES_FOR_DYNAMIC_THRESHOLDS = 50;

  // ----- Browser identity -----
  const BROWSER_ID_KEY = "jetsets:browser-id";
  function ensureBrowserId() {
    try {
      let id = localStorage.getItem(BROWSER_ID_KEY);
      if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
      id = uuidv4();
      localStorage.setItem(BROWSER_ID_KEY, id);
      return id;
    } catch (_) {
      // localStorage unavailable (private browsing, very old browser).
      // Fall back to a per-tab id so attempts at least submit; uniqueness
      // is then per-tab rather than per-browser.
      if (!window.__jetsetsTabId) window.__jetsetsTabId = uuidv4();
      return window.__jetsetsTabId;
    }
  }
  function uuidv4() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older browsers without crypto.randomUUID.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  const browserId = ensureBrowserId();

  // ----- Stats cache -----
  // statsByKey[puzzleKey] = { attempts: int, successes: int }
  const statsByKey = Object.create(null);
  // Promise that resolves once the bulk-fetch on page-load is done.
  // Subscribers can await it to make sure the cache is hydrated before
  // they read.
  let bootPromise = null;
  // Has the local cache also been seeded with a vote from this browser
  // for a given puzzle? Tracks the unique-constraint we expect server-side
  // so we don't double-count optimistically.
  const submittedKeys = new Set();

  function puzzleKey(start, dest) {
    return `${start}-${dest}`;
  }

  function getStats(start, dest) {
    const k = puzzleKey(start, dest);
    return statsByKey[k] || { attempts: 0, successes: 0 };
  }

  // Live thresholds — pre-seeded with completion-rate equivalents of the
  // TIER_PERCENTILES interpreted as direct rate cuts, so a fresh page
  // with no stats still labels tiers sensibly until recomputeThresholds()
  // overwrites them from the empirical distribution. Order matches
  // TIER_PERCENTILES: [extreme/hard, hard/medium, medium/easy, easy/simple].
  let tierThresholds = [0.05, 0.25, 0.50, 0.85];

  // Raw posterior rate for a puzzle. Used both by computeRate() and by
  // recomputeThresholds() — split out so the threshold pass doesn't pay
  // the cost of building the full result object.
  function posteriorRate(start, dest, priorP) {
    const s = getStats(start, dest);
    const p = (typeof priorP === "number") ? priorP : 0.5;
    const denom = PRIOR_N + s.attempts;
    return denom > 0 ? (PRIOR_N * p + s.successes) / denom : p;
  }

  function rateToTier(rate) {
    if (rate >= tierThresholds[3]) return "Simple";
    if (rate >= tierThresholds[2]) return "Easy";
    if (rate >= tierThresholds[1]) return "Medium";
    if (rate >= tierThresholds[0]) return "Hard";
    return "Extreme";
  }

  // Recompute the four boundary rates as quintiles of the current
  // distribution of posterior rates across every puzzle in the pool
  // (global + continent). Called after the bulk fetch lands and again
  // after a player submits a fresh attempt, so the labels stay in sync
  // with the data.
  //
  // Falls back to the static 20/40/60/80 boundaries if the puzzle pool
  // hasn't been loaded yet or is suspiciously small — quintiles of a
  // tiny sample don't carry useful signal.
  function recomputeThresholds() {
    const pools = [];
    if (window.PUZZLES && Array.isArray(window.PUZZLES)) pools.push(window.PUZZLES);
    if (window.CONTINENT_PUZZLES) {
      for (const k of Object.keys(window.CONTINENT_PUZZLES)) {
        const arr = window.CONTINENT_PUZZLES[k];
        if (Array.isArray(arr)) pools.push(arr);
      }
    }
    const rates = [];
    for (const pool of pools) {
      for (const p of pool) {
        if (!p || typeof p.prior_p !== "number") continue;
        rates.push(posteriorRate(p.start, p.dest, p.prior_p));
      }
    }
    if (rates.length < MIN_PUZZLES_FOR_DYNAMIC_THRESHOLDS) {
      // Fall back to the seed values that match TIER_PERCENTILES.
      tierThresholds = [0.05, 0.25, 0.50, 0.85];
      return;
    }
    rates.sort((a, b) => a - b);
    // Cluster-aware percentile. The puzzle pool's posterior rates can
    // pile up at a handful of discrete values (early on, every rate IS
    // its prior_p, so there are only 5 distinct rates total). A naive
    // percentile lands AT one of those cluster values; the `rate >=
    // threshold` check then folds the entire cluster into the UPPER
    // tier, leaving the LOWER tier empty.
    //
    // Fix: for each percentile cutpoint, find the cluster the position
    // lands in, then put the threshold at the MIDPOINT between this
    // cluster's value and the next distinct rate. That way the cluster
    // falls into the lower tier and the next one into the upper tier
    // — which is what "5% threshold" naturally means.
    //
    // Once player attempts spread the posterior rates across many
    // distinct values, the "next distinct rate" sits just above the
    // percentile rate and this becomes a no-op refinement.
    const at = (q) => {
      const idx = Math.max(0, Math.min(rates.length - 1, Math.floor(rates.length * q)));
      const cur = rates[idx];
      // Walk forward until we find a rate strictly greater than cur
      // (i.e. the start of the next cluster).
      let nextIdx = idx + 1;
      while (nextIdx < rates.length && rates[nextIdx] === cur) nextIdx++;
      if (nextIdx >= rates.length) {
        // Cluster extends to the end of the distribution — no next
        // cluster to bound against. Pull the threshold just below the
        // cluster value so members are still classified into the
        // upper tier (Simple, for the top threshold).
        return Math.max(0, cur - 0.0001);
      }
      return (cur + rates[nextIdx]) / 2;
    };
    tierThresholds = TIER_PERCENTILES.map(at);
    window.dispatchEvent(new CustomEvent("jetsets-tiers-updated", {
      detail: { thresholds: tierThresholds.slice() },
    }));
  }

  // Bayesian posterior. Returns an object with the displayed rate, the
  // tier label (Simple..Extreme), and a confidence flag the UI can use
  // to decorate low-N puzzles.
  function computeRate(start, dest, priorP) {
    const rate = posteriorRate(start, dest, priorP);
    const s = getStats(start, dest);
    return {
      rate,
      percent: Math.round(rate * 100),
      tier: rateToTier(rate),
      attempts: s.attempts,
      successes: s.successes,
      lowConfidence: s.attempts < LOW_CONFIDENCE_N,
    };
  }

  // ----- Bulk fetch -----
  // `bootDone` separates "in-flight" from "completed" so the auth-ready
  // listener below can re-try the fetch if the first attempt bailed
  // because auth hadn't initialised yet.
  let bootDone = false;
  let bootInFlight = false;
  async function loadAllStats() {
    if (bootDone || bootInFlight) return;
    if (!window.JetSetsAuth || !window.JetSetsAuth.client) {
      // Auth module isn't ready. Don't mark bootDone — we'll be
      // re-invoked by the `jetsets-auth-ready` listener below as soon
      // as auth.js finishes its init.
      return;
    }
    bootInFlight = true;
    bootPromise = (async () => {
      try {
        const supabase = window.JetSetsAuth.client;
        const withTimeout = window.JetSetsAuth.withTimeout || ((p) => p);
        // 880 puzzle pool maxes out around 880 rows × ~40 bytes ≈ 35 KB.
        // Supabase caps SELECT at 1000 rows by default; we add an explicit
        // range to be safe in case the pool grows past that later.
        // 15s timeout — bulk fetches over slow networks or a cold-cache
        // backend can be slow, but anything longer is a real problem.
        const { data, error } = await withTimeout(
          supabase
            .from("puzzle_stats")
            .select("puzzle_key, attempts, successes")
            .range(0, 1999),
          15000, "Loading puzzle stats"
        );
        if (error) {
          console.warn("[stats] bulk fetch failed:", error.message);
          return;
        }
        for (const row of data || []) {
          statsByKey[row.puzzle_key] = {
            attempts: row.attempts || 0,
            successes: row.successes || 0,
          };
        }
        bootDone = true;
        // Now that the cache is full, we have enough signal to recompute
        // tier boundaries from the live distribution rather than the
        // fallback static 20/40/60/80 split.
        recomputeThresholds();
        // Tell the rest of the app the cache is ready so any already-mounted
        // puzzle headers can repaint.
        window.dispatchEvent(new CustomEvent("jetsets-stats-ready"));
      } finally {
        bootInFlight = false;
      }
    })();
    return bootPromise;
  }

  // ----- Submit one attempt -----
  // Idempotent per (browserId, puzzleKey). Optimistically updates the
  // local cache so renderDifficulty repaints with the player's own vote
  // before the round-trip finishes. The server has the actual unique
  // constraint; a unique-violation just means "already voted" and we
  // swallow it silently.
  async function submitAttempt(start, dest, success) {
    const k = puzzleKey(start, dest);
    if (submittedKeys.has(k)) return; // optimistic local dedupe
    submittedKeys.add(k);
    // Optimistic cache update.
    const cur = statsByKey[k] || { attempts: 0, successes: 0 };
    statsByKey[k] = {
      attempts: cur.attempts + 1,
      successes: cur.successes + (success ? 1 : 0),
    };
    // A single new attempt won't shift quintiles meaningfully, but a
    // burst of solves during a speedrun can. Recompute cheaply (one
    // pass over the puzzle pool) so the tier label of the *next*
    // puzzle reflects the freshly-updated distribution.
    recomputeThresholds();
    window.dispatchEvent(new CustomEvent("jetsets-stats-updated", {
      detail: { puzzleKey: k },
    }));

    if (!window.JetSetsAuth || !window.JetSetsAuth.client) return;
    const supabase = window.JetSetsAuth.client;
    const withTimeout = window.JetSetsAuth.withTimeout || ((p) => p);
    const userId = (window.JetSetsAuth.currentUser && window.JetSetsAuth.currentUser()) || null;
    try {
      const { error } = await withTimeout(
        supabase
          .from("puzzle_attempts")
          .insert({
            browser_id: browserId,
            user_id: userId ? userId.id : null,
            puzzle_key: k,
            success: !!success,
          }),
        8000, "Recording puzzle attempt"
      );
      if (error) {
        // 23505 = unique_violation — they already voted from this
        // browser. The server stays authoritative; revert the local
        // optimistic bump so we don't double-count.
        if (error.code === "23505") {
          statsByKey[k] = cur;
          recomputeThresholds();
          window.dispatchEvent(new CustomEvent("jetsets-stats-updated", {
            detail: { puzzleKey: k },
          }));
          return;
        }
        console.warn("[stats] submit failed:", error.message);
      }
    } catch (err) {
      // Most likely a withTimeout rejection. Revert the optimistic
      // local bump so the cached stats don't drift from the server.
      if (err && err.code === "timeout") {
        statsByKey[k] = cur;
        submittedKeys.delete(k);
        recomputeThresholds();
        window.dispatchEvent(new CustomEvent("jetsets-stats-updated", {
          detail: { puzzleKey: k },
        }));
      }
      console.warn("[stats] submit threw:", err);
    }
  }

  // Kick the bulk-fetch as soon as we load. The first attempt only
  // succeeds if auth.js happens to have initialised first; otherwise
  // we wait for auth.js to dispatch `jetsets-auth-ready` and try again.
  loadAllStats();
  window.addEventListener("jetsets-auth-ready",  () => loadAllStats());
  window.addEventListener("jetsets-auth-changed", () => loadAllStats());

  // Public API.
  window.JetSetsStats = {
    browserId,
    getStats,
    computeRate,
    submitAttempt,
    // Inspectors — useful from DevTools to see what the engine is doing.
    // thresholds() returns the four boundary rates [p20, p40, p60, p80];
    // a value of 0.43 in slot 1 means "Hard ↔ Medium boundary is 43%."
    thresholds: () => tierThresholds.slice(),
    recomputeThresholds,
    PRIOR_N,
    LOW_CONFIDENCE_N,
    TIER_PERCENTILES,
  };
})();
