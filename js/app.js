/* ============================================================
   Prime Telecoms FSM — App Logic (routing + rendering)
   ============================================================ */

const appRoot = document.getElementById("app-root");

// ── Auth race guard ──────────────────────────────────────────────────────
// Firebase's SDK fires the GLOBAL onAuthStateChanged listener (registered
// once, below, on boot) the INSTANT an account is created or signed in —
// at the exact same moment an explicit flow (manager registration,
// technician activation, customer sign-up, or the Supreme Admin claim)
// is about to make its OWN call to Auth.loadProfile(fbUser, {role: ...}).
// Without this guard, both calls run concurrently and race to create the
// brand-new user's Firestore profile: the global listener's call always
// asks for the bare default ("customer"), while the explicit flow asks
// for the real role. Whichever write reaches Firestore first wins as the
// document's "create" — and firestore.rules never lets a signed-in user
// change their own role afterwards, so the second write is silently
// rejected. This is what caused new managers to end up stuck as
// "customer" and could just as easily leave a freshly-claimed Supreme
// Admin unable to see the admin dashboard. Every explicit flow below sets
// this flag before touching Firebase Auth and always clears it (success
// or failure) once its own loadProfile call has resolved, so the global
// listener knows to sit out that one transition instead of racing it.
let _explicitAuthFlow = false;

