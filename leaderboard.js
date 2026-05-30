/* JetSets — Leaderboard view.
 * Reads top-100 scores per speedrun mode from Supabase (via the client
 * exposed by auth.js). Mode is a row of chips; switching chips refetches.
 * If the signed-in user is in the top 100 their row is highlighted; if
 * they're outside the top 100 their personal best is pinned above the
 * table so they always see how they're doing.
 *
 * Lazy-loads: the first fetch only happens when the user actually opens
 * the Leaderboards view (app.js calls JetSetsLeaderboard.refresh() on
 * view switch). Subsequent visits refetch so a freshly-saved score shows
 * up without a full page reload.
 */
(function () {
  "use strict";

  // Same mode order as the Speedrun dropdown so users orient quickly.
  // Label here can be shorter than the full mode label since we have
  // limited horizontal space for the chip row.
  const MODES = [
    { key: "speedrun-global",         label: "Global" },
    { key: "speedrun-simple",         label: "Simple ★" },
    { key: "speedrun-easy",           label: "Easy ★★" },
    { key: "speedrun-medium",         label: "Medium ★★★" },
    { key: "speedrun-hard",           label: "Hard ★★★★" },
    { key: "speedrun-extreme",        label: "Extreme ★★★★★" },
    { key: "speedrun-africa",         label: "Africa" },
    { key: "speedrun-europe",         label: "Europe" },
    { key: "speedrun-north-america",  label: "N. America" },
    { key: "speedrun-south-america",  label: "S. America" },
    { key: "speedrun-asia",           label: "Asia" },
    { key: "speedrun-oceania",        label: "Oceania" },
    { key: "speedrun-cryptic",        label: "Cryptic" },
  ];

  let currentMode = "speedrun-global";
  // In-flight fetch token. Increment on every call so stale fetches
  // (started before a chip change) don't overwrite a fresher render.
  let fetchToken = 0;

  const chipsRow = document.getElementById("lb-mode-chips");
  const yourBest = document.getElementById("lb-your-best");
  const tableBody = document.getElementById("lb-table-body");

  function renderChips() {
    if (!chipsRow) return;
    chipsRow.innerHTML = MODES.map((m) =>
      `<button class="lb-chip${m.key === currentMode ? " active" : ""}" data-mode="${m.key}" type="button">${m.label}</button>`
    ).join("");
    chipsRow.querySelectorAll(".lb-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = btn.getAttribute("data-mode");
        if (m === currentMode) return;
        currentMode = m;
        renderChips();
        loadAndRender();
      });
    });
  }

  async function loadAndRender() {
    if (!tableBody) return;
    if (!window.JetSetsAuth || !window.JetSetsAuth.client) {
      tableBody.innerHTML =
        `<tr><td colspan="5" class="lb-error">Leaderboard unavailable — auth module not ready.</td></tr>`;
      return;
    }
    const myToken = ++fetchToken;
    tableBody.innerHTML = `<tr><td colspan="5" class="lb-loading">Loading…</td></tr>`;
    if (yourBest) yourBest.style.display = "none";

    const supabase = window.JetSetsAuth.client;
    const withTimeout = window.JetSetsAuth.withTimeout || ((p) => p);
    const user = window.JetSetsAuth.currentUser();
    const userId = user ? user.id : null;

    try {
      // Top 100 by points desc; older runs win the tiebreaker so a
      // player who hit the score first holds the position.
      const { data: top, error } = await withTimeout(
        supabase
          .from("scores")
          .select("id, points, solves, played_at, user_id, profiles(username)")
          .eq("mode", currentMode)
          .order("points", { ascending: false })
          .order("played_at", { ascending: true })
          .limit(100),
        12000, "Loading leaderboard"
      );
      if (error) throw error;
      if (myToken !== fetchToken) return; // stale, a newer fetch is in flight

      // If signed-in and NOT in the top 100, pin their best run.
      let bestOutside = null;
      if (userId) {
        const inTop = top && top.some((r) => r.user_id === userId);
        if (!inTop) {
          const { data: own } = await withTimeout(
            supabase
              .from("scores")
              .select("points, solves, played_at")
              .eq("mode", currentMode)
              .eq("user_id", userId)
              .order("points", { ascending: false })
              .order("played_at", { ascending: true })
              .limit(1),
            8000, "Loading your best"
          );
          if (myToken !== fetchToken) return;
          if (own && own.length) bestOutside = own[0];
        }
      }

      renderYourBest(bestOutside);
      renderTable(top || [], userId);
    } catch (err) {
      if (myToken !== fetchToken) return;
      const msg = (err && err.code === "timeout")
        ? "Connection timed out — try again."
        : (err && err.message) ? err.message : "unknown error";
      tableBody.innerHTML =
        `<tr><td colspan="5" class="lb-error">Couldn't load — ${escapeHtml(msg)}</td></tr>`;
    }
  }

  function renderTable(rows, userId) {
    if (!tableBody) return;
    if (!rows.length) {
      tableBody.innerHTML =
        `<tr><td colspan="5" class="lb-empty">No scores yet for this mode. Be the first!</td></tr>`;
      return;
    }
    tableBody.innerHTML = rows.map((r, i) => {
      const username = (r.profiles && r.profiles.username) || "unknown";
      const isMe = userId && r.user_id === userId;
      const tag = isMe ? `<span class="lb-me-tag">YOU</span>` : "";
      // The username is a clickable link to the player profile modal.
      // We embed user_id + username as data attributes so a single
      // delegated click handler (below) can read what to fetch.
      const userCell =
        `<span class="lb-user-link" data-user-id="${escapeAttr(r.user_id)}" data-username="${escapeAttr(username)}" tabindex="0" role="button">${escapeHtml(username)}</span>`;
      return `<tr class="${isMe ? "lb-row-me" : ""}">
        <td class="lb-rank">${i + 1}</td>
        <td class="lb-user">${userCell}${tag}</td>
        <td class="lb-points">${r.points}</td>
        <td class="lb-solves">${r.solves}</td>
        <td class="lb-date">${formatDate(r.played_at)}</td>
      </tr>`;
    }).join("");
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // Delegated click handler — one listener on the tbody catches clicks
  // on any username link regardless of how many rows are rendered.
  if (tableBody) {
    tableBody.addEventListener("click", (e) => {
      const el = e.target.closest(".lb-user-link");
      if (!el) return;
      const userId = el.getAttribute("data-user-id");
      const username = el.getAttribute("data-username");
      if (userId) openPlayerProfile(userId, username);
    });
    // Keyboard accessibility — Enter / Space activates a focused link.
    tableBody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = e.target.closest(".lb-user-link");
      if (!el) return;
      e.preventDefault();
      const userId = el.getAttribute("data-user-id");
      const username = el.getAttribute("data-username");
      if (userId) openPlayerProfile(userId, username);
    });
  }

  // ---------- Player profile modal ----------
  // Friendly labels for the 13 speedrun modes so the profile reads
  // naturally without hyphens / slugs.
  const MODE_LABEL = MODES.reduce((acc, m) => {
    acc[m.key] = m.label;
    return acc;
  }, {});

  const ppModal       = document.getElementById("player-profile-modal");
  const ppTitle       = document.getElementById("player-profile-title");
  const ppSummary     = document.getElementById("player-profile-summary");
  const ppBest        = document.getElementById("player-profile-best");
  const ppRecent      = document.getElementById("player-profile-recent");
  const ppClose       = document.getElementById("player-profile-close");

  if (ppClose)  ppClose.addEventListener("click", closePlayerProfile);
  if (ppModal)  ppModal.addEventListener("click", (e) => { if (e.target === ppModal) closePlayerProfile(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ppModal && ppModal.style.display === "flex") {
      closePlayerProfile();
    }
  });

  function closePlayerProfile() {
    if (ppModal) ppModal.style.display = "none";
  }

  async function openPlayerProfile(userId, knownUsername) {
    if (!ppModal || !userId) return;
    // Render the modal in its loading shape immediately so the click feels
    // responsive even when the network is slow.
    ppModal.style.display = "flex";
    if (ppTitle) ppTitle.textContent = knownUsername || "Player";
    if (ppSummary) ppSummary.innerHTML = "";
    if (ppBest)    ppBest.innerHTML    = `<div class="player-profile-empty">Loading…</div>`;
    if (ppRecent)  ppRecent.innerHTML  = `<div class="player-profile-empty">Loading…</div>`;

    if (!window.JetSetsAuth || !window.JetSetsAuth.client) {
      if (ppBest)   ppBest.innerHTML   = `<div class="player-profile-empty player-profile-error">Auth module not ready.</div>`;
      if (ppRecent) ppRecent.innerHTML = ``;
      return;
    }
    const supabase = window.JetSetsAuth.client;
    const withTimeout = window.JetSetsAuth.withTimeout || ((p) => p);

    try {
      // Pull this user's full score history. Cap at 500 to bound the
      // payload — anyone playing more than 500 runs deserves a special
      // honor and a smarter pagination story.
      const { data: runs, error } = await withTimeout(
        supabase
          .from("scores")
          .select("mode, points, solves, played_at")
          .eq("user_id", userId)
          .order("played_at", { ascending: false })
          .limit(500),
        12000, "Loading player history"
      );
      if (error) throw error;

      // Confirm the username from profiles in case the click came from a
      // row where it was missing or stale.
      const { data: profile } = await withTimeout(
        supabase
          .from("profiles")
          .select("username, created_at")
          .eq("id", userId)
          .maybeSingle(),
        8000, "Loading profile"
      );
      const username = (profile && profile.username) || knownUsername || "Player";

      if (ppTitle) ppTitle.textContent = username;
      renderProfileBody(runs || [], profile);
    } catch (err) {
      const msg = (err && err.code === "timeout")
        ? "Connection timed out — try again."
        : (err && err.message) ? err.message : "Couldn't load profile.";
      if (ppBest)   ppBest.innerHTML   = `<div class="player-profile-empty player-profile-error">${escapeHtml(msg)}</div>`;
      if (ppRecent) ppRecent.innerHTML = ``;
    }
  }

  function renderProfileBody(runs, profile) {
    // Summary line: total runs + modes played + member since.
    const modesPlayed = new Set(runs.map((r) => r.mode));
    const summaryParts = [
      `<strong>${runs.length}</strong>&nbsp;run${runs.length === 1 ? "" : "s"}`,
      `across&nbsp;<strong>${modesPlayed.size}</strong>&nbsp;mode${modesPlayed.size === 1 ? "" : "s"}`,
    ];
    if (profile && profile.created_at) {
      summaryParts.push(`member since&nbsp;${formatDate(profile.created_at)}`);
    }
    if (ppSummary) ppSummary.innerHTML = summaryParts.join("&nbsp;·&nbsp;");

    // Best per mode — collapse runs[] by mode, keep the row with the
    // highest points (earlier wins ties). Sort modes by best-points desc.
    const bestByMode = {};
    for (const r of runs) {
      const cur = bestByMode[r.mode];
      if (!cur
          || r.points > cur.points
          || (r.points === cur.points && new Date(r.played_at) < new Date(cur.played_at))) {
        bestByMode[r.mode] = r;
      }
    }
    const bestRows = Object.entries(bestByMode)
      .sort((a, b) => b[1].points - a[1].points);

    if (ppBest) {
      if (!bestRows.length) {
        ppBest.innerHTML = `<div class="player-profile-empty">No runs yet.</div>`;
      } else {
        ppBest.innerHTML = bestRows.map(([mode, r]) => {
          const label = MODE_LABEL[mode] || mode;
          return `<div class="pp-row">
            <span class="pp-mode">${escapeHtml(label)}</span>
            <span class="pp-points">${r.points}&nbsp;pts</span>
            <span class="pp-solves">${r.solves}&nbsp;solved</span>
            <span class="pp-date">${formatDate(r.played_at)}</span>
          </div>`;
        }).join("");
      }
    }

    // Recent runs — first 20 from the already-sorted list (we ordered by
    // played_at desc above).
    if (ppRecent) {
      if (!runs.length) {
        ppRecent.innerHTML = `<div class="player-profile-empty">No runs yet.</div>`;
      } else {
        ppRecent.innerHTML = runs.slice(0, 20).map((r) => {
          const label = MODE_LABEL[r.mode] || r.mode;
          return `<div class="pp-row">
            <span class="pp-mode">${escapeHtml(label)}</span>
            <span class="pp-points">${r.points}&nbsp;pts</span>
            <span class="pp-solves">${r.solves}&nbsp;solved</span>
            <span class="pp-date">${formatDate(r.played_at)}</span>
          </div>`;
        }).join("");
      }
    }
  }

  function renderYourBest(best) {
    if (!yourBest) return;
    if (!best) {
      yourBest.style.display = "none";
      yourBest.innerHTML = "";
      return;
    }
    yourBest.style.display = "";
    yourBest.innerHTML = `
      <div class="lb-your-best-label">Your best (outside top 100)</div>
      <div class="lb-your-best-row">
        <span><strong>${best.points}</strong>&nbsp;pts</span>
        <span><strong>${best.solves}</strong>&nbsp;solved</span>
        <span>${formatDate(best.played_at)}</span>
      </div>
    `;
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    // Compact format that fits the column without truncation.
    return d.toLocaleDateString(undefined, {
      year: "2-digit", month: "short", day: "numeric",
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Re-render the table when auth state flips so the "YOU" highlight
  // (and the personal-best pin) reflects the current user. Only do work
  // if the leaderboard view is currently visible.
  window.addEventListener("jetsets-auth-changed", () => {
    const view = document.getElementById("view-leaderboard");
    if (view && view.classList.contains("active")) {
      loadAndRender();
    }
  });

  // Public API — app.js calls .refresh() when the user navigates here.
  // First call doubles as initial render (chips + table).
  let chipsRendered = false;
  window.JetSetsLeaderboard = {
    refresh() {
      if (!chipsRendered) {
        renderChips();
        chipsRendered = true;
      }
      loadAndRender();
    },
  };
})();
