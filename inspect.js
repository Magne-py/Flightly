/* JetSets — hidden route-stats inspector.
 *
 * A debug-only panel for confirming the live completion-probability
 * pipeline. Every route's stable ID is its START-DEST key (e.g. "AKL-STL")
 * — the same key puzzle_attempts / puzzle_stats are keyed on — so this tool
 * looks a route up by that ID and reads the CURRENT row straight from
 * Supabase (not the in-memory cache), so you can watch attempts/successes
 * and the posterior rate move as routes get played.
 *
 * Open it via:
 *   - URL flag:   ?inspect            (opens empty)
 *                 ?inspect=AKL-STL    (opens and looks that route up)
 *   - Key combo:  Ctrl+Shift+0
 *   - Console:    JetSetsInspect.open("AKL-STL")
 *
 * It is never shown to normal players — nothing renders until triggered.
 */
(function () {
  "use strict";

  var PRIOR_N = (window.JetSetsStats && window.JetSetsStats.PRIOR_N) || 20;
  var KEY_RE = /^[A-Z]{3}-[A-Z]{3}$/;
  var built = false;
  var els = {};

  // ---- helpers -------------------------------------------------------------

  // Accepts "AKL-STL", "akl stl", "aklstl" → "AKL-STL"; returns "" if invalid.
  function normalizeKey(raw) {
    if (!raw) return "";
    var s = String(raw).toUpperCase().replace(/[^A-Z]/g, "");
    if (s.length !== 6) return "";
    var k = s.slice(0, 3) + "-" + s.slice(3);
    return KEY_RE.test(k) ? k : "";
  }

  // Walk the loaded puzzle pools (global + every continent) for metadata.
  function findPuzzle(key) {
    var parts = key.split("-"), start = parts[0], dest = parts[1];
    var pools = [];
    if (Array.isArray(window.PUZZLES)) pools.push(window.PUZZLES);
    if (window.CONTINENT_PUZZLES) {
      for (var c in window.CONTINENT_PUZZLES) {
        if (Array.isArray(window.CONTINENT_PUZZLES[c])) pools.push(window.CONTINENT_PUZZLES[c]);
      }
    }
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < pools[i].length; j++) {
        var p = pools[i][j];
        if (p && p.start === start && p.dest === dest) return p;
      }
    }
    return null;
  }

  function posterior(priorP, attempts, successes) {
    var p = (typeof priorP === "number") ? priorP : 0.5;
    var denom = PRIOR_N + attempts;
    return denom > 0 ? (PRIOR_N * p + successes) / denom : p;
  }

  function tierOf(rate) {
    var t = (window.JetSetsStats && window.JetSetsStats.thresholds)
      ? window.JetSetsStats.thresholds() : [0.05, 0.25, 0.50, 0.85];
    if (rate >= t[3]) return "Simple";
    if (rate >= t[2]) return "Easy";
    if (rate >= t[1]) return "Medium";
    if (rate >= t[0]) return "Hard";
    return "Extreme";
  }

  function pct(x) { return Math.round(x * 100) + "%"; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"; }); }

  // Wait (briefly) for the Supabase client auth.js wires up.
  function getClient() {
    return (window.JetSetsAuth && window.JetSetsAuth.client) || null;
  }
  function whenClientReady(timeoutMs) {
    return new Promise(function (resolve) {
      var c = getClient();
      if (c) return resolve(c);
      var done = false;
      var finish = function () { if (done) return; done = true; resolve(getClient()); };
      window.addEventListener("jetsets-auth-ready", finish, { once: true });
      setTimeout(finish, timeoutMs || 4000);
    });
  }

  // ---- live queries --------------------------------------------------------

  async function fetchLive(key) {
    var supabase = await whenClientReady();
    if (!supabase) throw new Error("Auth/Supabase client not ready.");
    var withTimeout = (window.JetSetsAuth && window.JetSetsAuth.withTimeout) || function (p) { return p; };
    var res = await withTimeout(
      supabase.from("puzzle_stats")
        .select("puzzle_key, attempts, successes, updated_at")
        .eq("puzzle_key", key)
        .maybeSingle(),
      8000, "Inspector fetch"
    );
    if (res.error) throw new Error(res.error.message);
    return res.data; // null when no one has played it yet
  }

  async function fetchTopPlayed(limit) {
    var supabase = await whenClientReady();
    if (!supabase) throw new Error("Auth/Supabase client not ready.");
    var withTimeout = (window.JetSetsAuth && window.JetSetsAuth.withTimeout) || function (p) { return p; };
    var res = await withTimeout(
      supabase.from("puzzle_stats")
        .select("puzzle_key, attempts, successes, updated_at")
        .order("attempts", { ascending: false })
        .limit(limit || 25),
      8000, "Inspector top-played"
    );
    if (res.error) throw new Error(res.error.message);
    return res.data || [];
  }

  // ---- rendering -----------------------------------------------------------

  async function lookup(rawKey) {
    var key = normalizeKey(rawKey);
    if (!key) {
      els.result.innerHTML = '<p class="ins-msg ins-bad">Enter a route ID like <b>AKL-STL</b> (3 letters + 3 letters).</p>';
      return;
    }
    els.input.value = key;
    els.result.innerHTML = '<p class="ins-msg">Reading <b>' + esc(key) + '</b> from the database…</p>';
    var puzzle = findPuzzle(key);
    var live;
    try {
      live = await fetchLive(key);
    } catch (e) {
      els.result.innerHTML = '<p class="ins-msg ins-bad">Fetch failed: ' + esc(e.message) + '</p>';
      return;
    }
    var attempts = live ? (live.attempts || 0) : 0;
    var successes = live ? (live.successes || 0) : 0;
    var priorP = puzzle && typeof puzzle.prior_p === "number" ? puzzle.prior_p : null;
    var post = posterior(priorP, attempts, successes);
    var rawRate = attempts > 0 ? successes / attempts : null;

    var rows = "";
    rows += metaRow("Route ID", "<b>" + esc(key) + "</b>");
    if (puzzle) {
      rows += metaRow("Shortest hops", String(puzzle.shortest_hops));
      rows += metaRow("Alt. routes", String(puzzle.alt_count));
      rows += metaRow("Baked stars / prior", puzzle.stars + "★ · prior " + pct(priorP));
    } else {
      rows += metaRow("In puzzle pool?", '<span class="ins-bad">not found in loaded pools</span>');
    }
    rows += '<div class="ins-divider"></div>';
    rows += metaRow("Live attempts", '<b>' + attempts + '</b>' + (live ? "" : ' <span class="ins-dim">(no row yet — nobody has played it)</span>'));
    rows += metaRow("Live successes", "<b>" + successes + "</b>");
    rows += metaRow("Raw success rate", rawRate === null ? '<span class="ins-dim">—</span>' : pct(rawRate));
    rows += metaRow("Posterior rate", '<b class="ins-big">' + pct(post) + '</b> <span class="ins-dim">(' + tierOf(post) + ', PRIOR_N=' + PRIOR_N + ')</span>');
    if (live && live.updated_at) {
      rows += metaRow("Last updated", esc(new Date(live.updated_at).toLocaleString()));
    }
    els.result.innerHTML = '<div class="ins-grid">' + rows + "</div>" +
      '<p class="ins-note">Posterior = (PRIOR_N·prior + successes) / (PRIOR_N + attempts). ' +
      'Play this route, then hit <b>Refresh</b> — attempts should climb and the posterior should move toward the raw rate.</p>';
  }

  function metaRow(label, valHtml) {
    return '<div class="ins-k">' + esc(label) + '</div><div class="ins-v">' + valHtml + "</div>";
  }

  async function loadTop() {
    els.top.innerHTML = '<p class="ins-msg">Loading most-played routes…</p>';
    var data;
    try {
      data = await fetchTopPlayed(25);
    } catch (e) {
      els.top.innerHTML = '<p class="ins-msg ins-bad">Fetch failed: ' + esc(e.message) + '</p>';
      return;
    }
    if (!data.length) {
      els.top.innerHTML = '<p class="ins-msg ins-dim">No attempts recorded yet — the table is empty.</p>';
      return;
    }
    var html = '<table class="ins-table"><thead><tr><th>Route ID</th><th>Att.</th><th>Succ.</th><th>Rate</th></tr></thead><tbody>';
    data.forEach(function (r) {
      var rate = r.attempts > 0 ? Math.round((r.successes / r.attempts) * 100) + "%" : "—";
      html += '<tr class="ins-trow" data-key="' + esc(r.puzzle_key) + '"><td><b>' + esc(r.puzzle_key) +
        "</b></td><td>" + r.attempts + "</td><td>" + r.successes + "</td><td>" + rate + "</td></tr>";
    });
    html += "</tbody></table>";
    els.top.innerHTML = html;
    Array.prototype.forEach.call(els.top.querySelectorAll(".ins-trow"), function (tr) {
      tr.addEventListener("click", function () { lookup(tr.getAttribute("data-key")); });
    });
  }

  // ---- panel construction --------------------------------------------------

  function build() {
    if (built) return;
    built = true;

    var style = document.createElement("style");
    style.textContent = [
      "#ins-modal{position:fixed;inset:0;background:rgba(7,16,28,.8);display:none;align-items:flex-start;justify-content:center;z-index:200;padding:24px 16px;overflow:auto;}",
      "#ins-modal .ins-panel{width:100%;max-width:560px;background:var(--panel,#1c2e45);border:1px solid var(--border,#29405c);border-radius:14px;padding:20px;position:relative;box-shadow:0 12px 40px rgba(0,0,0,.55);color:var(--text,#e8eef6);font-size:13px;}",
      "#ins-modal h2{margin:0 0 2px;font-size:17px;color:var(--accent,#4ea8ff);}",
      "#ins-modal .ins-sub{margin:0 0 14px;color:var(--muted,#8ea3bf);font-size:12px;}",
      "#ins-modal .ins-close{position:absolute;top:10px;right:12px;background:transparent;border:0;color:var(--muted,#8ea3bf);font-size:24px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px;}",
      "#ins-modal .ins-close:hover{color:var(--accent,#4ea8ff);background:var(--bg-alt,#162638);}",
      "#ins-modal .ins-search{display:flex;gap:8px;margin-bottom:14px;}",
      "#ins-modal input{flex:1;background:var(--bg-alt,#162638);border:1px solid var(--border,#29405c);border-radius:8px;color:var(--text,#e8eef6);padding:9px 11px;font-size:14px;letter-spacing:1px;text-transform:uppercase;}",
      "#ins-modal button.ins-btn{background:var(--accent,#4ea8ff);color:#06121f;border:0;border-radius:8px;padding:9px 14px;font-weight:700;font-size:13px;cursor:pointer;}",
      "#ins-modal button.ins-btn.ins-ghost{background:transparent;color:var(--text,#e8eef6);border:1px solid var(--border,#29405c);}",
      "#ins-modal .ins-grid{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;align-items:baseline;}",
      "#ins-modal .ins-k{color:var(--muted,#8ea3bf);}",
      "#ins-modal .ins-v{color:var(--text,#e8eef6);}",
      "#ins-modal .ins-big{font-size:18px;}",
      "#ins-modal .ins-dim{color:var(--muted,#8ea3bf);font-weight:400;}",
      "#ins-modal .ins-bad{color:var(--red,#d4504c);}",
      "#ins-modal .ins-divider{grid-column:1/-1;height:1px;background:var(--border,#29405c);margin:5px 0;}",
      "#ins-modal .ins-msg{color:var(--muted,#8ea3bf);margin:6px 0;}",
      "#ins-modal .ins-note{margin:14px 0 0;color:var(--muted,#8ea3bf);font-size:11.5px;line-height:1.5;}",
      "#ins-modal .ins-sec{margin-top:18px;border-top:1px solid var(--border,#29405c);padding-top:14px;}",
      "#ins-modal .ins-sec h3{margin:0 0 8px;font-size:13px;color:var(--accent,#4ea8ff);display:flex;justify-content:space-between;align-items:center;}",
      "#ins-modal .ins-table{width:100%;border-collapse:collapse;font-size:12.5px;}",
      "#ins-modal .ins-table th{text-align:left;color:var(--muted,#8ea3bf);font-weight:600;padding:4px 6px;border-bottom:1px solid var(--border,#29405c);}",
      "#ins-modal .ins-table td{padding:4px 6px;border-bottom:1px solid var(--bg-alt,#162638);}",
      "#ins-modal .ins-trow{cursor:pointer;}",
      "#ins-modal .ins-trow:hover td{background:var(--bg-alt,#162638);}"
    ].join("");
    document.head.appendChild(style);

    var modal = document.createElement("div");
    modal.id = "ins-modal";
    modal.setAttribute("role", "dialog");
    modal.innerHTML =
      '<div class="ins-panel">' +
        '<button class="ins-close" type="button" aria-label="Close">&times;</button>' +
        "<h2>Route inspector</h2>" +
        '<p class="ins-sub">Live read of <code>puzzle_stats</code>. Route ID = START-DEST (e.g. AKL-STL).</p>' +
        '<div class="ins-search">' +
          '<input id="ins-input" type="text" placeholder="AKL-STL" autocomplete="off" spellcheck="false" maxlength="7">' +
          '<button class="ins-btn" id="ins-search-btn" type="button">Search</button>' +
          '<button class="ins-btn ins-ghost" id="ins-refresh-btn" type="button">Refresh</button>' +
        "</div>" +
        '<div id="ins-result"></div>' +
        '<div class="ins-sec">' +
          '<h3>Most-played routes <button class="ins-btn ins-ghost" id="ins-top-btn" type="button" style="padding:4px 10px;font-size:11px;">Load</button></h3>' +
          '<div id="ins-top"></div>' +
        "</div>" +
      "</div>";
    document.body.appendChild(modal);

    els.modal = modal;
    els.input = modal.querySelector("#ins-input");
    els.result = modal.querySelector("#ins-result");
    els.top = modal.querySelector("#ins-top");

    modal.querySelector(".ins-close").addEventListener("click", close);
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
    modal.querySelector("#ins-search-btn").addEventListener("click", function () { lookup(els.input.value); });
    modal.querySelector("#ins-refresh-btn").addEventListener("click", function () {
      if (els.input.value.trim()) lookup(els.input.value);
    });
    modal.querySelector("#ins-top-btn").addEventListener("click", loadTop);
    els.input.addEventListener("keydown", function (e) { if (e.key === "Enter") lookup(els.input.value); });
  }

  function open(key) {
    build();
    els.modal.style.display = "flex";
    if (window.JS_track) JS_track("inspector-opened");
    if (key) { lookup(key); }
    else { setTimeout(function () { els.input.focus(); }, 50); }
  }
  function close() { if (els.modal) els.modal.style.display = "none"; }

  // ---- triggers ------------------------------------------------------------

  // URL flag: ?inspect or ?inspect=AKL-STL
  try {
    var params = new URLSearchParams(location.search);
    if (params.has("inspect")) {
      var seed = params.get("inspect");
      var boot = function () { open(seed && seed.length ? seed : null); };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
      } else { boot(); }
    }
  } catch (_) {}

  // Key combo: Ctrl+Shift+0 toggles the panel.
  window.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === "0" || e.code === "Digit0")) {
      e.preventDefault();
      if (built && els.modal && els.modal.style.display === "flex") close();
      else open(null);
    }
  });

  window.JetSetsInspect = { open: open, close: close };
})();