function toast(message, type = "info") {
  let wrap = document.querySelector(".pt-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "pt-toast-wrap";
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.className = `pt-toast ${type}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function nl2br(str) {
  return escapeHtml(str).replace(/\n/g, "<br>");
}

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Relative "time ago" — lets a manager triage the queue at a glance
// ("Raised 2h ago" is faster to scan than a full timestamp).
function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(dateStr);
}

// Duration between two ISO timestamps, human-readable (e.g. "1h 20m").
function fmtDuration(startStr, endStr) {
  if (!startStr || !endStr) return "—";
  const ms = new Date(endStr) - new Date(startStr);
  if (isNaN(ms) || ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

// The admin has every manager power in the operational screens (jobs,
// reports, staff, customers, reviews) PLUS the admin-only manager-approval
// screen — this is the one helper used everywhere that used to just check
// `user.role === "manager"` for UI/edit affordances.
function isManagerLike(user) {
  return !!user && (user.role === "manager" || user.role === "admin");
}

// ── Password field with a "Show/Hide" toggle ────────────────────────────
// Used on every registration/account-creation form (login, manager
// registration, customer sign-up, technician activation, the Supreme Admin
// claim screen, and the admin's "Add a Manager" form) so the person can
// double-check what they typed before submitting.
function pwField(id, labelText, placeholder = "", autocomplete = "") {
  return `
    <label class="form-label">${labelText}</label>
    <div style="position:relative;">
      <input type="password" class="form-control pt-pw-input" id="${id}" placeholder="${placeholder}"
        ${autocomplete ? `autocomplete="${autocomplete}"` : ""} style="padding-right:58px;">
      <button type="button" class="pt-pw-toggle" data-target="${id}" aria-label="Show password"
        style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;
        color:#2563EB;font-size:12px;font-weight:700;cursor:pointer;padding:4px 6px;">Show</button>
    </div>`;
}

// Single delegated listener (attached once) rather than re-wiring buttons
// after every innerHTML re-render — works for every pwField() instance
// anywhere in the app, present now or added later.
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".pt-pw-toggle");
  if (!btn) return;
  const input = document.getElementById(btn.getAttribute("data-target"));
  if (!input) return;
  const nowShowing = input.type === "password";
  input.type = nowShowing ? "text" : "password";
  btn.textContent = nowShowing ? "Hide" : "Show";
  btn.setAttribute("aria-label", nowShowing ? "Hide password" : "Show password");
});

function starRating(n, max = 5) {
  const filled = "&#9733;".repeat(n || 0);
  const empty = "&#9734;".repeat(max - (n || 0));
  return `<span class="pt-star-rating">${filled}${empty}</span>`;
}

/* ============================================================
   ROUTER
   ============================================================ */
function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  return { route: parts[0] || "dashboard", parts };
}

function navigate(hash) {
  window.location.hash = hash;
}

function router() {
  const user = Auth.currentUser();
  if (!user) {
    const { route, parts } = parseHash();
    if (route === "login" && parts[1]) {
      renderRoleLogin(parts[1]);
    } else if (route === "claim-admin") {
      renderClaimAdmin();
    } else if (route === "register") {
      renderRegister();
    } else if (route === "activate-technician") {
      renderActivateTechnician();
    } else if (route === "register-customer") {
      renderCustomerRegister();
    } else {
      renderRoleGateway();
    }
    return;
  }

  // A self-registered manager sits in "manager_pending" (and a manager
  // who was rejected/revoked keeps role manager_pending/manager with
  // active:false) until the Supreme Admin decides — they get a dedicated
  // waiting screen, full stop, regardless of what hash they typed. The
  // profile listener in data.js (_startMyProfileListener) re-fires the
  // router the instant the Supreme Admin approves them, so this screen
  // clears itself without the person needing to refresh or re-navigate.
  if (user.role === "manager_pending") {
    renderPendingApproval(user);
    return;
  }

  const { route, parts } = parseHash();
  const userIsManagerLike = user.role === "manager" || user.role === "admin";

  // ── Strict role-based route guard ───────────────────────────────────────
  // Each role is confined to its own slice of the app. Customers can never
  // reach the manager/technician workspace (staff, internal report review)
  // and technicians/customers can never reach manager-only staff admin.
  // "jobs", "reports" and "dashboard" are shared hash routes but render a
  // completely different view per role (see the switch below) — this is
  // enforced in code, not just hidden in the nav, so typing the hash
  // directly can't bypass it either.
  const managerOnlyRoutes = ["staff", "customers", "reviews"];
  const adminOnlyRoutes = ["admin"];
  const customerBlockedRoutes = ["staff", "reports"];
  if (!userIsManagerLike && managerOnlyRoutes.includes(route)) {
    navigate("dashboard");
    return;
  }
  if (user.role !== "admin" && adminOnlyRoutes.includes(route)) {
    navigate("dashboard");
    return;
  }
  if (user.role === "customer" && customerBlockedRoutes.includes(route)) {
    navigate("dashboard");
    return;
  }

  renderShell(user);
  const content = document.getElementById("app-content");
  
  let navKey = route;
  if (route === "admin" && parts[1]) {
    navKey = `admin/${parts[1]}`;
  }
  setActiveNav(navKey);

  switch (route) {
    case "dashboard":
      if (user.role === "admin") renderAdminOverview(content, user);
      else if (user.role === "manager") renderManagerDashboard(content, user);
      else if (user.role === "technician") renderTechDashboard(content, user);
      else renderCustomerDashboard(content, user);
      break;

    case "admin":
      // Only the admin reaches here (guard above)
      if (parts[1] === "managers") {
        renderAdminManagers(content, user);
      } else if (parts[1] === "orgs") {
        renderAdminOrgs(content, user);
      } else if (parts[1] === "intel") {
        renderAdminIntel(content, user);
      } else if (parts[1] === "activity") {
        renderAdminActivity(content, user);
      } else if (parts[1] === "manager" && parts[2]) {
        renderAdminManagerDetail(content, user, parts[2]);
      } else {
        renderAdminManagers(content, user);
      }
      break;

    case "jobs":
      if (userIsManagerLike) {
        if (parts[1] === "new") renderJobForm(content, user, null);
        else if (parts[1] && parts[2] === "edit") renderJobForm(content, user, parts[1]);
        else if (parts[1]) renderJobDetail(content, user, parts[1]);
        else renderJobList(content, user);
      } else if (user.role === "technician") {
        // Technicians can view/update assigned jobs but never create or edit job details.
        if (parts[1] === "new" || (parts[1] && parts[2] === "edit")) { navigate("dashboard"); return; }
        if (parts[1]) renderJobDetail(content, user, parts[1]);
        else renderJobList(content, user);
      } else {
        // Customer: book a service (#jobs/new), view own requests (#jobs), view one (#jobs/:id)
        if (parts[1] === "new") renderBookingForm(content, user);
        else if (parts[1]) renderCustomerRequestDetail(content, user, parts[1]);
        else renderCustomerRequestList(content, user);
      }
      break;

    case "reports":
      // Customers never reach here (blocked above).
      if (parts[1] === "new" && parts[2]) renderReportForm(content, user, parts[2]);
      else if (parts[1]) renderReportDetail(content, user, parts[1]);
      else renderReportList(content, user);
      break;

    case "staff":
      // Only managers reach here (guard above) — this is the admin panel
      // that controls who is granted the technician role.
      renderStaffList(content, user);
      break;

    case "reviews":
      // Only managers reach here (guard above) — every customer review
      // (star rating + comment) left across all jobs, org-wide.
      renderReviewsList(content, user);
      break;

    case "customers":
      // Only managers reach here (guard above) — full customer roster +
      // role management (customer <-> technician).
      renderCustomersList(content, user);
      break;

    case "profile":
      renderProfile(content, user);
      break;

    default:
      content.innerHTML = `<div class="pt-empty-state"><i>404</i>Page not found.</div>`;
  }
}

window.addEventListener("hashchange", router);
// Fired by data.js whenever the live Firestore caches (jobs/reports/users)
// change, so every open screen reflects new data without a manual refresh.
window.addEventListener("pt:data-changed", () => { if (Auth.currentUser()) router(); });

/* ============================================================
   BOOT — Firebase onAuthStateChanged drives the whole app.
   No synchronous localStorage session check needed.
   ============================================================ */
window.addEventListener("DOMContentLoaded", () => {
  // Show a loading state while Firebase resolves
  appRoot.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;">
      <div style="width:48px;height:48px;border:4px solid #e2e8f0;border-top:4px solid #2563EB;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
      <div style="color:#64748b;font-family:Inter,sans-serif;font-size:14px;">Loading Prime Telecoms FSM…</div>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;

  Auth.onAuthStateChanged(async (firebaseUser) => {
    // An explicit flow (sign-in, registration, activation, or the admin
    // claim) is already in the middle of handling this exact transition
    // itself — see the guard comment above. Sitting out here is what
    // prevents the double-write race that used to corrupt new accounts'
    // roles.
    if (_explicitAuthFlow) return;
    if (firebaseUser) {
      try {
        await Auth.loadProfile(firebaseUser);
      } catch (e) {
        console.error("[App] Profile load error:", e);
        // Same protection as the explicit sign-in flow: if we can't
        // confirm the profile, we do NOT let a stale/guessed role stand.
        // _currentProfile is left null, so router() below treats this as
        // signed-out rather than silently showing the wrong dashboard.
        if (typeof toast === "function") {
          toast("Couldn't verify your account (connection issue). Please sign in again.", "error");
        }
      }
    } else {
      // No Firebase session — clear cached profile
      await Auth.loadProfile(null);
    }
    router();
  });
});

/* ============================================================
   LOGIN VIEW — Firebase Auth (email/password + Google)
   ============================================================ */
function renderLogin() {
  renderRoleGateway();
}

/* ============================================================
   ROLE GATEWAY — 4-Box Selector
   ============================================================ */
function renderRoleGateway() {
  appRoot.innerHTML = `
    <div class="pt-auth-wrap" style="align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 24px; padding: 40px 20px;">
      <div style="text-align: center; color: #fff; max-width: 600px; margin-bottom: 12px;">
        <div style="width: 64px; height: 64px; border-radius: 16px; background: var(--pt-amber); color: var(--pt-navy); display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 28px; margin-bottom: 18px; box-shadow: 0 10px 25px rgba(244,163,0,0.3);">PT</div>
        <h2 style="font-weight: 800; font-size: 28px; letter-spacing: -0.5px; margin: 0 0 8px; color: #fff;">Prime Telecoms Portal</h2>
        <p style="color: #AEB9D6; font-size: 14.5px; line-height: 1.5; margin: 0;">Field Service Management Platform Gateway. Please select your workspace portal to continue.</p>
      </div>

      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; width: 100%; max-width: 820px;">
        <!-- Card 1: Supreme Admin -->
        <div class="pt-gateway-card" onclick="location.hash='#login/admin'" style="background: rgba(11, 37, 69, 0.65); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 26px; color: #fff; cursor: pointer; transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 15px 35px rgba(0,0,0,0.2);">
          <div style="font-size: 32px;">🛡️</div>
          <div>
            <h4 style="margin: 0 0 6px; font-weight: 700; font-size: 16px; color: #fff;">Supreme Admin Command Center</h4>
            <p style="margin: 0; font-size: 12.5px; color: #AEB9D6; line-height: 1.5;">Platform command center, organization control, system diagnostics, and audit logs.</p>
          </div>
          <div style="margin-top: auto; font-size: 12.5px; font-weight: 700; color: var(--pt-amber); display: flex; align-items: center; gap: 4px;">Enter Command Center ➔</div>
        </div>

        <!-- Card 2: Operations Manager -->
        <div class="pt-gateway-card" onclick="location.hash='#login/manager'" style="background: rgba(11, 37, 69, 0.65); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 26px; color: #fff; cursor: pointer; transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 15px 35px rgba(0,0,0,0.2);">
          <div style="font-size: 32px;">🏢</div>
          <div>
            <h4 style="margin: 0 0 6px; font-weight: 700; font-size: 16px; color: #fff;">Operations Management</h4>
            <p style="margin: 0; font-size: 12.5px; color: #AEB9D6; line-height: 1.5;">Dispatch technicians, manage work orders, approve service reports, and monitor customer reviews.</p>
          </div>
          <div style="margin-top: auto; font-size: 12.5px; font-weight: 700; color: var(--pt-amber); display: flex; align-items: center; gap: 4px;">Access Operations Desk ➔</div>
        </div>

        <!-- Card 3: Field Technician -->
        <div class="pt-gateway-card" onclick="location.hash='#login/technician'" style="background: rgba(11, 37, 69, 0.65); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 26px; color: #fff; cursor: pointer; transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 15px 35px rgba(0,0,0,0.2);">
          <div style="font-size: 32px;">🔧</div>
          <div>
            <h4 style="margin: 0 0 6px; font-weight: 700; font-size: 16px; color: #fff;">Technician Portal</h4>
            <p style="margin: 0; font-size: 12.5px; color: #AEB9D6; line-height: 1.5;">View assigned jobs, update location status, log materials used, and submit site reports.</p>
          </div>
          <div style="margin-top: auto; font-size: 12.5px; font-weight: 700; color: var(--pt-amber); display: flex; align-items: center; gap: 4px;">Enter Field Workspace ➔</div>
        </div>

        <!-- Card 4: Client Users -->
        <div class="pt-gateway-card" onclick="location.hash='#login/customer'" style="background: rgba(11, 37, 69, 0.65); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 18px; padding: 26px; color: #fff; cursor: pointer; transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 15px 35px rgba(0,0,0,0.2);">
          <div style="font-size: 32px;">👤</div>
          <div>
            <h4 style="margin: 0 0 6px; font-weight: 700; font-size: 16px; color: #fff;">Client Services Portal</h4>
            <p style="margin: 0; font-size: 12.5px; color: #AEB9D6; line-height: 1.5;">Book new service requests, check booking timeline updates, and rate completed work.</p>
          </div>
          <div style="margin-top: auto; font-size: 12.5px; font-weight: 700; color: var(--pt-amber); display: flex; align-items: center; gap: 4px;">Book &amp; Track Services ➔</div>
        </div>
      </div>
      
      <style>
        .pt-gateway-card {
          box-sizing: border-box;
        }
        .pt-gateway-card:hover {
          transform: translateY(-4px);
          border-color: rgba(244, 163, 0, 0.5) !important;
          box-shadow: 0 20px 40px rgba(244, 163, 0, 0.1), 0 15px 30px rgba(0,0,0,0.25) !important;
        }
      </style>
    </div>
  `;
}

/* ============================================================
   ROLE ACCESS PANEL — Dedicated forms for roles
   ============================================================ */
function renderRoleLogin(role) {
  let title = "";
  let icon = "";
  let registerLinkHtml = "";
  let demoCredentials = null;

  if (role === "admin") {
    title = "Supreme Admin Command Center";
    icon = "🛡️";
    // No demo autofill here on purpose: unlike manager/technician/customer
    // below, this is the ONE real, permanent owner login (now tied to
    // printexenginieers@gmail.com — see ADMIN_ALLOWED_EMAILS in js/data.js
    // and isAllowedAdminEmail() in firestore.rules). Auto-filling a real
    // admin password on a public login screen would hand out full admin
    // access to anyone who opens this page and clicks a button.
  } else if (role === "manager") {
    title = "Operations Desk Access";
    icon = "🏢";
    // No self-registration link here on purpose: manager accounts are
    // provisioned top-down by the Supreme Admin ("Add a Manager" inside
    // #admin/managers → Auth.adminCreateManager), not by public sign-up.
    // Keeping a self-registration link here would let anyone request a
    // manager account, undercutting the admin-authorized hierarchy.
    demoCredentials = { email: "manager@primetelecoms.com", label: "manager@primetelecoms.com / manager123" };
  } else if (role === "technician") {
    title = "Technician Portal";
    icon = "🔧";
    // Same reasoning as manager above: technician accounts are provisioned
    // by their manager ("Add a Technician" inside #staff →
    // Auth.managerCreateTechnician), not by public self-activation.
    demoCredentials = { email: "technician@primetelecoms.com", label: "technician@primetelecoms.com / technician123" };
  } else if (role === "customer") {
    title = "Client Service Desk";
    icon = "👤";
    registerLinkHtml = `<div style="margin-top: 14px; font-size: 13px;"><a href="#register-customer" style="color: #2563EB; font-weight: 600;">Book a Service — Create Customer Account</a></div>`;
    demoCredentials = { email: "customer@primetelecoms.com", label: "customer@primetelecoms.com / customer123" };
  } else {
    navigate("");
    return;
  }

  appRoot.innerHTML = `
    <div class="pt-auth-wrap">
      <div class="pt-auth-card">
        <a href="#" id="btn-back-gateway" style="display:inline-flex; align-items:center; gap:5px; color:#64748b; font-weight:600; font-size:12.5px; text-decoration:none; margin-bottom:14px;">&larr; Change Portal</a>
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 18px;">
          <div class="pt-auth-logo" style="margin-bottom: 0;">PT</div>
          <span style="font-size: 26px;">${icon}</span>
        </div>
        <h4 style="font-weight: 800; color: #0f172a; margin-bottom: 4px;">${title}</h4>
        <p style="color: #64748b; font-size: 13.5px; margin-bottom: 20px;">Telecom Field Service Management Portal</p>

        <div id="auth-error" style="display:none;background:#FBE1E1;color:#D64545;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:14px;"></div>
        <div id="auth-info"  style="display:none;background:#e0f2fe;color:#0369a1;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:14px;"></div>

        <div class="field">
          <label class="form-label">Email Address / Username</label>
          <input type="email" class="form-control" id="login-email" placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="field">
          ${pwField("login-password", "Password", "Your password", "current-password")}
        </div>

        <button class="btn btn-pt-primary btn-block" id="btn-signin" style="margin-top:6px;">
          Sign In
        </button>

        ${demoCredentials ? `
          <div style="margin-top: 14px;">
            <button class="btn btn-pt-outline btn-block btn-sm" id="btn-demo-autofill" style="justify-content: center; gap: 6px; font-weight: 700; border-color: var(--pt-amber); color: var(--pt-navy);">
              ⚡ Use Demo Account
            </button>
            <div style="font-size: 11px; color: var(--pt-text-muted); text-align: center; margin-top: 4px;">
              Auto-fills: <code>${demoCredentials.label}</code>
            </div>
          </div>
        ` : ""}

        ${registerLinkHtml ? `
          <div style="margin-top: 22px; padding-top: 18px; border-top: 1px solid #e2e8f0; text-align: center;">
            ${registerLinkHtml}
          </div>
        ` : ""}
      </div>
    </div>
  `;

  const errEl  = document.getElementById("auth-error");
  const infoEl = document.getElementById("auth-info");

  function showErr(msg)  { errEl.textContent = msg; errEl.style.display = "block"; infoEl.style.display = "none"; }
  function showInfo(msg) { infoEl.textContent = msg; infoEl.style.display = "block"; errEl.style.display = "none"; }
  function clearMsg()    { errEl.style.display = "none"; infoEl.style.display = "none"; }

  // back button
  document.getElementById("btn-back-gateway").addEventListener("click", (e) => {
    e.preventDefault();
    navigate("");
    router();
  });

  // demo autofill helper
  const autofillBtn = document.getElementById("btn-demo-autofill");
  if (autofillBtn) {
    autofillBtn.addEventListener("click", () => {
      document.getElementById("login-email").value = demoCredentials.email;
      document.getElementById("login-password").value = `${role}123`;
      toast("Demo credentials filled. Click Sign In to connect.", "success");
    });
  }

  // sign in handler with self-healing demo profile creations
  document.getElementById("btn-signin").addEventListener("click", async () => {
    const btn      = document.getElementById("btn-signin");
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    if (!email || !password) { showErr("Please enter your email and password."); return; }

    btn.disabled    = true;
    btn.textContent = "Signing in…";
    clearMsg();

    try {
      _explicitAuthFlow = true;
      let fbUser = null;

      // Real Supreme Admin bootstrap: the FIRST time the allowlisted admin
      // email signs in with whatever password they choose, this creates
      // the Firebase Auth account and the matching Firestore profile in
      // one shot. Every sign-in after that just goes through the normal
      // signInWithEmail path below, since the account now exists.
      if (role === "admin" && Auth.isAllowedAdminEmail(email)) {
        const bootstrapAvailable = await Auth.isAdminBootstrapAvailable();
        if (bootstrapAvailable) {
          showInfo("Setting up your Supreme Admin account...");
          fbUser = await Auth.claimAdmin(email, password, "Supreme", "Admin");
        }
      } else if (email === "manager@primetelecoms.com" && password === "manager123") {
        try {
          fbUser = await Auth.signInWithEmail(email, password);
        } catch (signInErr) {
          if (signInErr.code === "auth/user-not-found") {
            showInfo("Creating demo Manager profile...");
            const createdAuth = await Auth.registerWithEmail(email, password, "Grace Wanjiru");
            const db = firebase.firestore();
            const profile = {
              uid: createdAuth.uid,
              email: email,
              firstName: "Grace",
              lastName: "Wanjiru",
              role: "manager",
              organizationId: DEFAULT_ORG_ID,
              orgName: "Prime Telecoms Limited",
              active: true,
              approvedAt: new Date().toISOString(),
              approvedBy: "demo_bootstrap",
              createdAt: new Date().toISOString()
            };
            await db.collection("users").doc(createdAuth.uid).set(profile, { merge: true });
            fbUser = createdAuth;
          } else {
            throw signInErr;
          }
        }
      } else if (email === "technician@primetelecoms.com" && password === "technician123") {
        try {
          fbUser = await Auth.signInWithEmail(email, password);
        } catch (signInErr) {
          if (signInErr.code === "auth/user-not-found") {
            showInfo("Creating demo Technician profile...");
            const db = firebase.firestore();
            await db.collection("tech_authorizations").doc(email.toLowerCase()).set({
              email: email.toLowerCase(),
              organizationId: DEFAULT_ORG_ID,
              status: "authorized",
              authorizedBy: "demo_bootstrap",
              createdAt: new Date().toISOString(),
              firstName: "John",
              lastName: "Mwangi",
              employeeId: "PT-001"
            });
            const createdAuth = await Auth.registerWithEmail(email, password, "John Mwangi");
            const profile = {
              uid: createdAuth.uid,
              email: email,
              firstName: "John",
              lastName: "Mwangi",
              role: "technician",
              organizationId: DEFAULT_ORG_ID,
              orgName: "Prime Telecoms Limited",
              employeeId: "PT-001",
              active: true,
              status: "available",
              createdAt: new Date().toISOString()
            };
            await db.collection("users").doc(createdAuth.uid).set(profile, { merge: true });
            fbUser = createdAuth;
          } else {
            throw signInErr;
          }
        }
      } else if (email === "customer@primetelecoms.com" && password === "customer123") {
        try {
          fbUser = await Auth.signInWithEmail(email, password);
        } catch (signInErr) {
          if (signInErr.code === "auth/user-not-found") {
            showInfo("Creating demo Customer profile...");
            const createdAuth = await Auth.registerWithEmail(email, password, "Alice Njeri");
            const db = firebase.firestore();
            const profile = {
              uid: createdAuth.uid,
              email: email,
              firstName: "Alice",
              lastName: "Njeri",
              role: "customer",
              organizationId: DEFAULT_ORG_ID,
              orgName: "Client Space",
              phone: "0712345678",
              active: true,
              createdAt: new Date().toISOString()
            };
            await db.collection("users").doc(createdAuth.uid).set(profile, { merge: true });
            fbUser = createdAuth;
          } else {
            throw signInErr;
          }
        }
      }

      // standard email signin
      if (!fbUser) {
        fbUser = await Auth.signInWithEmail(email, password);
      }

      await Auth.loadProfile(fbUser);
      navigate("dashboard");
      router();
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = "Sign In";
      showErr(Auth.getErrorMessage(err.code) || err.message);
    } finally {
      _explicitAuthFlow = false;
    }
  });

  // Enter key support
  document.getElementById("login-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-signin").click();
  });
}

/* ============================================================
   SUPREME ADMIN CLAIM — one-time setup, only available until claimed
   ============================================================ */
function renderClaimAdmin() {
  appRoot.innerHTML = `
    <div class="pt-auth-wrap">
      <div class="pt-auth-card" style="max-width:500px;">
        <div class="pt-auth-logo">PT</div>
        <h4 style="font-weight:700;color:#0f172a;margin-bottom:4px;">Claim Supreme Admin Access</h4>
        <p style="color:#64748b;font-size:13px;margin-bottom:18px;">
          One-time setup for this deployment, restricted to a specific pre-approved email address. Whoever claims
          this becomes the Supreme Admin — able to approve new managers, manage every role, and see system-wide
          issues. This can only ever be claimed once; if someone already has, you'll be sent back to Sign In.
        </p>

        <div id="admin-error" style="display:none;background:#FBE1E1;color:#D64545;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px;"></div>

        <div class="form-row cols-2">
          <div><label class="form-label">First Name</label><input type="text" class="form-control" id="admin-fname" placeholder="Amina"></div>
          <div><label class="form-label">Last Name</label><input type="text" class="form-control" id="admin-lname" placeholder="Yusuf"></div>
        </div>
        <div class="field">
          <label class="form-label">Email Address</label>
          <input type="email" class="form-control" id="admin-email" placeholder="admin@company.com">
        </div>
        <div class="form-row cols-2">
          <div>${pwField("admin-pw", "Password", "Min. 6 characters")}</div>
          <div>${pwField("admin-pw2", "Confirm Password")}</div>
        </div>

        <button class="btn btn-pt-primary btn-block" id="btn-claim-admin" style="margin-top:6px;background:#7c3aed;border-color:#7c3aed;">
          Claim Supreme Admin Access
        </button>
        <div style="text-align:center;margin-top:12px;font-size:13px;">
          <a href="#" id="back-to-login" style="color:#2563EB;">← Back to Sign In</a>
        </div>
      </div>
    </div>
  `;

  const errEl = document.getElementById("admin-error");
  function showErr(msg) { errEl.textContent = msg; errEl.style.display = "block"; }

  document.getElementById("back-to-login").addEventListener("click", (e) => {
    e.preventDefault();
    window.location.hash = ""; // leave the hidden #claim-admin route
    renderLogin();
  });

  document.getElementById("btn-claim-admin").addEventListener("click", async () => {
    const btn    = document.getElementById("btn-claim-admin");
    const fname  = document.getElementById("admin-fname").value.trim();
    const lname  = document.getElementById("admin-lname").value.trim();
    const email  = document.getElementById("admin-email").value.trim();
    const pw     = document.getElementById("admin-pw").value;
    const pw2    = document.getElementById("admin-pw2").value;

    if (!fname || !lname || !email || !pw) { showErr("Please fill in all fields."); return; }
    if (pw !== pw2) { showErr("Passwords do not match."); return; }
    if (pw.length < 6) { showErr("Password must be at least 6 characters."); return; }

    btn.disabled    = true;
    btn.textContent = "Claiming access…";

    try {
      _explicitAuthFlow = true;
      const fbUser = await Auth.claimAdmin(email, pw, fname, lname);
      await Auth.loadProfile(fbUser);
      toast("Supreme Admin access claimed. Welcome aboard.", "success");
      navigate("dashboard");
      router();
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = "Claim Supreme Admin Access";
      showErr(err.message || "Failed to claim admin access.");
    } finally {
      _explicitAuthFlow = false;
    }
  });
}

/* ============================================================
   MANAGER REGISTRATION — creates Firebase account + Firestore profile
   ============================================================ */
function renderRegister() {
  appRoot.innerHTML = `
    <div class="pt-auth-wrap">
      <div class="pt-auth-card" style="max-width:500px;">
        <div class="pt-auth-logo">PT</div>
        <h4 style="font-weight:700;color:#0f172a;margin-bottom:4px;">Register Organization</h4>
        <p style="color:#64748b;font-size:13px;margin-bottom:18px;">Create a manager account and set up your organization. Your account is created right away, but a manager can't access the dashboard until the Supreme Admin approves the request.</p>

        <div id="reg-error" style="display:none;background:#FBE1E1;color:#D64545;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px;"></div>

        <div class="form-row cols-2">
          <div><label class="form-label">First Name</label><input type="text" class="form-control" id="reg-fname" placeholder="Grace"></div>
          <div><label class="form-label">Last Name</label><input type="text" class="form-control" id="reg-lname" placeholder="Wanjiru"></div>
        </div>
        <div class="field">
          <label class="form-label">Organization / Company Name</label>
          <input type="text" class="form-control" id="reg-org" placeholder="Prime Telecoms Ltd">
        </div>
        <div class="field">
          <label class="form-label">Email Address</label>
          <input type="email" class="form-control" id="reg-email" placeholder="manager@company.com">
        </div>
        <div class="form-row cols-2">
          <div>${pwField("reg-pw", "Password", "Min. 6 characters")}</div>
          <div>${pwField("reg-pw2", "Confirm Password")}</div>
        </div>

        <button class="btn btn-pt-primary btn-block" id="btn-register" style="margin-top:6px;">
          Create Manager Account
        </button>
        <div style="text-align:center;margin-top:12px;font-size:13px;">
          <a href="#" id="back-to-login" style="color:#2563EB;">← Back to Sign In</a>
        </div>
      </div>
    </div>
  `;

  const errEl = document.getElementById("reg-error");
  function showErr(msg) { errEl.textContent = msg; errEl.style.display = "block"; }

  document.getElementById("back-to-login").addEventListener("click", (e) => { e.preventDefault(); renderLogin(); });

  document.getElementById("btn-register").addEventListener("click", async () => {
    const btn    = document.getElementById("btn-register");
    const fname  = document.getElementById("reg-fname").value.trim();
    const lname  = document.getElementById("reg-lname").value.trim();
    const org    = document.getElementById("reg-org").value.trim();
    const email  = document.getElementById("reg-email").value.trim();
    const pw     = document.getElementById("reg-pw").value;
    const pw2    = document.getElementById("reg-pw2").value;

    if (!fname || !lname || !org || !email || !pw) { showErr("Please fill in all fields."); return; }
    if (pw !== pw2) { showErr("Passwords do not match."); return; }
    if (pw.length < 6) { showErr("Password must be at least 6 characters."); return; }

    btn.disabled    = true;
    btn.textContent = "Creating account…";

    try {
      _explicitAuthFlow = true;
      const displayName = `${fname} ${lname}`;
      const fbUser = await Auth.registerWithEmail(email, pw, displayName);

      // Create Firestore profile with the manager_pending role — NOT
      // "manager" outright. A manager only gets real access once the
      // Supreme Admin approves the request (see Users.setManagerStatus);
      // until then the router below sends them to a waiting screen.
      // Single-tenant deployment: every account (manager, technician,
      // customer) shares DEFAULT_ORG_ID so customer requests are visible
      // to the manager and vice versa. See data.js for details.
      await Auth.loadProfile(fbUser, {
        role: "manager_pending",
        organizationId: DEFAULT_ORG_ID,
        orgName: org,
      });
      // Overwrite firstName/lastName correctly (displayName split may miss them)
      await Auth.updateProfile(fbUser.uid, { firstName: fname, lastName: lname, orgName: org });

      toast(`Account created, ${fname}. Waiting on Supreme Admin approval.`, "success");
      navigate("dashboard");
      router();
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = "Create Manager Account";
      showErr(Auth.getErrorMessage(err.code) || err.message);
    } finally {
      _explicitAuthFlow = false;
    }
  });
}

/* ============================================================
   TECHNICIAN ACTIVATION — activates Firebase account using manager-authorized email
   ============================================================ */
function renderActivateTechnician() {
  appRoot.innerHTML = `
    <div class="pt-auth-wrap">
      <div class="pt-auth-card" style="max-width:460px;">
        <div class="pt-auth-logo">PT</div>
        <h4 style="font-weight:700;color:#0f172a;margin-bottom:4px;">Technician Activation</h4>
        <p style="color:#64748b;font-size:13px;margin-bottom:6px;">Authorized technician staff only.</p>
        <div style="background:#fef9c3;color:#713f12;padding:10px 14px;border-radius:10px;font-size:12.5px;margin-bottom:14px;">
          ⚠ You must use the exact email address authorized by your organization manager.
        </div>

        <div id="tech-error" style="display:none;background:#FBE1E1;color:#D64545;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px;"></div>
        <div id="tech-info"  style="display:none;background:#e0f2fe;color:#0369a1;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px;"></div>

        <div class="field">
          <label class="form-label">Authorized Email</label>
          <input type="email" class="form-control" id="tech-email" placeholder="technician@company.com">
        </div>
        <div class="field">
          ${pwField("tech-pw", "Set Your Password", "Min. 6 characters")}
        </div>

        <button class="btn btn-pt-primary btn-block" id="btn-activate">
          Verify &amp; Activate Account
        </button>
        <div style="text-align:center;margin-top:12px;font-size:13px;">
          <a href="#" id="back-to-login2" style="color:#2563EB;">← Back to Sign In</a>
        </div>
      </div>
    </div>
  `;

  const errEl  = document.getElementById("tech-error");
  const infoEl = document.getElementById("tech-info");
  function showErr(msg)  { errEl.textContent = msg; errEl.style.display = "block"; infoEl.style.display = "none"; }
  function showInfo(msg) { infoEl.textContent = msg; infoEl.style.display = "block"; errEl.style.display = "none"; }

  document.getElementById("back-to-login2").addEventListener("click", (e) => { e.preventDefault(); renderLogin(); });

  document.getElementById("btn-activate").addEventListener("click", async () => {
    const btn   = document.getElementById("btn-activate");
    const email = document.getElementById("tech-email").value.trim().toLowerCase();
    const pw    = document.getElementById("tech-pw").value;

    if (!email || !pw) { showErr("Please enter your authorized email and a password."); return; }
    if (pw.length < 6) { showErr("Password must be at least 6 characters."); return; }

    btn.disabled    = true;
    btn.textContent = "Checking authorization…";

    try {
      // Step 1 — check Firestore authorization record
      const authRecord = await Auth.getTechnicianAuthorization(email);
      if (!authRecord) {
        showErr(`Access Denied: "${email}" has not been authorized by any organization manager.`);
        btn.disabled    = false;
        btn.textContent = "Verify & Activate Account";
        return;
      }
      if (authRecord.status === "revoked") {
        showErr(`Access Denied: Authorization for "${email}" has been revoked. Contact your manager.`);
        btn.disabled    = false;
        btn.textContent = "Verify & Activate Account";
        return;
      }

      showInfo("Authorization confirmed — creating your account…");
      _explicitAuthFlow = true;

      // Step 2 — create or sign into Firebase account
      let fbUser;
      try {
        fbUser = await Auth.registerWithEmail(email, pw, email.split("@")[0]);
      } catch (createErr) {
        if (createErr.code === "auth/email-already-in-use") {
          fbUser = (await (async () => {
            const a = await (window.PrimeFirebase && window.PrimeFirebase.auth
              ? window.PrimeFirebase.auth
              : firebase.auth()).signInWithEmailAndPassword(email, pw);
            return a.user;
          })());
        } else {
          throw createErr;
        }
      }

      // Step 3 — write Firestore profile with technician role.
      // organizationId is deliberately hard-pinned to DEFAULT_ORG_ID here,
      // NOT inherited from authRecord.organizationId — the authorization
      // record is written by a manager's own profile at authorization time
      // (see Auth.authorizeTechnician / Users.changeRole in data.js) and if
      // that manager's own profile ever carried a stale organizationId, this
      // was a live path for that stale value to propagate into a brand-new
      // technician account. Single-tenant deployment: every account shares
      // DEFAULT_ORG_ID regardless of what the authorization record says.
      await Auth.loadProfile(fbUser, {
        role: "technician",
        organizationId: DEFAULT_ORG_ID,
        authorizedBy: authRecord.authorizedBy || "",
      });
      if (authRecord.firstName || authRecord.lastName) {
        await Auth.updateProfile(fbUser.uid, {
          firstName: authRecord.firstName || email.split("@")[0],
          lastName:  authRecord.lastName  || "",
        });
      }

      toast("Technician account activated! Welcome to your workspace.", "success");
      navigate("dashboard");
      router();

    } catch (err) {
      btn.disabled    = false;
      btn.textContent = "Verify & Activate Account";
      showErr(Auth.getErrorMessage(err.code) || err.message);
    } finally {
      _explicitAuthFlow = false;
    }
  });
}

/* ============================================================
   CUSTOMER REGISTRATION — self-service, no manager authorization needed.
   Unlike technicians (who must be pre-authorized by a manager), any
   member of the public can create a customer account directly.
   ============================================================ */
function renderCustomerRegister() {
  appRoot.innerHTML = `
    <div class="pt-auth-wrap">
      <div class="pt-auth-card" style="max-width:500px;">
        <div class="pt-auth-logo">PT</div>
        <h4 style="font-weight:700;color:#0f172a;margin-bottom:4px;">Create Your Customer Account</h4>
        <p style="color:#64748b;font-size:13px;margin-bottom:18px;">Register to book field service requests and track their progress.</p>

        <div id="cust-error" style="display:none;background:#FBE1E1;color:#D64545;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px;"></div>

        <div class="form-row cols-2">
          <div><label class="form-label">First Name</label><input type="text" class="form-control" id="cust-fname" placeholder="Alice"></div>
          <div><label class="form-label">Last Name</label><input type="text" class="form-control" id="cust-lname" placeholder="Njeri"></div>
        </div>
        <div class="field">
          <label class="form-label">Email Address</label>
          <input type="email" class="form-control" id="cust-email" placeholder="you@example.com">
        </div>
        <div class="field">
          <label class="form-label">Phone Number</label>
          <input type="text" class="form-control" id="cust-phone" placeholder="e.g. 0712345678">
        </div>
        <div class="form-row cols-2">
          <div>${pwField("cust-pw", "Password", "Min. 6 characters")}</div>
          <div>${pwField("cust-pw2", "Confirm Password")}</div>
        </div>

        <button class="btn btn-pt-primary btn-block" id="btn-cust-register" style="margin-top:6px;">
          Create My Account
        </button>
        <div style="text-align:center;margin-top:12px;font-size:13px;">
          <a href="#" id="back-to-login3" style="color:#2563EB;">← Back to Sign In</a>
        </div>
      </div>
    </div>
  `;

  const errEl = document.getElementById("cust-error");
  function showErr(msg) { errEl.textContent = msg; errEl.style.display = "block"; }

  document.getElementById("back-to-login3").addEventListener("click", (e) => { e.preventDefault(); renderLogin(); });

  document.getElementById("btn-cust-register").addEventListener("click", async () => {
    const btn    = document.getElementById("btn-cust-register");
    const fname  = document.getElementById("cust-fname").value.trim();
    const lname  = document.getElementById("cust-lname").value.trim();
    const email  = document.getElementById("cust-email").value.trim();
    const phone  = document.getElementById("cust-phone").value.trim();
    const pw     = document.getElementById("cust-pw").value;
    const pw2    = document.getElementById("cust-pw2").value;

    if (!fname || !lname || !email || !pw) { showErr("Please fill in all required fields."); return; }
    if (pw !== pw2) { showErr("Passwords do not match."); return; }
    if (pw.length < 6) { showErr("Password must be at least 6 characters."); return; }

    btn.disabled    = true;
    btn.textContent = "Creating account…";

    try {
      _explicitAuthFlow = true;
      const displayName = `${fname} ${lname}`;
      const fbUser = await Auth.registerWithEmail(email, pw, displayName);

      // Self-service — role is fixed to "customer" here in code, the
      // person has no way to pick a different role from this form.
      await Auth.loadProfile(fbUser, {
        role: "customer",
        organizationId: DEFAULT_ORG_ID,
        phone,
      });
      await Auth.updateProfile(fbUser.uid, { firstName: fname, lastName: lname, phone });

      toast(`Welcome, ${fname}! You can now book a service.`, "success");
      navigate("dashboard");
      router();
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = "Create My Account";
      showErr(Auth.getErrorMessage(err.code) || err.message);
    } finally {
      _explicitAuthFlow = false;
    }
  });
}

/* ============================================================
   PENDING MANAGER APPROVAL — waiting / rejected screen
   Shown by the router for any signed-in user whose role is still
   "manager_pending", regardless of what hash they typed. Clears
   itself automatically the instant the Supreme Admin decides —
   see _startMyProfileListener in data.js, which re-fires the
   router on any role/active change to the signed-in user's own
   profile without requiring a manual refresh.
   ============================================================ */
function renderPendingApproval(user) {
  const rejected = user.active === false;
  appRoot.innerHTML = `
    <div class="pt-auth-wrap">
      <div class="pt-auth-card" style="text-align:center;">
        <div class="pt-auth-logo">PT</div>
        ${rejected ? `
          <h4 style="font-weight:700;color:#D64545;margin-bottom:8px;">Access Not Granted</h4>
          <p style="color:#64748b;font-size:13.5px;margin-bottom:20px;">
            Your manager registration for <strong>${escapeHtml(user.orgName || "this organization")}</strong> was not
            approved by the Supreme Admin. If you believe this is a mistake, contact your system administrator.
          </p>
        ` : `
          <h4 style="font-weight:700;color:#0f172a;margin-bottom:8px;">Awaiting Admin Approval</h4>
          <p style="color:#64748b;font-size:13.5px;margin-bottom:20px;">
            Thanks, ${escapeHtml(user.firstName)} — your manager account for <strong>${escapeHtml(user.orgName || "your organization")}</strong>
            has been created, but manager access needs to be approved by the Supreme Admin first. You'll be let in
            automatically the moment it's approved — no need to keep refreshing this page.
          </p>
        `}
        <button class="btn btn-pt-outline btn-block" id="btn-pending-logout">Sign Out</button>
      </div>
    </div>
  `;
  document.getElementById("btn-pending-logout").addEventListener("click", async () => {
    await Auth.signOut();
    navigate("dashboard");
    router();
  });
}

/* ============================================================
   SUPREME ADMIN — Overview & Issues (the admin's #dashboard)
   ============================================================ */
function renderAdminOverview(el, user) {
  setPageTitle("Supreme Admin Command Center", "Complete visibility and operational intelligence");
  const jobs = Jobs.all();
  const reports = Reports.all();
  const pendingManagers = Users.pendingManagers();
  const activeManagers = Users.managers();
  const technicians = Users.allTechniciansForAdmin();
  const activeTechnicians = Users.technicians();
  const clientUsers = Users.customers();

  const ratedJobs = jobs.filter((j) => j.rating);
  const avgRating = ratedJobs.length ? (ratedJobs.reduce((s, j) => s + j.rating, 0) / ratedJobs.length) : 0;

  // Alerts
  const unassigned = jobs.filter((j) => j.status === "pending");
  const staleUnassigned = unassigned.filter((j) => (Date.now() - new Date(j.createdAt).getTime()) > 24 * 60 * 60 * 1000);
  const stuckInProgress = jobs.filter((j) => j.status === "in_progress" && j.startedAt && (Date.now() - new Date(j.startedAt).getTime()) > 3 * 24 * 60 * 60 * 1000);
  const reportsAwaitingReview = reports.filter((r) => r.status === "submitted");
  const lowReviews = Jobs.reviews().filter((j) => j.rating <= 2);

  const alerts = [];
  if (pendingManagers.length) {
    alerts.push({
      type: "critical",
      icon: "🚨",
      text: `${pendingManagers.length} manager registration request${pendingManagers.length > 1 ? "s" : ""} pending approval`,
      link: "#admin/managers"
    });
  }
  if (staleUnassigned.length) {
    alerts.push({
      type: "warning",
      icon: "⏳",
      text: `${staleUnassigned.length} job${staleUnassigned.length > 1 ? "s" : ""} unassigned for over 24 hours`,
      link: "#jobs"
    });
  }
  if (stuckInProgress.length) {
    alerts.push({
      type: "warning",
      icon: "⚠️",
      text: `${stuckInProgress.length} job${stuckInProgress.length > 1 ? "s" : ""} in-progress for over 3 days`,
      link: "#jobs"
    });
  }
  if (reportsAwaitingReview.length) {
    alerts.push({
      type: "info",
      icon: "📝",
      text: `${reportsAwaitingReview.length} service report${reportsAwaitingReview.length > 1 ? "s" : ""} awaiting manager review`,
      link: "#reports"
    });
  }
  if (lowReviews.length) {
    alerts.push({
      type: "critical",
      icon: "👎",
      text: `${lowReviews.length} customer complaint${lowReviews.length > 1 ? "s" : ""} (rating 2★ or below)`,
      link: "#reviews"
    });
  }

  // Managers aggregated view
  const managersOverviewList = AdminStats.managerOverview();

  // Techs list
  const techPerformance = AdminStats.technicianPerformance();

  // Activity Feed
  const recentActivities = AdminStats.activityFeed(8);

  el.innerHTML = `
    <!-- KPI Command Row -->
    <div class="pt-admin-kpi-row">
      <div class="pt-admin-kpi-tile slate">
        <span class="pt-admin-kpi-icon">🏢</span>
        <div class="pt-admin-kpi-value">1</div>
        <div class="pt-admin-kpi-label">Organizations</div>
        <div class="pt-admin-kpi-sub">Prime Telecoms Ltd</div>
      </div>
      <div class="pt-admin-kpi-tile purple">
        <span class="pt-admin-kpi-icon">🛡️</span>
        <div class="pt-admin-kpi-value">${activeManagers.length}</div>
        <div class="pt-admin-kpi-label">Managers</div>
        <div class="pt-admin-kpi-sub">${pendingManagers.length} pending approval</div>
      </div>
      <div class="pt-admin-kpi-tile green">
        <span class="pt-admin-kpi-icon">🔧</span>
        <div class="pt-admin-kpi-value">${activeTechnicians.length}</div>
        <div class="pt-admin-kpi-label">Technicians</div>
        <div class="pt-admin-kpi-sub">${technicians.filter(t => t.active === false).length} inactive accounts</div>
      </div>
      <div class="pt-admin-kpi-tile">
        <span class="pt-admin-kpi-icon">💼</span>
        <div class="pt-admin-kpi-value">${jobs.length}</div>
        <div class="pt-admin-kpi-label">Total Jobs</div>
        <div class="pt-admin-kpi-sub">${jobs.filter(j => j.status === "completed").length} completed</div>
      </div>
      <div class="pt-admin-kpi-tile blue">
        <span class="pt-admin-kpi-icon">👤</span>
        <div class="pt-admin-kpi-value">${clientUsers.length}</div>
        <div class="pt-admin-kpi-label">Client Users</div>
        <div class="pt-admin-kpi-sub">${clientUsers.filter(c => c.active !== false).length} active accounts</div>
      </div>
      <div class="pt-admin-kpi-tile amber">
        <span class="pt-admin-kpi-icon">⭐️</span>
        <div class="pt-admin-kpi-value">${avgRating ? avgRating.toFixed(1) : "—"}</div>
        <div class="pt-admin-kpi-label">Avg Rating</div>
        <div class="pt-admin-kpi-sub">Across ${ratedJobs.length} reviews</div>
      </div>
    </div>

    <!-- Alert / System Event Feed -->
    <div class="pt-card" style="margin-bottom: 20px;">
      <div class="pt-card-title">System Activity Alerts</div>
      ${alerts.length ? `
        <div style="display: flex; flex-direction: column;">
          ${alerts.map(a => `
            <a href="${a.link}" class="pt-admin-alert ${a.type}">
              <span class="pt-admin-alert-icon">${a.icon}</span>
              <span class="pt-admin-alert-text">${a.text}</span>
              <span class="pt-admin-alert-arrow">➔</span>
            </a>
          `).join("")}
        </div>
      ` : `
        <div class="pt-admin-alert success">
          <span class="pt-admin-alert-icon">💚</span>
          <span class="pt-admin-alert-text">All systems green. No pending registrations, stalled jobs, or low ratings found.</span>
        </div>
      `}
    </div>

    <!-- Manager Control Center Grid -->
    <div class="pt-admin-section-head">
      <h3><span>🏢</span> Managers &amp; Organizations</h3>
      <a href="#admin/managers" class="btn btn-pt-outline btn-sm">Manage Accounts</a>
    </div>
    
    <div class="pt-admin-mgr-grid" style="margin-bottom: 20px;">
      ${managersOverviewList.length ? managersOverviewList.map(m => {
        const isSuspended = m.active === false;
        const badgeClass = isSuspended ? 'pt-mgr-badge-suspended' : 'pt-mgr-badge-active';
        const badgeLabel = isSuspended ? 'Suspended' : 'Active';
        return `
          <div class="pt-admin-mgr-card">
            <div class="pt-admin-mgr-card-header">
              <div class="pt-admin-mgr-avatar">${escapeHtml(m.firstName[0])}</div>
              <div>
                <div class="pt-admin-mgr-name">${escapeHtml(Users.fullName(m))}</div>
                <div class="pt-admin-mgr-email">${escapeHtml(m.email || m.username)}</div>
                <div class="pt-admin-mgr-org">${escapeHtml(m.orgName || "Prime Telecoms Limited")}</div>
              </div>
              <div style="margin-left: auto;">
                <span class="${badgeClass}">${badgeLabel}</span>
              </div>
            </div>
            <div class="pt-admin-mgr-stats">
              <div class="pt-admin-mgr-stat">
                <div class="pt-admin-mgr-stat-val">${m.techCount}</div>
                <div class="pt-admin-mgr-stat-lbl">Techs</div>
              </div>
              <div class="pt-admin-mgr-stat">
                <div class="pt-admin-mgr-stat-val">${m.totalJobs}</div>
                <div class="pt-admin-mgr-stat-lbl">Jobs</div>
              </div>
              <div class="pt-admin-mgr-stat">
                <div class="pt-admin-mgr-stat-val">${m.avgRating ? m.avgRating.toFixed(1) : "—"}★</div>
                <div class="pt-admin-mgr-stat-lbl">Rating</div>
              </div>
            </div>
            <div class="pt-admin-mgr-actions">
              <a href="#admin/manager/${m.id}" class="btn btn-pt-primary btn-sm btn-block" style="text-align: center; justify-content: center;">Drill Down Dashboard</a>
            </div>
          </div>
        `;
      }).join("") : `
        <div class="pt-empty-state" style="grid-column: 1/-1;">
          <i>👤</i>No managers approved yet.
        </div>
      `}
    </div>

    <!-- Techs Board & Activity Feed -->
    <div class="pt-grid-2">
      <!-- Technician Status Board -->
      <div class="pt-card">
        <div class="pt-card-title">Technician Status Board</div>
        ${techPerformance.length ? `
          <div class="pt-table-wrap">
            <table class="pt-table">
              <thead>
                <tr>
                  <th>Technician</th>
                  <th>Status</th>
                  <th>Active Jobs</th>
                  <th>Completion</th>
                  <th>Avg Rating</th>
                </tr>
              </thead>
              <tbody>
                ${techPerformance.map(t => {
                  const status = AdminStats.technicianStatus(t.id);
                  let statusClass = "pt-status-offline";
                  let statusLbl = "Offline";
                  if (status === "on-duty") { statusClass = "pt-status-on-duty"; statusLbl = "On Duty"; }
                  else if (status === "available") { statusClass = "pt-status-available"; statusLbl = "Available"; }
                  else if (status === "on-break") { statusClass = "pt-status-on-break"; statusLbl = "On Break"; }
                  else if (status === "inactive") { statusClass = "pt-status-inactive"; statusLbl = "Inactive"; }
                  
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHtml(Users.fullName(t))}</strong><br>
                        <span class="text-muted" style="font-size: 11px;">${escapeHtml(t.employeeId || "No ID")}</span>
                      </td>
                      <td>
                        <span class="pt-status-badge ${statusClass}">${statusLbl}</span>
                      </td>
                      <td><strong>${t.activeJobs}</strong></td>
                      <td>
                        <div style="font-size: 12px; font-weight: 600;">${t.compRate}%</div>
                        <div class="pt-admin-progress-bar" style="width: 60px;">
                          <div class="pt-admin-progress-fill" style="width: ${t.compRate}%;"></div>
                        </div>
                      </td>
                      <td>${t.avgRating ? `${t.avgRating.toFixed(1)}★` : "—"}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="pt-empty-state">
            <i>🔧</i>No technicians authorized.
          </div>
        `}
      </div>

      <!-- Recent System Activity Log -->
      <div class="pt-card">
        <div class="pt-card-title">
          <span>Activity Stream</span>
          <a href="#admin/activity" class="btn btn-pt-outline btn-sm">Full Log</a>
        </div>
        ${recentActivities.length ? `
          <div class="pt-activity-feed">
            ${recentActivities.map(a => `
              <div class="pt-activity-item">
                <div class="pt-activity-dot ${a.color}">${a.icon}</div>
                <div class="pt-activity-body">
                  <div class="pt-activity-title">${a.title}</div>
                  <div class="pt-activity-meta">${a.meta}</div>
                  <div class="pt-activity-time">${timeAgo(a.ts)}</div>
                </div>
              </div>
            `).join("")}
          </div>
        ` : `
          <div class="pt-empty-state">
            <i>📋</i>No activity logged yet.
          </div>
        `}
      </div>
    </div>
  `;
}

/* ============================================================
   SUPREME ADMIN — Manager Approvals (#admin/managers)
   ============================================================ */
function renderAdminManagers(el, user) {
  setPageTitle("Manager Control Center", "Add managers, approve requests, and manage access");
  const pending = Users.pendingManagers();
  const active = Users.managers();
  const rejected = Users.rejectedManagers();

  const allTechs = Users.allTechniciansForAdmin();
  const jobs = Jobs.all();
  const reviews = Jobs.reviews();

  function getStatsForManager(m) {
    const techCount = allTechs.length; // single-tenant pool
    const mgrJobs = jobs; // single-tenant
    const avgRating = reviews.length ? (reviews.reduce((s, j) => s + j.rating, 0) / reviews.length) : 0;
    return { techCount, jobCount: mgrJobs.length, avgRating };
  }

  el.innerHTML = `
    <div class="pt-card" style="max-width:600px;margin-bottom:20px;">
      <div class="pt-card-title">&#128100; Add a Manager</div>
      <p style="font-size:13px;color:#64748b;margin-bottom:14px;">
        Only the Supreme Admin can create a manager account this way. Set their email and password here — the
        account is created and made active immediately, so they can sign in right away with these credentials.
      </p>
      <div id="add-mgr-err" style="display:none;background:#FBE1E1;color:#D64545;padding:9px 12px;border-radius:9px;font-size:12.5px;margin-bottom:10px;"></div>
      <div id="add-mgr-ok"  style="display:none;background:#dcfce7;color:#166534;padding:9px 12px;border-radius:9px;font-size:12.5px;margin-bottom:10px;"></div>
      <div class="form-row cols-2" style="margin-bottom:0;">
        <div><label class="form-label">First Name</label><input type="text" class="form-control" id="mgr-fname" placeholder="Grace"></div>
        <div><label class="form-label">Last Name</label><input type="text" class="form-control" id="mgr-lname" placeholder="Wanjiru"></div>
      </div>
      <div class="field">
        <label class="form-label">Manager Email</label>
        <input type="email" class="form-control" id="mgr-email" placeholder="manager@company.com">
      </div>
      <div class="field">
        ${pwField("mgr-pw", "Set Their Password", "Min. 6 characters")}
      </div>
      <button class="btn btn-pt-primary mt-3" id="btn-add-mgr">Create Manager Account</button>
    </div>

    <div class="pt-card" style="margin-bottom:20px;">
      <div class="pt-card-title">Pending Requests (${pending.length})</div>
      ${pending.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Name</th><th>Email</th><th>Organization</th><th>Requested</th><th></th></tr></thead><tbody>
        ${pending.map((m) => `
          <tr>
            <td><strong>${escapeHtml(Users.fullName(m))}</strong></td>
            <td>${escapeHtml(m.username || m.email)}</td>
            <td>${escapeHtml(m.orgName) || "—"}</td>
            <td title="${fmtDateTime(m.createdAt)}">${timeAgo(m.createdAt)}</td>
            <td style="text-align:right;white-space:nowrap;">
              <button class="btn btn-pt-primary btn-sm" data-approve="${m.id}">Approve</button>
              <button class="btn btn-danger-outline btn-sm" data-reject="${m.id}">Reject</button>
            </td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#9989;</i>No pending manager requests.</div>`}
    </div>

    <div class="pt-card" style="margin-bottom:20px;">
      <div class="pt-card-title">Active Managers (${active.length})</div>
      ${active.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Name</th><th>Email</th><th>Organization</th><th>Techs</th><th>Jobs</th><th>Avg Rating</th><th></th></tr></thead><tbody>
        ${active.map((m) => {
          const stats = getStatsForManager(m);
          return `
          <tr>
            <td><strong>${escapeHtml(Users.fullName(m))}</strong></td>
            <td>${escapeHtml(m.username || m.email)}</td>
            <td>${escapeHtml(m.orgName) || "—"}</td>
            <td><strong>${stats.techCount}</strong></td>
            <td><strong>${stats.jobCount}</strong></td>
            <td>${stats.avgRating ? `${stats.avgRating.toFixed(1)}★` : "—"}</td>
            <td style="text-align:right;white-space:nowrap;">
              <a href="#admin/manager/${m.id}" class="btn btn-pt-primary btn-sm">Drill Down</a>
              <button class="btn btn-pt-outline btn-sm" data-show-pw="${m.id}">Show PW</button>
              <button class="btn btn-pt-outline btn-sm" data-reset-pw="${escapeHtml(m.email || m.username)}">Reset Email</button>
              <button class="btn btn-pt-outline btn-sm" data-suspend-mgr="${m.id}">Suspend</button>
              <button class="btn btn-danger-outline btn-sm" data-revoke-mgr="${m.id}">Revoke</button>
            </td>
          </tr>`;
        }).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128100;</i>No active managers yet.</div>`}
    </div>

    <div class="pt-card">
      <div class="pt-card-title">Suspended / Rejected / Revoked (${rejected.length})</div>
      ${rejected.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Name</th><th>Email</th><th>Organization</th><th>Status</th><th></th></tr></thead><tbody>
        ${rejected.map((m) => `
          <tr>
            <td><strong>${escapeHtml(Users.fullName(m))}</strong></td>
            <td>${escapeHtml(m.username || m.email)}</td>
            <td>${escapeHtml(m.orgName) || "—"}</td>
            <td>
              ${m.suspendedAt ? '<span class="pt-mgr-badge-suspended">Suspended</span>' : 
                (m.role === "manager_pending" ? '<span class="pt-mgr-badge-pending">Rejected Request</span>' : '<span class="pt-mgr-badge-revoked">Revoked Access</span>')}
            </td>
            <td style="text-align:right;"><button class="btn btn-pt-outline btn-sm" data-reinstate="${m.id}">Activate &amp; Reinstate</button></td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128100;</i>Nobody has been rejected, suspended, or revoked.</div>`}
    </div>
  `;

  el.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await Users.setManagerStatus(btn.getAttribute("data-approve"), "approve");
        toast("Manager approved — they now have full access.", "success");
      } catch (err) {
        toast(err.message || "Failed to approve.", "error");
        btn.disabled = false;
      }
    });
  });
  el.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Reject this manager request? They will not be able to access the system.")) return;
      btn.disabled = true;
      try {
        await Users.setManagerStatus(btn.getAttribute("data-reject"), "reject");
        toast("Manager request rejected.", "success");
      } catch (err) {
        toast(err.message || "Failed to reject.", "error");
        btn.disabled = false;
      }
    });
  });
  el.querySelectorAll("[data-revoke-mgr]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Revoke this manager's access? They will be signed out of manager duties immediately.")) return;
      btn.disabled = true;
      try {
        await Users.setManagerStatus(btn.getAttribute("data-revoke-mgr"), "revoke");
        toast("Manager access revoked.", "success");
      } catch (err) {
        toast(err.message || "Failed to revoke.", "error");
        btn.disabled = false;
      }
    });
  });
  el.querySelectorAll("[data-suspend-mgr]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Suspend this manager? Operations under their supervision will be paused.")) return;
      btn.disabled = true;
      try {
        await Users.setManagerStatus(btn.getAttribute("data-suspend-mgr"), "suspend");
        toast("Manager suspended.", "success");
      } catch (err) {
        toast(err.message || "Failed to suspend manager.", "error");
        btn.disabled = false;
      }
    });
  });
  el.querySelectorAll("[data-reinstate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await Users.setManagerStatus(btn.getAttribute("data-reinstate"), "reinstate");
        toast("Access reinstated.", "success");
      } catch (err) {
        toast(err.message || "Failed to reinstate.", "error");
        btn.disabled = false;
      }
    });
  });
  el.querySelectorAll("[data-reset-pw]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.getAttribute("data-reset-pw");
      btn.disabled = true;
      try {
        await Auth.sendPasswordReset(email);
        toast(`Password reset email sent to ${email}.`, "success");
      } catch (err) {
        toast(Auth.getErrorMessage(err.code) || err.message || "Couldn't send reset email.", "error");
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Reveal the password stored at account-creation time — only works for
  // managers created right here via "Add a Manager" (see adminCreateManager
  // in data.js). A self-registered manager has no stored password, same
  // as any self-activated account; the toast below explains that case.
  el.querySelectorAll("[data-show-pw]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-show-pw");
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        const rec = await Auth.getStoredPassword(id);
        if (!rec || !rec.lastKnownPassword) {
          toast("No stored password on file for this account — it likely self-registered, or has changed its password since. Use \"Send Reset Email\" instead.", "info");
          return;
        }
        const setWhen = rec.setAt ? fmtDateTime(rec.setAt) : "an earlier date";
        const copy = confirm(
          `Password set at account creation (by ${rec.setByName || "the Supreme Admin"} on ${setWhen}):\n\n${rec.lastKnownPassword}\n\n` +
          `Note: if this person has changed their password since, this will no longer work.\n\nClick OK to copy it to your clipboard.`
        );
        if (copy && navigator.clipboard) {
          navigator.clipboard.writeText(rec.lastKnownPassword).catch(() => {});
        }
      } catch (err) {
        toast(err.message || "Couldn't load the stored password.", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  // ── Add-manager button handler — Supreme-Admin-only direct account
  //    creation (mirrors "Add a Technician" in renderStaffList). ─────────
  document.getElementById("btn-add-mgr").addEventListener("click", async () => {
    const btn    = document.getElementById("btn-add-mgr");
    const fname  = document.getElementById("mgr-fname").value.trim();
    const lname  = document.getElementById("mgr-lname").value.trim();
    const email  = document.getElementById("mgr-email").value.trim().toLowerCase();
    const pw     = document.getElementById("mgr-pw").value;
    const errEl  = document.getElementById("add-mgr-err");
    const okEl   = document.getElementById("add-mgr-ok");

    errEl.style.display = "none";
    okEl.style.display  = "none";

    if (!fname || !lname || !email) { errEl.textContent = "Please fill in the manager's name and email."; errEl.style.display = "block"; return; }
    if (!pw || pw.length < 6) { errEl.textContent = "Please set a password of at least 6 characters."; errEl.style.display = "block"; return; }

    btn.disabled = true;
    btn.textContent = "Creating account…";

    try {
      await Auth.adminCreateManager(email, pw, { firstName: fname, lastName: lname });
      okEl.textContent = `✓ Manager account created for ${email}. Give them this email and password — they can sign in right away.`;
      okEl.style.display = "block";
      toast(`Manager account created for ${email}`, "success");
      document.getElementById("mgr-fname").value = "";
      document.getElementById("mgr-lname").value = "";
      document.getElementById("mgr-email").value = "";
      document.getElementById("mgr-pw").value = "";
    } catch (err) {
      errEl.textContent = Auth.getErrorMessage(err.code) || err.message || "Failed to create manager account. Please try again.";
      errEl.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = "Create Manager Account";
    }
  });
}

/* ============================================================
   APP SHELL (sidebar + topbar)
   ============================================================ */
function renderShell(user) {
  const isAdmin = user.role === "admin";
  const isManager = user.role === "manager";
  const isTechnician = user.role === "technician";
  const isCustomer = user.role === "customer";

  const pendingCount = isAdmin ? Users.pendingManagers().length : 0;
  const pendingBadge = pendingCount ? ` <span class="pt-badge badge-status-cancelled" style="margin-left:4px;">${pendingCount}</span>` : "";

  const mainNav = isAdmin ? `
          <a href="#dashboard" class="pt-nav-link" data-nav="dashboard"><i>&#9635;</i> Command Center</a>
          <a href="#admin/managers" class="pt-nav-link" data-nav="admin/managers"><i>&#128737;</i> Manager Control${pendingBadge}</a>
          <a href="#admin/orgs" class="pt-nav-link" data-nav="admin/orgs"><i>&#127985;</i> Organizations</a>
          <a href="#admin/intel" class="pt-nav-link" data-nav="admin/intel"><i>&#128202;</i> System Intelligence</a>
          <a href="#admin/activity" class="pt-nav-link" data-nav="admin/activity"><i>&#128195;</i> Activity Log</a>
          <div class="pt-nav-section-label">Operations View</div>
          <a href="#jobs" class="pt-nav-link" data-nav="jobs"><i>&#128188;</i> Jobs</a>
          <a href="#reports" class="pt-nav-link" data-nav="reports"><i>&#128196;</i> Service Reports</a>
          <a href="#staff" class="pt-nav-link" data-nav="staff"><i>&#128101;</i> Technicians</a>
          <a href="#customers" class="pt-nav-link" data-nav="customers"><i>&#128100;</i> Customers</a>
          <a href="#reviews" class="pt-nav-link" data-nav="reviews"><i>&#11088;</i> Customer Reviews</a>
  ` : isManager ? `
          <a href="#dashboard" class="pt-nav-link" data-nav="dashboard"><i>&#9635;</i> Dashboard</a>
          <a href="#jobs" class="pt-nav-link" data-nav="jobs"><i>&#128188;</i> Jobs</a>
          <a href="#reports" class="pt-nav-link" data-nav="reports"><i>&#128196;</i> Service Reports</a>
          <div class="pt-nav-section-label">Management</div>
          <a href="#jobs/new" class="pt-nav-link"><i>&#10133;</i> Assign New Job</a>
          <a href="#staff" class="pt-nav-link" data-nav="staff"><i>&#128101;</i> Technicians</a>
          <a href="#customers" class="pt-nav-link" data-nav="customers"><i>&#128100;</i> Customers</a>
          <a href="#reviews" class="pt-nav-link" data-nav="reviews"><i>&#11088;</i> Customer Reviews</a>
  ` : isTechnician ? `
          <a href="#dashboard" class="pt-nav-link" data-nav="dashboard"><i>&#9635;</i> Dashboard</a>
          <a href="#jobs" class="pt-nav-link" data-nav="jobs"><i>&#128188;</i> My Jobs</a>
          <a href="#reports" class="pt-nav-link" data-nav="reports"><i>&#128196;</i> Service Reports</a>
  ` : `
          <a href="#dashboard" class="pt-nav-link" data-nav="dashboard"><i>&#9635;</i> Dashboard</a>
          <a href="#jobs/new" class="pt-nav-link"><i>&#10133;</i> Book a Service</a>
          <a href="#jobs" class="pt-nav-link" data-nav="jobs"><i>&#128188;</i> My Requests</a>
  `;

  appRoot.innerHTML = `
    <div class="pt-shell">
      <aside class="pt-sidebar" id="pt-sidebar">
        <div class="pt-sidebar-brand">
          <div class="pt-logo-mark">PT</div>
          <div class="pt-brand-text"><strong>Prime Telecoms Limited</strong><span>${isAdmin ? "SUPREME ADMIN" : isCustomer ? "CUSTOMER PORTAL" : "FIELD SERVICE SYSTEM"}</span></div>
        </div>
        <nav class="pt-nav">
          <div class="pt-nav-section-label">Main</div>
          ${mainNav}
          <div class="pt-nav-section-label">Account</div>
          <a href="#profile" class="pt-nav-link" data-nav="profile"><i>&#128100;</i> My Profile</a>
          <a href="#" id="logout-link" class="pt-nav-link"><i>&#10162;</i> Logout</a>
        </nav>
        <div class="pt-sidebar-footer">
          <div class="pt-user-chip">
            <div class="pt-user-avatar">${escapeHtml(user.firstName[0])}</div>
            <div>
              <div class="pt-user-name">${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</div>
              <div class="pt-user-role">${LABELS.role[user.role]}</div>
            </div>
          </div>
        </div>
      </aside>
      <div class="pt-main">
        <header class="pt-topbar">
          <div class="d-flex" style="align-items:center; gap:8px;">
            <button class="pt-sidebar-toggle" id="pt-sidebar-toggle">&#9776;</button>
            <div>
              <h1 id="page-title">Dashboard</h1>
              <div class="pt-topbar-subtitle" id="page-subtitle">Welcome back</div>
            </div>
          </div>
          <div class="text-muted" style="font-size:12.5px;">${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}</div>
        </header>
        <main class="pt-content" id="app-content"></main>
      </div>
    </div>
  `;

  document.getElementById("logout-link").addEventListener("click", async (e) => {
    e.preventDefault();
    await Auth.signOut();
    navigate("dashboard");
    router();
  });
  document.getElementById("pt-sidebar-toggle").addEventListener("click", () => {
    document.getElementById("pt-sidebar").classList.toggle("open");
  });
}

function setActiveNav(route) {
  document.querySelectorAll(".pt-nav-link[data-nav]").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-nav") === route);
  });
}

