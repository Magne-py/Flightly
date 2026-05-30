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

  // Bayesian posterior. Returns an object with the displayed rate, the
  // tier label (Simple..Extreme), and a confidence flag the UI can use
  // to decorate low-N puzzles.
  function computeRate(start, dest, priorP) {
    const s = getStats(start, dest);
    const p = (typeof priorP === "number") ? priorP : 0.5;
    const numer = PRIOR_N * p + s.successes;
    const denom = PRIOR_N + s.attempts;
    const rate = denom > 0 ? numer / denom : p;
    let tier;
    if (rate >= 0.80)      tier = "Simple";
    else if (rate >= 0.60) tier = "Easy";
    else if (rate >= 0.40) tier = "Medium";
    else if (rate >= 0.20) tier = "Hard";
    else                   tier = "Extreme";
    return {
      rate,
      percent: Math.round(rate * 100),
      tier,
      attempts: s.attempts,
      successes: s.successes,
      lowConfidence: s.attempts < LOW_CONFIDENCE_N,
    };
  }

  // ----- Bulk fetch -----
  async function loadAllStats() {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      if (!window.JetSetsAuth || !window.JetSetsAuth.client) {
        // Auth module not ready yet — wait and retry once.
        await new Promise((r) => setTimeout(r, 250));
        if (!window.JetSetsAuth || !window.JetSetsAuth.client) return;
      }
      const supabase = window.JetSetsAuth.client;
      // 880 puzzle pool maxes out around 880 rows × ~40 bytes ≈ 35 KB.
      // Supabase caps SELECT at 1000 rows by default; we add an explicit
      // range to be safe in case the pool grows past that later.
      const { data, error } = await supabase
        .from("puzzle_stats")
        .select("puzzle_key, attempts, successes")
        .range(0, 1999);
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
      // Tell the rest of the app the cache is ready so any already-mounted
      // puzzle headers can repaint.
      window.dispatchEvent(new CustomEvent("jetsets-stats-ready"));
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
    window.dispatchEvent(new CustomEvent("jetsets-stats-updated", {
      detail: { puzzleKey: k },
    }));

    if (!window.JetSetsAuth || !window.JetSetsAuth.client) return;
    const supabase = window.JetSetsAuth.client;
    const userId = (window.JetSetsAuth.currentUser && window.JetSetsAuth.currentUser()) || null;
    try {
      const { error } = await supabase
        .from("puzzle_attempts")
        .insert({
          browser_id: browserId,
          user_id: userId ? userId.id : null,
          puzzle_key: k,
          success: !!success,
        });
      if (error) {
        // 23505 = unique_violation — they already voted from this
        // browser. The server stays authoritative; revert the local
        // optimistic bump so we don't double-count.
        if (error.code === "23505") {
          statsByKey[k] = cur;
          window.dispatchEvent(new CustomEvent("jetsets-stats-updated", {
            detail: { puzzleKey: k },
          }));
          return;
        }
        console.warn("[stats] submit failed:", error.message);
      }
    } catch (err) {
      console.warn("[stats] submit threw:", err);
    }
  }

  // Kick the bulk-fetch as soon as we load. Don't block on it — pages
  // can render with the baked prior_p alone, then upgrade once stats
  // arrive.
  loadAllStats();
  // Also retry when auth becomes available, in case stats.js ran first.
  window.addEventListener("jetsets-auth-changed", () => {
    if (!bootPromise) loadAllStats();
  });

  // Public API.
  window.JetSetsStats = {
    browserId,
    getStats,
    computeRate,
    submitAttempt,
    PRIOR_N,
    LOW_CONFIDENCE_N,
  };
})();
