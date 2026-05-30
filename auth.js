// JetSets — Supabase auth wrapper.
//
// Loaded as a <script type="module"> so we can pull the Supabase client
// from a CDN without a build step. Exposes a small `window.JetSetsAuth`
// API for the rest of the app (signup, signin, signout, session getters,
// score-submission helper). Also drives the auth UI in the header — the
// modal markup is in index.html; this file wires the buttons.
//
// Session persistence is handled by supabase-js (localStorage). We listen
// to onAuthStateChange and re-render the header chip whenever the session
// flips.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://gwfqglpgzkxejshomsts.supabase.co";
// The publishable (anon) key — safe to ship in client code. Row-Level
// Security is the real access boundary, not key secrecy.
const SUPABASE_KEY = "sb_publishable_T7XsHvxUXDLpfFuzxP-vlA_z1yMDFfM";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// ---------- Module state ----------
let currentSession = null;     // current Supabase session, or null when signed-out
let currentProfile = null;     // { id, username } once fetched

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const authBtn        = $("auth-btn");
const authMenu       = $("auth-menu");
const authMenuUser   = $("auth-menu-user");
const signOutBtn     = $("auth-signout");
const modal          = $("auth-modal");
const modalClose     = $("auth-modal-close");
const tabSignIn      = $("auth-tab-signin");
const tabSignUp      = $("auth-tab-signup");
const formSignIn     = $("auth-form-signin");
const formSignUp     = $("auth-form-signup");
const errSignIn      = $("auth-err-signin");
const errSignUp      = $("auth-err-signup");

// ---------- UI helpers ----------
function openModal(tab) {
  if (!modal) return;
  modal.style.display = "flex";
  setTab(tab || "signin");
  // Focus the first field in the active form on open.
  setTimeout(() => {
    const active = tab === "signup" ? formSignUp : formSignIn;
    const first = active && active.querySelector("input");
    if (first) first.focus();
  }, 50);
}
function closeModal() {
  if (!modal) return;
  modal.style.display = "none";
  clearErrors();
}
function setTab(tab) {
  const onSignUp = tab === "signup";
  if (tabSignIn)  tabSignIn.classList.toggle("active", !onSignUp);
  if (tabSignUp)  tabSignUp.classList.toggle("active",  onSignUp);
  if (formSignIn) formSignIn.style.display = onSignUp ? "none" : "block";
  if (formSignUp) formSignUp.style.display = onSignUp ? "block" : "none";
  clearErrors();
}
function clearErrors() {
  if (errSignIn) errSignIn.textContent = "";
  if (errSignUp) errSignUp.textContent = "";
}
function setError(which, msg) {
  const el = which === "signup" ? errSignUp : errSignIn;
  if (el) el.textContent = msg || "";
}
function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = busy ? "…" : btn.dataset.label;
}

// Refresh the header chip — either "Sign in" (signed-out) or the username
// with a hover dropdown for sign-out (signed-in).
async function renderHeader() {
  if (!authBtn) return;
  if (currentSession && currentSession.user) {
    // Pull the profile row to display username. Cached so we only do this
    // once per session refresh.
    if (!currentProfile || currentProfile.id !== currentSession.user.id) {
      const { data } = await supabase
        .from("profiles")
        .select("id, username")
        .eq("id", currentSession.user.id)
        .single();
      currentProfile = data || null;
    }
    const name = currentProfile ? currentProfile.username : "you";
    authBtn.textContent = name;
    authBtn.classList.add("signed-in");
    if (authMenuUser) authMenuUser.textContent = name;
    if (authMenu) authMenu.style.display = "";
  } else {
    currentProfile = null;
    authBtn.textContent = "Sign in";
    authBtn.classList.remove("signed-in");
    if (authMenu) authMenu.style.display = "none";
  }
}