function setPageTitle(title, subtitle) {
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-subtitle").textContent = subtitle;
}

/* ============================================================
   BADGES
   ============================================================ */
function priorityBadge(p) {
  return `<span class="pt-badge badge-priority-${p}">${LABELS.priority[p]}</span>`;
}
function jobStatusBadge(s) {
  return `<span class="pt-badge badge-status-${s}">${LABELS.jobStatus[s]}</span>`;
}
function reportStatusBadge(s) {
  return `<span class="pt-badge badge-status-${s}">${LABELS.reportStatus[s]}</span>`;
}

/* ============================================================
   DASHBOARDS
   ============================================================ */
function renderManagerDashboard(el, user) {
  setPageTitle("Operations Dashboard", "Overview of field service operations");
  const jobs = Jobs.all();
  const reports = Reports.all();
  const total = jobs.length;
  const pending = jobs.filter((j) => j.status === "pending").length;
  const active = jobs.filter((j) => ["assigned", "in_progress"].includes(j.status)).length;
  const completed = jobs.filter((j) => j.status === "completed").length;
  const urgent = jobs.filter((j) => j.priority === "urgent" && j.status !== "completed").length;
  const pendingQueue = jobs.filter((j) => j.status === "pending").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const pendingReports = reports.filter((r) => r.status === "submitted").slice(0, 6);
  const recentJobs = jobs.slice(0, 6);
  const ratedJobs = jobs.filter((j) => j.rating);
  const avgRating = ratedJobs.length ? (ratedJobs.reduce((s, j) => s + j.rating, 0) / ratedJobs.length) : 0;
  const recentReviews = [...ratedJobs].sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)).slice(0, 4);
  const techs = Users.technicians().map((t) => ({
    ...t,
    activeJobs: jobs.filter((j) => j.assignedTo === t.id && ["assigned", "in_progress"].includes(j.status)).length,
  })).sort((a, b) => b.activeJobs - a.activeJobs).slice(0, 6);

  el.innerHTML = `
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#128188;</div><div><div class="pt-stat-value">${total}</div><div class="pt-stat-label">Total Jobs</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-amber">&#8987;</div><div><div class="pt-stat-value">${pending + active}</div><div class="pt-stat-label">Active / Pending</div></div></div>
    </div>
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-green">&#10004;</div><div><div class="pt-stat-value">${completed}</div><div class="pt-stat-label">Completed</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-red">&#9888;</div><div><div class="pt-stat-value">${urgent}</div><div class="pt-stat-label">Urgent, Unresolved</div></div></div>
    </div>
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-amber">&#9733;</div><div><div class="pt-stat-value">${avgRating ? avgRating.toFixed(1) : "—"}</div><div class="pt-stat-label">Avg. Customer Rating (${ratedJobs.length})</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#128101;</div><div><div class="pt-stat-value">${Users.technicians().length}</div><div class="pt-stat-label">Active Technicians</div></div></div>
    </div>

    <div class="pt-grid-2">
      <div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Awaiting Assignment <a href="#jobs?status=pending" class="btn btn-pt-outline btn-sm">View all</a></div>
          ${pendingQueue.length ? `
          <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Customer</th><th>Raised</th><th>Priority</th><th></th></tr></thead><tbody>
            ${pendingQueue.slice(0, 6).map((j) => `
              <tr>
                <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
                <td>${escapeHtml(j.customerName)}</td>
                <td title="${fmtDateTime(j.createdAt)}"><strong style="color:var(--pt-amber-dark);">${timeAgo(j.createdAt)}</strong></td>
                <td>${priorityBadge(j.priority)}</td>
                <td style="text-align:right;"><a href="#jobs/${j.id}/edit" class="btn btn-pt-amber btn-sm">Assign</a></td>
              </tr>`).join("")}
          </tbody></table></div>` : `<div class="pt-empty-state"><i>&#10003;</i>Nothing waiting — every request has a technician assigned.</div>`}
        </div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Recent Jobs <a href="#jobs" class="btn btn-pt-outline btn-sm">View all</a></div>
          ${recentJobs.length ? `
          <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Customer</th><th>Technician</th><th>Priority</th><th>Status</th></tr></thead><tbody>
            ${recentJobs.map((j) => `
              <tr data-goto="#jobs/${j.id}">
                <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
                <td>${escapeHtml(j.customerName)}</td>
                <td>${escapeHtml(Users.fullName(Users.get(j.assignedTo)))}</td>
                <td>${priorityBadge(j.priority)}</td>
                <td>${jobStatusBadge(j.status)}</td>
              </tr>`).join("")}
          </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128193;</i>No jobs recorded yet.</div>`}
        </div>
        <div class="pt-card">
          <div class="pt-card-title">Reports Awaiting Review <a href="#reports" class="btn btn-pt-outline btn-sm">View all</a></div>
          ${pendingReports.length ? `
          <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Technician</th><th>Submitted</th><th></th></tr></thead><tbody>
            ${pendingReports.map((r) => `
              <tr>
                <td><strong>${Jobs.get(r.jobId)?.jobNumber || "—"}</strong></td>
                <td>${escapeHtml(Users.fullName(Users.get(r.technicianId)))}</td>
                <td>${fmtDate(r.submittedAt)}</td>
                <td style="text-align:right;"><a href="#reports/${r.id}" class="btn btn-pt-outline btn-sm">Review</a></td>
              </tr>`).join("")}
          </tbody></table></div>` : `<div class="pt-empty-state"><i>&#10003;</i>No reports pending review.</div>`}
        </div>
      </div>
      <div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Quick Actions</div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            <a href="#jobs/new" class="btn btn-pt-amber btn-block">+ Assign New Job</a>
            <a href="#staff" class="btn btn-pt-outline btn-block">+ Add Technician</a>
            <a href="#jobs" class="btn btn-pt-outline btn-block">View Unassigned Jobs</a>
          </div>
        </div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Technician Workload</div>
          ${techs.length ? techs.map((t) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--pt-border);">
              <div><div style="font-size:13.5px; font-weight:600;">${escapeHtml(Users.fullName(t))}</div><div class="text-muted" style="font-size:11.5px;">${escapeHtml(t.employeeId)}</div></div>
              <span class="pt-badge badge-status-assigned">${t.activeJobs} active</span>
            </div>`).join("") : `<div class="pt-empty-state"><i>&#128101;</i>No technicians added yet.</div>`}
        </div>
        <div class="pt-card">
          <div class="pt-card-title">Recent Customer Reviews</div>
          ${recentReviews.length ? recentReviews.map((j) => `
            <a href="#jobs/${j.id}" style="display:block; padding:8px 0; border-bottom:1px solid var(--pt-border); color:inherit;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:13px; font-weight:600;">${escapeHtml(j.customerName)}</span>${starRating(j.rating)}
              </div>
              ${j.reviewComment ? `<div class="text-muted" style="font-size:12px; margin-top:2px;">${escapeHtml(j.reviewComment).slice(0, 80)}${j.reviewComment.length > 80 ? "…" : ""}</div>` : ""}
            </a>`).join("") : `<div class="pt-empty-state"><i>&#11088;</i>No reviews yet.</div>`}
        </div>
      </div>
    </div>
  `;
  attachRowNav(el);
}

function renderTechDashboard(el, user) {
  setPageTitle("My Dashboard", "Your assigned field jobs and reports");
  const myJobs = Jobs.all().filter((j) => j.assignedTo === user.id);
  const myReports = Reports.all().filter((r) => r.technicianId === user.id).slice(0, 5);
  const upcoming = myJobs.filter((j) => j.status !== "completed").sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate)).slice(0, 6);
  const nextJob = myJobs.filter((j) => j.status === "assigned").sort((a, b) => new Date(a.assignedAt) - new Date(b.assignedAt))[0];
  const inProgressJob = myJobs.find((j) => j.status === "in_progress");
  const myRated = myJobs.filter((j) => j.rating);
  const myAvgRating = myRated.length ? (myRated.reduce((s, j) => s + j.rating, 0) / myRated.length) : 0;

  el.innerHTML = `
    ${inProgressJob ? `
    <div class="pt-card" style="margin-bottom:18px; border-left:4px solid var(--pt-blue); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <div class="pt-card-title" style="margin:0;">&#9881; Currently in progress: ${inProgressJob.jobNumber}</div>
        <div class="text-muted" style="font-size:13px;">${escapeHtml(inProgressJob.title)} — started ${timeAgo(inProgressJob.startedAt)}</div>
      </div>
      <a href="#jobs/${inProgressJob.id}" class="btn btn-pt-amber">Submit Report</a>
    </div>` : nextJob ? `
    <div class="pt-card" style="margin-bottom:18px; border-left:4px solid var(--pt-amber); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <div class="pt-card-title" style="margin:0;">Next up: ${nextJob.jobNumber}</div>
        <div class="text-muted" style="font-size:13px;">${escapeHtml(nextJob.title)} — ${escapeHtml(nextJob.siteLocation)}</div>
      </div>
      <button class="btn btn-pt-primary" id="dash-start-job-btn">&#9654; Start Job</button>
    </div>` : ""}
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#128188;</div><div><div class="pt-stat-value">${myJobs.length}</div><div class="pt-stat-label">Total Assigned</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-amber">&#8987;</div><div><div class="pt-stat-value">${myJobs.filter((j) => ["pending", "assigned"].includes(j.status)).length}</div><div class="pt-stat-label">Pending</div></div></div>
    </div>
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#9881;</div><div><div class="pt-stat-value">${myJobs.filter((j) => j.status === "in_progress").length}</div><div class="pt-stat-label">In Progress</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-green">&#10004;</div><div><div class="pt-stat-value">${myJobs.filter((j) => j.status === "completed").length}</div><div class="pt-stat-label">Completed</div></div></div>
    </div>
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-amber">&#9733;</div><div><div class="pt-stat-value">${myAvgRating ? myAvgRating.toFixed(1) : "—"}</div><div class="pt-stat-label">My Avg. Rating (${myRated.length} reviews)</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-green">&#128196;</div><div><div class="pt-stat-value">${myReports.length}</div><div class="pt-stat-label">Reports Filed</div></div></div>
    </div>
    <div class="pt-grid-2">
      <div class="pt-card">
        <div class="pt-card-title">Upcoming &amp; Active Jobs <a href="#jobs" class="btn btn-pt-outline btn-sm">View all</a></div>
        ${upcoming.length ? `
        <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Customer</th><th>Scheduled</th><th>Priority</th><th>Status</th></tr></thead><tbody>
          ${upcoming.map((j) => `
            <tr data-goto="#jobs/${j.id}">
              <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
              <td>${escapeHtml(j.customerName)}</td>
              <td>${fmtDate(j.scheduledDate)}</td>
              <td>${priorityBadge(j.priority)}</td>
              <td>${jobStatusBadge(j.status)}</td>
            </tr>`).join("")}
        </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128512;</i>You have no active jobs right now.</div>`}
      </div>
      <div class="pt-card">
        <div class="pt-card-title">My Recent Reports</div>
        ${myReports.length ? myReports.map((r) => `
          <a href="#reports/${r.id}" style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--pt-border); color:inherit;">
            <div><div style="font-size:13.5px; font-weight:600;">${Jobs.get(r.jobId)?.jobNumber || "—"}</div><div class="text-muted" style="font-size:11.5px;">${fmtDate(r.submittedAt)}</div></div>
            ${reportStatusBadge(r.status)}
          </a>`).join("") : `<div class="pt-empty-state"><i>&#128196;</i>No reports submitted yet.</div>`}
      </div>
    </div>
  `;

  const dashStartBtn = document.getElementById("dash-start-job-btn");
  if (dashStartBtn && nextJob) {
    dashStartBtn.addEventListener("click", () => {
      Jobs.update(nextJob.id, { status: "in_progress", startedAt: new Date().toISOString() });
      toast(`Job ${nextJob.jobNumber} started.`, "success");
      router();
    });
  }
  attachRowNav(el);
}

function attachRowNav(el) {
  el.querySelectorAll("tr[data-goto]").forEach((row) => {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => navigate(row.getAttribute("data-goto").replace("#", "")));
  });
}

/* ============================================================
   CUSTOMER PORTAL
   Business flow: customer books a service → job is created with
   status "pending" and no assignedTo → manager assigns a technician
   → technician works the job → customer sees status update live.
   ============================================================ */
function renderCustomerDashboard(el, user) {
  setPageTitle(`Welcome, ${user.firstName}`, "Book a service or track your requests");
  const myJobs = Jobs.all().filter((j) => j.customerId === user.id);
  const pending = myJobs.filter((j) => j.status === "pending").length;
  const active = myJobs.filter((j) => ["assigned", "in_progress"].includes(j.status)).length;
  const completed = myJobs.filter((j) => j.status === "completed").length;
  const recent = myJobs.slice(0, 6);
  const needsReview = myJobs.filter((j) => j.status === "completed" && !j.rating);

  el.innerHTML = `
    <div class="pt-card" style="margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <div class="pt-card-title" style="margin:0;">Need a technician?</div>
        <div class="text-muted" style="font-size:13px;">Submit a request and our team will assign a field technician.</div>
      </div>
      <a href="#jobs/new" class="btn btn-pt-amber">+ Book a Service</a>
    </div>
    ${needsReview.length ? `
    <div class="pt-card" style="margin-bottom:18px; border-left:4px solid var(--pt-amber); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <div class="pt-card-title" style="margin:0;">&#9733; How did we do?</div>
        <div class="text-muted" style="font-size:13px;">${needsReview[0].jobNumber} was completed — leave a quick review.</div>
      </div>
      <a href="#jobs/${needsReview[0].id}" class="btn btn-pt-primary">Rate Service</a>
    </div>` : ""}
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-amber">&#8987;</div><div><div class="pt-stat-value">${pending}</div><div class="pt-stat-label">Awaiting Assignment</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#9881;</div><div><div class="pt-stat-value">${active}</div><div class="pt-stat-label">In Progress</div></div></div>
    </div>
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-green">&#10004;</div><div><div class="pt-stat-value">${completed}</div><div class="pt-stat-label">Completed</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#128188;</div><div><div class="pt-stat-value">${myJobs.length}</div><div class="pt-stat-label">Total Requests</div></div></div>
    </div>
    <div class="pt-card" style="margin-bottom:18px;">
      <div class="pt-card-title">My Recent Requests <a href="#jobs" class="btn btn-pt-outline btn-sm">View all</a></div>
      ${recent.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Request</th><th>Service</th><th>Raised</th><th>Priority</th><th>Status</th></tr></thead><tbody>
        ${recent.map((j) => `
          <tr data-goto="#jobs/${j.id}">
            <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
            <td>${LABELS.jobType[j.jobType] || "—"}</td>
            <td title="${fmtDateTime(j.createdAt)}">${timeAgo(j.createdAt)}</td>
            <td>${priorityBadge(j.priority)}</td>
            <td>${jobStatusBadge(j.status)}</td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128172;</i>You haven't booked any services yet.</div>`}
    </div>
    <div class="pt-card">
      <div class="pt-card-title">Need Help?</div>
      <div class="text-muted" style="font-size:13px;">
        Have a question about an existing request? Open it from "My Requests" to see its live status and assigned technician,
        or book a new service anytime — our team typically assigns a technician within one business day.
      </div>
    </div>
  `;
  attachRowNav(el);
}

function renderBookingForm(el, user) {
  setPageTitle("Book a Service", "Tell us what you need — a manager will assign a technician");

  el.innerHTML = `
    <div class="pt-card" style="max-width:760px;">
      <form id="booking-form">
        <div class="form-row cols-2">
          <div><label class="form-label">Request Title</label><input type="text" class="form-control" name="title" required placeholder="e.g. Home fibre installation"></div>
          <div><label class="form-label">Service Type</label>
            <select name="jobType" class="form-select">${Object.entries(LABELS.jobType).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          </div>
        </div>
        <div class="field"><label class="form-label">Site / Address</label><input type="text" class="form-control" name="siteLocation" required placeholder="Where should the technician go?"></div>
        <div class="field"><label class="form-label">Describe the Issue / Work Needed</label><textarea class="form-control" name="description" rows="4" required placeholder="Give as much detail as you can"></textarea></div>
        <div class="form-row cols-2">
          <div><label class="form-label">Preferred Date</label><input type="date" class="form-control" name="scheduledDate"></div>
          <div><label class="form-label">Urgency</label>
            <select name="priority" class="form-select">${Object.entries(LABELS.priority).map(([v, l]) => `<option value="${v}" ${v === "medium" ? "selected" : ""}>${l}</option>`).join("")}</select>
          </div>
        </div>
        <div class="field"><label class="form-label">Contact Phone / Email</label><input type="text" class="form-control" name="customerContact" value="${escapeHtml(user.phone || user.username || "")}" placeholder="How should we reach you?"></div>
        <div class="d-flex gap-2 mt-3">
          <button type="submit" class="btn btn-pt-primary">Submit Request</button>
          <a href="#dashboard" class="btn btn-pt-outline">Cancel</a>
        </div>
      </form>
    </div>
  `;

  document.getElementById("booking-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const job = Jobs.create({
      title: fd.get("title").trim(),
      jobType: fd.get("jobType"),
      siteLocation: fd.get("siteLocation").trim(),
      description: fd.get("description").trim(),
      scheduledDate: fd.get("scheduledDate") || null,
      priority: fd.get("priority"),
      customerId: user.id,
      customerName: `${user.firstName} ${user.lastName}`.trim(),
      customerContact: fd.get("customerContact").trim(),
      createdBy: user.id,
      // assignedTo intentionally omitted — a manager assigns a technician next.
    });
    toast("Request submitted — we'll assign a technician shortly.", "success");
    navigate(`jobs/${job.id}`);
    router();
  });
}

function renderCustomerRequestList(el, user) {
  setPageTitle("My Requests", "Every service you've booked with us");
  const jobs = Jobs.all().filter((j) => j.customerId === user.id);

  el.innerHTML = `
    <div class="pt-page-header">
      <div></div>
      <a href="#jobs/new" class="btn btn-pt-amber">+ Book a Service</a>
    </div>
    <div class="pt-card">
      ${jobs.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Request</th><th>Service</th><th>Site</th><th>Scheduled</th><th>Priority</th><th>Status</th></tr></thead><tbody>
        ${jobs.map((j) => `
          <tr data-goto="#jobs/${j.id}">
            <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
            <td>${LABELS.jobType[j.jobType] || "—"}</td>
            <td>${escapeHtml(j.siteLocation)}</td>
            <td>${fmtDate(j.scheduledDate)}</td>
            <td>${priorityBadge(j.priority)}</td>
            <td>${jobStatusBadge(j.status)}</td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128172;</i>You haven't booked any services yet.</div>`}
    </div>
  `;
  attachRowNav(el);
}

function renderCustomerRequestDetail(el, user, jobId) {
  const job = Jobs.get(jobId);
  if (!job) { el.innerHTML = `<div class="pt-empty-state">Request not found.</div>`; return; }
  // Strict ownership check — a customer may only ever view their own requests.
  if (job.customerId !== user.id) { el.innerHTML = `<div class="pt-empty-state">You don't have access to this request.</div>`; return; }

  setPageTitle(job.jobNumber, job.title);
  const report = Jobs.reportFor(job.id);
  const tech = job.assignedTo ? Users.get(job.assignedTo) : null;
  const canReview = job.status === "completed" && !job.rating;

  el.innerHTML = `
    <div class="pt-page-header">
      <div class="d-flex gap-2">${priorityBadge(job.priority)}${jobStatusBadge(job.status)}</div>
      <div></div>
    </div>
    <div class="pt-grid-2">
      <div class="pt-card">
        <div class="pt-card-title">Request Details</div>
        <div class="form-row cols-2">
          <div><div class="pt-detail-label">Service Type</div><div class="pt-detail-value">${LABELS.jobType[job.jobType]}</div></div>
          <div><div class="pt-detail-label">Preferred Date</div><div class="pt-detail-value">${fmtDate(job.scheduledDate)}</div></div>
        </div>
        <div class="pt-detail-label">Site Location</div><div class="pt-detail-value">${escapeHtml(job.siteLocation)}</div>
        <div class="pt-detail-label">Description</div><div class="pt-detail-value mb-0">${nl2br(job.description)}</div>
      </div>
      <div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Status</div>
          <div class="pt-detail-label">Assigned Technician</div>
          <div class="pt-detail-value">${tech ? escapeHtml(Users.fullName(tech)) : "Not yet assigned — a manager will assign one shortly."}</div>
        </div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Timeline</div>
          ${jobTimeline(job)}
        </div>
        ${report ? `
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Service Summary</div>
          <div class="pt-detail-label">Work Performed</div>
          <div class="pt-detail-value">${nl2br(report.workPerformed || report.summary || "—")}</div>
          ${report.recommendations ? `<div class="pt-detail-label">Recommendations</div><div class="pt-detail-value mb-0">${nl2br(report.recommendations)}</div>` : ""}
        </div>` : ""}
        ${canReview ? `
        <div class="pt-card">
          <div class="pt-card-title">Rate This Service</div>
          <form id="customer-review-form">
            <div class="field">
              <label class="form-label">Your Rating</label>
              <div id="star-picker" style="font-size:26px; letter-spacing:6px; cursor:pointer; color:#cbd5e1;">
                ${[1, 2, 3, 4, 5].map((n) => `<span data-star="${n}">&#9734;</span>`).join("")}
              </div>
              <input type="hidden" name="rating" id="rating-input" value="0">
            </div>
            <div class="field"><label class="form-label">Comments (optional)</label><textarea class="form-control" name="reviewComment" rows="3" placeholder="How did the technician do?"></textarea></div>
            <button type="submit" class="btn btn-pt-primary" id="submit-review-btn" disabled>Submit Review</button>
          </form>
        </div>` : (job.rating ? `
        <div class="pt-card">
          <div class="pt-card-title">Your Review</div>
          ${starRating(job.rating)}
          ${job.reviewComment ? `<div class="pt-detail-value" style="margin-top:8px;">${nl2br(job.reviewComment)}</div>` : ""}
        </div>` : "")}
      </div>
    </div>
  `;

  const starPicker = document.getElementById("star-picker");
  if (starPicker) {
    const stars = [...starPicker.querySelectorAll("[data-star]")];
    const ratingInput = document.getElementById("rating-input");
    const submitBtn = document.getElementById("submit-review-btn");
    function paint(n) {
      stars.forEach((s) => { s.innerHTML = Number(s.dataset.star) <= n ? "&#9733;" : "&#9734;"; s.style.color = Number(s.dataset.star) <= n ? "#F4A300" : "#cbd5e1"; });
    }
    stars.forEach((s) => {
      s.addEventListener("click", () => {
        const n = Number(s.dataset.star);
        ratingInput.value = n;
        submitBtn.disabled = false;
        paint(n);
      });
    });
    document.getElementById("customer-review-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const rating = Number(fd.get("rating"));
      if (!rating) { toast("Please select a star rating.", "error"); return; }
      Jobs.update(job.id, {
        rating, reviewComment: fd.get("reviewComment").trim(), reviewedAt: new Date().toISOString(),
      });
      toast("Thanks for your feedback!", "success");
      router();
    });
  }
}

/* ============================================================
   JOBS: LIST
   ============================================================ */
function renderJobList(el, user) {
  setPageTitle(user.role === "technician" ? "My Jobs" : "Jobs", user.role === "technician" ? "Jobs assigned to you" : "All field service jobs");
  const url = new URLSearchParams(window.location.hash.split("?")[1] || "");
  let jobs = Jobs.all();
  if (user.role === "technician") jobs = jobs.filter((j) => j.assignedTo === user.id);

  const q = url.get("q") || "";
  const status = url.get("status") || "";
  const priority = url.get("priority") || "";
  if (q) {
    const ql = q.toLowerCase();
    jobs = jobs.filter((j) => j.jobNumber.toLowerCase().includes(ql) || j.title.toLowerCase().includes(ql) || j.customerName.toLowerCase().includes(ql));
  }
  if (status) jobs = jobs.filter((j) => j.status === status);
  if (priority) jobs = jobs.filter((j) => j.priority === priority);

  el.innerHTML = `
    <div class="pt-page-header">
      <div></div>
      ${isManagerLike(user) ? `<a href="#jobs/new" class="btn btn-pt-amber">+ Assign New Job</a>` : ""}
    </div>
    <form class="pt-filter-bar" id="job-filter-form">
      <div class="pt-filter-row">
        <div><label class="form-label">Search</label><input type="text" name="q" class="form-control" placeholder="Job number, title, customer..." value="${escapeHtml(q)}"></div>
        <div><label class="form-label">Status</label>
          <select name="status" class="form-select">
            <option value="">All statuses</option>
            ${Object.entries(LABELS.jobStatus).map(([v, l]) => `<option value="${v}" ${status === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div><label class="form-label">Priority</label>
          <select name="priority" class="form-select">
            <option value="">All priorities</option>
            ${Object.entries(LABELS.priority).map(([v, l]) => `<option value="${v}" ${priority === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <button type="submit" class="btn btn-pt-primary">Filter</button>
      </div>
    </form>
    <div class="pt-card">
      ${jobs.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Customer</th><th>Site</th><th>Technician</th><th>Raised</th><th>Priority</th><th>Status</th></tr></thead><tbody>
        ${jobs.map((j) => `
          <tr data-goto="#jobs/${j.id}">
            <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
            <td>${escapeHtml(j.customerName)}</td>
            <td>${escapeHtml(j.siteLocation)}</td>
            <td>${escapeHtml(Users.fullName(Users.get(j.assignedTo)))}</td>
            <td title="${fmtDateTime(j.createdAt)}">${j.status === "pending" ? `<strong style="color:var(--pt-amber-dark);">${timeAgo(j.createdAt)}</strong>` : timeAgo(j.createdAt)}</td>
            <td>${priorityBadge(j.priority)}</td>
            <td>${jobStatusBadge(j.status)}</td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128193;</i>No jobs found matching your filters.</div>`}
    </div>
  `;
  attachRowNav(el);
  document.getElementById("job-filter-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (v) params.set(k, v);
    navigate(`jobs?${params.toString()}`);
    router();
  });
}

/* ============================================================
   JOBS: CREATE / EDIT FORM
   ============================================================ */
function renderJobForm(el, user, jobId) {
  const job = jobId ? Jobs.get(jobId) : null;
  if (jobId && !job) { el.innerHTML = `<div class="pt-empty-state">Job not found.</div>`; return; }
  setPageTitle(job ? `Edit Job ${job.jobNumber}` : "Assign New Job", job ? "Update job details or reassign" : "Create and assign a field service job");
  const techs = Users.technicians();
  const customers = Users.customers();

  el.innerHTML = `
    <div class="pt-card" style="max-width:820px;">
      <form id="job-form">
        <div class="form-row cols-2">
          <div><label class="form-label">Job Title</label><input type="text" class="form-control" name="title" required value="${escapeHtml(job?.title || "")}" placeholder="e.g. Fibre installation - Westlands branch"></div>
          <div><label class="form-label">Job Type</label>
            <select name="jobType" class="form-select">${Object.entries(LABELS.jobType).map(([v, l]) => `<option value="${v}" ${job?.jobType === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          </div>
        </div>
        ${customers.length ? `
        <div class="field">
          <label class="form-label">Link to Registered Customer <span class="text-muted" style="font-weight:400;">(optional — fills in name &amp; contact from their account)</span></label>
          <select class="form-select" id="link-customer">
            <option value="">— Walk-in / not registered —</option>
            ${customers.map((c) => `<option value="${c.id}" ${job?.customerId === c.id ? "selected" : ""}>${escapeHtml(Users.fullName(c))} (${escapeHtml(c.email || "")})</option>`).join("")}
          </select>
        </div>` : ""}
        <input type="hidden" name="customerId" id="customerId-field" value="${escapeHtml(job?.customerId || "")}">
        <div class="form-row cols-2">
          <div><label class="form-label">Customer Name</label><input type="text" class="form-control" name="customerName" required value="${escapeHtml(job?.customerName || "")}"></div>
          <div><label class="form-label">Customer Contact</label><input type="text" class="form-control" name="customerContact" value="${escapeHtml(job?.customerContact || "")}" placeholder="Phone or email"></div>
        </div>
        <div class="field"><label class="form-label">Site Location</label><input type="text" class="form-control" name="siteLocation" required value="${escapeHtml(job?.siteLocation || "")}" placeholder="Physical site address"></div>
        <div class="field"><label class="form-label">Scope of Work / Description</label><textarea class="form-control" name="description" rows="4" required>${escapeHtml(job?.description || "")}</textarea></div>
        <div class="form-row cols-3">
          <div><label class="form-label">Priority</label>
            <select name="priority" class="form-select">${Object.entries(LABELS.priority).map(([v, l]) => `<option value="${v}" ${job?.priority === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          </div>
          <div><label class="form-label">Assign Technician</label>
            <select name="assignedTo" class="form-select">
              <option value="">Unassigned</option>
              ${techs.map((t) => `<option value="${t.id}" ${job?.assignedTo === t.id ? "selected" : ""}>${escapeHtml(Users.fullName(t))}</option>`).join("")}
            </select>
          </div>
          <div><label class="form-label">Scheduled Date</label><input type="date" class="form-control" name="scheduledDate" value="${job?.scheduledDate || ""}"></div>
        </div>
        <div class="d-flex gap-2 mt-3">
          <button type="submit" class="btn btn-pt-primary">${job ? "Save Changes" : "Create Job"}</button>
          <a href="#jobs" class="btn btn-pt-outline">Cancel</a>
        </div>
      </form>
    </div>
  `;

  const linkSelect = document.getElementById("link-customer");
  if (linkSelect) {
    linkSelect.addEventListener("change", () => {
      const c = customers.find((cust) => cust.id === linkSelect.value);
      document.getElementById("customerId-field").value = c ? c.id : "";
      if (c) {
        el.querySelector('[name="customerName"]').value = Users.fullName(c);
        el.querySelector('[name="customerContact"]').value = c.phone || c.email || "";
      }
    });
  }

  document.getElementById("job-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {
      title: fd.get("title").trim(), jobType: fd.get("jobType"), customerName: fd.get("customerName").trim(),
      customerContact: fd.get("customerContact").trim(), siteLocation: fd.get("siteLocation").trim(),
      description: fd.get("description").trim(), priority: fd.get("priority"),
      assignedTo: fd.get("assignedTo") || null, scheduledDate: fd.get("scheduledDate") || null,
      customerId: fd.get("customerId") || null,
    };
    if (job) {
      const patch = { ...data };
      // Stamp the moment a technician is actually assigned — this is what
      // lets the manager (and the customer) see how long a request waited
      // before being picked up, separate from when it was first raised.
      if (data.assignedTo && data.assignedTo !== job.assignedTo) {
        patch.assignedAt = new Date().toISOString();
        if (job.status === "pending") patch.status = "assigned";
      }
      Jobs.update(job.id, patch);
      toast("Job updated.", "success");
      navigate(`jobs/${job.id}`);
    } else {
      data.createdBy = user.id;
      const newJob = Jobs.create(data);
      toast("Job created and reference number assigned — opening job…", "success");
      navigate(`jobs/${newJob.id}`);
    }
    router();
  });
}

/* ============================================================
   JOBS: DETAIL
   ============================================================ */
function jobTimeline(job) {
  const steps = [
    { key: "createdAt", label: "Request Raised", time: job.createdAt },
    { key: "assignedAt", label: "Technician Assigned", time: job.assignedAt },
    { key: "startedAt", label: "Job Started", time: job.startedAt },
    { key: "completedAt", label: "Job Completed", time: job.completedAt },
  ];
  return `<ul class="pt-timeline">
    ${steps.map((s) => `
      <li class="${s.time ? "done" : ""}">
        <div class="pt-tl-label">${s.label}</div>
        <div class="pt-tl-time">${s.time ? fmtDateTime(s.time) : "Pending"}</div>
      </li>`).join("")}
  </ul>`;
}

function renderJobDetail(el, user, jobId) {
  const job = Jobs.get(jobId);
  if (!job) { el.innerHTML = `<div class="pt-empty-state">Job not found.</div>`; return; }
  if (user.role === "technician" && job.assignedTo !== user.id) { el.innerHTML = `<div class="pt-empty-state">You don't have access to this job.</div>`; return; }

  setPageTitle(job.jobNumber, job.title);
  const report = Jobs.reportFor(job.id);
  const canSubmitReport = user.role === "technician" && job.assignedTo === user.id && job.status === "in_progress" && !report;
  const canStartJob = user.role === "technician" && job.assignedTo === user.id && job.status === "assigned";

  el.innerHTML = `
    <div class="pt-page-header">
      <div class="d-flex gap-2">${priorityBadge(job.priority)}${jobStatusBadge(job.status)}</div>
      <div class="d-flex gap-2">
        ${isManagerLike(user) ? `<a href="#jobs/${job.id}/edit" class="btn btn-pt-outline">Edit Job</a>` : ""}
        ${report ? `<a href="#reports/${report.id}" class="btn btn-pt-outline">View Report</a>` : ""}
        ${canStartJob ? `<button class="btn btn-pt-primary" id="start-job-btn">&#9654; Start Job</button>` : ""}
        ${canSubmitReport ? `<a href="#reports/new/${job.id}" class="btn btn-pt-amber">Submit Service Report</a>` : ""}
      </div>
    </div>
    <div class="pt-grid-2">
      <div class="pt-card">
        <div class="pt-card-title">Job Details</div>
        <div class="form-row cols-2">
          <div><div class="pt-detail-label">Job Type</div><div class="pt-detail-value">${LABELS.jobType[job.jobType]}</div></div>
          <div><div class="pt-detail-label">Scheduled Date</div><div class="pt-detail-value">${fmtDate(job.scheduledDate)}</div></div>
          <div><div class="pt-detail-label">Customer</div><div class="pt-detail-value">${escapeHtml(job.customerName)}</div></div>
          <div><div class="pt-detail-label">Customer Contact</div><div class="pt-detail-value">${escapeHtml(job.customerContact) || "—"}</div></div>
        </div>
        <div class="pt-detail-label">Site Location</div><div class="pt-detail-value">${escapeHtml(job.siteLocation)}</div>
        <div class="pt-detail-label">Scope of Work</div><div class="pt-detail-value ${job.status === "completed" ? "" : "mb-0"}">${nl2br(job.description)}</div>
        ${job.status === "completed" && job.startedAt && job.completedAt ? `
        <div class="pt-detail-label">Time on Site</div><div class="pt-detail-value mb-0">${fmtDuration(job.startedAt, job.completedAt)}</div>` : ""}
      </div>
      <div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Assignment</div>
          <div class="pt-detail-label">Assigned Technician</div><div class="pt-detail-value">${escapeHtml(Users.fullName(Users.get(job.assignedTo)))}</div>
          <div class="pt-detail-label">Created By</div><div class="pt-detail-value mb-0">${job.customerId ? `${escapeHtml(job.customerName)} (Customer request)` : escapeHtml(Users.fullName(Users.get(job.createdBy)))}</div>
        </div>
        <div class="pt-card" style="margin-bottom:16px;">
          <div class="pt-card-title">Timeline</div>
          ${jobTimeline(job)}
        </div>
        ${job.rating ? `
        <div class="pt-card">
          <div class="pt-card-title">Customer Review</div>
          ${starRating(job.rating)}
          ${job.reviewComment ? `<div class="pt-detail-value" style="margin-top:8px;">${nl2br(job.reviewComment)}</div>` : ""}
          <div class="pt-tl-time" style="margin-top:6px;">Reviewed ${fmtDateTime(job.reviewedAt)}</div>
        </div>` : ""}
      </div>
    </div>
  `;

  const startBtn = document.getElementById("start-job-btn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      // The single, authoritative way a job becomes "in_progress" — a
      // technician explicitly starting it, with a real clock-in time.
      // (Manual free-form status editing was removed: it used to let a
      // technician jump straight to "completed" without ever filing a
      // report, which bypassed the one place duration/report data comes
      // from. Now there is exactly one path to each status.)
      Jobs.update(job.id, { status: "in_progress", startedAt: new Date().toISOString() });
      toast(`Job ${job.jobNumber} started.`, "success");
      router();
    });
  }
}

/* ============================================================
   REPORTS: LIST
   ============================================================ */
function renderReportList(el, user) {
  setPageTitle("Service Reports", user.role === "technician" ? "Reports you've submitted" : "All submitted field service reports");
  const url = new URLSearchParams(window.location.hash.split("?")[1] || "");
  let reports = Reports.all();
  if (user.role === "technician") reports = reports.filter((r) => r.technicianId === user.id);

  const q = url.get("q") || "";
  const status = url.get("status") || "";
  if (q) {
    const ql = q.toLowerCase();
    reports = reports.filter((r) => {
      const job = Jobs.get(r.jobId);
      return job && (job.jobNumber.toLowerCase().includes(ql) || job.customerName.toLowerCase().includes(ql));
    });
  }
  if (status) reports = reports.filter((r) => r.status === status);

  el.innerHTML = `
    <form class="pt-filter-bar" id="report-filter-form">
      <div class="pt-filter-row">
        <div><label class="form-label">Search</label><input type="text" name="q" class="form-control" placeholder="Job number or customer..." value="${escapeHtml(q)}"></div>
        <div><label class="form-label">Status</label>
          <select name="status" class="form-select">
            <option value="">All statuses</option>
            ${Object.entries(LABELS.reportStatus).map(([v, l]) => `<option value="${v}" ${status === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div></div>
        <button type="submit" class="btn btn-pt-primary">Filter</button>
      </div>
    </form>
    <div class="pt-card">
      ${reports.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Customer</th><th>Technician</th><th>Date of Service</th><th>Status</th><th></th></tr></thead><tbody>
        ${reports.map((r) => {
          const job = Jobs.get(r.jobId);
          return `<tr>
            <td><strong>${job?.jobNumber || "—"}</strong></td>
            <td>${escapeHtml(job?.customerName || "—")}</td>
            <td>${escapeHtml(Users.fullName(Users.get(r.technicianId)))}</td>
            <td>${fmtDate(r.dateOfService)}</td>
            <td>${reportStatusBadge(r.status)}</td>
            <td style="text-align:right;"><a href="#reports/${r.id}" class="btn btn-pt-outline btn-sm">View</a></td>
          </tr>`;
        }).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128196;</i>No service reports found.</div>`}
    </div>
  `;
  document.getElementById("report-filter-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (v) params.set(k, v);
    navigate(`reports?${params.toString()}`);
    router();
  });
}

/* ============================================================
   REPORTS: SUBMIT FORM
   ============================================================ */
function renderReportForm(el, user, jobId) {
  const job = Jobs.get(jobId);
  if (!job) { el.innerHTML = `<div class="pt-empty-state">Job not found.</div>`; return; }
  if (user.role === "technician" && job.assignedTo !== user.id) { el.innerHTML = `<div class="pt-empty-state">You can only submit a report for jobs assigned to you.</div>`; return; }
  if (Jobs.hasReport(job.id)) { navigate(`reports/${Jobs.reportFor(job.id).id}`); router(); return; }

  setPageTitle("Submit Service Report", `${job.jobNumber} · ${job.customerName}`);
  el.innerHTML = `
    <div class="pt-card" style="margin-bottom:16px; max-width:820px;">
      <div class="pt-card-title">Job Summary</div>
      <div class="form-row cols-2">
        <div><div class="pt-detail-label">Customer</div><div class="pt-detail-value">${escapeHtml(job.customerName)}</div></div>
        <div><div class="pt-detail-label">Site Location</div><div class="pt-detail-value">${escapeHtml(job.siteLocation)}</div></div>
      </div>
      <div class="pt-detail-label">Scope of Work</div><div class="pt-detail-value mb-0">${nl2br(job.description)}</div>
    </div>
    <div class="pt-card" style="max-width:820px;">
      <form id="report-form">
        <div class="form-row cols-2">
          <div><label class="form-label">Date of Service</label><input type="date" class="form-control" name="dateOfService" required value="${job.scheduledDate || new Date().toISOString().slice(0, 10)}"></div>
          <div><label class="form-label">Customer Representative</label><input type="text" class="form-control" name="customerRepresentative" placeholder="Name of person who received the service"></div>
        </div>
        <div class="field"><label class="form-label">Work Performed</label><textarea class="form-control" name="workPerformed" rows="4" required placeholder="Describe the work carried out in detail..."></textarea></div>
        <div class="field"><label class="form-label">Materials Used</label><textarea class="form-control" name="materialsUsed" rows="3" placeholder="e.g. 2x RJ45 connectors, 30m Cat6 cable"></textarea></div>
        <div class="field"><label class="form-label">Issues Encountered</label><textarea class="form-control" name="issuesEncountered" rows="3"></textarea></div>
        <div class="field"><label class="form-label">Recommendations</label><textarea class="form-control" name="recommendations" rows="3"></textarea></div>
        <div class="d-flex gap-2 mt-3">
          <button type="submit" class="btn btn-pt-primary">Submit Report</button>
          <a href="#jobs/${job.id}" class="btn btn-pt-outline">Cancel</a>
        </div>
      </form>
    </div>
  `;

  document.getElementById("report-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const report = Reports.create({
      jobId: job.id, technicianId: user.id,
      dateOfService: fd.get("dateOfService"), workPerformed: fd.get("workPerformed").trim(),
      materialsUsed: fd.get("materialsUsed").trim(), issuesEncountered: fd.get("issuesEncountered").trim(),
      recommendations: fd.get("recommendations").trim(), customerRepresentative: fd.get("customerRepresentative").trim(),
    });
    toast(`Service report submitted for ${job.jobNumber}.`, "success");
    navigate(`reports/${report.id}`);
    router();
  });
}

/* ============================================================
   REPORTS: DETAIL (+ manager review + print/PDF)
   ============================================================ */
function renderReportDetail(el, user, reportId) {
  const report = Reports.get(reportId);
  if (!report) { el.innerHTML = `<div class="pt-empty-state">Report not found.</div>`; return; }
  if (user.role === "technician" && report.technicianId !== user.id) { el.innerHTML = `<div class="pt-empty-state">You don't have access to this report.</div>`; return; }

  const job = Jobs.get(report.jobId);
  setPageTitle("Service Report", `${job?.jobNumber || ""} · ${job?.customerName || ""}`);

  el.innerHTML = `
    <div class="pt-page-header">
      ${reportStatusBadge(report.status)}
      <button class="btn btn-pt-amber no-print" id="print-report-btn">&#8595; Download / Print PDF</button>
    </div>
    <div id="report-printable">
      <div class="pt-grid-2">
        <div class="pt-card">
          <div class="pt-card-title">
            <span>Prime Telecoms Limited — Service Report</span>
          </div>
          <div class="form-row cols-2">
            <div><div class="pt-detail-label">Job Number</div><div class="pt-detail-value">${job?.jobNumber || "—"}</div></div>
            <div><div class="pt-detail-label">Technician</div><div class="pt-detail-value">${escapeHtml(Users.fullName(Users.get(report.technicianId)))}</div></div>
            <div><div class="pt-detail-label">Customer</div><div class="pt-detail-value">${escapeHtml(job?.customerName || "—")}</div></div>
            <div><div class="pt-detail-label">Date of Service</div><div class="pt-detail-value">${fmtDate(report.dateOfService)}</div></div>
          </div>
          <div class="pt-detail-label">Scope of Work</div><div class="pt-detail-value">${nl2br(job?.description || "—")}</div>
          <div class="pt-detail-label">Work Performed</div><div class="pt-detail-value">${nl2br(report.workPerformed)}</div>
          <div class="pt-detail-label">Materials Used</div><div class="pt-detail-value">${nl2br(report.materialsUsed) || "—"}</div>
          <div class="pt-detail-label">Issues Encountered</div><div class="pt-detail-value">${nl2br(report.issuesEncountered) || "None reported"}</div>
          <div class="pt-detail-label">Recommendations</div><div class="pt-detail-value">${nl2br(report.recommendations) || "—"}</div>
          <div class="form-row cols-2">
            <div><div class="pt-detail-label">Customer Representative</div><div class="pt-detail-value mb-0">${escapeHtml(report.customerRepresentative) || "—"}</div></div>
            <div><div class="pt-detail-label">Submitted</div><div class="pt-detail-value mb-0">${fmtDateTime(report.submittedAt)}</div></div>
          </div>
        </div>
        <div class="no-print">
          <div class="pt-card" style="margin-bottom:16px;">
            <div class="pt-card-title">Related Job</div>
            <div class="pt-detail-label">Job Number</div><div class="pt-detail-value"><a href="#jobs/${job?.id}">${job?.jobNumber || "—"}</a></div>
            <div class="pt-detail-label">Site Location</div><div class="pt-detail-value mb-0">${escapeHtml(job?.siteLocation) || "—"}</div>
          </div>
          ${isManagerLike(user) ? `
          <div class="pt-card">
            <div class="pt-card-title">Manager Review</div>
            <form id="review-form">
              <label class="form-label">Status</label>
              <select name="status" class="form-select" style="margin-bottom:10px;">
                ${Object.entries(LABELS.reportStatus).map(([v, l]) => `<option value="${v}" ${report.status === v ? "selected" : ""}>${l}</option>`).join("")}
              </select>
              <label class="form-label">Review Notes</label>
              <textarea class="form-control" name="reviewNotes" rows="3">${escapeHtml(report.reviewNotes || "")}</textarea>
              <button type="submit" class="btn btn-pt-primary btn-block mt-3">Save Review</button>
            </form>
            ${report.reviewedBy ? `<div class="text-muted mt-3" style="font-size:12.5px;">Last reviewed by ${escapeHtml(Users.fullName(Users.get(report.reviewedBy)))}</div>` : ""}
          </div>` : ""}
        </div>
      </div>
    </div>
  `;

  document.getElementById("print-report-btn").addEventListener("click", () => window.print());

  const reviewForm = document.getElementById("review-form");
  if (reviewForm) {
    reviewForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      Reports.update(report.id, { status: fd.get("status"), reviewNotes: fd.get("reviewNotes").trim(), reviewedBy: user.id });
      toast("Report review saved.", "success");
      router();
    });
  }
}

/* ============================================================
   STAFF: LIST / FORM
   ============================================================ */
function renderStaffList(el, user) {
  setPageTitle("Technicians & Staff", "Manage field technician and manager accounts");
  const staff = Users.staff();
  el.innerHTML = `
    <div class="pt-card" style="max-width:600px;margin-bottom:20px;">
      <div class="pt-card-title">&#128101; Add a Technician</div>
      <p style="font-size:13px;color:#64748b;margin-bottom:14px;">
        Set a password here to create their account instantly — give them the email and password so they can sign in right away.
        Leave the password blank to just authorize the email instead — they'll set their own password later from the login page → "Activate Technician Account".
      </p>
      <div id="auth-tech-err" style="display:none;background:#FBE1E1;color:#D64545;padding:9px 12px;border-radius:9px;font-size:12.5px;margin-bottom:10px;"></div>
      <div id="auth-tech-ok"  style="display:none;background:#dcfce7;color:#166534;padding:9px 12px;border-radius:9px;font-size:12.5px;margin-bottom:10px;"></div>
      <div class="form-row cols-2" style="margin-bottom:0;">
        <div><label class="form-label">First Name</label><input type="text" class="form-control" id="auth-fname" placeholder="John"></div>
        <div><label class="form-label">Last Name</label><input type="text" class="form-control" id="auth-lname" placeholder="Mwangi"></div>
      </div>
      <div class="field">
        <label class="form-label">Technician Email (they must use this exact email)</label>
        <input type="email" class="form-control" id="auth-email" placeholder="technician@example.com">
      </div>
      <div class="form-row cols-2" style="margin-bottom:0;">
        <div>
          <label class="form-label">Employee ID (optional)</label>
          <input type="text" class="form-control" id="auth-empid" placeholder="e.g. PT-014">
        </div>
        <div>
          <label class="form-label">Set Their Password (optional)</label>
          <div style="display:flex;gap:6px;">
            <input type="text" class="form-control" id="auth-pw" placeholder="Min. 6 characters">
            <button type="button" class="btn btn-pt-outline btn-sm" id="btn-gen-pw" style="white-space:nowrap;">Generate</button>
          </div>
        </div>
      </div>
      <button class="btn btn-pt-primary mt-3" id="btn-auth-tech">Grant Technician Access</button>
    </div>

    <div class="pt-page-header"><div></div></div>
    <div class="pt-card">
      <div class="pt-card-title">All Staff</div>
      <p style="font-size:12.5px;color:#64748b;margin-bottom:12px;">
        "Show Password" only works for technician accounts created right here with a manager-set password, and only
        reflects the password as of account creation — it can't reveal a password someone has since changed
        themselves. That's a hard Firebase limitation, not a bug: passwords are stored as one-way hashes and can
        never be retrieved once a person has set their own. For everyone else, "Send Reset Email" is the secure,
        standard way to get them a new one.
      </p>
      ${staff.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Name</th><th>Employee ID</th><th>Role</th><th>Phone</th><th>Active Jobs</th><th>Status</th><th></th></tr></thead><tbody>
        ${staff.map((m) => `
          <tr>
            <td><strong>${escapeHtml(Users.fullName(m))}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(m.username || m.email)}</span></td>
            <td>${escapeHtml(m.employeeId) || "—"}</td>
            <td>${LABELS.role[m.role] || m.role}</td>
            <td>${escapeHtml(m.phone) || "—"}</td>
            <td>${Jobs.all().filter((j) => j.assignedTo === m.id && ["assigned", "in_progress"].includes(j.status)).length}</td>
            <td>${m.active !== false ? `<span class="pt-badge badge-status-completed">Active</span>` : `<span class="pt-badge badge-status-cancelled">Inactive</span>`}</td>
            <td style="text-align:right; white-space:nowrap;">
              ${m.role === "technician" ? `
                <button class="btn btn-pt-outline btn-sm" data-show-pw="${m.id}">Show Password</button>
                <button class="btn btn-pt-outline btn-sm" data-reset-pw="${escapeHtml(m.email || m.username)}">Send Reset Email</button>
                <button class="btn btn-pt-outline btn-sm" data-make-customer="${m.id}">Make Customer</button>
                <button class="btn btn-danger-outline btn-sm" data-revoke="${escapeHtml(m.email || m.username)}">Revoke</button>
              ` : m.role === "manager" ? `
                <button class="btn btn-pt-outline btn-sm" data-reset-pw="${escapeHtml(m.email || m.username)}">Send Reset Email</button>
              ` : ""}
            </td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128101;</i>No staff members have joined yet. Authorize technicians above to get started.</div>`}
    </div>
  `;

  // Reveal the password stored at account-creation time (technicians the
  // manager/admin created directly with a chosen password only — see the
  // explanatory note above the table for why this can't work for anyone
  // else). Fetched lazily on click rather than upfront for the whole
  // table, so nothing sensitive sits in the DOM until deliberately asked for.
  el.querySelectorAll("[data-show-pw]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-show-pw");
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        const rec = await Auth.getStoredPassword(id);
        if (!rec || !rec.lastKnownPassword) {
          toast("No stored password on file for this account — it likely self-activated, or has changed its password since. Use \"Send Reset Email\" instead.", "info");
          return;
        }
        const setWhen = rec.setAt ? fmtDateTime(rec.setAt) : "an earlier date";
        const copy = confirm(
          `Password set at account creation (by ${rec.setByName || "a manager"} on ${setWhen}):\n\n${rec.lastKnownPassword}\n\n` +
          `Note: if this person has changed their password since, this will no longer work.\n\nClick OK to copy it to your clipboard.`
        );
        if (copy && navigator.clipboard) {
          navigator.clipboard.writeText(rec.lastKnownPassword).catch(() => {});
        }
      } catch (err) {
        toast(err.message || "Couldn't load the stored password.", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  // Standard, secure password-reset email — the only option for any
  // account whose password wasn't set here at creation time.
  el.querySelectorAll("[data-reset-pw]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.getAttribute("data-reset-pw");
      btn.disabled = true;
      try {
        await Auth.sendPasswordReset(email);
        toast(`Password reset email sent to ${email}.`, "success");
      } catch (err) {
        toast(Auth.getErrorMessage(err.code) || err.message || "Couldn't send reset email.", "error");
      } finally {
        btn.disabled = false;
      }
    });
  });

  // "Generate" fills in a random, reasonably strong temporary password.
  document.getElementById("btn-gen-pw").addEventListener("click", () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$";
    let pw = "";
    for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    const pwInput = document.getElementById("auth-pw");
    pwInput.value = pw;
    pwInput.type = "text";
  });

  // Add-technician button handler. With a password: creates the Firebase
  // Auth account + profile immediately (manager-set password, technician
  // can log in right away). Without one: falls back to the original
  // authorize-only flow (technician sets their own password later).
  document.getElementById("btn-auth-tech").addEventListener("click", async () => {
    const btn   = document.getElementById("btn-auth-tech");
    const fname = document.getElementById("auth-fname").value.trim();
    const lname = document.getElementById("auth-lname").value.trim();
    const email = document.getElementById("auth-email").value.trim().toLowerCase();
    const empId = document.getElementById("auth-empid").value.trim();
    const pw    = document.getElementById("auth-pw").value;
    const errEl = document.getElementById("auth-tech-err");
    const okEl  = document.getElementById("auth-tech-ok");

    errEl.style.display = "none";
    okEl.style.display  = "none";

    if (!email) { errEl.textContent = "Please enter the technician's email."; errEl.style.display = "block"; return; }
    if (pw && pw.length < 6) { errEl.textContent = "Password must be at least 6 characters (or leave it blank)."; errEl.style.display = "block"; return; }

    btn.disabled    = true;

    try {
      if (pw) {
        btn.textContent = "Creating account…";
        await Auth.managerCreateTechnician(email, pw, { firstName: fname, lastName: lname, employeeId: empId });
        okEl.textContent = `✓ Account created for ${email}. Give them this email and password to sign in — they can change the password later from their profile.`;
        okEl.style.display = "block";
        toast(`Technician account created for ${email}`, "success");
      } else {
        btn.textContent = "Authorizing…";
        await Auth.authorizeTechnician(user.organizationId || DEFAULT_ORG_ID, email, {
          firstName: fname, lastName: lname, employeeId: empId,
        });
        okEl.textContent = `✓ ${email} has been authorized. Share the activation link with them: ${window.location.origin}#login`;
        okEl.style.display = "block";
        toast(`Technician access granted to ${email}`, "success");
      }
      document.getElementById("auth-email").value = "";
      document.getElementById("auth-fname").value = "";
      document.getElementById("auth-lname").value = "";
      document.getElementById("auth-empid").value = "";
      document.getElementById("auth-pw").value = "";
    } catch (err) {
      errEl.textContent = Auth.getErrorMessage(err.code) || err.message || "Failed to add technician. Please try again.";
      errEl.style.display = "block";
    } finally {
      btn.disabled    = false;
      btn.textContent = "Grant Technician Access";
    }
  });

  // Convert a technician back into a plain customer account (keeps their
  // login working, just changes what they can see/do — distinct from
  // "Revoke", which blocks them from signing in as staff at all).
  el.querySelectorAll("[data-make-customer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-make-customer");
      const m = staff.find((s) => s.id === id);
      if (!m) return;
      if (!confirm(`Change ${Users.fullName(m)} to a customer account? They'll lose technician access immediately and no longer appear in job assignment.`)) return;
      btn.disabled = true;
      try {
        await Users.changeRole(id, "customer");
        toast(`${Users.fullName(m)} is now a customer.`, "success");
      } catch (err) {
        toast(err.message || "Failed to change role.", "error");
        btn.disabled = false;
      }
    });
  });

  // Revoke technician access — this is the admin control that removes the
  // technician role's ability to sign back in / access the technician portal.
  // It marks the tech_authorizations record as revoked (checked at every
  // activation attempt) and deactivates the live account so job assignment
  // dropdowns stop offering them immediately.
  el.querySelectorAll("[data-revoke]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.getAttribute("data-revoke");
      if (!confirm(`Revoke technician access for ${email}? They will no longer be able to sign in.`)) return;
      try {
        await Auth.revokeTechnician(email);
        const member = staff.find((m) => (m.email || m.username) === email);
        if (member) Users.update(member.id, { active: false });
        toast(`Access revoked for ${email}.`, "success");
      } catch (err) {
        toast(err.message || "Failed to revoke access.", "error");
      }
    });
  });
}

