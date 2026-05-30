/* JetSets — game logic
 * Globals available from data/*.js:
 *   AIRPORTS:           {iata: {name, city, country, continent, lat, lon, tier}}
 *   ROUTES:             {iata: [iata, ...]}  adjacency list, bidirectional
 *   PUZZLES:            [{start, dest, shortest_hops}]   (full-graph pool)
 *   CONTINENT_ROUTES:   {continent: {iata: [iata, ...]}} (intra-continent only)
 *   CONTINENT_PUZZLES:  {continent: [puzzle, ...]}       (start, dest, intermediates all in continent)
 */

(function () {
  "use strict";

  // ---------- Config ----------
  const MAX_ATTEMPTS = 6;
  const SLOTS = 5; // intermediate airport slots per attempt
  // Speedrun: one continuous countdown across all puzzles in a run.
  const SPEEDRUN_DURATION_MS = 90 * 1000;

  // ---------- State ----------
  // Mode names: 'daily', 'random', 'simple'..'extreme', a continent slug
  // ('africa', 'europe', 'north-america', 'south-america', 'asia', 'oceania'),
  // or a layover slug ('layover-1'..'layover-4').
  let mode = "daily";
  let puzzle = null; // {start, dest, shortest_hops, stars, id}

  // ACTIVE_ROUTES is the adjacency the game grades and pathfinds against. In
  // continent modes it's swapped for an intra-continent subgraph so a route
  // through, say, JFK in a "Routes within Europe" puzzle is correctly red.
  let ACTIVE_ROUTES = window.ROUTES;
  // The set of airport codes that may legally appear in the current grid.
  // Continent modes restrict this to airports in that continent.
  let activeCodes = new Set(Object.keys(window.AIRPORTS));

  // Mode → star tier (1..5). null means "any tier" / not a difficulty mode.
  const MODE_STARS = {
    daily: null,
    random: null,
    simple: 1,
    easy: 2,
    medium: 3,
    hard: 4,
    extreme: 5,
  };
  // Slug → continent name as it appears in the data.
  const MODE_CONTINENT = {
    "africa":         "Africa",
    "europe":         "Europe",
    "north-america":  "North America",
    "south-america":  "South America",
    "asia":           "Asia",
    "oceania":        "Oceania",
  };
  // Slug → required layover count (= shortest_hops - 1, since hops is the
  // edge count and layovers are the intermediate airports between start
  // and dest). null means "any" / not a layover-pinned mode.
  const MODE_LAYOVERS = {
    "layover-1": 1,
    "layover-2": 2,
    "layover-3": 3,
    "layover-4": 4,
  };
  // Speedrun config — each entry describes one variant of the 90-second
  // run. `variant` selects the puzzle picker; `continent` (when present)
  // names the intra-continent subgraph to swap into.
  const MODE_SPEEDRUN = {
    "speedrun-global":         { variant: "global",    label: "Speedrun · Global" },
    "speedrun-simple":         { variant: "difficulty", label: "Speedrun · Simple",   stars: 1 },
    "speedrun-easy":           { variant: "difficulty", label: "Speedrun · Easy",     stars: 2 },
    "speedrun-medium":         { variant: "difficulty", label: "Speedrun · Medium",   stars: 3 },
    "speedrun-hard":           { variant: "difficulty", label: "Speedrun · Hard",     stars: 4 },
    "speedrun-extreme":        { variant: "difficulty", label: "Speedrun · Extreme",  stars: 5 },
    "speedrun-africa":         { variant: "continent", label: "Speedrun · Africa",         continent: "Africa" },
    "speedrun-europe":         { variant: "continent", label: "Speedrun · Europe",         continent: "Europe" },
    "speedrun-north-america":  { variant: "continent", label: "Speedrun · North America",  continent: "North America" },
    "speedrun-south-america":  { variant: "continent", label: "Speedrun · South America",  continent: "South America" },
    "speedrun-asia":           { variant: "continent", label: "Speedrun · Asia",           continent: "Asia" },
    "speedrun-oceania":        { variant: "continent", label: "Speedrun · Oceania",        continent: "Oceania" },
    "speedrun-cryptic":        { variant: "cryptic",   label: "Speedrun · Cryptic" },
  };
  const MODE_LABELS = {
    daily: "Daily",
    random: "Random",
    simple: "Simple",
    easy: "Easy",
    medium: "Medium",
    hard: "Hard",
    extreme: "Extreme",
    "africa":         "Africa",
    "europe":         "Europe",
    "north-america":  "North America",
    "south-america":  "South America",
    "asia":           "Asia",
    "oceania":        "Oceania",
    "layover-1":      "1 layover",
    "layover-2":      "2 layovers",
    "layover-3":      "3 layovers",
    "layover-4":      "4 layovers",
    cryptic: "Cryptic",
    "speedrun-global":         "Speedrun · Global",
    "speedrun-simple":         "Speedrun · Simple",
    "speedrun-easy":           "Speedrun · Easy",
    "speedrun-medium":         "Speedrun · Medium",
    "speedrun-hard":           "Speedrun · Hard",
    "speedrun-extreme":        "Speedrun · Extreme",
    "speedrun-africa":         "Speedrun · Africa",
    "speedrun-europe":         "Speedrun · Europe",
    "speedrun-north-america":  "Speedrun · North America",
    "speedrun-south-america":  "Speedrun · South America",
    "speedrun-asia":           "Speedrun · Asia",
    "speedrun-oceania":        "Speedrun · Oceania",
    "speedrun-cryptic":        "Speedrun · Cryptic",
  };
  let attempts = []; // [[{code, color}, ...], ...]
  let currentRow = []; // draft row of airport codes
  let finished = false;
  let won = false;
  // Last solution route drawn on the globe — cached so we can re-apply it
  // after the user visits the Learn page (which temporarily takes over the
  // globe with hub arcs) and returns to the game view.
  let lastSolutionRoute = null;
  // Cached BFS distance map from destination: { iata: minHopsToDest }
  let distToDest = null;
  // Set of airports on at least one shortest start→dest path
  let shortestPathAirports = null;
  // Per-slot sets: airport must appear at slot index i on at least one shortest path
  let shortestPathBySlot = null;
  // Minimum total kilometres flown across all shortest-hop paths for the
  // current puzzle. Used to detect the "best route" purple win tier.
  let optimalKm = null;

  // ---------- Speedrun state ----------
  // A speedrun is a 90-second timed run of consecutive puzzles. Solving a
  // puzzle banks its score and auto-advances to the next; failing one (out
  // of attempts or give-up) ends the run, as does the timer reaching 0.
  // The run is armed when the player picks a speedrun mode (the first
  // puzzle is loaded and the Start button is shown), but the countdown
  // doesn't begin until the player clicks Start — this gives them a moment
  // to read the start/destination before the clock starts ticking.
  let speedrunActive = false;     // a speedrun mode is selected
  let speedrunStarted = false;    // the player has clicked Start
  let speedrunModeKey = null;     // current speedrun mode slug
  let speedrunStartTime = 0;      // ms timestamp when the run began
  let speedrunDeadline = 0;       // ms timestamp when the run will end
  let speedrunScore = 0;          // running point total
  let speedrunSolves = 0;         // running solved-puzzle count
  let speedrunHistory = [];       // [{start, dest, path, attemptsUsed, points}]
  let speedrunTimerInterval = null;
  // Leaderboard submission state for the just-ended run. Captured at end
  // of run so we can retry the submit if the user signs in while the
  // summary panel is still visible.
  let speedrunPendingSubmit = null; // {mode, points, solves} or null
  let speedrunSubmitted = false;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  const input = $("airport-input");
  const addBtn = $("add-btn");
  const undoBtn = $("undo-btn");
  const submitBtn = $("submit-btn");
  const giveUpBtn = $("give-up-btn");
  const suggestions = $("suggestions");
  const statusBar = $("status-bar");
  const resultPanel = $("result-panel");
  const resultHeading = $("result-heading");
  const resultStats = $("result-stats");
  const shareBtn = $("share-btn");
  const newPuzzleBtn = $("new-puzzle-btn");
  const modalCloseBtn = $("modal-close");
  const showResultBtn = $("show-result-btn");
  const leftCol = document.querySelector(".left-col");
  const inputRow = document.querySelector(".input-row");
  const modeButtons = {
    daily:           $("mode-daily"),
    random:          $("mode-random"),
    simple:          $("mode-simple"),
    easy:            $("mode-easy"),
    medium:          $("mode-medium"),
    hard:            $("mode-hard"),
    extreme:         $("mode-extreme"),
    "africa":        $("mode-africa"),
    "europe":        $("mode-europe"),
    "north-america": $("mode-north-america"),
    "south-america": $("mode-south-america"),
    "asia":          $("mode-asia"),
    "oceania":       $("mode-oceania"),
    "layover-1":     $("mode-layover-1"),
    "layover-2":     $("mode-layover-2"),
    "layover-3":     $("mode-layover-3"),
    "layover-4":     $("mode-layover-4"),
    cryptic:         $("mode-cryptic"),
    "speedrun-global":        $("mode-speedrun-global"),
    "speedrun-simple":        $("mode-speedrun-simple"),
    "speedrun-easy":          $("mode-speedrun-easy"),
    "speedrun-medium":        $("mode-speedrun-medium"),
    "speedrun-hard":          $("mode-speedrun-hard"),
    "speedrun-extreme":       $("mode-speedrun-extreme"),
    "speedrun-africa":        $("mode-speedrun-africa"),
    "speedrun-europe":        $("mode-speedrun-europe"),
    "speedrun-north-america": $("mode-speedrun-north-america"),
    "speedrun-south-america": $("mode-speedrun-south-america"),
    "speedrun-asia":          $("mode-speedrun-asia"),
    "speedrun-oceania":       $("mode-speedrun-oceania"),
    "speedrun-cryptic":       $("mode-speedrun-cryptic"),
  };
  const difficultyEl = $("puzzle-difficulty");
  const toast = $("toast");
  // Speedrun HUD bits (corners that flank the puzzle-header).
  const speedrunCornerLeft  = $("speedrun-corner-left");
  const speedrunCornerRight = $("speedrun-corner-right");
  const speedrunStartBtn    = $("speedrun-start-btn");
  const speedrunTimeBlock   = $("speedrun-time-block");
  const speedrunTimeEl      = $("speedrun-time");
  const speedrunScoreEl     = $("speedrun-score");
  const speedrunSolvedEl    = $("speedrun-solved");
  const speedrunQuitBtn     = $("speedrun-quit");

  // ---------- Utils ----------
  function toast_show(msg, ms) {
    toast.textContent = msg;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), ms || 1800);
  }

  function dateSeed() {
    // YYYY-MM-DD → deterministic integer
    const d = new Date();
    const s = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    return s;
  }

  // Pre-bucket puzzles by their star rating so mode-pick is O(1).
  // Falls back gracefully if older puzzles.json without `stars` is loaded.
  const PUZZLES_BY_STARS = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  // Pre-bucket puzzles by layover count. Layovers = shortest_hops - 1 (hops
  // counts edges; layovers count the intermediate airports). Build pool data
  // is bounded to 2..5 hops, so the layover keys 1..4 cover everything.
  const PUZZLES_BY_LAYOVERS = { 1: [], 2: [], 3: [], 4: [] };
  // Joint bucket: PUZZLES_BY_STARS_AND_LAYOVERS[stars][layovers] = [idx,...]
  // Used by the weighted picker for Daily / Random / Speedrun (see below).
  const PUZZLES_BY_STARS_AND_LAYOVERS = {};
  for (let s = 1; s <= 5; s++) {
    PUZZLES_BY_STARS_AND_LAYOVERS[s] = { 1: [], 2: [], 3: [], 4: [] };
  }
  for (let i = 0; i < PUZZLES.length; i++) {
    const p = PUZZLES[i];
    const s = p.stars;
    const lay = (p.shortest_hops || 0) - 1;
    if (s >= 1 && s <= 5) {
      PUZZLES_BY_STARS[s].push(i);
    }
    if (lay >= 1 && lay <= 4) {
      PUZZLES_BY_LAYOVERS[lay].push(i);
    }
    if (s >= 1 && s <= 5 && lay >= 1 && lay <= 4) {
      PUZZLES_BY_STARS_AND_LAYOVERS[s][lay].push(i);
    }
  }

  // ---------- Weighted puzzle distribution ----------
  // Daily / Random / global-pool Speedrun pick puzzles from a JOINT
  // distribution over (layover-count, star-tier). The marginals are:
  //   Layovers (1,2,3,4):   15% / 30% / 30% / 25%
  //   Stars   (1,2,3,4,5):  30% / 30% / 25% / 10% /  5%
  // Each pick samples both axes independently, then looks up the joint
  // bucket. Empty buckets fall back loosely (layover-only → stars-only →
  // global pool) so picks always succeed even if the puzzle pool doesn't
  // densely cover every (stars × layovers) cell.
  const LAYOVER_WEIGHTS          = [0.15, 0.30, 0.30, 0.25];   // → 1..4 layovers (Daily / Random)
  const SPEEDRUN_LAYOVER_WEIGHTS = [0.30, 0.30, 0.30, 0.10];   // → 1..4 layovers (Speedrun: short-route bias)
  const STAR_WEIGHTS             = [0.30, 0.30, 0.25, 0.10, 0.05]; // → 1..5 stars (all modes)

  // Sample an index in [0, weights.length) given uniform u in [0, 1).
  function pickWeighted(weights, u) {
    let cum = 0;
    for (let i = 0; i < weights.length; i++) {
      cum += weights[i];
      if (u < cum) return i;
    }
    return weights.length - 1;
  }

  // Pick a puzzle index using the joint distribution. `rng` returns
  // uniform [0, 1) floats — pass `Math.random` for live picks, or a
  // seeded RNG for a deterministic Daily. `layWeights` lets a caller
  // (currently Speedrun) swap in its own layover distribution while
  // keeping the same star weights.
  function weightedPuzzleIndex(rng, layWeights) {
    const layW  = layWeights || LAYOVER_WEIGHTS;
    const lay   = pickWeighted(layW,        rng()) + 1;  // 1..4
    const stars = pickWeighted(STAR_WEIGHTS, rng()) + 1; // 1..5
    let bucket = (PUZZLES_BY_STARS_AND_LAYOVERS[stars] || {})[lay] || [];
    if (!bucket.length) bucket = PUZZLES_BY_LAYOVERS[lay] || [];   // relax stars
    if (!bucket.length) bucket = PUZZLES_BY_STARS[stars] || [];    // relax layovers
    if (!bucket.length) {                                          // global fallback
      return Math.floor(rng() * PUZZLES.length);
    }
    return bucket[Math.floor(rng() * bucket.length)];
  }

  // Tiny seeded PRNG (mulberry32) — used for the Daily so the puzzle is
  // stable across reloads on the same UTC date but the (stars × layover)
  // sample still respects the configured weights.
  function seededRng(seed) {
    let state = (seed | 0) || 1;
    return function () {
      state = state + 0x6D2B79F5 | 0;
      let t = state;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function dailyPuzzle() {
    // Deterministic per UTC date, but sampled from the weighted joint
    // distribution rather than uniform-over-PUZZLES.
    const idx = weightedPuzzleIndex(seededRng(dateSeed()));
    return Object.assign(
      { id: "Daily " + new Date().toISOString().slice(0, 10) },
      PUZZLES[idx]
    );
  }

  // Pick a random puzzle from a star tier. If the tier is empty (shouldn't
  // happen with annotated data, but be defensive), fall back to the global pool.
  function randomPuzzleByStars(stars) {
    const pool = PUZZLES_BY_STARS[stars] || [];
    const indices = pool.length ? pool : PUZZLES.map((_, i) => i);
    const idx = indices[Math.floor(Math.random() * indices.length)];
    const label = MODE_LABELS[mode] || "Practice";
    return Object.assign(
      { id: `${label} #${idx + 1}` },
      PUZZLES[idx]
    );
  }

  // Pick a random puzzle from the layover bucket. Falls back to the global
  // pool if the bucket is empty (shouldn't happen with current data).
  function randomPuzzleByLayovers(layovers) {
    const pool = PUZZLES_BY_LAYOVERS[layovers] || [];
    const indices = pool.length ? pool : PUZZLES.map((_, i) => i);
    const idx = indices[Math.floor(Math.random() * indices.length)];
    const label = MODE_LABELS[mode] || `${layovers} layover${layovers === 1 ? "" : "s"}`;
    return Object.assign(
      { id: `${label} #${idx + 1}` },
      PUZZLES[idx]
    );
  }

  // "Random" mode: any puzzle from any difficulty tier in the global pool,
  // sampled via the weighted layover/star distribution.
  function randomPuzzleAnyTier() {
    const idx = weightedPuzzleIndex(Math.random);
    return Object.assign({ id: `Random #${idx + 1}` }, PUZZLES[idx]);
  }

  // Speedrun's own picker — same star weights as Random, but its own
  // layover distribution (more weight on shorter routes so the player
  // can stack solves inside the 90-second window).
  function randomSpeedrunPuzzle() {
    const idx = weightedPuzzleIndex(Math.random, SPEEDRUN_LAYOVER_WEIGHTS);
    return Object.assign({ id: `Random #${idx + 1}` }, PUZZLES[idx]);
  }

  // Difficulty-tier speedrun: every puzzle is locked to the requested
  // star tier, but the layover distribution within that tier still
  // favours shorter routes so the player can rack up solves inside the
  // 90-second window. Falls back to global if the tier somehow empty.
  function randomDifficultySpeedrunPuzzle(stars) {
    const pool = PUZZLES_BY_STARS[stars] || [];
    if (!pool.length) return randomSpeedrunPuzzle();
    // Try a layover-weighted pick FIRST (intersect tier × layover); fall
    // back to a uniform pick within the tier if every weighted slot is
    // empty (e.g. tier 5 with no 1-layover puzzles).
    for (let tries = 0; tries < 6; tries++) {
      const lay = pickWeighted(SPEEDRUN_LAYOVER_WEIGHTS, Math.random()) + 1;
      const bucket = (PUZZLES_BY_STARS_AND_LAYOVERS[stars] || {})[lay] || [];
      if (bucket.length) {
        const idx = bucket[Math.floor(Math.random() * bucket.length)];
        return Object.assign({ id: `${stars}★ #${idx + 1}` }, PUZZLES[idx]);
      }
    }
    const idx = pool[Math.floor(Math.random() * pool.length)];
    return Object.assign({ id: `${stars}★ #${idx + 1}` }, PUZZLES[idx]);
  }

  // Pick a random puzzle from a continent's intra-continent pool. The puzzle
  // is guaranteed to have start, dest, and (in the answer) all intermediates
  // inside the named continent.
  function randomContinentPuzzle(continent) {
    const pool = (window.CONTINENT_PUZZLES && window.CONTINENT_PUZZLES[continent]) || [];
    if (!pool.length) return null;
    const idx = Math.floor(Math.random() * pool.length);
    return Object.assign({ id: `${continent} #${idx + 1}` }, pool[idx]);
  }

  // ---------- Geographic helpers ----------
  // Great-circle distance in kilometres between two lat/lon points.
  // Used to compare candidate shortest-hop routes by total flight distance —
  // the route with the fewest km flown wins the purple "best route" tier.
  const EARTH_KM = 6371;
  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (d) => d * Math.PI / 180;
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const dφ = toRad(lat2 - lat1), dλ = toRad(lon2 - lon1);
    const a = Math.sin(dφ / 2) * Math.sin(dφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) * Math.sin(dλ / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  // Sum great-circle distances along a path of IATA codes.
  function pathKm(route) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const A = AIRPORTS[route[i]], B = AIRPORTS[route[i + 1]];
      if (!A || !B) return Infinity;
      total += haversineKm(A.lat, A.lon, B.lat, B.lon);
    }
    return total;
  }

  // BFS from a single source. Returns a distance map {iata: hops}.
  // Walks ACTIVE_ROUTES so continent modes correctly ignore intercontinental
  // hops.
  function bfsDistances(source) {
    const dist = { [source]: 0 };
    const q = [source];
    let head = 0;
    while (head < q.length) {
      const n = q[head++];
      const d = dist[n];
      const nbs = ACTIVE_ROUTES[n] || [];
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        if (dist[nb] === undefined) {
          dist[nb] = d + 1;
          q.push(nb);
        }
      }
    }
    return dist;
  }

  // Compute the set of airports that appear on at least one shortest path
  // from `start` to `dest` — and, per slot (0..k-1), the airports valid at
  // that exact slot across all shortest paths.
  function analyseShortestPaths(start, dest) {
    const distFromStart = bfsDistances(start);
    const distFromDest = bfsDistances(dest);
    const total = distFromStart[dest];
    const onPath = new Set();
    for (const iata of Object.keys(distFromStart)) {
      if (distFromDest[iata] !== undefined &&
          distFromStart[iata] + distFromDest[iata] === total) {
        onPath.add(iata);
      }
    }
    // For our game: shortest_hops = number of edges. Intermediate slots = hops - 1.
    // Slot 0 holds the airport at distance 1 from start on a shortest path.
    const slots = [];
    const numIntermediateSlots = Math.max(0, total - 1);
    for (let k = 1; k <= numIntermediateSlots; k++) {
      const setAtK = new Set();
      for (const iata of onPath) {
        if (distFromStart[iata] === k) setAtK.add(iata);
      }
      slots.push(setAtK);
    }
    // Min-km DP over the shortest-paths DAG. Walk nodes in BFS-distance
    // order so each node's predecessors are already resolved when we
    // compute its own minKm. Predecessors of a node N at distance d are
    // any neighbour P with distFromStart[P] === d-1 AND on a shortest path.
    const minKmTo = { [start]: 0 };
    if (total !== undefined) {
      const onPathByDist = [];
      for (const iata of onPath) {
        const d = distFromStart[iata];
        if (!onPathByDist[d]) onPathByDist[d] = [];
        onPathByDist[d].push(iata);
      }
      for (let d = 1; d <= total; d++) {
        const layer = onPathByDist[d] || [];
        for (const node of layer) {
          let best = Infinity;
          const nbs = ACTIVE_ROUTES[node] || [];
          for (let i = 0; i < nbs.length; i++) {
            const p = nbs[i];
            if (distFromStart[p] === d - 1 && onPath.has(p) && minKmTo[p] !== undefined) {
              const A = AIRPORTS[p], B = AIRPORTS[node];
              if (!A || !B) continue;
              const km = haversineKm(A.lat, A.lon, B.lat, B.lon);
              const cand = minKmTo[p] + km;
              if (cand < best) best = cand;
            }
          }
          if (best < Infinity) minKmTo[node] = best;
        }
      }
    }
    const optimalKm = minKmTo[dest];
    return { onPath, slots, total, distFromDest, optimalKm };
  }

  // ---------- Autocomplete ----------
  const ALL_CODES = Object.keys(AIRPORTS);
  let suggestIndex = -1;

  function normalise(s) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function suggest(q) {
    const nq = normalise(q);
    if (!nq) return [];
    const matches = [];
    // Cryptic restricts the search itself to IATA codes — no city / name
    // hits, so a player can't sneak in by typing "tokyo".
    const cryptic = mode === "cryptic";
    for (const code of ALL_CODES) {
      // In continent modes, hide airports that aren't in the active subgraph
      // — they'd be unflyable anyway and clutter the dropdown.
      if (!activeCodes.has(code)) continue;
      const a = AIRPORTS[code];
      const nCode = code.toLowerCase();
      let score = -1;
      if (cryptic) {
        if (nCode === nq) score = 0;
        else if (nCode.startsWith(nq)) score = 1;
      } else {
        const nCity = normalise(a.city);
        const nName = normalise(a.name);
        if (nCode === nq) score = 0;
        else if (nCode.startsWith(nq)) score = 1;
        else if (nCity.startsWith(nq)) score = 2;
        else if (nName.startsWith(nq)) score = 3;
        else if (nCity.includes(nq)) score = 4;
        else if (nName.includes(nq)) score = 5;
      }
      if (score >= 0) matches.push({ code, score });
    }
    matches.sort((a, b) => a.score - b.score || a.code.localeCompare(b.code));
    return matches.slice(0, 8).map((m) => m.code);
  }

  function renderSuggestions(list) {
    if (!list.length) { suggestions.classList.remove("active"); suggestions.innerHTML = ""; return; }
    suggestions.innerHTML = list.map((code, i) => {
      const a = AIRPORTS[code];
      // Show the airport's long-form name (e.g. "John F Kennedy International
      // Airport") rather than the city — it's more identifying. Class stays
      // .s-city so the cryptic-mode hide rule still catches it.
      return `<div class="suggestion${i === suggestIndex ? " highlighted" : ""}" data-code="${code}">
                <span><span class="s-code">${code}</span><span class="s-city">${a.name}</span></span>
                <span class="s-country">${a.country}</span>
              </div>`;
    }).join("");
    suggestions.classList.add("active");
  }

  function closeSuggestions() {
    suggestions.classList.remove("active");
    suggestIndex = -1;
  }

  // ---------- Grid rendering ----------
  function renderGrid() {
    grid.innerHTML = "";
    for (let r = 0; r < MAX_ATTEMPTS; r++) {
      const row = document.createElement("div");
      const isDone = r < attempts.length;
      const isActive = r === attempts.length && !finished;
      row.className = "row" + (isActive ? " active" : "") + (isDone ? " done" : "");
      for (let c = 0; c < SLOTS; c++) {
        const cell = document.createElement("div");
        let code = "", color = "";
        if (isDone) {
          const data = attempts[r][c];
          if (data && data.code) { code = data.code; color = data.color; }
        } else if (isActive) {
          code = currentRow[c] || "";
        }
        cell.className = "cell" + (color ? " " + color : (code ? "" : " empty"));
        if (code) {
          const a = AIRPORTS[code];
          cell.innerHTML = `<div class="code">${code}</div><div class="city">${a ? a.city : ""}</div>`;
        } else {
          cell.innerHTML = `<div class="code">&middot;</div>`;
        }
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  // ---------- Grading ----------
  // Per-slot color rules (independent of any other slot's leg validity):
  //   green  — the player's airport at slot k matches the BEST-MATCHING
  //            shortest path at position k+1. "Best-matching" = the single
  //            shortest path from start to dest that aligns with the largest
  //            number of the player's filled slots simultaneously. This
  //            guarantees that all green slots in a row coexist on the SAME
  //            shortest path (the "same solution" requirement).
  //   yellow — airport appears somewhere on at least one shortest path, but
  //            not at the best-matching position. Yellow fires regardless of
  //            whether the previous leg was a real flight.
  //   orange — neither green nor yellow, but there's a real flight from the
  //            previous airport AND there's some ≤MAX onward path to dest.
  //   red    — none of the above.
  // The row "wins" if start → filled[0] → … → filled[n-1] → dest are all
  // real flights, regardless of the per-slot colors.
  function grade(row) {
    const filled = [];
    for (let i = 0; i < row.length; i++) {
      if (row[i]) filled.push({ code: row[i], slot: i });
    }
    const n = filled.length;
    const colors = new Array(SLOTS).fill("");

    // 1. Walk the legs to determine `fullyConnects` (drives the win check).
    //    Walks ACTIVE_ROUTES so continent modes don't accept routes that
    //    leave the continent — even if a real-world flight exists.
    let fullyConnects = true;
    let prev = puzzle.start;
    for (let i = 0; i < n; i++) {
      const code = filled[i].code;
      if (!ACTIVE_ROUTES[prev] || !ACTIVE_ROUTES[prev].includes(code)) { fullyConnects = false; break; }
      prev = code;
    }
    if (fullyConnects) {
      if (!ACTIVE_ROUTES[prev] || !ACTIVE_ROUTES[prev].includes(puzzle.dest)) fullyConnects = false;
    }

    // 2. Find the shortest path that best matches the player's submission.
    //    Slots whose airport matches this path get green.
    const best = n ? computeBestMatchingPath(filled) : null;

    // 3. Independent per-slot grading — no cascading red.
    prev = puzzle.start;
    for (let i = 0; i < n; i++) {
      const { code, slot } = filled[i];
      const legValid = !!(ACTIVE_ROUTES[prev] && ACTIVE_ROUTES[prev].includes(code));
      const matchesBest = !!(best && best.path[slot + 1] === code);
      const onShortestPath = shortestPathAirports.has(code);
      const onwardHops = distToDest[code];

      if (matchesBest) {
        colors[slot] = "green";
      } else if (onShortestPath) {
        // Yellow precedes red: even if the previous leg was invalid, an
        // airport that's on a shortest path is more useful info than red.
        colors[slot] = "yellow";
      } else if (legValid && onwardHops !== undefined && onwardHops <= (SLOTS - slot)) {
        colors[slot] = "orange";
      } else {
        colors[slot] = "red";
      }
      prev = code;
    }

    return { colors, fullyConnects, stopsUsed: n };
  }

  // Find the shortest path from start to dest that maximizes the count of
  // (filled slot, airport) matches against the player's row. Implemented via
  // BFS to build the parents DAG, then a memoized DP over that DAG.
  // Returns { path: [start, …, dest], matches: int } or null if unreachable.
  function computeBestMatchingPath(filled) {
    const start = puzzle.start, dest = puzzle.dest;
    const dist = { [start]: 0 };
    const parents = { [start]: [] };
    const q = [start];
    let head = 0;
    while (head < q.length) {
      const node = q[head++];
      const d = dist[node];
      const nbs = ACTIVE_ROUTES[node] || [];
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        if (dist[nb] === undefined) {
          dist[nb] = d + 1;
          parents[nb] = [node];
          q.push(nb);
        } else if (dist[nb] === d + 1) {
          parents[nb].push(node);
        }
      }
    }
    if (dist[dest] === undefined) return null;

    // Map distance-from-start → expected airport at that distance, derived
    // from the player's filled slots. Slot k in the grid is at distance k+1
    // from start (slot 0 is the first intermediate).
    const expectedAtDist = {};
    for (const f of filled) expectedAtDist[f.slot + 1] = f.code;

    const memo = {};
    function bestTo(node) {
      if (node === start) return { matches: 0, prev: null };
      if (memo[node] !== undefined) return memo[node];
      let bestMatches = -1, bestPrev = null;
      const ps = parents[node];
      for (let i = 0; i < ps.length; i++) {
        const sub = bestTo(ps[i]);
        if (sub.matches > bestMatches) {
          bestMatches = sub.matches;
          bestPrev = ps[i];
        }
      }
      const d = dist[node];
      const result = {
        matches: bestMatches + (expectedAtDist[d] === node ? 1 : 0),
        prev: bestPrev,
      };
      memo[node] = result;
      return result;
    }

    const destBest = bestTo(dest);

    // Reconstruct the path back to start
    const path = [dest];
    let cur = dest;
    while (cur !== start) {
      cur = memo[cur].prev;
      path.unshift(cur);
    }
    return { path, matches: destBest.matches };
  }

  // ---------- Result panel helpers ----------
  // The result panel is an inline card (no overlay, no scrim) that gets
  // mounted into the page flow at one of two positions:
  //   • "top"    — between the puzzle header and the input row, where it
  //                appears automatically when a round ends.
  //   • "bottom" — at the very bottom of the left column, where it appears
  //                when the player taps "View result" below the grid.
  // The CSS animation re-fires on each show because the node is moved.
  function showResultPanelAt(position) {
    if (!resultPanel || !leftCol) return;
    if (position === "top" && inputRow) {
      leftCol.insertBefore(resultPanel, inputRow);
    } else {
      // "bottom" — append to end of the left column.
      leftCol.appendChild(resultPanel);
    }
    // Reset the slide-in animation so it runs every time we re-show.
    resultPanel.style.display = "none";
    // Force reflow so the next display change re-triggers the keyframes.
    void resultPanel.offsetWidth;
    resultPanel.style.display = "block";
    if (showResultBtn) showResultBtn.style.display = "none";
  }
  function hideResultPanel() {
    if (!resultPanel) return;
    resultPanel.style.display = "none";
    // If the round is over, surface the "View result" button so the player
    // can re-open the panel they just dismissed.
    if (finished && showResultBtn) showResultBtn.style.display = "inline-block";
  }

  // ---------- Game flow ----------
  function startPuzzle() {
    attempts = [];
    currentRow = [];
    finished = false;
    lastSolutionRoute = null;
    won = false;
    if (resultPanel) resultPanel.style.display = "none";
    if (showResultBtn) showResultBtn.style.display = "none";
    if (giveUpBtn) giveUpBtn.style.display = "";

    $("start-code").textContent = puzzle.start;
    $("start-city").textContent = AIRPORTS[puzzle.start].city;
    $("start-country").textContent =
      (window.COUNTRY_CODES && window.COUNTRY_CODES[AIRPORTS[puzzle.start].country]) || "";
    $("dest-code").textContent = puzzle.dest;
    $("dest-city").textContent = AIRPORTS[puzzle.dest].city;
    $("dest-country").textContent =
      (window.COUNTRY_CODES && window.COUNTRY_CODES[AIRPORTS[puzzle.dest].country]) || "";
    $("puzzle-id").textContent = puzzle.id || "";
    renderDifficulty();
    const hopsText = puzzle.shortest_hops === 2
      ? "1 stop"
      : (puzzle.shortest_hops - 1) + " stops";
    $("shortest-hops").textContent = hopsText;

    // Pre-compute shortest-path analysis for grading
    const analysis = analyseShortestPaths(puzzle.start, puzzle.dest);
    shortestPathAirports = analysis.onPath;
    shortestPathBySlot = analysis.slots;
    distToDest = analysis.distFromDest;
    optimalKm = analysis.optimalKm;

    input.value = "";
    closeSuggestions();
    renderGrid();
    if (window.JetSetsGlobe) {
      JetSetsGlobe.setPuzzle(puzzle.start, puzzle.dest);
    }
    statusBar.textContent = "Type an airport and press Enter or Add. Press Backspace on an empty input (or tap Undo) to remove the last stop. Submit (or press Shift+Enter) when ready — leave trailing boxes empty if you find a shorter route.";
    statusBar.className = "status-bar";
    submitBtn.disabled = true;
    addBtn.disabled = false;
    undoBtn.disabled = false;
    if (giveUpBtn) giveUpBtn.disabled = false;
    // Drop the player straight into typing — no hunting for the input box.
    if (input) input.focus();
  }

  function tryAddAirport(code) {
    if (finished) return;
    code = code.toUpperCase();
    if (!AIRPORTS[code]) { toast_show("Unknown airport: " + code); return; }
    if (!activeCodes.has(code)) {
      const cont = MODE_CONTINENT[mode];
      toast_show(cont
        ? `${code} is outside ${cont} — pick an airport inside the continent.`
        : `${code} has no flights in this puzzle's network.`);
      return;
    }
    if (code === puzzle.start) { toast_show("That's your starting airport."); return; }
    if (code === puzzle.dest) { toast_show("That's your destination — leave trailing boxes empty and submit."); return; }
    if (currentRow.includes(code)) { toast_show("Already in this row."); return; }
    if (currentRow.length >= SLOTS) { toast_show("All 5 slots filled. Submit or clear."); return; }
    currentRow.push(code);
    submitBtn.disabled = false;
    input.value = "";
    closeSuggestions();
    renderGrid();
    if (window.JetSetsGlobe) JetSetsGlobe.setDraft(currentRow);
  }

  function clearCurrentRow() {
    currentRow = [];
    submitBtn.disabled = true;
    renderGrid();
    if (window.JetSetsGlobe) JetSetsGlobe.setDraft(currentRow);
  }

  function removeLastFromRow() {
    if (finished) return;
    if (currentRow.length === 0) return;
    currentRow.pop();
    submitBtn.disabled = currentRow.length === 0;
    renderGrid();
    if (window.JetSetsGlobe) JetSetsGlobe.setDraft(currentRow);
  }

  function submitRow() {
    if (finished) return;
    const graded = grade(currentRow);
    const rowData = new Array(SLOTS).fill(null);
    for (let i = 0; i < currentRow.length; i++) {
      rowData[i] = { code: currentRow[i], color: graded.colors[i] };
    }
    // Detect the "best route" purple tier: shortest-hops match AND the
    // player's total km equals the puzzle's minimum km across all
    // shortest-hop paths. Done before the green repaint so we can swap
    // the fill color in one pass below. Tolerance of ~0.5 km absorbs
    // floating-point drift in haversine sums. We always compute playerKm
    // when the row connects so the result panel can show the km gap to
    // the best route, even for non-purple wins.
    let isBestPath = false;
    let playerKm = null;
    if (graded.fullyConnects) {
      playerKm = pathKm([puzzle.start, ...currentRow, puzzle.dest]);
      const matchedShortest = graded.stopsUsed === (puzzle.shortest_hops - 1);
      if (matchedShortest && optimalKm != null && isFinite(optimalKm)) {
        if (Math.abs(playerKm - optimalKm) < 0.5) isBestPath = true;
      }
    }
    // If this row connects start→dest, repaint every filled cell green so
    // the win reads as a complete success — even if the player took more
    // stops than the shortest path. (We used to paint these light-green to
    // signal "valid but not optimal", but the extra color was more confusing
    // than helpful — green simply means "you finished".)
    // Best-path wins paint purple instead — a louder celebration for the
    // single tightest route through the network.
    if (graded.fullyConnects) {
      const fillColor = isBestPath ? "purple" : "green";
      for (let i = 0; i < rowData.length; i++) {
        if (rowData[i]) rowData[i].color = fillColor;
      }
    }
    attempts.push(rowData);
    currentRow = [];
    submitBtn.disabled = true;

    if (window.JetSetsGlobe) {
      JetSetsGlobe.setHistory(attempts);
      JetSetsGlobe.setDraft(currentRow);
    }

    if (graded.fullyConnects) {
      finished = true;
      won = true;
      renderGrid();
      if (speedrunActive) {
        // Bank the score and roll into the next puzzle. The countdown
        // does NOT reset between puzzles — same 90s clock for the whole
        // run.
        const earned = score(graded.stopsUsed, attempts.length, puzzle, isBestPath);
        speedrunScore += earned;
        speedrunSolves += 1;
        // Capture this puzzle for the end-of-run summary. The path is
        // the full chain start → typed-intermediates → dest.
        const intermediates = rowData
          .filter((cell) => cell && cell.code)
          .map((cell) => cell.code);
        speedrunHistory.push({
          start: puzzle.start,
          dest: puzzle.dest,
          path: [puzzle.start, ...intermediates, puzzle.dest],
          attemptsUsed: attempts.length,
          points: earned,
          bestPath: isBestPath,
        });
        // Successful speedrun puzzles contribute one vote to the
        // dynamic-difficulty system, same as regular wins.
        if (window.JetSetsStats) {
          window.JetSetsStats.submitAttempt(puzzle.start, puzzle.dest, true);
        }
        updateSpeedrunHud();
        if (Date.now() >= speedrunDeadline) {
          endSpeedrun("timeup");
        } else {
          // Tiny delay so the player sees the green row before the next
          // puzzle replaces it.
          setTimeout(() => {
            if (speedrunActive) advanceSpeedrunPuzzle();
          }, 350);
        }
      } else {
        showResult(true, graded.stopsUsed, attempts.length, false, isBestPath, playerKm);
      }
    } else if (attempts.length >= MAX_ATTEMPTS) {
      finished = true;
      won = false;
      renderGrid();
      if (speedrunActive) {
        endSpeedrun("fail");
      } else {
        showResult(false, null, attempts.length);
      }
    } else {
      renderGrid();
      statusBar.textContent = `Not quite — ${MAX_ATTEMPTS - attempts.length} ${MAX_ATTEMPTS - attempts.length === 1 ? "try" : "tries"} left.`;
      statusBar.className = "status-bar";
      // Keep typing flow uninterrupted between attempts.
      if (input) input.focus();
    }
  }

  // ---------- Scoring ----------
  // Three multiplicative factors:
  //   base    — driven by puzzle difficulty (stars). Harder puzzles score
  //             higher headline numbers, so a 5★ Extreme on try 1 pays out
  //             far more than a 1★ Simple on try 1.
  //   attempt — linear curve from 1.00 (try 1) down to 1/MAX_ATTEMPTS
  //             (try 6). Solve faster, score more.
  //   optimal — 1.5× bonus when the player's stops_used matches the
  //             puzzle's shortest hop count exactly. Hitting the optimum
  //             is meaningful and visible on the result panel.
  // Range: ~5 pts (1★ Simple, suboptimal, try 6) to ~390 pts (5★ Extreme,
  // optimal, try 1). All values rounded to whole numbers.
  const STAR_BASE = { 1: 50, 2: 80, 3: 120, 4: 180, 5: 260 };
  const OPTIMAL_BONUS = 1.5;
  const BEST_PATH_BONUS = 2.0;

  function score(stopsUsed, attemptsUsed, puzzleArg, isBestPath) {
    const p = puzzleArg || puzzle || {};
    const stars = STAR_BASE[p.stars] ? p.stars : 3; // default to Medium
    const base = STAR_BASE[stars];
    const attempt = (MAX_ATTEMPTS + 1 - attemptsUsed) / MAX_ATTEMPTS;
    const shortestStops = (p.shortest_hops || 0) - 1; // hops include the start; stops is hops-1
    const matchedShortest = shortestStops >= 0 && stopsUsed === shortestStops;
    // Best-path supersedes the optimal bonus — it implies optimal hops AND
    // the minimum km. 2.0× headline payout for the absolute tightest route.
    const bonus = isBestPath ? BEST_PATH_BONUS
                : matchedShortest ? OPTIMAL_BONUS
                : 1.0;
    return Math.round(base * attempt * bonus);
  }

  // Produce a positive heading + status-bar pair for a winning round,
  // describing how many km off the best (purple) route the player was.
  // Tiers tighten the language as the gap narrows: a 100-km miss reads
  // as "razor-thin", a 4,000-km miss reads as "route complete". When
  // we don't have an optimal-km figure (rare edge case) we fall back to
  // a neutral "Route complete!" so we never lie about the gap.
  function buildWinCopy(isBestPath, playerKm) {
    if (isBestPath) {
      return {
        heading: "Perfect — the absolute best route!",
        status: "Best route — solved!",
      };
    }
    const haveKm = optimalKm != null && isFinite(optimalKm)
                && playerKm != null && isFinite(playerKm);
    if (!haveKm) {
      return { heading: "Route complete!", status: "Solved!" };
    }
    const kmOver = Math.max(0, Math.round(playerKm - optimalKm));
    const kmStr = kmOver.toLocaleString();
    let descriptor;
    if (kmOver < 100)        descriptor = "Razor-thin";
    else if (kmOver < 500)   descriptor = "So close";
    else if (kmOver < 1500)  descriptor = "Sharp routing";
    else if (kmOver < 4000)  descriptor = "Solid solve";
    else                     descriptor = "Route complete";
    return {
      heading: `${descriptor} — ${kmStr} km off the best route.`,
      status: `Solved! ${kmStr} km off the best route.`,
    };
  }

  function showResult(winFlag, stopsUsed, attemptsUsed, gaveUp, isBestPath, playerKm) {
    // Log this attempt for the dynamic-difficulty system. Rule (b): the
    // attempt counts if the player engaged at all (any row submitted
    // OR gave up). Internal dedupe in stats.submitAttempt means calling
    // this on every showResult is safe.
    if (puzzle && window.JetSetsStats
        && (winFlag || gaveUp || attemptsUsed > 0)) {
      window.JetSetsStats.submitAttempt(puzzle.start, puzzle.dest, !!winFlag);
    }
    // First show always lands above the grid — score & shortest-route
    // reveal sit on top of the player's colored cells.
    showResultPanelAt("top");
    // Drop the speedrun-summary class in case a previous run left it on.
    if (resultPanel) resultPanel.classList.remove("speedrun-summary-panel");
    // Best-path wins get an extra class so we can theme the panel border /
    // heading purple. Strip both first so a follow-up regular win clears
    // the previous round's purple styling.
    if (resultPanel) resultPanel.classList.remove("best-path");
    // Tear down the speedrun history list (if any) — the regular round
    // result panel doesn't show it.
    const oldHistory = document.getElementById("speedrun-history-block");
    if (oldHistory) oldHistory.remove();
    // Hide the give-up button — the round is done. The "View result"
    // button takes its place once the panel is dismissed.
    if (giveUpBtn) giveUpBtn.style.display = "none";
    if (winFlag) {
      const pts = score(stopsUsed, attemptsUsed, puzzle, isBestPath);
      const copy = buildWinCopy(isBestPath, playerKm);
      resultHeading.textContent = copy.heading;
      if (isBestPath && resultPanel) resultPanel.classList.add("best-path");
      // Compact pills: "<strong>2</strong> stops · <strong>3/6</strong> tries · <strong>12</strong> pts"
      // Purple wins also get a "best route" badge so the achievement is
      // visible at a glance from the pills row.
      const badge = isBestPath
        ? `<span class="pill-best">Best route</span>`
        : "";
      resultStats.innerHTML =
        `<span><strong>${stopsUsed}</strong>stops</span>` +
        `<span><strong>${attemptsUsed}/${MAX_ATTEMPTS}</strong>tries</span>` +
        `<span><strong>${pts}</strong>pts</span>` +
        badge;
      statusBar.textContent = copy.status;
      statusBar.className = "status-bar win";
    } else {
      resultHeading.textContent = gaveUp ? "You gave up — here's the answer." : "Out of attempts.";
      resultStats.innerHTML = "";
      statusBar.textContent = gaveUp ? "Round revealed." : "Better luck next round.";
      statusBar.className = "status-bar lose";
    }
    // Always reveal the shortest route(s), whether solved or not.
    renderShortestRoutesBlock();
    // Lock all action controls — the round is over.
    submitBtn.disabled = true;
    addBtn.disabled = true;
    undoBtn.disabled = true;
    if (giveUpBtn) giveUpBtn.disabled = true;
    // Daily is locked to one puzzle per day, but the player still wants
    // somewhere to go after they've solved it — offer to roll into Random.
    // Every other mode rolls a fresh puzzle from the same pool.
    newPuzzleBtn.style.display = "inline-block";
    if (mode === "daily") {
      newPuzzleBtn.textContent = "Play Random ↵";
      newPuzzleBtn.title = "Or press Enter to start a Random puzzle";
    } else {
      newPuzzleBtn.textContent = `New ${MODE_LABELS[mode]} puzzle ↵`;
      newPuzzleBtn.title = "Or press Enter to roll a fresh puzzle";
    }
  }

  function giveUp() {
    if (finished) return;
    finished = true;
    won = false;
    // Discard any in-progress draft so the grid renders cleanly.
    currentRow = [];
    if (window.JetSetsGlobe) JetSetsGlobe.setDraft([]);
    renderGrid();
    // In a speedrun, "give up" mid-puzzle ends the run — same as failing.
    if (speedrunActive) {
      endSpeedrun("fail");
    } else {
      showResult(false, null, attempts.length, /* gaveUp */ true);
    }
  }

  // ---------- Speedrun ----------
  // Pick the next puzzle for the active speedrun's variant. Falls back to
  // the global pool if a continent variant somehow runs dry.
  function pickSpeedrunPuzzle(modeKey) {
    const cfg = MODE_SPEEDRUN[modeKey];
    if (!cfg) return null;
    if (cfg.variant === "continent") {
      const p = randomContinentPuzzle(cfg.continent);
      if (p) return p;
      // Continent fell empty — fall back to the speedrun-weighted picker
      // rather than the Random picker so the layover bias is preserved.
      return randomSpeedrunPuzzle();
    }
    if (cfg.variant === "difficulty") {
      // Every puzzle in the run is locked to the configured star tier,
      // with the speedrun layover bias applied within that tier.
      return randomDifficultySpeedrunPuzzle(cfg.stars);
    }
    if (cfg.variant === "cryptic") {
      // Cryptic styling comes from the body class — the picker is the
      // same global pool with speedrun layover weights. Re-label so the
      // puzzle ID reads "Cryptic #N" rather than "Random #N" while the
      // player blitzes through them.
      const p = randomSpeedrunPuzzle();
      if (p) p.id = `Cryptic #${(p.id || "").split("#")[1] || ""}`.trim();
      return p;
    }
    // "global" — any puzzle in the world, with speedrun layover weights.
    return randomSpeedrunPuzzle();
  }

  function startSpeedrun(modeKey) {
    speedrunActive = true;
    speedrunStarted = false;
    speedrunModeKey = modeKey;
    speedrunScore = 0;
    speedrunSolves = 0;
    speedrunHistory = [];
    speedrunPendingSubmit = null;
    speedrunSubmitted = false;
    speedrunStartTime = 0;
    // Deadline isn't armed until the player clicks Start — set to a sentinel
    // so the auto-advance path's "Date.now() >= deadline" check can't fire.
    speedrunDeadline = Number.MAX_SAFE_INTEGER;
    advanceSpeedrunPuzzle();
    // Lock the input controls — the player can't type or submit until they
    // click Start. Locking happens AFTER advanceSpeedrunPuzzle because
    // startPuzzle() re-enables them for normal play.
    lockSpeedrunControls();
    // Drop the curtain over the route + meta. Removed in beginSpeedrunRun
    // the moment the player clicks Start, just before the countdown plays.
    document.body.classList.add("speedrun-pre-start");
    updateSpeedrunHud();
  }

  // Player clicked Start — reveal the route, run a 3-2-1-Go countdown,
  // THEN start the 90s timer and hand control to the input box. The
  // countdown is gated on speedrunStarted so the player can't double-
  // click their way past it.
  function beginSpeedrunRun() {
    if (!speedrunActive || speedrunStarted) return;
    speedrunStarted = true;
    // Drop the pre-start curtain — the route is now visible.
    document.body.classList.remove("speedrun-pre-start");
    // Hide the Start button so it can't be re-clicked, and reveal the
    // (still paused) time block so the player sees the slot the timer
    // will land in.
    if (speedrunStartBtn) speedrunStartBtn.style.display = "none";
    const timeBlock = document.getElementById("speedrun-time-block");
    if (timeBlock) timeBlock.style.display = "";
    runSpeedrunCountdown(() => {
      const now = Date.now();
      speedrunStartTime = now;
      speedrunDeadline = now + SPEEDRUN_DURATION_MS;
      startSpeedrunTimer();
      unlockSpeedrunControls();
      updateSpeedrunHud();
      if (input) input.focus();
    });
  }

  // Plays a 3 → 2 → 1 → Go! sequence over a fullscreen overlay. Each
  // number holds for one second; "Go!" flashes for ~450ms before the
  // overlay clears and onDone fires. Controls stay locked the entire
  // time so the player can't sneak in moves before the clock starts.
  function runSpeedrunCountdown(onDone) {
    const overlay = document.getElementById("speedrun-countdown");
    let numEl     = document.getElementById("speedrun-countdown-num");
    if (!overlay || !numEl) { onDone && onDone(); return; }
    const steps = [
      { text: "3",   hold: 1000, go: false },
      { text: "2",   hold: 1000, go: false },
      { text: "1",   hold: 1000, go: false },
      { text: "Go!", hold: 450,  go: true  },
    ];
    overlay.classList.add("visible");
    let i = 0;
    function step() {
      if (i >= steps.length) {
        overlay.classList.remove("visible");
        overlay.classList.remove("go");
        if (onDone) onDone();
        return;
      }
      const s = steps[i++];
      overlay.classList.toggle("go", !!s.go);
      // Force the animation to re-fire on each step by swapping the
      // span for a fresh clone — keyframes only replay on a new node.
      const fresh = numEl.cloneNode(false);
      fresh.textContent = s.text;
      numEl.parentNode.replaceChild(fresh, numEl);
      numEl = fresh;
      setTimeout(step, s.hold);
    }
    step();
  }

  // Pre-start: disable the controls so the player can't sneak in moves
  // before the timer's running. (The puzzle itself is visible — we only
  // gate the input.)
  function lockSpeedrunControls() {
    if (input) { input.disabled = true; input.blur(); }
    if (addBtn)    addBtn.disabled = true;
    if (undoBtn)   undoBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
  }
  function unlockSpeedrunControls() {
    if (input)   input.disabled = false;
    if (addBtn)  addBtn.disabled = false;
    if (undoBtn) undoBtn.disabled = false;
    // submitBtn stays disabled until the player adds an airport — that's
    // its normal state at the top of a fresh puzzle.
  }

  function advanceSpeedrunPuzzle() {
    if (!speedrunActive) return;
    if (Date.now() >= speedrunDeadline) {
      endSpeedrun("timeup");
      return;
    }
    const next = pickSpeedrunPuzzle(speedrunModeKey);
    if (!next) {
      toast_show("No puzzles available for this speedrun variant.");
      endSpeedrun("error");
      return;
    }
    puzzle = next;
    startPuzzle();
    updateSpeedrunHud();
  }

  function startSpeedrunTimer() {
    stopSpeedrunTimer();
    speedrunTimerInterval = setInterval(() => {
      updateSpeedrunHud();
      if (speedrunActive && Date.now() >= speedrunDeadline) {
        endSpeedrun("timeup");
      }
    }, 200);
  }

  function stopSpeedrunTimer() {
    if (speedrunTimerInterval) {
      clearInterval(speedrunTimerInterval);
      speedrunTimerInterval = null;
    }
  }

  function endSpeedrun(reason) {
    if (!speedrunActive) return;
    speedrunActive = false;
    stopSpeedrunTimer();
    // If the player was mid-puzzle when the run ended (rows submitted
    // but no solve), that puzzle counts as a failure for the dynamic
    // difficulty system — rule (b). Skip if the puzzle was already
    // solved earlier in submitRow (won === true) so we don't double-vote.
    if (puzzle && !won && window.JetSetsStats
        && (attempts.length > 0 || reason === "fail")) {
      window.JetSetsStats.submitAttempt(puzzle.start, puzzle.dest, false);
    }
    showSpeedrunSummary(reason);
    updateSpeedrunHud();
  }

  // The speedrun summary re-uses the inline result panel — same layout,
  // different content. We tag the panel with .speedrun-summary-panel so
  // the score/solved/time stack reads larger; the tag is removed when a
  // regular round shows the panel later.
  function showSpeedrunSummary(reason) {
    finished = true;
    won = false;
    currentRow = [];
    if (window.JetSetsGlobe) JetSetsGlobe.setDraft([]);
    renderGrid();

    showResultPanelAt("top");
    if (resultPanel) resultPanel.classList.add("speedrun-summary-panel");
    if (giveUpBtn) giveUpBtn.style.display = "none";

    const elapsedMs = Math.min(SPEEDRUN_DURATION_MS, Date.now() - speedrunStartTime);
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    let title;
    if (reason === "timeup") {
      title = speedrunSolves > 0
        ? `Time's up — ${speedrunSolves} solved!`
        : "Time's up!";
    } else if (reason === "fail") {
      title = speedrunSolves > 0
        ? `Run ended on a missed puzzle (${speedrunSolves} banked)`
        : "Run ended — first puzzle missed.";
    } else if (reason === "quit") {
      title = speedrunSolves > 0
        ? `Run ended early (${speedrunSolves} banked)`
        : "Run ended early.";
    } else {
      title = "Run ended.";
    }
    resultHeading.textContent = title;
    const variantLabel = (MODE_SPEEDRUN[speedrunModeKey] || {}).label || "Speedrun";
    resultStats.innerHTML =
      `<span><strong>${speedrunScore}</strong>pts</span>` +
      `<span><strong>${speedrunSolves}</strong>solved</span>` +
      `<span><strong>${elapsedSec}s</strong>time</span>` +
      `<span>${variantLabel}</span>`;

    statusBar.textContent = reason === "timeup"
      ? "Time's up — your run is over."
      : "Run ended.";
    statusBar.className = "status-bar lose";

    // Show the shortest route for the LAST puzzle the player saw —
    // educational closure on whatever stumped them at the buzzer.
    renderShortestRoutesBlock();
    // Render the compressed list of every solved route + its solution
    // immediately after the shortest-route block.
    renderSpeedrunHistoryBlock();
    // Then the leaderboard-submit block: shows save state, or a
    // sign-in CTA if the player isn't authenticated.
    maybeAutoSubmitScore();

    // Lock controls.
    submitBtn.disabled = true;
    addBtn.disabled = true;
    undoBtn.disabled = true;
    if (giveUpBtn) giveUpBtn.disabled = true;

    newPuzzleBtn.style.display = "inline-block";
    newPuzzleBtn.textContent = "New speedrun ↵";
    newPuzzleBtn.title = "Or press Enter to start a fresh speedrun";
  }

  // Re-paint the speedrun HUD: timer, score, solved-count. Also drives
  // visibility — when no run is selected the corner HUDs and quit button
  // are hidden. While a run is armed but the player hasn't clicked Start
  // yet, the Start button is shown in place of the timer.
  function updateSpeedrunHud() {
    const showHud = !!speedrunActive;
    if (speedrunCornerLeft)  speedrunCornerLeft.style.display  = showHud ? "flex" : "none";
    if (speedrunCornerRight) speedrunCornerRight.style.display = showHud ? "flex" : "none";
    if (speedrunQuitBtn)     speedrunQuitBtn.style.display     = showHud ? "inline-block" : "none";
    // Hide the regular Give-Up button during a speedrun — End run takes
    // its place. Keep the round's normal "finished" state in charge of
    // hiding/showing it the rest of the time (we don't want to override
    // showResult's own toggle when the run isn't active).
    if (giveUpBtn && showHud) giveUpBtn.style.display = "none";
    document.body.classList.toggle("speedrun-active", showHud);
    // When the HUD goes away (run ended or mode switched), the pre-start
    // curtain has to come down with it. Otherwise a player who quits
    // a speedrun mid-curtain would carry the hidden route into a
    // subsequent Daily/Random load.
    if (!showHud) document.body.classList.remove("speedrun-pre-start");
    if (!showHud) return;

    // Pre-start: Start button visible, timer hidden. Once started: swap.
    if (speedrunStartBtn)  speedrunStartBtn.style.display  = speedrunStarted ? "none" : "inline-block";
    if (speedrunTimeBlock) speedrunTimeBlock.style.display = speedrunStarted ? "flex" : "none";

    if (speedrunStarted) {
      const remaining = Math.max(0, speedrunDeadline - Date.now());
      const secs = Math.ceil(remaining / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      if (speedrunTimeEl) {
        speedrunTimeEl.textContent = m + ":" + (s < 10 ? "0" : "") + s;
        speedrunTimeEl.classList.toggle("speedrun-time-low", remaining <= 10000);
      }
    } else if (speedrunTimeEl) {
      // Pre-start state — show the full duration as a preview.
      const totalSec = Math.round(SPEEDRUN_DURATION_MS / 1000);
      const m = Math.floor(totalSec / 60), s = totalSec % 60;
      speedrunTimeEl.textContent = m + ":" + (s < 10 ? "0" : "") + s;
      speedrunTimeEl.classList.remove("speedrun-time-low");
    }
    if (speedrunScoreEl) {
      // Score reads "<score>" with a "<solved> solved" subline. Single
      // element rewrite so the .speedrun-corner-sub wrapping stays inline
      // with the score and we don't need separate DOM nodes for each.
      speedrunScoreEl.textContent = String(speedrunScore);
    }
    if (speedrunSolvedEl) speedrunSolvedEl.textContent = String(speedrunSolves);
  }

  // Build / refresh the "Shortest route" block inside the result panel.
  // Shows the first shortest route inline with a clickable count of
  // alternatives (when there are more than one). Clicking the count
  // toggles a list of all shortest routes (capped at 50 for display).
  function renderShortestRoutesBlock() {
    const { count, routes } = shortestRoutes(puzzle.start, puzzle.dest, 50);
    let block = document.getElementById("shortest-routes-block");
    if (!block) {
      block = document.createElement("div");
      block.id = "shortest-routes-block";
      block.className = "solution-block";
      // Click delegation: clicking any .sol-code toggles its parent's
      // .expanded class, revealing the long-form airport name inline.
      block.addEventListener("click", (e) => {
        const code = e.target.closest(".sol-code");
        if (!code) return;
        const airport = code.parentElement;
        if (airport && airport.classList.contains("sol-airport")) {
          airport.classList.toggle("expanded");
        }
      });
      const actions = resultPanel.querySelector(".result-actions");
      resultPanel.insertBefore(block, actions);
    }
    if (count === 0) {
      block.innerHTML = `<div class="solution-label">No path exists.</div>`;
      return;
    }
    const stopsLabel = puzzle.shortest_hops === 1
      ? "direct flight"
      : (puzzle.shortest_hops === 2
          ? "1-stop route"
          : (puzzle.shortest_hops - 1) + "-stop route");
    const counterHtml = count > 1
      ? `<a class="solution-count" id="solution-count" href="#"
            title="Click to see all ${count} shortest routes">(${count})</a>`
      : `<span class="solution-count solo">(1)</span>`;
    // Best-route km: the minimum km across every shortest-hop path. Shown
    // alongside the route count so the player can see what target they
    // were aiming at for the purple win tier.
    const bestKmHtml = (optimalKm != null && isFinite(optimalKm))
      ? `<span class="solution-bestkm" title="Fewest kilometres flown across all shortest routes">best: ${Math.round(optimalKm).toLocaleString()} km</span>`
      : "";
    // Slot counts: how many distinct airports are valid at each intermediate
    // slot across shortest routes — annotated next to each leg of the
    // primary solution so the player can spot which slot was the hardest
    // (small count = bottleneck leg).
    // Pass the full per-slot airport sets (not just sizes) so the (N)
    // badges can show the actual IATA codes on hover via the native
    // title tooltip. fmtRoute reads .size for the badge text and .codes
    // for the tooltip.
    const slotInfo = (shortestPathBySlot || []).map((s) => ({
      size: s.size,
      codes: Array.from(s).sort(),
    }));
    // Decorate every enumerated route with its great-circle km, then sort
    // by km ascending. After sorting, routesWithKm[0] is the tightest path
    // through the network — i.e. the puzzle's purple "best route" target —
    // so it doubles as the primary route shown inline.
    const routesWithKm = routes.map((r) => ({ route: r, km: pathKm(r) }));
    routesWithKm.sort((a, b) => a.km - b.km);
    const fmtKm = (km) => `<span class="route-km">(${Math.round(km).toLocaleString()} km)</span>`;
    const primaryRoute = routesWithKm[0].route;
    const primaryKm = routesWithKm[0].km;
    // Primary route shares a row with its label — "Shortest 2-stop route (3): JFK (3) → LAX (14) (12,840 km)".
    block.innerHTML =
      `<div class="solution-row">
         <span class="solution-label">Shortest ${stopsLabel} ${counterHtml} ${bestKmHtml}:</span>
         <span class="solution-route" id="solution-primary">${fmtRoute(primaryRoute, slotInfo)} ${fmtKm(primaryKm)}</span>
       </div>
       <div class="solution-list" id="solution-list" style="display:none"></div>`;
    // Highlight the chosen primary shortest route on the globe so the player
    // can see exactly where it goes geographically.
    if (window.JetSetsGlobe) {
      JetSetsGlobe.setSolution(primaryRoute);
    }
    lastSolutionRoute = primaryRoute.slice();
    if (count > 1) {
      const link = document.getElementById("solution-count");
      const list = document.getElementById("solution-list");
      const primary = document.getElementById("solution-primary");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const isHidden = list.style.display === "none";
        if (isHidden) {
          let html = "";
          // Render every enumerated route in km-ascending order so the
          // tightest paths sit at the top of the list.
          for (let i = 0; i < routesWithKm.length; i++) {
            const { route, km } = routesWithKm[i];
            html += `<div class="solution-route">
                       <span class="solution-num">${i + 1}.</span>
                       ${fmtRoute(route)} ${fmtKm(km)}
                     </div>`;
          }
          if (count > routesWithKm.length) {
            html += `<div class="solution-more">…and ${count - routesWithKm.length} more not shown</div>`;
          }
          list.innerHTML = html;
          list.style.display = "block";
          primary.style.display = "none";
          link.textContent = "(hide)";
        } else {
          list.style.display = "none";
          primary.style.display = "";
          link.textContent = `(${count})`;
        }
      });
    }
  }

  // Render the compact "you solved N routes" list inside the speedrun
  // summary panel. Each entry shows: start → dest, the player's full
  // path through the puzzle, the points earned, and the attempts used.
  // Click any code to reveal its long-form name (same delegation pattern
  // as renderShortestRoutesBlock).
  function renderSpeedrunHistoryBlock() {
    if (!resultPanel) return;
    let block = document.getElementById("speedrun-history-block");
    if (!block) {
      block = document.createElement("div");
      block.id = "speedrun-history-block";
      block.className = "solution-block speedrun-history-block";
      block.addEventListener("click", (e) => {
        const code = e.target.closest(".sol-code");
        if (!code) return;
        const airport = code.parentElement;
        if (airport && airport.classList.contains("sol-airport")) {
          airport.classList.toggle("expanded");
        }
      });
      const actions = resultPanel.querySelector(".result-actions");
      resultPanel.insertBefore(block, actions);
    }
    if (!speedrunHistory.length) {
      block.innerHTML = `<div class="solution-label">No puzzles banked this run.</div>`;
      return;
    }
    const items = speedrunHistory.map((entry, i) => {
      const route = fmtRoute(entry.path);
      const tries = entry.attemptsUsed === 1
        ? "1 try"
        : `${entry.attemptsUsed} tries`;
      const bestTag = entry.bestPath ? ` · <span class="sh-best">best route</span>` : "";
      return `<div class="speedrun-history-row${entry.bestPath ? " best" : ""}">
                <span class="speedrun-history-num">${i + 1}.</span>
                <span class="speedrun-history-route">${route}</span>
                <span class="speedrun-history-meta">+${entry.points} pts · ${tries}${bestTag}</span>
              </div>`;
    }).join("");
    block.innerHTML =
      `<div class="solution-label">Routes you solved (${speedrunHistory.length}):</div>
       <div class="speedrun-history-list">${items}</div>`;
  }

  // ---------- Leaderboard submission ----------
  // Try to save the just-finished run to Supabase. Skips zero-score runs
  // (no point cluttering the leaderboard). If the user is signed in, fires
  // the insert immediately. If not, shows a sign-in CTA — and we listen
  // for the auth state change so the score auto-submits once they're in.
  function maybeAutoSubmitScore() {
    if (speedrunScore <= 0 || speedrunSolves <= 0) {
      renderLeaderboardBlock("none");
      return;
    }
    speedrunPendingSubmit = {
      mode: speedrunModeKey,
      points: speedrunScore,
      solves: speedrunSolves,
    };
    if (window.JetSetsAuth && window.JetSetsAuth.isSignedIn()) {
      submitPendingScore();
    } else {
      renderLeaderboardBlock("need-signin");
    }
  }

  async function submitPendingScore() {
    if (!speedrunPendingSubmit || speedrunSubmitted) return;
    if (!window.JetSetsAuth || !window.JetSetsAuth.submitScore) {
      renderLeaderboardBlock("error", "Auth module unavailable.");
      return;
    }
    renderLeaderboardBlock("saving");
    try {
      await window.JetSetsAuth.submitScore(speedrunPendingSubmit);
      speedrunSubmitted = true;
      renderLeaderboardBlock("saved");
    } catch (err) {
      if (err && err.code === "not_signed_in") {
        renderLeaderboardBlock("need-signin");
      } else {
        const msg = (err && err.message) ? err.message : "Couldn't save score.";
        renderLeaderboardBlock("error", msg);
      }
    }
  }

  // Render (or update) the leaderboard-submit block inside the speedrun
  // summary panel. State is one of: "none", "need-signin", "saving",
  // "saved", "error". The block is inserted just before the result panel's
  // action row so it sits at the bottom of the summary content.
  function renderLeaderboardBlock(state, errMsg) {
    if (!resultPanel) return;
    let block = document.getElementById("leaderboard-submit-block");
    const needsBlock = state !== "none";
    if (!needsBlock) {
      if (block) block.remove();
      return;
    }
    if (!block) {
      block = document.createElement("div");
      block.id = "leaderboard-submit-block";
      block.className = "leaderboard-submit";
      const actions = resultPanel.querySelector(".result-actions");
      resultPanel.insertBefore(block, actions);
    }
    let html = "";
    if (state === "need-signin") {
      html =
        `<div class="lb-msg">Sign in to save this score on the leaderboard.</div>
         <button type="button" class="btn lb-signin-btn" id="lb-signin-btn">Sign in / Create account</button>`;
    } else if (state === "saving") {
      html = `<div class="lb-msg">Saving score…</div>`;
    } else if (state === "saved") {
      html = `<div class="lb-msg lb-saved">&#x2713; Score saved to the leaderboard.</div>`;
    } else if (state === "error") {
      html = `<div class="lb-msg lb-error">Couldn't save score${errMsg ? ` — ${errMsg}` : ""}.</div>
              <button type="button" class="btn secondary lb-retry-btn" id="lb-retry-btn">Try again</button>`;
    }
    block.innerHTML = html;
    const signInBtn = document.getElementById("lb-signin-btn");
    if (signInBtn) {
      signInBtn.addEventListener("click", () => {
        if (window.JetSetsAuth && window.JetSetsAuth.openModal) {
          window.JetSetsAuth.openModal("signin");
        }
      });
    }
    const retryBtn = document.getElementById("lb-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", submitPendingScore);
    }
  }

  // When the user signs in (or out) while the summary panel is open,
  // react: a fresh sign-in retries the pending submission; a sign-out
  // reverts the block to the sign-in CTA.
  window.addEventListener("jetsets-auth-changed", (e) => {
    if (!speedrunPendingSubmit || speedrunSubmitted) return;
    const signedIn = !!(e && e.detail && e.detail.signedIn);
    if (signedIn) {
      submitPendingScore();
    } else {
      renderLeaderboardBlock("need-signin");
    }
  });

  // Compute every shortest path from start→dest. Returns:
  //   { count: total_count, routes: [[code, ...], ...] }
  // `routes` is capped at maxEnum entries; `count` is always exact (computed
  // via DP, not by enumeration).
  function shortestRoutes(start, dest, maxEnum) {
    if (maxEnum == null) maxEnum = 50;
    if (start === dest) return { count: 1, routes: [[start]] };
    // BFS recording every parent at the same shortest depth.
    // Walks ACTIVE_ROUTES so the "shortest route(s)" reveal in continent
    // modes shows only intra-continent paths.
    const dist = { [start]: 0 };
    const parents = { [start]: [] };
    const q = [start];
    let head = 0;
    while (head < q.length) {
      const n = q[head++];
      const d = dist[n];
      const nbs = ACTIVE_ROUTES[n] || [];
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        if (dist[nb] === undefined) {
          dist[nb] = d + 1;
          parents[nb] = [n];
          q.push(nb);
        } else if (dist[nb] === d + 1) {
          parents[nb].push(n);
        }
      }
    }
    if (dist[dest] === undefined) return { count: 0, routes: [] };
    // Count via DP on the DAG of parents
    const memo = {};
    function countTo(node) {
      if (node === start) return 1;
      if (memo[node] !== undefined) return memo[node];
      let total = 0;
      for (const p of parents[node]) total += countTo(p);
      memo[node] = total;
      return total;
    }
    const count = countTo(dest);
    // Enumerate up to maxEnum routes
    const routes = [];
    function recurse(node, suffix) {
      if (routes.length >= maxEnum) return;
      if (node === start) { routes.push([start].concat(suffix)); return; }
      for (let i = 0; i < parents[node].length; i++) {
        if (routes.length >= maxEnum) return;
        recurse(parents[node][i], [node].concat(suffix));
      }
    }
    recurse(dest, []);
    return { count, routes };
  }

  // Format a single airport as a clickable code; the long-form name is hidden
  // by default and revealed when the player clicks the code.
  function fmtAirportToggle(code) {
    const a = AIRPORTS[code];
    if (!a) return `<span class="sol-airport"><span class="sol-code">${code}</span></span>`;
    const place = a.country ? `${a.city}, ${a.country}` : a.city;
    const long = `${a.name} (${place})`;
    return `<span class="sol-airport" title="Click to reveal name">` +
             `<span class="sol-code">${code}</span>` +
             `<span class="sol-name"> — ${long}</span>` +
           `</span>`;
  }

  // Render the route as ONLY its intermediate stops (the airports that go in
  // the grid). The start and destination are already shown in the puzzle
  // header, so showing them again here would be redundant.
  // `slotInfo` (optional) is an array of {size, codes} — when present, each
  // intermediate is annotated with `(N)` showing how many airports can fill
  // that slot on a shortest route. Hovering the badge reveals the actual
  // IATA codes via the native tooltip (capped so the tooltip stays usable
  // when a slot has dozens of valid airports).
  const SLOT_TOOLTIP_CAP = 30;
  function fmtRoute(route, slotInfo) {
    const intermediates = route.slice(1, -1);
    if (intermediates.length === 0) {
      return `<span class="sol-direct">Direct flight — no intermediate stops.</span>`;
    }
    return intermediates.map((code, i) => {
      const html = fmtAirportToggle(code);
      const info = slotInfo && slotInfo[i];
      if (info != null) {
        const n = info.size;
        const codes = info.codes || [];
        // Build the hover tooltip: header line + comma-separated codes,
        // truncated if the slot has more options than will fit cleanly.
        const shown = codes.slice(0, SLOT_TOOLTIP_CAP);
        const overflow = codes.length > SLOT_TOOLTIP_CAP
          ? `, …+${codes.length - SLOT_TOOLTIP_CAP} more`
          : "";
        const header = `${n} airport${n === 1 ? "" : "s"} can fill this slot on a shortest route`;
        const tip = codes.length
          ? `${header}:\n${shown.join(", ")}${overflow}`
          : header;
        // Escape double-quotes in the title attribute. IATA codes are
        // ASCII so the codes themselves are safe; the header text is too.
        const safe = tip.replace(/"/g, "&quot;");
        return html + ` <span class="sol-slot-count" title="${safe}">(${n})</span>`;
      }
      return html;
    }).join(' <span class="sol-arrow">→</span> ');
  }

  // ---------- Share ----------
  function buildShare() {
    const emojiMap = { green: "🟩", purple: "🟪", yellow: "🟨", orange: "🟧", red: "🟥", "": "⬜" };
    const lines = [];
    const header = won
      ? `JetSets ${puzzle.id} — solved in ${attempts.length}/${MAX_ATTEMPTS}`
      : `JetSets ${puzzle.id} — X/${MAX_ATTEMPTS}`;
    lines.push(header);
    if (puzzle.stars) {
      const stars = "★".repeat(puzzle.stars) + "☆".repeat(5 - puzzle.stars);
      lines.push(`${puzzle.start} → ${puzzle.dest}  ${stars}`);
    } else {
      lines.push(`${puzzle.start} → ${puzzle.dest}`);
    }
    for (const row of attempts) {
      lines.push(row.map((c) => emojiMap[c ? c.color : ""]).join(""));
    }
    return lines.join("\n");
  }

  // Speedrun share: emit a single-line summary of the just-finished run
  // rather than the (less useful) per-puzzle grid of the last attempt.
  function buildSpeedrunShare() {
    const cfg = MODE_SPEEDRUN[speedrunModeKey] || {};
    const variant = cfg.label || "Speedrun";
    return `JetSets ${variant} — ${speedrunScore} pts in 90s, ${speedrunSolves} solved`;
  }

  shareBtn.addEventListener("click", () => {
    const isSummary = resultPanel && resultPanel.classList.contains("speedrun-summary-panel");
    const text = isSummary ? buildSpeedrunShare() : buildShare();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast_show("Copied to clipboard"));
    } else {
      prompt("Copy your result:", text);
    }
  });

  newPuzzleBtn.addEventListener("click", () => {
    // Daily is locked to one puzzle per day, so the button rolls into
    // Random instead. Every other mode just rolls a fresh puzzle from the
    // same pool; setMode handles puzzle-pickers + graph swap for us.
    if (mode === "daily") setMode("random");
    else setMode(mode);
  });

  // ---------- Input handling ----------
  input.addEventListener("input", () => {
    const list = suggest(input.value);
    suggestIndex = list.length ? 0 : -1;
    renderSuggestions(list);
  });
  input.addEventListener("keydown", (e) => {
    const visible = suggestions.classList.contains("active");
    const items = visible ? Array.from(suggestions.querySelectorAll(".suggestion")) : [];
    if (e.key === "ArrowDown" && items.length) {
      suggestIndex = (suggestIndex + 1) % items.length;
      items.forEach((el, i) => el.classList.toggle("highlighted", i === suggestIndex));
      e.preventDefault();
    } else if (e.key === "ArrowUp" && items.length) {
      suggestIndex = (suggestIndex - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("highlighted", i === suggestIndex));
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Round over? Enter rolls a fresh puzzle. For Daily — which is
      // locked to one puzzle per day — Enter sends the player into Random
      // instead, matching the "Play Random" button. During a speedrun's
      // brief auto-advance gap finished=true but the run is still going
      // — swallow the Enter so we don't accidentally restart the run.
      if (finished) {
        if (speedrunActive) return;
        setMode(mode === "daily" ? "random" : mode);
        return;
      }
      if (e.shiftKey) {
        // Shift+Enter — submit the row without trying to add another stop.
        if (!submitBtn.disabled) submitRow();
        return;
      }
      if (visible && suggestIndex >= 0 && items[suggestIndex]) {
        tryAddAirport(items[suggestIndex].getAttribute("data-code"));
      } else if (input.value.trim()) {
        // Try to interpret as IATA or top-match
        const list = suggest(input.value);
        if (list.length) tryAddAirport(list[0]);
      }
    } else if (e.key === "Escape") {
      closeSuggestions();
    } else if (e.key === "Backspace" && !input.value && currentRow.length > 0) {
      // When the text box is empty, Backspace pops the most recently added
      // waypoint off the current row (so players can undo a bad choice).
      e.preventDefault();
      closeSuggestions();
      removeLastFromRow();
    }
  });
  input.addEventListener("blur", () => {
    // Slight delay so suggestion click can register
    setTimeout(closeSuggestions, 120);
  });
  suggestions.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".suggestion");
    if (el) {
      e.preventDefault();
      tryAddAirport(el.getAttribute("data-code"));
    }
  });

  addBtn.addEventListener("click", () => {
    if (!input.value.trim()) return;
    const list = suggest(input.value);
    if (list.length) tryAddAirport(list[0]);
  });
  undoBtn.addEventListener("click", () => {
    removeLastFromRow();
    input.focus();
  });
  submitBtn.addEventListener("click", submitRow);
  if (giveUpBtn) giveUpBtn.addEventListener("click", giveUp);
  if (speedrunQuitBtn) {
    speedrunQuitBtn.addEventListener("click", () => {
      if (speedrunActive) endSpeedrun("quit");
    });
  }
  if (speedrunStartBtn) {
    speedrunStartBtn.addEventListener("click", beginSpeedrunRun);
  }

  // ---------- Result panel — close & re-open ----------
  // Corner × always dismisses the panel.
  if (modalCloseBtn) modalCloseBtn.addEventListener("click", hideResultPanel);
  // "View result" mounts the panel BELOW the grid (per design — the user
  // expects the re-opened panel to flow out from where the button sits).
  if (showResultBtn) showResultBtn.addEventListener("click", () => showResultPanelAt("bottom"));

  // Global keyboard shortcuts:
  //   Shift+Backspace  — clear the current row
  //   Shift+Enter      — submit the current row
  //   Enter (round over) — start a new puzzle of the same type
  // (When the input is focused, its own keydown handler already manages
  // Enter / Shift+Enter, so we skip here to avoid double-firing.)
  document.addEventListener("keydown", (e) => {
    // ESC dismisses the result panel if it's currently visible.
    if (e.key === "Escape" && resultPanel && resultPanel.style.display === "block") {
      e.preventDefault();
      hideResultPanel();
      return;
    }
    // Pre-start speedrun: pressing Enter kicks off the timer (same effect
    // as clicking the big yellow Start button on top of the timer block).
    if (speedrunActive && !speedrunStarted && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      beginSpeedrunRun();
      return;
    }
    if (finished) {
      if (e.key === "Enter" && !e.shiftKey && e.target !== input) {
        e.preventDefault();
        // During a speedrun auto-advance gap, swallow Enter — the next
        // puzzle is on its way and we don't want to restart the run.
        if (speedrunActive) return;
        // Daily is locked to one per day → Enter rolls into Random.
        setMode(mode === "daily" ? "random" : mode);
      }
      return;
    }
    if (e.shiftKey && e.key === "Backspace") {
      clearCurrentRow();
    } else if (e.shiftKey && e.key === "Enter" && e.target !== input) {
      e.preventDefault();
      if (!submitBtn.disabled) submitRow();
    }
  });

  // ---------- Difficulty display ----------
  // Renders the current puzzle's difficulty as a 5-star badge in the header.
  // If the puzzle has no stars field (legacy data), the badge is hidden.
  function renderDifficulty() {
    if (!difficultyEl) return;
    // In Cryptic mode the player gets no place-name hints, so the difficulty
    // tier is hidden too — every puzzle reads as five question marks.
    if (mode === "cryptic" || mode === "speedrun-cryptic") {
      let html = `<span class="label">Cryptic</span>`;
      for (let i = 0; i < 5; i++) html += `<span class="star-on">?</span>`;
      difficultyEl.innerHTML = html;
      return;
    }
    if (!puzzle) { difficultyEl.innerHTML = ""; return; }
    const stars = puzzle.stars;
    const priorP = puzzle.prior_p;
    // Compute the live (Bayesian-posterior) completion rate. The tier
    // label and star count follow the live rate, so a puzzle that's
    // proven easier than its heuristic seeded gets re-labelled in real
    // time. Falls back to the baked stars when stats.js hasn't loaded.
    let percent = null, tier = null, lowConf = true, derivedStars = stars;
    if (window.JetSetsStats && stars) {
      const r = window.JetSetsStats.computeRate(puzzle.start, puzzle.dest, priorP);
      percent = r.percent;
      tier = r.tier;
      lowConf = r.lowConfidence;
      // Map % bucket → 1..5 stars to drive the visual fill.
      if      (percent >= 80) derivedStars = 1;
      else if (percent >= 60) derivedStars = 2;
      else if (percent >= 40) derivedStars = 3;
      else if (percent >= 20) derivedStars = 4;
      else                    derivedStars = 5;
    } else if (stars) {
      // No stats engine yet — show the static tier so the header isn't blank.
      tier = ["", "Simple", "Easy", "Medium", "Hard", "Extreme"][stars];
    } else {
      difficultyEl.innerHTML = "";
      return;
    }
    let html = "";
    if (tier) html += `<span class="label">${tier}</span>`;
    for (let i = 1; i <= 5; i++) {
      html += `<span class="${i <= derivedStars ? "star-on" : "star-off"}">★</span>`;
    }
    // Percentage sits to the RIGHT of the stars, and is a clickable
    // button: tapping it toggles a sibling .rate-explainer that spells
    // out what the completion rate is and how it's calculated. Players
    // who don't care never see the explanation; curious ones can dig in.
    if (percent != null) {
      const starMark = lowConf ? `<span class="rate-est" aria-label="estimated">*</span>` : "";
      const confLine = lowConf
        ? `<span class="re-tag">Estimated &mdash; fewer than ${window.JetSetsStats.LOW_CONFIDENCE_N} real attempts so far.</span>`
        : `<span class="re-tag re-tag-live">Based on ${ (window.JetSetsStats.getStats(puzzle.start, puzzle.dest).attempts) } real player attempt${window.JetSetsStats.getStats(puzzle.start, puzzle.dest).attempts === 1 ? "" : "s"}.</span>`;
      html +=
        `<button type="button" class="rate" id="rate-toggle"
                 aria-expanded="false" aria-controls="rate-explainer"
                 title="Click to learn what this is">${percent}%${starMark}</button>`;
      html +=
        `<div class="rate-explainer" id="rate-explainer" role="region"
              aria-label="What the completion rate means" hidden>
           <p class="re-line"><b>Completion rate.</b> The fraction of players who have solved this puzzle (start → destination), across every game mode it appears in.</p>
           <p class="re-line"><b>How it's calculated.</b> A Bayesian blend of the puzzle's seeded difficulty and real player attempts &mdash; a sparsely-played puzzle leans on the seed, a heavily-played one converges on the real success rate.</p>
           <p class="re-line"><b>Tier (Simple &middot; Easy &middot; Medium &middot; Hard &middot; Extreme).</b> Recomputed from where every puzzle currently sits in the live distribution, so "Extreme" really means "in the toughest 5% of puzzles right now."</p>
           ${confLine}
         </div>`;
    }
    difficultyEl.innerHTML = html;
    // Wire the toggle. The expander lives inside the same <span> so we
    // rebind every render (cheap — one button).
    const toggleBtn = document.getElementById("rate-toggle");
    const expander  = document.getElementById("rate-explainer");
    if (toggleBtn && expander) {
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = !expander.hasAttribute("hidden");
        if (open) {
          expander.setAttribute("hidden", "");
          toggleBtn.setAttribute("aria-expanded", "false");
        } else {
          expander.removeAttribute("hidden");
          toggleBtn.setAttribute("aria-expanded", "true");
        }
      });
    }
  }

  // Re-render the difficulty badge whenever the stats cache loads or
  // updates so a freshly-bulk-fetched puzzle's % appears without a
  // round refresh, and the player's own attempt-submission reflects
  // immediately in the header.
  window.addEventListener("jetsets-stats-ready", () => {
    if (puzzle) renderDifficulty();
  });
  window.addEventListener("jetsets-stats-updated", (e) => {
    if (!puzzle) return;
    const k = `${puzzle.start}-${puzzle.dest}`;
    if (e && e.detail && e.detail.puzzleKey === k) renderDifficulty();
  });

  // ---------- Mode switching ----------
  // Wire ACTIVE_ROUTES + activeCodes for the selected mode, then pick a
  // puzzle. Continent modes swap to an intra-continent subgraph; everything
  // else uses the full ROUTES. Speedrun continent variants swap the same
  // way as the regular By-Continent modes.
  function applyModeGraph(m) {
    let cont = MODE_CONTINENT[m];
    const sr = MODE_SPEEDRUN[m];
    if (sr && sr.continent) cont = sr.continent;
    if (cont && window.CONTINENT_ROUTES && window.CONTINENT_ROUTES[cont]) {
      ACTIVE_ROUTES = window.CONTINENT_ROUTES[cont];
      activeCodes = new Set(Object.keys(ACTIVE_ROUTES));
    } else {
      ACTIVE_ROUTES = window.ROUTES;
      activeCodes = new Set(Object.keys(window.AIRPORTS));
    }
  }

  function setMode(m) {
    if (!(m in modeButtons)) return;
    // Picking any non-speedrun mode (or a fresh speedrun slug) ends any
    // in-flight run. We clear the run state up front so the rest of
    // setMode runs in a known-clean baseline; if the new mode IS a
    // speedrun, startSpeedrun re-arms it below.
    if (speedrunActive) {
      stopSpeedrunTimer();
      speedrunActive = false;
    }
    mode = m;
    for (const key of Object.keys(modeButtons)) {
      const btn = modeButtons[key];
      if (btn) btn.classList.toggle("active", key === m);
    }
    // Light up the dropdown trigger if its child is the active mode (so the
    // collapsed dropdown still reads as "selected" at a glance).
    const isDifficulty = MODE_STARS[m] != null;
    const isContinent  = !!MODE_CONTINENT[m];
    const isLayovers   = MODE_LAYOVERS[m] != null;
    const isSpeedrun   = !!MODE_SPEEDRUN[m];
    const ddDiff = document.getElementById("dropdown-difficulty");
    const ddCont = document.getElementById("dropdown-continent");
    const ddLay  = document.getElementById("dropdown-layovers");
    const ddSr   = document.getElementById("dropdown-speedrun");
    if (ddDiff) ddDiff.classList.toggle("has-active", isDifficulty);
    if (ddCont) ddCont.classList.toggle("has-active", isContinent);
    if (ddLay)  ddLay.classList.toggle("has-active", isLayovers);
    if (ddSr)   ddSr.classList.toggle("has-active", isSpeedrun);
    applyModeGraph(m);

    // Cryptic strips every place-name surface from the UI. Toggle the body
    // class first so all the renders below pick the right styling. The
    // cryptic speedrun variant gets the same treatment.
    document.body.classList.toggle(
      "cryptic-mode",
      m === "cryptic" || m === "speedrun-cryptic"
    );

    // Speedrun modes take a different path — they manage their own puzzle
    // sequence + 60s timer. startSpeedrun picks the first puzzle and calls
    // startPuzzle internally, so we return early. (The .speedrun-active
    // body class — which drives the puzzle-header corner padding — is
    // toggled inside updateSpeedrunHud so it tracks the live HUD state.)
    if (isSpeedrun) {
      startSpeedrun(m);
      return;
    }
    // Non-speedrun: hide the HUD if it was visible.
    updateSpeedrunHud();

    let next = null;
    if (m === "daily") {
      next = dailyPuzzle();
    } else if (m === "random") {
      next = randomPuzzleAnyTier();
    } else if (m === "cryptic") {
      // Cryptic plays a random puzzle from any tier — same picker as Random.
      next = randomPuzzleAnyTier();
      if (next) next.id = `Cryptic #${next.id.split("#")[1] || ""}`.trim();
    } else if (MODE_CONTINENT[m]) {
      next = randomContinentPuzzle(MODE_CONTINENT[m]);
    } else if (MODE_LAYOVERS[m] != null) {
      next = randomPuzzleByLayovers(MODE_LAYOVERS[m]);
    } else {
      next = randomPuzzleByStars(MODE_STARS[m]);
    }
    if (!next) {
      // Defensive: continent pool empty (shouldn't happen with prebuilt data).
      toast_show(`No puzzles available for ${MODE_LABELS[m] || m}.`);
      return;
    }
    puzzle = next;
    startPuzzle();
  }
  for (const key of Object.keys(modeButtons)) {
    const btn = modeButtons[key];
    if (btn) btn.addEventListener("click", () => setMode(key));
  }

  // ---------- Dropdowns (By Difficulty / By Continent) ----------
  // Hover handles the desktop case via CSS; click toggles for keyboard /
  // touch users, and clicking outside closes any open menu.
  (function wireDropdowns() {
    const dropdowns = Array.from(document.querySelectorAll(".mode-dropdown"));
    if (!dropdowns.length) return;

    function closeAll(except) {
      for (const d of dropdowns) {
        if (d === except) continue;
        d.classList.remove("open");
        const t = d.querySelector(".mode-trigger");
        if (t) t.setAttribute("aria-expanded", "false");
      }
    }

    for (const d of dropdowns) {
      const trigger = d.querySelector(".mode-trigger");
      if (!trigger) continue;
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        // Special case: clicking the Speedrun trigger directly starts a
        // global speedrun. The hover-menu still exposes the continent
        // and cryptic variants for picking.
        if (trigger.id === "trigger-speedrun") {
          closeAll(null);
          setMode("speedrun-global");
          return;
        }
        const wasOpen = d.classList.contains("open");
        closeAll(d);
        d.classList.toggle("open", !wasOpen);
        trigger.setAttribute("aria-expanded", String(!wasOpen));
      });
      // Picking a child mode collapses the dropdown.
      d.querySelectorAll(".mode-menu button").forEach((b) => {
        b.addEventListener("click", () => closeAll(null));
      });
    }
    // Close any open dropdown when clicking elsewhere.
    document.addEventListener("click", () => closeAll(null));
  })();

  // ---------- Go ----------
  if (!window.AIRPORTS || !window.ROUTES || !window.PUZZLES) {
    statusBar.textContent = "Failed to load flight data. (Are you opening index.html directly? That should still work — check console.)";
    statusBar.className = "status-bar lose";
    return;
  }
  // Initialize the globe panel (if it exists on the page)
  const globeEl = document.getElementById("globe");
  if (globeEl && window.JetSetsGlobe) {
    JetSetsGlobe.init(globeEl, AIRPORTS, window.COASTLINES || null);
  }

  // Wire up the zoom controls overlaid on the map.
  const zoomInBtn = document.getElementById("zoom-in");
  const zoomOutBtn = document.getElementById("zoom-out");
  const zoomResetBtn = document.getElementById("zoom-reset");
  if (zoomInBtn && window.JetSetsGlobe) {
    zoomInBtn.addEventListener("click", () => JetSetsGlobe.zoomBy(1.25));
  }
  if (zoomOutBtn && window.JetSetsGlobe) {
    zoomOutBtn.addEventListener("click", () => JetSetsGlobe.zoomBy(0.8));
  }
  if (zoomResetBtn && window.JetSetsGlobe) {
    zoomResetBtn.addEventListener("click", () => JetSetsGlobe.resetView());
  }

  setMode("daily");

  // ---------- External hooks ----------
  // app.js (the View router) takes the globe over for the Learn page. When
  // the user returns to the game view we need to put the globe back into
  // the right state — this helper re-applies puzzle + history + draft (and
  // the post-round solution if one was rendered).
  window.JetSets = {
    refreshGlobe() {
      if (!window.JetSetsGlobe || !puzzle) return;
      JetSetsGlobe.setPuzzle(puzzle.start, puzzle.dest);
      JetSetsGlobe.setHistory(attempts);
      JetSetsGlobe.setDraft(currentRow);
      if (lastSolutionRoute) JetSetsGlobe.setSolution(lastSolutionRoute);
    },
    // Restart the daily puzzle. Used by the title-link click when the user
    // is already on the game view but we still want a clean reset.
    goDaily() { setMode("daily"); },
  };
})();
