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
    game:        document.getElementById("view-game"),
    about:       document.getElementById("view-about"),
    learn:       document.getElementById("view-learn"),
    leaderboard: document.getElementById("view-leaderboard"),
  };
  const navMenu        = document.getElementById("nav-menu");
  const navToggle      = document.getElementById("nav-toggle");
  const navAbout       = document.getElementById("nav-about");
  const navLearn       = document.getElementById("nav-learn");
  const navLeaderboard = document.getElementById("nav-leaderboard");
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
    if (navAbout)       navAbout.classList.toggle("active",       name === "about");
    if (navLearn)       navLearn.classList.toggle("active",       name === "learn");
    if (navLeaderboard) navLeaderboard.classList.toggle("active", name === "leaderboard");

    // Leaderboard view triggers its own lazy fetch on entry. Refetches
    // on every visit so a score submitted earlier in the session shows
    // up without a reload.
    if (name === "leaderboard" && window.JetSetsLeaderboard) {
      window.JetSetsLeaderboard.refresh();
    }

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
  if (navAbout)       navAbout.addEventListener("click",       () => { setView("about");       setMenuOpen(false); });
  if (navLearn)       navLearn.addEventListener("click",       () => { setView("learn");       setMenuOpen(false); });
  if (navLeaderboard) navLeaderboard.addEventListener("click", () => { setView("leaderboard"); setMenuOpen(false); });

  // ---------- Ambient background planes ----------
  // Spawns a small fleet of slowly-drifting ✈ glyphs behind the page
  // content. Each plane gets its own animation duration, delay, vertical
  // position, size, opacity, and tilt — randomized once on load so the
  // field looks scattered rather than parallel. A negative animation-delay
  // (between -duration and 0) means each plane starts mid-flight, so the
  // page renders with planes already on screen instead of a five-second
  // wait for the first one to arrive.
  function spawnBackgroundPlanes() {
    // Respect users who've asked for reduced motion in their OS settings.
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // If already mounted (e.g. from a previous init in the same session),
    // skip — we don't want to stack fleets on re-entry.
    if (document.getElementById("bg-planes")) return;
    const container = document.createElement("div");
    container.className = "bg-planes";
    container.id = "bg-planes";
    container.setAttribute("aria-hidden", "true");
    // Two top-down passenger-jet silhouettes, both pointing EAST at
    // rotation 0 and sharing the same 56×56 viewBox so render sizing
    // works the same for both. The fleet draws from this set with a
    // weight: narrow-bodies are far more common in real life, so the
    // 737-style silhouette gets the majority.
    //   [0] Narrow-body (737 / A320): modest 15° wing sweep, slim
    //       fuselage, small horizontal stabilizers. Wing tips at
    //       x=26 — barely behind the wing roots.
    //   [1] Wide-body (747-style): aggressive 40° wing sweep, the
    //       defining 747 silhouette. Wing tips at x=14 — well behind
    //       the wing roots, so the wings look distinctly angular.
    //       Slightly larger tail stabilizers too.
    const PLANE_SVGS = [
      '<svg viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
        '<path d="M0 28 L3 16 L10 26 L22 26 L26 0 L32 26 L52 25 L56 28 L52 31 L32 30 L26 56 L22 30 L10 30 L3 40 Z"/>' +
      '</svg>',
      '<svg viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
        '<path d="M0 28 L3 14 L10 26 L24 26 L14 0 L36 26 L52 25 L56 28 L52 31 L36 30 L14 56 L24 30 L10 30 L3 42 Z"/>' +
      '</svg>',
    ];
    // Weight of the wide-body silhouette. 0.30 ≈ "one in three is a
    // 747 / wide-body, the rest are narrow-bodies." Tweak between
    // 0 (no wide-bodies) and 1 (all wide-bodies) to taste.
    const WIDE_BODY_PROBABILITY = 0.30;
    const PLANE_COUNT = 14;
    // Half-length of each plane's flight path in viewport units. 90 is
    // wide enough that the planes are fully off-screen at the endpoints
    // even on portrait phones (where vw and vh diverge).
    const HALF_LEN = 90;
    for (let i = 0; i < PLANE_COUNT; i++) {
      const plane = document.createElement("div");
      plane.className = "bg-plane";
      // Pick the silhouette for this plane. Wide-bodies are a minority
      // (real fleet ratios skew narrow-body); see WIDE_BODY_PROBABILITY.
      const isWideBody = Math.random() < WIDE_BODY_PROBABILITY;
      plane.innerHTML = PLANE_SVGS[isWideBody ? 1 : 0];
      // Heading: any direction, 0–360°. Since the SVG points east at
      // rotation 0, the rotation we apply IS the heading.
      const headingDeg = Math.random() * 360;
      const headingRad = headingDeg * Math.PI / 180;
      const dx = Math.cos(headingRad);
      const dy = Math.sin(headingRad);
      // Pick a random viewport point the flight path passes through.
      // Using vw for both axes keeps the geometry square — important
      // because the path length is measured in vw and we want the
      // visual angle to look correct regardless of viewport ratio.
      const midX = Math.random() * 100;
      const midY = Math.random() * 100;
      const fromX = midX - dx * HALF_LEN;
      const fromY = midY - dy * HALF_LEN;
      const toX   = midX + dx * HALF_LEN;
      const toY   = midY + dy * HALF_LEN;
      // 40–95s crossing time gives a calm, parallax-y range of speeds.
      const duration = 40 + Math.random() * 55;
      // Negative delay seeds the field with planes already in flight
      // on first paint, so the sky doesn't look empty for 30 seconds.
      const delay = -Math.random() * duration;
      // 16–34px square base; wide-bodies render 1.25× bigger to reflect
      // their real-world size (747 ≈ 1.8× the wingspan of a 737, so
      // 1.25× in pixels is a modest visual nod without dominating).
      const baseWidth = 16 + Math.random() * 18;
      const width = isWideBody ? baseWidth * 1.25 : baseWidth;
      const opacity = 0.18 + Math.random() * 0.15;
      plane.style.width = width + "px";
      plane.style.height = width + "px";
      plane.style.opacity = opacity;
      plane.style.animationDuration = duration + "s";
      plane.style.animationDelay = delay + "s";
      plane.style.setProperty("--angle", headingDeg.toFixed(2) + "deg");
      // vw on both axes keeps the path geometry square regardless of
      // viewport aspect ratio, so a 45° heading looks like a true 45°
      // diagonal on any device.
      plane.style.setProperty("--from-x", fromX.toFixed(2) + "vw");
      plane.style.setProperty("--from-y", fromY.toFixed(2) + "vw");
      plane.style.setProperty("--to-x",   toX.toFixed(2)   + "vw");
      plane.style.setProperty("--to-y",   toY.toFixed(2)   + "vw");
      container.appendChild(plane);
    }
    document.body.appendChild(container);
  }
  spawnBackgroundPlanes();

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
      // Lead with CITY, not the long airport name. A lot of OpenFlights
      // names contain hyphens or qualifiers (e.g. "Berlin-Tegel Airport",
      // "Aspen-Pitkin Co/Sardy Field") which can read like a city-pair
      // route at a glance. The city is the most recognisable identifier
      // anyway — we keep the airport name as a smaller subline.
      const cityLabel = a.city || a.name || "";
      const subName = a.name && a.city && a.name !== a.city ? a.name : "";
      return `<div class="suggestion${i === learnIndex ? " highlighted" : ""}" data-code="${c}">
        <span class="s-main">
          <span class="s-code">${c}</span>
          <span class="s-city"> · ${cityLabel}</span>
          ${subName ? `<span class="s-name">${subName}</span>` : ""}
        </span>
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
    renderHubPanel(code, neighbors);
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

  // Renders the hub title, meta line, and compact connections table all
  // INSIDE .learn-info — a single right-hand panel beside the map.
  function renderHubPanel(code, neighbors) {
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

    // Sort connections by tier then city — top hubs first.
    const rows = neighbors.slice().sort((x, y) => {
      const ax = A[x] || {}, ay = A[y] || {};
      const tx = ax.tier || 9, ty = ay.tier || 9;
      if (tx !== ty) return tx - ty;
      return (ax.city || x).localeCompare(ay.city || y);
    });

    const tableRows = rows.length
      ? rows.map((c) => {
          const x = A[c] || {};
          const label = x.name || x.city || c;
          return `<tr data-code="${c}">
            <td class="col-code">${c}</td>
            <td>${label}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="2" class="empty">No connections found for ${code}.</td></tr>`;

    learnInfo.innerHTML = `
      <h3 class="hub-name">${code} — ${a.name || a.city || ""}</h3>
      <p class="hub-place">${a.city || ""}${a.country ? ", " + a.country : ""}</p>
      <div class="hub-meta">
        <span><strong>${neighbors.length}</strong>direct connections</span>
        <span><strong>${continents.size}</strong>continent${continents.size === 1 ? "" : "s"} reached</span>
        <span><strong>${tierLabel}</strong></span>
      </div>
      <div class="connections">
        <div class="connections-head">
          <span>Connecting flights</span>
          <span class="count">${neighbors.length} airport${neighbors.length === 1 ? "" : "s"}</span>
        </div>
        <div class="connections-body">
          <table class="connections-list">
            <thead><tr><th class="col-code">Code</th><th>Airport</th></tr></thead>
            <tbody id="connections-tbody">${tableRows}</tbody>
          </table>
        </div>
      </div>
    `;

    // Row click → re-pivot the Learn view onto the clicked airport so the
    // user can step outward through the network. Mirrors clicking the
    // matching dot on the globe.
    const tbody = learnInfo.querySelector("#connections-tbody");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const tr = e.target.closest("tr[data-code]");
        if (!tr) return;
        const c = tr.getAttribute("data-code");
        if (!c) return;
        selectLearnAirport(c);
      });
    }
  }

  // Globe dispatches "hub-pivot" when the user clicks a neighbor dot on
  // the map. We treat that as a search for that airport — pivot the hub.
  document.addEventListener("hub-pivot", (e) => {
    const code = e.detail && e.detail.code;
    if (code) selectLearnAirport(code);
  });

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