/* ============================================================
   REVIEWS (manager-only: every customer review, org-wide)
   ============================================================ */
function renderReviewsList(el, user) {
  setPageTitle("Customer Reviews", "Feedback customers left after their job was completed");
  const reviews = Jobs.reviews();
  const avg = reviews.length ? (reviews.reduce((s, j) => s + j.rating, 0) / reviews.length) : 0;

  el.innerHTML = `
    <div class="pt-grid-2-even" style="margin-bottom:18px;">
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-amber">&#9733;</div><div><div class="pt-stat-value">${avg ? avg.toFixed(1) : "—"}</div><div class="pt-stat-label">Average Rating</div></div></div>
      <div class="pt-stat-card"><div class="pt-stat-icon pt-icon-blue">&#11088;</div><div><div class="pt-stat-value">${reviews.length}</div><div class="pt-stat-label">Total Reviews</div></div></div>
    </div>
    <div class="pt-card">
      <div class="pt-card-title">All Reviews</div>
      ${reviews.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Job</th><th>Customer</th><th>Technician</th><th>Rating</th><th>Comment</th><th>Date</th></tr></thead><tbody>
        ${reviews.map((j) => `
          <tr data-goto="#jobs/${j.id}">
            <td><strong>${j.jobNumber}</strong><br><span class="text-muted" style="font-size:12px;">${escapeHtml(j.title)}</span></td>
            <td>${escapeHtml(j.customerName)}</td>
            <td>${escapeHtml(Users.fullName(Users.get(j.assignedTo)))}</td>
            <td>${starRating(j.rating)}</td>
            <td style="max-width:280px;">${j.reviewComment ? escapeHtml(j.reviewComment) : `<span class="text-muted">—</span>`}</td>
            <td>${fmtDate(j.reviewedAt)}</td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#11088;</i>No reviews yet — they'll appear here as soon as customers rate a completed job.</div>`}
    </div>
  `;
  attachRowNav(el);
}

/* ============================================================
   CUSTOMERS (manager-only: full roster + role management)
   ============================================================ */
function renderCustomersList(el, user) {
  setPageTitle("Customers", "All registered customer accounts");
  const customers = Users.customers();
  const jobs = Jobs.all();

  el.innerHTML = `
    <div class="pt-card">
      <div class="pt-card-title">Registered Customers (${customers.length})</div>
      ${customers.length ? `
      <div class="pt-table-wrap"><table class="pt-table"><thead><tr><th>Name</th><th>Contact</th><th>Requests</th><th>Registered</th><th>Role</th><th></th></tr></thead><tbody>
        ${customers.map((c) => `
          <tr>
            <td><strong>${escapeHtml(Users.fullName(c))}</strong></td>
            <td>${escapeHtml(c.email || c.username || "—")}${c.phone ? `<br><span class="text-muted" style="font-size:12px;">${escapeHtml(c.phone)}</span>` : ""}</td>
            <td>${jobs.filter((j) => j.customerId === c.id).length}</td>
            <td>${c.createdAt ? fmtDate(c.createdAt) : "—"}</td>
            <td><span class="pt-badge badge-status-completed">Customer</span></td>
            <td style="text-align:right; white-space:nowrap;">
              <button class="btn btn-pt-outline btn-sm" data-make-tech="${c.id}">Make Technician</button>
            </td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="pt-empty-state"><i>&#128100;</i>No customers have registered yet.</div>`}
    </div>
  `;

  el.querySelectorAll("[data-make-tech]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-make-tech");
      const c = customers.find((cust) => cust.id === id);
      if (!c) return;
      if (!confirm(`Grant technician access to ${Users.fullName(c)}? They'll be able to see and update jobs assigned to them, and will appear in the technician assignment dropdown immediately.`)) return;
      btn.disabled = true;
      btn.textContent = "Updating…";
      try {
        await Users.changeRole(id, "technician");
        toast(`${Users.fullName(c)} is now a technician.`, "success");
      } catch (err) {
        toast(err.message || "Failed to change role.", "error");
        btn.disabled = false;
        btn.textContent = "Make Technician";
      }
    });
  });
}