// ---------- Auth flows ----------
async function signUp(username, email, password) {
  // Username goes into auth metadata; the database trigger copies it into
  // public.profiles on insert.
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email, password,
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Submit a finished speedrun's score. Returns the inserted row, or throws.
// Soft-rejects unsigned attempts so callers can show a Sign-in CTA.
async function submitScore({ mode, points, solves }) {
  if (!currentSession) {
    const err = new Error("not signed in");
    err.code = "not_signed_in";
    throw err;
  }
  const { data, error } = await supabase
    .from("scores")
    .insert({ user_id: currentSession.user.id, mode, points, solves })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- Form wiring ----------
function wireForms() {
  if (formSignIn) {
    formSignIn.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearErrors();
      const email = (formSignIn.querySelector("[name='email']").value || "").trim();
      const password = formSignIn.querySelector("[name='password']").value || "";
      const submit = formSignIn.querySelector("button[type='submit']");
      setBusy(submit, true);
      try {
        await signIn(email, password);
        closeModal();
      } catch (err) {
        setError("signin", friendlyError(err));
      } finally {
        setBusy(submit, false);
      }
    });
  }

  if (formSignUp) {
    formSignUp.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearErrors();
      const username = (formSignUp.querySelector("[name='username']").value || "").trim();
      const email = (formSignUp.querySelector("[name='email']").value || "").trim();
      const password = formSignUp.querySelector("[name='password']").value || "";
      const submit = formSignUp.querySelector("button[type='submit']");

      // Cheap client-side validation — the database has the real rules,
      // but failing fast keeps the round-trip count down.
      if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
        setError("signup", "Username: 3–24 chars, letters/numbers/dash/underscore only.");
        return;
      }
      if (password.length < 6) {
        setError("signup", "Password must be at least 6 characters.");
        return;
      }
      setBusy(submit, true);
      try {
        const result = await signUp(username, email, password);
        // If email confirmations are OFF in Supabase (default for new
        // projects), we get a session immediately and can close the modal.
        // If they're ON, no session yet — tell the user to check their inbox.
        if (result && result.session) {
          closeModal();
        } else {
          setError("signup", "Account created. Check your email to confirm, then sign in.");
        }
      } catch (err) {
        setError("signup", friendlyError(err));
      } finally {
        setBusy(submit, false);
      }
    });
  }
}

// Normalise Supabase / Postgres errors into something a user can read.
function friendlyError(err) {
  if (!err) return "Something went wrong.";
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes("invalid login credentials")) return "Wrong email or password.";
  if (msg.includes("user already registered"))   return "An account already exists for this email. Try signing in.";
  if (msg.includes("duplicate key") && msg.includes("username")) {
    return "That username is taken — pick another.";
  }
  if (msg.includes("rate limit")) return "Too many attempts — wait a minute and try again.";
  return err.message || "Something went wrong.";
}

// ---------- Boot ----------
function wireButtons() {
  if (authBtn) {
    authBtn.addEventListener("click", () => {
      if (currentSession) {
        // Toggle the sign-out dropdown for signed-in users.
        if (authMenu) {
          authMenu.classList.toggle("open");
        }
      } else {
        openModal("signin");
      }
    });
  }
  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modal) {
    // Click outside the panel closes the modal.
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
  }
  if (tabSignIn) tabSignIn.addEventListener("click", () => setTab("signin"));
  if (tabSignUp) tabSignUp.addEventListener("click", () => setTab("signup"));
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      try { await signOut(); } catch (_) {}
      if (authMenu) authMenu.classList.remove("open");
    });
  }
  // Escape closes the modal.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && modal.style.display === "flex") {
      closeModal();
    }
  });
  // Click outside the user-menu closes it.
  document.addEventListener("click", (e) => {
    if (!authMenu) return;
    if (authMenu.contains(e.target) || (authBtn && authBtn.contains(e.target))) return;
    authMenu.classList.remove("open");
  });
}

(async function init() {
  wireForms();
  wireButtons();
  // Initial session check — supabase-js hydrates from localStorage.
  const { data } = await supabase.auth.getSession();
  currentSession = data.session || null;
  await renderHeader();
  // Listen for sign-in / sign-out / token-refresh events.
  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session || null;
    currentProfile = null;
    await renderHeader();
  });
})();

// Public API used by game.js (score submission) and elsewhere.
window.JetSetsAuth = {
  isSignedIn: () => !!currentSession,
  currentUser: () => (currentSession ? currentSession.user : null),
  currentProfile: () => currentProfile,
  openModal,
  submitScore,
  // Direct supabase client access for the leaderboard view (read-only
  // queries don't need to go through this module).
  client: supabase,
};
