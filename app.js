/* JetSets — top-level "shell" wiring around the game.
 * Responsibilities:
 *   - Hamburger menu (About / Learn) and view switching
 *   - About page stats (computed once from AIRPORTS / ROUTES / PUZZLES)
 *   - Learn page: airport search → globe hub view + connections table
 *
 * The globe is a singleton (state lives inside globe.js). When the Learn
 * view is active we re-parent the .map-panel into #learn-map-host and call
 * JetSetsGlobe.setHub(...). When returning to the game we move it back and
 * ask game.js to re-apply its state via window.JetSets.refreshGlobe().
 */
(function () {
  "use strict";

  // ---------- View switching ----------
  const views = {
    game:  document.getElementById("view-game"),
    about: document.getElementById("view-about"),
    learn: document.getElementById("view-learn"),
  };
  const navMenu      = document.getElementById("nav-menu");
  const navToggle    = document.getElementById("nav-toggle");
  const navAbout     = document.getElementById("nav-about");
  const navLearn     = document.getElementById("nav-learn");
  const titleLink    = document.getElementById("title-link");
  const mapPanel     = document.querySelector(".map-panel");
  // Where the map lives in each view — we move .map-panel between them.
  const gameMapHost  = document.querySelector("#view-game .right-col");
  const learnMapHost = document.getElementById("learn-map-host");

  let activeView = "game";

  function setView(name) {
    if (!views[name]) return;
    activeView = name;
    for (const k of Object.keys(views)) {
      views[k].classList.toggle("active", k === name);
    }
    // Highlight the menu items so the popover reflects the current view.
    if (navAbout) navAbout.classList.toggle("active", name === "about");
    if (navLearn) navLearn.classList.toggle("active", name === "learn");

    if (name === "learn") {
      // Move the map into the Learn page. If we already have a selected
      // airport, redraw its hub; otherwise reset the globe so it's neutral.
      if (mapPanel && learnMapHost && mapPanel.parentNode !== learnMapHost) {
        learnMapHost.appendChild(mapPanel);
      }
      if (currentHub) {
        applyHub(currentHub);
      } else if (window.JetSetsGlobe) {
        window.JetSetsGlobe.reset();
      }
    } else {
      // Anything but Learn: put the map back in the game's right column,
      // clear hub overlay, and re-apply the game's state.
      if (mapPanel && gameMapHost && mapPanel.parentNode !== gameMapHost) {
        // Insert the map-panel as the first child so the legend stays below.
        gameMapHost.insertBefore(mapPanel, gameMapHost.firstChild);
      }
      if (window.JetSetsGlobe) {
        window.JetSetsGlobe.clearHub();
      }
      if (window.JetSets && typeof window.JetSets.refreshGlobe === "function") {
        window.JetSets.refreshGlobe();
      }
    }
  }

  // Menu open/close
  function setMenuOpen(open) {
    if (!navMenu || !navToggle) return;
    navMenu.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", String(open));
  }
  if (navToggle) {
    navToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setMenuOpen(!navMenu.classList.contains("open"));
    });
  }
  document.addEventListener("click", () => setMenuOpen(false));
  if (navAbout) navAbout.addEventListener("click", () => { setView("about"); setMenuOpen(false); });
  if (navLearn) navLearn.addEventListener("click", () => { setView("learn"); setMenuOpen(false); });
  if (titleLink) {
    titleLink.addEventListener("click", () => {
      // "Clicking JetSets reverts to the main page and the daily puzzle."
      // Switch to the game view, then reseed to the daily.
      setView("game");
      setMenuOpen(false);
      if (window.JetSets && typeof window.JetSets.goDaily === "function") {
        window.JetSets.goDaily();
      }
    });
  }

  // ---------- About page stats ----------
  function computeStats() {
    const airports = window.AIRPORTS || {};
    const routes = window.ROUTES || {};
    const puzzles = window.PUZZLES || [];

    const codes = Object.keys(airports);
    let edgeCount = 0;
    let maxDeg = 0;
    let maxDegCode = null;
    const tierCounts = { 1: 0, 2: 0, 3: 0 };
    for (const c of codes) {
      const deg = (routes[c] || []).length;
      edgeCount += deg;
      if (deg > maxDeg) { maxDeg = deg; maxDegCode = c; }
      const t = airports[c].tier;
      if (t in tierCounts) tierCounts[t]++;
    }
    const uniquePairs = Math.round(edgeCount / 2);
    const avgDeg = codes.length ? (edgeCount / codes.length) : 0;

    // Continent coverage from CONTINENT_PUZZLES (keys are display names).
    const continents = (window.CONTINENT_PUZZLES && Object.keys(window.CONTINENT_PUZZLES).length) || 0;

    return {
      airports: codes.length,
      pairs: uniquePairs,
      puzzles: puzzles.length,
      avgDeg,
      maxDeg,
      maxDegCode,
      tier1: tierCounts[1],
      tier2: tierCounts[2],
      tier3: tierCounts[3],
      continents,
    };
  }

  function renderAboutStats() {
    const host = document.getElementById("about-stats");
    if (!host) return;
    const s = computeStats();
    const A = window.AIRPORTS || {};
    const hubCity = (s.maxDegCode && A[s.maxDegCode])
      ? `${s.maxDegCode} (${A[s.maxDegCode].city})`
      : (s.maxDegCode || "—");
    const cells = [
      [s.airports.toLocaleString(),         "Airports"],
      [s.pairs.toLocaleString(),            "Direct flight pairs"],
      [s.puzzles.toLocaleString(),          "Puzzles in pool"],
      [s.avgDeg.toFixed(1),                 "Avg connections / airport"],
      [`${s.maxDeg}`,                       `Most connected — ${hubCity}`],
      [s.continents.toString(),             "Continent modes"],
      [s.tier1.toString(),                  "Tier 1 mega-hubs"],
      [s.tier2.toString(),                  "Tier 2 majors"],
    ];
    host.innerHTML = cells.map(([num, label]) =>
      `<div class="stat"><div class="num">${num}</div><div class="label">${label}</div></div>`
    ).join("");
  }
  renderAboutStats();

  // ---------- Learn page ----------
  const learnInput        = document.getElementById("learn-input");
  const learnSuggestions  = document.getElementById("learn-suggestions");
  const learnInfo         = document.getElementById("learn-info");
  const connectionsTbody  = document.getElementById("connections-tbody");
  const connectionsCount  = document.getElementById("connections-count");

  // Cache of all airport codes for the autocomplete.
  const ALL_CODES = Object.keys(window.AIRPORTS || {});
  let learnIndex = -1;
  let currentHub = null;  // selected IATA code

  function searchAirports(q) {
    q = q.trim().toUpperCase();
    if (!q) return [];
    const A = window.AIRPORTS;
    const out = [];
    for (const code of ALL_CODES) {
      const a = A[code];
      if (!a) continue;
      const hay = code + " " + (a.city || "").toUpperCase() + " " +
                  (a.name || "").toUpperCase() + " " + (a.country || "").toUpperCase();
      if (hay.includes(q)) out.push(code);
      if (out.length >= 30) break;
    }
    // Prefer exact / prefix matches on IATA code first.
    out.sort((a, b) => {
      const aPref = a.startsWith(q) ? 0 : 1;
      const bPref = b.startsWith(q) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.localeCompare(b);
    });
    return out.slice(0, 12);
  }

  function renderLearnSuggestions(codes) {
    if (!learnSuggestions) return;
    if (!codes.length) {
      learnSuggestions.classList.remove("active");
      learnSuggestions.innerHTML = "";
      learnIndex = -1;
      return;
    }
    const A = window.AIRPORTS;
    learnSuggestions.innerHTML = codes.map((c, i) => {
      const a = A[c];
      return `<div class="suggestion${i === learnIndex ? " highlighted" : ""}" data-code="${c}">
        <span><span class="s-code">${c}</span><span class="s-city"> · ${a.name || a.city}</span></span>
        <span class="s-country">${a.country || ""}</span>
      </div>`;
    }).join("");
    learnSuggestions.classList.add("active");
    learnSuggestions.querySelectorAll(".suggestion").forEach((el) => {
      el.addEventListener("click", () => {
        const code = el.getAttribute("data-code");
        selectLearnAirport(code);
      });
    });
  }

  function closeLearnSuggestions() {
    if (!learnSuggestions) return;
    learnSuggestions.classList.remove("active");
    learnSuggestions.innerHTML = "";
    learnIndex = -1;
  }

  function applyHub(code) {
    const A = window.AIRPORTS, R = window.ROUTES;
    if (!A || !R || !A[code]) return;
    const neighbors = (R[code] || []).slice();
    if (window.JetSetsGlobe) {
      window.JetSetsGlobe.setHub(code, neighbors);
    }
    renderHubInfo(code, neighbors);
    renderConnectionsTable(code, neighbors);
  }

  function selectLearnAirport(code) {
    if (!code || !window.AIRPORTS || !window.AIRPORTS[code]) return;
    currentHub = code;
    learnInput.value = code;
    closeLearnSuggestions();
    if (activeView !== "learn") {
      // Selecting an airport implies the user wants to see it on the Learn
      // page — switch in.
      setView("learn");
    } else {
      applyHub(code);
    }
  }

  function renderHubInfo(code, neighbors) {
    if (!learnInfo) return;
    const A = window.AIRPORTS;
    const a = A[code];
    if (!a) {
      learnInfo.innerHTML = `<p class="hub-empty">Airport not found.</p>`;
      return;
    }
    // Continents reachable from this hub directly.
    const continents = new Set();
    for (const nb of neighbors) {
      const x = A[nb];
      if (x && x.continent) continents.add(x.continent);
    }
    const tierLabel = a.tier === 1 ? "Tier 1 mega-hub"
                    : a.tier === 2 ? "Tier 2 major"
                    : "Tier 3";
    learnInfo.innerHTML = `
      <h3 class="hub-name">${code} — ${a.name || a.city || ""}</h3>
      <p class="hub-place">${a.city || ""}${a.country ? ", " + a.country : ""}</p>
      <div class="hub-meta">
        <span><strong>${neighbors.length}</strong>direct connections</span>
        <span><strong>${continents.size}</strong>continent${continents.size === 1 ? "" : "s"} reached</span>
        <span><strong>${tierLabel}</strong></span>
      </div>
    `;
  }

  function renderConnectionsTable(code, neighbors) {
    if (!connectionsTbody) return;
    const A = window.AIRPORTS;
    if (!neighbors.length) {
      connectionsTbody.innerHTML = `<tr><td colspan="5" class="empty">No connections found for ${code}.</td></tr>`;
      if (connectionsCount) connectionsCount.textContent = "";
      return;
    }
    // Sort by tier (1→3) then city alphabetically — top hubs surface first.
    const rows = neighbors.slice().sort((x, y) => {
      const ax = A[x] || {}, ay = A[y] || {};
      const tx = ax.tier || 9, ty = ay.tier || 9;
      if (tx !== ty) return tx - ty;
      return (ax.city || x).localeCompare(ay.city || y);
    });
    connectionsTbody.innerHTML = rows.map((c) => {
      const a = A[c] || {};
      const tier = a.tier ? `T${a.tier}` : "";
      return `<tr>
        <td class="col-code">${c}</td>
        <td>${a.name || ""}</td>
        <td>${a.city || ""}</td>
        <td>${a.country || ""}</td>
        <td class="col-tier">${tier}</td>
      </tr>`;
    }).join("");
    if (connectionsCount) {
      connectionsCount.textContent = `${neighbors.length} airport${neighbors.length === 1 ? "" : "s"}`;
    }
  }

  // Wire the search input
  if (learnInput) {
    learnInput.addEventListener("input", () => {
      const codes = searchAirports(learnInput.value);
      learnIndex = codes.length ? 0 : -1;
      renderLearnSuggestions(codes);
    });
    learnInput.addEventListener("keydown", (e) => {
      if (!learnSuggestions || !learnSuggestions.classList.contains("active")) {
        if (e.key === "Enter" && learnInput.value.trim()) {
          // No dropdown open — try a direct code lookup.
          const code = learnInput.value.trim().toUpperCase();
          if (window.AIRPORTS && window.AIRPORTS[code]) {
            selectLearnAirport(code);
          }
        }
        return;
      }
      const items = learnSuggestions.querySelectorAll(".suggestion");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        learnIndex = Math.min(items.length - 1, learnIndex + 1);
        items.forEach((el, i) => el.classList.toggle("highlighted", i === learnIndex));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        learnIndex = Math.max(0, learnIndex - 1);
        items.forEach((el, i) => el.classList.toggle("highlighted", i === learnIndex));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const el = items[learnIndex] || items[0];
        if (el) selectLearnAirport(el.getAttribute("data-code"));
      } else if (e.key === "Escape") {
        closeLearnSuggestions();
      }
    });
    learnInput.addEventListener("blur", () => {
      // Delay so click-on-suggestion still fires.
      setTimeout(closeLearnSuggestions, 150);
    });
  }
})();