/* ============================================================
   PROFILE
   ============================================================ */
function renderProfile(el, user) {
  setPageTitle("My Profile", "Manage your account details");
  const isTechnician = user.role === "technician";
  el.innerHTML = `
    <div class="pt-card" style="max-width:680px; margin-bottom:16px;">
      <form id="profile-form">
        <div class="form-row cols-2">
          <div><label class="form-label">First Name</label><input type="text" class="form-control" name="firstName" required value="${escapeHtml(user.firstName)}"></div>
          <div><label class="form-label">Last Name</label><input type="text" class="form-control" name="lastName" required value="${escapeHtml(user.lastName)}"></div>
        </div>
        <div class="field"><label class="form-label">Phone Number</label><input type="text" class="form-control" name="phone" value="${escapeHtml(user.phone || "")}"></div>
        <button type="submit" class="btn btn-pt-primary">Save Changes</button>
      </form>
    </div>
    <div class="pt-card" style="max-width:680px;">
      <div class="pt-card-title">Account Info</div>
      <div class="form-row cols-2">
        <div><div class="pt-detail-label">Email</div><div class="pt-detail-value">${escapeHtml(user.username)}</div></div>
        <div><div class="pt-detail-label">Role</div><div class="pt-detail-value mb-0">${LABELS.role[user.role]}</div></div>
        ${isTechnician ? `<div><div class="pt-detail-label">Employee ID</div><div class="pt-detail-value mb-0">${escapeHtml(user.employeeId) || "—"}</div></div>` : ""}
      </div>
    </div>
  `;
  document.getElementById("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await Auth.updateProfile(user.id, {
      firstName: fd.get("firstName").trim(), lastName: fd.get("lastName").trim(), phone: fd.get("phone").trim(),
    });
    toast("Profile updated successfully.", "success");
    router();
  });
}

