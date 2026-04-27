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

  // ---------- State ----------
  // Mode names: 'daily', 'random', 'simple'..'extreme', or a continent slug
  // ('africa', 'europe', 'north-america', 'south-america', 'asia', 'oceania').
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
    cryptic: "Cryptic",
  };
  let attempts = []; // [[{code, color}, ...], ...]
  let currentRow = []; // draft row of airport codes
  let finished = false;
  let won = false;
  // Cached BFS distance map from destination: { iata: minHopsToDest }
  let distToDest = null;
  // Set of airports on at least one shortest start→dest path
  let shortestPathAirports = null;
  // Per-slot sets: airport must appear at slot index i on at least one shortest path
  let shortestPathBySlot = null;

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
    cryptic:         $("mode-cryptic"),
  };
  const difficultyEl = $("puzzle-difficulty");
  const toast = $("toast");

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
  for (let i = 0; i < PUZZLES.length; i++) {
    const p = PUZZLES[i];
    const s = p.stars;
    if (s >= 1 && s <= 5) {
      PUZZLES_BY_STARS[s].push(i);
    }
  }

  function dailyPuzzle() {
    const idx = dateSeed() % PUZZLES.length;
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

  // "Random" mode: any puzzle from any difficulty tier in the global pool.
  function randomPuzzleAnyTier() {
    const idx = Math.floor(Math.random() * PUZZLES.length);
    return Object.assign({ id: `Random #${idx + 1}` }, PUZZLES[idx]);
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
    return { onPath, slots, total, distFromDest };
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
      return `<div class="suggestion${i === suggestIndex ? " highlighted" : ""}" data-code="${code}">
                <span><span class="s-code">${code}</span><span class="s-city">${a.city}</span></span>
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

  // ---------- Game flow ----------
  function startPuzzle() {
    attempts = [];
    currentRow = [];
    finished = false;
    won = false;
    resultPanel.classList.remove("visible");

    $("start-code").textContent = puzzle.start;
    $("start-city").textContent = AIRPORTS[puzzle.start].city;
    $("dest-code").textContent = puzzle.dest;
    $("dest-city").textContent = AIRPORTS[puzzle.dest].city;
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
    // If this row connects start→dest but used MORE stops than the shortest
    // path, repaint every filled cell light-green so the player can see at
    // a glance that they got there but not optimally.
    if (graded.fullyConnects && graded.stopsUsed > (puzzle.shortest_hops - 1)) {
      for (let i = 0; i < rowData.length; i++) {
        if (rowData[i]) rowData[i].color = "lightgreen";
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
      showResult(true, graded.stopsUsed, attempts.length);
    } else if (attempts.length >= MAX_ATTEMPTS) {
      finished = true;
      won = false;
      renderGrid();
      showResult(false, null, attempts.length);
    } else {
      renderGrid();
      statusBar.textContent = `Not quite — ${MAX_ATTEMPTS - attempts.length} ${MAX_ATTEMPTS - attempts.length === 1 ? "try" : "tries"} left.`;
      statusBar.className = "status-bar";
      // Keep typing flow uninterrupted between attempts.
      if (input) input.focus();
    }
  }

  // ---------- Scoring ----------
  function score(stopsUsed, attemptsUsed) {
    // Points = (max_stops − stops_used) × attempts_bonus
    // max_stops = 5 (slots). attempts_bonus = (MAX_ATTEMPTS + 1 − attemptsUsed).
    // Direct flight on first try: (5 - 0) * 6 = 30.
    // Shortest route (e.g. 3 stops) on 3rd try: (5 - 3) * 4 = 8.
    return (SLOTS - stopsUsed) * (MAX_ATTEMPTS + 1 - attemptsUsed);
  }

  function showResult(winFlag, stopsUsed, attemptsUsed, gaveUp) {
    resultPanel.classList.add("visible");
    if (winFlag) {
      const pts = score(stopsUsed, attemptsUsed);
      const matched = stopsUsed === (puzzle.shortest_hops - 1);
      resultHeading.textContent = matched
        ? "You nailed the shortest route!"
        : "Route complete!";
      resultStats.innerHTML =
        `<div><strong>${stopsUsed}</strong>stops used</div>` +
        `<div><strong>${attemptsUsed}/${MAX_ATTEMPTS}</strong>attempts</div>` +
        `<div><strong>${pts}</strong>points</div>`;
      statusBar.textContent = "Solved!";
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
    // Daily is locked to one puzzle per day; every difficulty mode lets the
    // player roll a fresh puzzle in the same tier.
    if (mode === "daily") {
      newPuzzleBtn.style.display = "none";
    } else {
      newPuzzleBtn.style.display = "inline-block";
      newPuzzleBtn.textContent = `New ${MODE_LABELS[mode]} puzzle`;
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
    showResult(false, null, attempts.length, /* gaveUp */ true);
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
    block.innerHTML =
      `<div class="solution-label">Shortest ${stopsLabel} ${counterHtml}</div>
       <div class="solution-route" id="solution-primary">${fmtRoute(routes[0])}</div>
       <div class="solution-list" id="solution-list" style="display:none"></div>`;
    // Highlight the chosen primary shortest route on the globe so the player
    // can see exactly where it goes geographically.
    if (window.JetSetsGlobe) {
      JetSetsGlobe.setSolution(routes[0]);
    }
    if (count > 1) {
      const link = document.getElementById("solution-count");
      const list = document.getElementById("solution-list");
      const primary = document.getElementById("solution-primary");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const isHidden = list.style.display === "none";
        if (isHidden) {
          let html = "";
          // Render every enumerated route (we already capped at 50)
          for (let i = 0; i < routes.length; i++) {
            html += `<div class="solution-route">
                       <span class="solution-num">${i + 1}.</span>
                       ${fmtRoute(routes[i])}
                     </div>`;
          }
          if (count > routes.length) {
            html += `<div class="solution-more">…and ${count - routes.length} more not shown</div>`;
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
  function fmtRoute(route) {
    const intermediates = route.slice(1, -1);
    if (intermediates.length === 0) {
      return `<span class="sol-direct">Direct flight — no intermediate stops.</span>`;
    }
    return intermediates.map(fmtAirportToggle).join(' <span class="sol-arrow">→</span> ');
  }

  // ---------- Share ----------
  function buildShare() {
    const emojiMap = { green: "🟩", lightgreen: "🟢", yellow: "🟨", orange: "🟧", red: "🟥", "": "⬜" };
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

  shareBtn.addEventListener("click", () => {
    const text = buildShare();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast_show("Copied to clipboard"));
    } else {
      prompt("Copy your result:", text);
    }
  });

  newPuzzleBtn.addEventListener("click", () => {
    if (mode === "daily") return; // Daily has only one puzzle per day.
    // Re-running setMode handles all the puzzle-pickers + graph swap, so
    // continent modes correctly draw from their own pool.
    setMode(mode);
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
      if (e.shiftKey) {
        // Shift+Enter — submit the row without trying to add another stop.
        if (!finished && !submitBtn.disabled) submitRow();
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

  // Global keyboard shortcuts:
  //   Shift+Backspace  — clear the current row
  //   Shift+Enter      — submit the current row
  // (When the input is focused, its own keydown handler already manages
  // Shift+Enter, so we skip here to avoid a double-submit.)
  document.addEventListener("keydown", (e) => {
    if (finished) return;
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
    const stars = puzzle && puzzle.stars;
    if (!stars) { difficultyEl.innerHTML = ""; return; }
    const tierLabel = ["", "Simple", "Easy", "Medium", "Hard", "Extreme"][stars];
    let html = `<span class="label">${tierLabel}</span>`;
    for (let i = 1; i <= 5; i++) {
      html += `<span class="${i <= stars ? "star-on" : "star-off"}">★</span>`;
    }
    difficultyEl.innerHTML = html;
  }

  // ---------- Mode switching ----------
  // Wire ACTIVE_ROUTES + activeCodes for the selected mode, then pick a
  // puzzle. Continent modes swap to an intra-continent subgraph; everything
  // else uses the full ROUTES.
  function applyModeGraph(m) {
    const cont = MODE_CONTINENT[m];
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
    mode = m;
    for (const key of Object.keys(modeButtons)) {
      const btn = modeButtons[key];
      if (btn) btn.classList.toggle("active", key === m);
    }
    // Light up the dropdown trigger if its child is the active mode (so the
    // collapsed dropdown still reads as "selected" at a glance).
    const isDifficulty = MODE_STARS[m] != null;
    const isContinent  = !!MODE_CONTINENT[m];
    const ddDiff = document.getElementById("dropdown-difficulty");
    const ddCont = document.getElementById("dropdown-continent");
    if (ddDiff) ddDiff.classList.toggle("has-active", isDifficulty);
    if (ddCont) ddCont.classList.toggle("has-active", isContinent);
    applyModeGraph(m);

    // Cryptic strips every place-name surface from the UI. Toggle the body
    // class first so all the renders below pick the right styling.
    document.body.classList.toggle("cryptic-mode", m === "cryptic");

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
})();
