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
    const user = window.JetSetsAuth.currentUser();
    const userId = user ? user.id : null;

    try {
      // Top 100 by points desc; older runs win the tiebreaker so a
      // player who hit the score first holds the position.
      const { data: top, error } = await supabase
        .from("scores")
        .select("id, points, solves, played_at, user_id, profiles(username)")
        .eq("mode", currentMode)
        .order("points", { ascending: false })
        .order("played_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      if (myToken !== fetchToken) return; // stale, a newer fetch is in flight

      // If signed-in and NOT in the top 100, pin their best run.
      let bestOutside = null;
      if (userId) {
        const inTop = top && top.some((r) => r.user_id === userId);
        if (!inTop) {
          const { data: own } = await supabase
            .from("scores")
            .select("points, solves, played_at")
            .eq("mode", currentMode)
            .eq("user_id", userId)
            .order("points", { ascending: false })
            .order("played_at", { ascending: true })
            .limit(1);
          if (myToken !== fetchToken) return;
          if (own && own.length) bestOutside = own[0];
        }
      }

      renderYourBest(bestOutside);
      renderTable(top || [], userId);
    } catch (err) {
      if (myToken !== fetchToken) return;
      tableBody.innerHTML =
        `<tr><td colspan="5" class="lb-error">Couldn't load — ${escapeHtml(err.message || "unknown error")}</td></tr>`;
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
      return `<tr class="${isMe ? "lb-row-me" : ""}">
        <td class="lb-rank">${i + 1}</td>
        <td class="lb-user">${escapeHtml(username)}${tag}</td>
        <td class="lb-points">${r.points}</td>
        <td class="lb-solves">${r.solves}</td>
        <td class="lb-date">${formatDate(r.played_at)}</td>
      </tr>`;
    }).join("");
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