/* ============================================================
   SUPREME ADMIN — Manager Detail Drill-Down (#admin/manager/:id)
   ============================================================ */
function renderAdminManagerDetail(el, user, managerId) {
  const manager = Users.get(managerId);
  if (!manager) {
    el.innerHTML = `<div class="pt-empty-state"><i>👤</i>Manager not found.</div>`;
    return;
  }

  setPageTitle(`Manager Detail — ${Users.fullName(manager)}`, "Operational drill-down and performance analysis");

  const jobs = Jobs.all();
  const allTechs = Users.allTechniciansForAdmin();
  const reviews = Jobs.reviews();

  // Performance calculations
  const mgrJobs = jobs; // single-tenant
  const completed = mgrJobs.filter((j) => j.status === "completed");
  const inProgress = mgrJobs.filter((j) => j.status === "in_progress");
  const pending = mgrJobs.filter((j) => j.status === "pending");
  const assigned = mgrJobs.filter((j) => j.status === "assigned");
  const completionRate = mgrJobs.length ? Math.round((completed.length / mgrJobs.length) * 100) : 0;
  
  const mgrReviews = reviews;
  const avgRating = mgrReviews.length ? (mgrReviews.reduce((s, j) => s + j.rating, 0) / mgrReviews.length) : 0;

  // Render HTML
  el.innerHTML = `
    <button class="pt-admin-back" id="btn-back-mgrs">← Back to Command Center</button>

    <div class="pt-grid-2">
      <!-- Left Column: Manager Profile & Team Roster -->
      <div>
        <!-- Profile Card -->
        <div class="pt-card" style="margin-bottom: 20px;">
          <div class="pt-card-title">Manager Profile</div>
          <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 16px;">
            <div class="pt-admin-mgr-avatar" style="width: 56px; height: 56px; font-size: 20px;">${escapeHtml(manager.firstName[0])}</div>
            <div>
              <h4 style="margin: 0; font-size: 17px; font-weight: 800; color: var(--pt-navy);">${escapeHtml(Users.fullName(manager))}</h4>
              <div class="text-muted" style="font-size: 13px;">${escapeHtml(manager.email || manager.username)}</div>
              <div style="font-weight: 700; color: var(--pt-blue); font-size: 12px; margin-top: 3px;">${escapeHtml(manager.orgName || "Prime Telecoms Limited")}</div>
            </div>
          </div>

          <div style="padding: 12px 14px; background: var(--pt-bg); border-radius: 10px; font-size: 13px; margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span class="text-muted">Account Status:</span>
              <strong>
                ${manager.active !== false ? '<span class="pt-mgr-badge-active">Active</span>' : 
                  (manager.role === "manager_pending" ? '<span class="pt-mgr-badge-pending">Pending Approval</span>' : '<span class="pt-mgr-badge-suspended">Suspended</span>')}
              </strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span class="text-muted">Registered On:</span>
              <span>${fmtDate(manager.createdAt)}</span>
            </div>
            ${manager.approvedAt ? `
              <div style="display: flex; justify-content: space-between;">
                <span class="text-muted">Approved On:</span>
                <span>${fmtDate(manager.approvedAt)}</span>
              </div>
            ` : ""}
          </div>

          <div class="pt-card-title" style="font-size: 13px; text-transform: uppercase; margin-bottom: 8px;">Access Control</div>
          <div class="pt-admin-mgr-actions" style="display: flex; gap: 8px;">
            ${manager.role === "manager_pending" && manager.active !== false ? `
              <button class="btn btn-pt-primary btn-sm" id="detail-approve">Approve</button>
              <button class="btn btn-danger-outline btn-sm" id="detail-reject">Reject</button>
            ` : manager.active !== false ? `
              <button class="btn btn-pt-outline btn-sm" id="detail-suspend">Suspend</button>
              <button class="btn btn-danger-outline btn-sm" id="detail-revoke">Revoke</button>
            ` : `
              <button class="btn btn-pt-primary btn-sm" id="detail-reinstate">Activate / Reinstate</button>
            `}
          </div>
        </div>

        <!-- Team Roster -->
        <div class="pt-card">
          <div class="pt-card-title">Technicians Team (${allTechs.length})</div>
          ${allTechs.length ? `
            <div class="pt-table-wrap">
              <table class="pt-table">
                <thead>
                  <tr>
                    <th>Technician</th>
                    <th>Status</th>
                    <th>Active Jobs</th>
                  </tr>
                </thead>
                <tbody>
                  ${allTechs.map(t => {
                    const status = AdminStats.technicianStatus(t.id);
                    let statusClass = "pt-status-offline";
                    let statusLbl = "Offline";
                    if (status === "on-duty") { statusClass = "pt-status-on-duty"; statusLbl = "On Duty"; }
                    else if (status === "available") { statusClass = "pt-status-available"; statusLbl = "Available"; }
                    else if (status === "on-break") { statusClass = "pt-status-on-break"; statusLbl = "On Break"; }
                    else if (status === "inactive") { statusClass = "pt-status-inactive"; statusLbl = "Inactive"; }
                    
                    return `
                      <tr>
                        <td>
                          <strong>${escapeHtml(Users.fullName(t))}</strong><br>
                          <span class="text-muted" style="font-size: 11px;">${escapeHtml(t.email || t.username)}</span>
                        </td>
                        <td>
                          <span class="pt-status-badge ${statusClass}">${statusLbl}</span>
                        </td>
                        <td><strong>${t.activeJobs || 0}</strong></td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="pt-empty-state">No technicians assigned to this manager's team.</div>
          `}
        </div>
      </div>

      <!-- Right Column: Performance & Job Pipeline -->
      <div>
        <!-- Performance Indicators -->
        <div class="pt-card" style="margin-bottom: 20px;">
          <div class="pt-card-title">Performance Metrics</div>
          <div class="pt-admin-kpi-row" style="grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 0;">
            <div class="pt-admin-kpi-tile slate" style="padding: 14px;">
              <span style="font-size: 20px;">📈</span>
              <div class="pt-admin-kpi-value" style="font-size: 24px;">${completionRate}%</div>
              <div class="pt-admin-kpi-label" style="font-size: 10px;">Completion Rate</div>
              <div class="pt-admin-progress-bar" style="margin-top: 8px;">
                <div class="pt-admin-progress-fill" style="width: ${completionRate}%;"></div>
              </div>
            </div>
            <div class="pt-admin-kpi-tile amber" style="padding: 14px;">
              <span style="font-size: 20px;">⭐️</span>
              <div class="pt-admin-kpi-value" style="font-size: 24px;">${avgRating ? avgRating.toFixed(1) : "—"}</div>
              <div class="pt-admin-kpi-label" style="font-size: 10px;">Average Rating</div>
              <div style="font-size: 10px; color: rgba(255,255,255,0.7); margin-top: 8px;">From ${mgrReviews.length} reviews</div>
            </div>
          </div>
        </div>

        <!-- Job Pipeline -->
        <div class="pt-card" style="margin-bottom: 20px;">
          <div class="pt-card-title">Job Pipeline Status</div>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px;">
            <div style="background: var(--pt-bg); padding: 10px; border-radius: 8px; text-align: center;">
              <div style="font-size: 18px; font-weight: 800; color: var(--pt-navy);">${pending.length}</div>
              <div class="text-muted" style="font-size: 11px;">Pending</div>
            </div>
            <div style="background: var(--pt-bg); padding: 10px; border-radius: 8px; text-align: center;">
              <div style="font-size: 18px; font-weight: 800; color: var(--pt-navy);">${assigned.length}</div>
              <div class="text-muted" style="font-size: 11px;">Assigned</div>
            </div>
            <div style="background: var(--pt-bg); padding: 10px; border-radius: 8px; text-align: center;">
              <div style="font-size: 18px; font-weight: 800; color: var(--pt-navy);">${inProgress.length}</div>
              <div class="text-muted" style="font-size: 11px;">In Progress</div>
            </div>
            <div style="background: var(--pt-bg); padding: 10px; border-radius: 8px; text-align: center;">
              <div style="font-size: 18px; font-weight: 800; color: var(--pt-navy);">${completed.length}</div>
              <div class="text-muted" style="font-size: 11px;">Completed</div>
            </div>
          </div>

          <div class="pt-card-title" style="font-size: 13px; text-transform: uppercase; margin-bottom: 8px;">Recent Pipeline Jobs</div>
          ${mgrJobs.length ? `
            <div class="pt-table-wrap">
              <table class="pt-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Customer</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${mgrJobs.slice(0, 5).map(j => `
                    <tr data-goto="#jobs/${j.id}">
                      <td>
                        <strong>${j.jobNumber}</strong><br>
                        <span class="text-muted" style="font-size: 11px;">${escapeHtml(j.title)}</span>
                      </td>
                      <td>${escapeHtml(j.customerName)}</td>
                      <td>${jobStatusBadge(j.status)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="pt-empty-state">No jobs processed yet.</div>
          `}
        </div>

        <!-- Reviews / Customer Feedback -->
        <div class="pt-card">
          <div class="pt-card-title">Customer Feedback Ledger</div>
          ${mgrReviews.length ? `
            <div style="display: flex; flex-direction: column; gap: 10px;">
              ${mgrReviews.slice(0, 4).map(r => `
                <div style="border-bottom: 1px solid var(--pt-border); padding-bottom: 8px;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 13px; font-weight: 700;">${escapeHtml(r.customerName)}</span>
                    <span>${starRating(r.rating)}</span>
                  </div>
                  <div style="font-size: 12px; color: var(--pt-text-muted); margin-top: 3px;">
                    ${r.reviewComment ? `"${escapeHtml(r.reviewComment)}"` : "No comment left."}
                  </div>
                  <div style="font-size: 10px; color: var(--pt-text-muted); margin-top: 4px; text-align: right;">${fmtDate(r.reviewedAt)}</div>
                </div>
              `).join("")}
            </div>
          ` : `
            <div class="pt-empty-state">No reviews recorded yet.</div>
          `}
        </div>
      </div>
    </div>
  `;

  // Register Back Action
  document.getElementById("btn-back-mgrs").addEventListener("click", () => {
    navigate("dashboard");
    router();
  });

  // Action listeners inside Detail
  const setupBtn = (id, action, label) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener("click", async () => {
        if (action !== "approve" && action !== "reinstate" && !confirm(`Are you sure you want to ${action} this manager account?`)) return;
        btn.disabled = true;
        try {
          await Users.setManagerStatus(manager.id, action);
          toast(`Manager account ${label} successfully.`, "success");
          router();
        } catch (err) {
          toast(err.message || "Operation failed", "error");
          btn.disabled = false;
        }
      });
    }
  };

  setupBtn("detail-approve", "approve", "approved");
  setupBtn("detail-reject", "reject", "rejected");
  setupBtn("detail-suspend", "suspend", "suspended");
  setupBtn("detail-revoke", "revoke", "revoked");
  setupBtn("detail-reinstate", "reinstate", "reinstated");

  attachRowNav(el);
}

/* ============================================================
   SUPREME ADMIN — Organizations Management (#admin/orgs)
   ============================================================ */
function renderAdminOrgs(el, user) {
  setPageTitle("Organization Registry", "Platform companies and tenant spaces");

  const activeManagers = Users.managers();
  const pendingManagers = Users.pendingManagers();
  const technicians = Users.allTechniciansForAdmin();
  const jobs = Jobs.all();
  const ratedJobs = jobs.filter((j) => j.rating);
  const avgRating = ratedJobs.length ? (ratedJobs.reduce((s, j) => s + j.rating, 0) / ratedJobs.length) : 0;

  el.innerHTML = `
    <div class="pt-admin-banner">
      <div>
        <div class="pt-admin-banner-title">Organizations Registry</div>
        <div class="pt-admin-banner-sub">Currently running in single-tenant deployment mode. High scalability architecture ready for multi-tenant mapping.</div>
      </div>
    </div>

    <div class="pt-grid-2" style="grid-template-columns: 1.5fr 1fr;">
      <!-- Registry List -->
      <div class="pt-card">
        <div class="pt-card-title">Registered Tenants (1)</div>
        <div class="pt-admin-org-card">
          <div class="pt-admin-org-header">
            <div class="pt-admin-org-icon">🏢</div>
            <div>
              <div class="pt-admin-org-name">Prime Telecoms Limited</div>
              <div class="pt-admin-org-id">Tenant Key: org_primetelecoms</div>
            </div>
            <div style="margin-left: auto;">
              <span class="pt-status-badge pt-status-on-duty">Core Space</span>
            </div>
          </div>

          <div class="pt-admin-org-stats">
            <div class="pt-admin-org-stat">
              <div class="pt-admin-org-stat-val">${activeManagers.length + pendingManagers.length}</div>
              <div class="pt-admin-org-stat-lbl">Managers</div>
            </div>
            <div class="pt-admin-org-stat">
              <div class="pt-admin-org-stat-val">${technicians.length}</div>
              <div class="pt-admin-org-stat-lbl">Techs</div>
            </div>
            <div class="pt-admin-org-stat">
              <div class="pt-admin-org-stat-val">${jobs.length}</div>
              <div class="pt-admin-org-stat-lbl">Total Jobs</div>
            </div>
            <div class="pt-admin-org-stat">
              <div class="pt-admin-org-stat-val">${avgRating ? avgRating.toFixed(1) : "—"}★</div>
              <div class="pt-admin-org-stat-lbl">Rating</div>
            </div>
          </div>

          <div style="display: flex; gap: 8px;">
            <a href="#admin/managers" class="btn btn-pt-primary btn-sm">Managers Directory</a>
            <a href="#staff" class="btn btn-pt-outline btn-sm">Technicians Roster</a>
          </div>
        </div>
      </div>

      <!-- Add Tenant Info (Command Info Desk) -->
      <div class="pt-card">
        <div class="pt-card-title">Tenant Operations Desk</div>
        <div style="line-height: 1.6; font-size: 13.5px;">
          <p>This deployment is scoped to <strong>Prime Telecoms Limited</strong> (<code>org_primetelecoms</code>) serving as the main corporate domain.</p>
          <p style="margin-top: 12px;"><strong>Hierarchy Chain:</strong><br>
          <span style="color: var(--pt-blue-light); font-weight: bold;">SUPER ADMIN</span> authorizes and audits <span style="color: var(--pt-blue); font-weight: bold;">MANAGERS</span>.<br>
          <span style="color: var(--pt-blue); font-weight: bold;">MANAGERS</span> authorize and dispatch <span style="color: var(--pt-warning); font-weight: bold;">TECHNICIANS</span>.<br>
          <span style="color: var(--pt-warning); font-weight: bold;">TECHNICIANS</span> execute jobs on-site for customer assets.</p>
          <p style="margin-top: 12px; background: var(--pt-bg); padding: 12px; border-radius: 8px; border-left: 3px solid var(--pt-amber);">
            <strong>Need to setup a new company?</strong> Contact Prime Telecoms devops center to spin up new database instances for multiple client scopes.
          </p>
        </div>
      </div>
    </div>
  `;
}

/* ============================================================
   SUPREME ADMIN — System Intelligence (#admin/intel)
   ============================================================ */
function renderAdminIntel(el, user) {
  setPageTitle("System Intelligence & Performance", "Core analytics and top ranking lists");

  const jobs = Jobs.all();
  const reports = Reports.all();
  const reviews = Jobs.reviews();

  // Ratings calculation
  const totalReviews = reviews.length;
  const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach(r => { if (ratingCounts[r.rating] !== undefined) ratingCounts[r.rating]++; });

  // Tech rankings
  const techRankings = AdminStats.technicianPerformance();

  // Stalled jobs
  const unassigned = jobs.filter((j) => j.status === "pending");
  const staleUnassigned = unassigned.filter((j) => (Date.now() - new Date(j.createdAt).getTime()) > 24 * 60 * 60 * 1000);
  const stuckInProgress = jobs.filter((j) => j.status === "in_progress" && j.startedAt && (Date.now() - new Date(j.startedAt).getTime()) > 3 * 24 * 60 * 60 * 1000);

  // Status breakdown
  const pendingJ = jobs.filter(j => j.status === "pending").length;
  const assignedJ = jobs.filter(j => j.status === "assigned").length;
  const progressJ = jobs.filter(j => j.status === "in_progress").length;
  const completedJ = jobs.filter(j => j.status === "completed").length;

  el.innerHTML = `
    <!-- Top KPI Grid -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px;">
      <div style="background: #fff; border: 1px solid var(--pt-border); border-radius: 12px; padding: 16px; box-shadow: var(--pt-shadow);">
        <div style="font-size: 11px; text-transform: uppercase; color: var(--pt-text-muted); font-weight: 700;">Job Queue Status</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--pt-navy); margin-top: 4px;">${pendingJ}</div>
        <div style="font-size: 11px; color: var(--pt-amber-dark); margin-top: 4px; font-weight: 600;">Unassigned Pipeline</div>
      </div>
      <div style="background: #fff; border: 1px solid var(--pt-border); border-radius: 12px; padding: 16px; box-shadow: var(--pt-shadow);">
        <div style="font-size: 11px; text-transform: uppercase; color: var(--pt-text-muted); font-weight: 700;">Dispatched active</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--pt-navy); margin-top: 4px;">${assignedJ + progressJ}</div>
        <div style="font-size: 11px; color: var(--pt-blue); margin-top: 4px; font-weight: 600;">Currently In Action</div>
      </div>
      <div style="background: #fff; border: 1px solid var(--pt-border); border-radius: 12px; padding: 16px; box-shadow: var(--pt-shadow);">
        <div style="font-size: 11px; text-transform: uppercase; color: var(--pt-text-muted); font-weight: 700;">Completed Operations</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--pt-navy); margin-top: 4px;">${completedJ}</div>
        <div style="font-size: 11px; color: var(--pt-success); margin-top: 4px; font-weight: 600;">Report Filed &amp; Closed</div>
      </div>
      <div style="background: #fff; border: 1px solid var(--pt-border); border-radius: 12px; padding: 16px; box-shadow: var(--pt-shadow);">
        <div style="font-size: 11px; text-transform: uppercase; color: var(--pt-text-muted); font-weight: 700;">Total Filed Reports</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--pt-navy); margin-top: 4px;">${reports.length}</div>
        <div style="font-size: 11px; color: var(--pt-blue-light); margin-top: 4px; font-weight: 600;">Service Logs Saved</div>
      </div>
    </div>

    <div class="pt-grid-2">
      <!-- Left: Technicians Ranking & Performance -->
      <div class="pt-card">
        <div class="pt-card-title">Technicians Rank &amp; Performance</div>
        ${techRankings.length ? `
          <div style="display: flex; flex-direction: column; gap: 14px;">
            ${techRankings.map((t, idx) => {
              let medalClass = "";
              if (idx === 0) medalClass = "gold";
              else if (idx === 1) medalClass = "silver";
              else if (idx === 2) medalClass = "bronze";

              return `
                <div class="pt-admin-rank-row">
                  <div class="pt-admin-rank-num ${medalClass}">${idx + 1}</div>
                  <div class="pt-admin-rank-body">
                    <div class="pt-admin-rank-name">${escapeHtml(Users.fullName(t))}</div>
                    <div class="pt-admin-rank-sub">${t.completed.length} completed jobs · ${t.avgRating ? `${t.avgRating.toFixed(1)}★ avg` : "no ratings"}</div>
                    <div class="pt-admin-progress-bar">
                      <div class="pt-admin-progress-fill" style="width: ${t.compRate}%;"></div>
                    </div>
                  </div>
                  <div style="font-size: 13px; font-weight: bold; color: var(--pt-navy); text-align: right; width: 45px;">
                    ${t.compRate}%
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        ` : `
          <div class="pt-empty-state">No rankings calculated.</div>
        `}
      </div>

      <!-- Right: Ratings Breakdown & Stalled Jobs Alerts -->
      <div>
        <!-- Ratings Breakdown -->
        <div class="pt-card" style="margin-bottom: 20px;">
          <div class="pt-card-title">Customer Ratings Ledger (${totalReviews} reviews)</div>
          ${totalReviews ? [5, 4, 3, 2, 1].map(stars => {
            const count = ratingCounts[stars];
            const pct = totalReviews ? Math.round((count / totalReviews) * 100) : 0;
            return `
              <div class="pt-rating-dist-row">
                <div class="pt-rating-dist-label">${stars} ★</div>
                <div class="pt-rating-dist-bar">
                  <div class="pt-rating-dist-fill" style="width: ${pct}%;"></div>
                </div>
                <div class="pt-rating-dist-count">${count}</div>
              </div>
            `;
          }).join("") : `
            <div class="pt-empty-state">No ratings available.</div>
          `}
        </div>

        <!-- Stalled Jobs Warnings -->
        <div class="pt-card">
          <div class="pt-card-title" style="color: var(--pt-danger);">Operational Bottlenecks</div>
          ${staleUnassigned.length || stuckInProgress.length ? `
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${staleUnassigned.map(j => `
                <a href="#jobs/${j.id}" style="display: flex; flex-direction: column; padding: 10px; border-radius: 8px; background: #fffbeb; border: 1px solid #fde68a; text-decoration: none; color: inherit; margin-bottom: 4px;">
                  <div style="font-size: 12.5px; font-weight: 700; color: #b45309;">⚠️ Stale Unassigned Job: ${j.jobNumber}</div>
                  <div style="font-size: 11px; color: var(--pt-text-muted); margin-top: 2px;">Waiting assignment since: ${fmtDate(j.createdAt)} (${timeAgo(j.createdAt)})</div>
                </a>
              `).join("")}
              ${stuckInProgress.map(j => `
                <a href="#jobs/${j.id}" style="display: flex; flex-direction: column; padding: 10px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; text-decoration: none; color: inherit; margin-bottom: 4px;">
                  <div style="font-size: 12.5px; font-weight: 700; color: #b91c1c;">🚨 Stuck Job: ${j.jobNumber}</div>
                  <div style="font-size: 11px; color: var(--pt-text-muted); margin-top: 2px;">In Progress for ${timeAgo(j.startedAt)}</div>
                </a>
              `).join("")}
            </div>
          ` : `
            <div class="pt-empty-state">💚 No operational bottlenecks identified. All requests processed efficiently.</div>
          `}
        </div>
      </div>
    </div>
  `;
}

/* ============================================================
   SUPREME ADMIN — Activity Log (#admin/activity)
   ============================================================ */
function renderAdminActivity(el, user) {
  setPageTitle("Authorization History & Event Log", "Comprehensive system audit trails");

  const limit = 80;
  const feed = AdminStats.activityFeed(limit);

  el.innerHTML = `
    <div class="pt-card">
      <div class="pt-card-title">Audit Ledger Feed (Last ${feed.length} Events)</div>
      ${feed.length ? `
        <div class="pt-activity-feed">
          ${feed.map(a => `
            <div class="pt-activity-item">
              <div class="pt-activity-dot ${a.color}">${a.icon}</div>
              <div class="pt-activity-body">
                <div style="display: flex; justify-content: space-between; align-items: start;">
                  <span class="pt-activity-title" style="font-size: 14px;">${a.title}</span>
                  <span class="text-muted" style="font-size: 11px; font-weight: bold; white-space: nowrap;">${fmtDateTime(a.ts)}</span>
                </div>
                <div class="pt-activity-meta" style="font-size: 12.5px; margin-top: 4px;">${a.meta}</div>
              </div>
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="pt-empty-state">No audit activities logged in this space.</div>
      `}
    </div>
  `;
}
