/* ============================================================
   Prime Telecoms FSM — Data Layer
   Identity:   Firebase Authentication + Firestore (source of truth)
   App data:   Cloud Firestore — jobs, reports, users (org-scoped,
               live-synced via onSnapshot so every role sees the
               same data across devices/sessions in real time)
   ============================================================ */

// Single-tenant default: this deployment serves one organization
// (Prime Telecoms Limited). Every manager, technician, and customer
// account is scoped to this organizationId unless a profile already
// carries a different one (kept for backward compatibility with any
// pre-existing accounts).
const DEFAULT_ORG_ID = "org_primetelecoms";

// ── Supreme Admin allowlist ──────────────────────────────────────────────
// ONLY these exact email addresses are ever allowed to claim the one-time
// Supreme Admin bootstrap (see Auth.claimAdmin below). This is what makes
// admin creation a controlled, specific-identity door instead of "whoever
// clicks the link first" — anyone who isn't on this list gets a clear
// rejection even if they find the hidden claim screen.
//
// IMPORTANT: this array is only a friendly client-side check. The actual
// security boundary is the matching isAllowedAdminEmail() list in
// firestore.rules — that's what a malicious client can't bypass by editing
// this file. Keep BOTH lists in sync (same email(s), lowercase), and
// redeploy firestore.rules after changing it.
//
const ADMIN_ALLOWED_EMAILS = ["printexenginieers@gmail.com"];

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================================================
   FIREBASE HANDLES
   ============================================================ */
function _getAuth() {
  if (window.PrimeFirebase && window.PrimeFirebase.auth) return window.PrimeFirebase.auth;
  if (typeof firebase !== "undefined" && firebase.apps && firebase.apps.length) {
    return firebase.auth();
  }
  return null;
}

function _getFirestore() {
  if (window.PrimeFirebase && window.PrimeFirebase.firestore) return window.PrimeFirebase.firestore;
  if (typeof firebase !== "undefined" && firebase.apps && firebase.apps.length) {
    try { return firebase.firestore(); } catch (e) { return null; }
  }
  return null;
}

/* ============================================================
   LIVE ORG-SCOPED CACHES
   Populated by Firestore onSnapshot listeners once a user's
   organizationId is known. Every render function in app.js reads
   these caches synchronously (Jobs.all(), Users.technicians(), …)
   so the rest of the app didn't need to become async — the cache
   just re-populates itself in the background and fires
   "pt:data-changed" so the router can re-render.
   ============================================================ */
let _jobsCache = [];
let _reportsCache = [];
let _orgUsersCache = []; // managers + technicians in the org (NOT customers)
let _customersCache = []; // customer accounts in the org — kept separate from staff
let _unsubJobs = null, _unsubReports = null, _unsubUsers = null, _unsubCustomers = null, _unsubMyProfile = null;

function _emitDataChanged() {
  window.dispatchEvent(new CustomEvent("pt:data-changed"));
}

// Firestore listener errors used to just vanish into console.error, leaving
// the UI stuck on an empty/stale list with no clue why (this is exactly
// what "my jobs aren't showing" turns out to be most of the time —
// permission-denied from undeployed rules or an organizationId mismatch).
// Dedup per-collection so a flaky connection doesn't spam the same toast
// on every reconnect attempt.
const _warnedListeners = new Set();
function _reportListenerError(label, e) {
  console.error(`[${label}] listener error:`, e);
  if (_warnedListeners.has(label)) return;
  _warnedListeners.add(label);
  const reason = e && e.code ? e.code : (e && e.message) || "unknown error";
  if (typeof toast === "function") {
    toast(`Couldn't load ${label.toLowerCase()} (${reason}). Try refreshing — if it keeps happening, Firestore rules may need re-deploying.`, "error");
  }
}

function stopOrgListeners() {
  if (_unsubJobs) { _unsubJobs(); _unsubJobs = null; }
  if (_unsubReports) { _unsubReports(); _unsubReports = null; }
  if (_unsubUsers) { _unsubUsers(); _unsubUsers = null; }
  if (_unsubCustomers) { _unsubCustomers(); _unsubCustomers = null; }
  if (_unsubMyProfile) { _unsubMyProfile(); _unsubMyProfile = null; }
  _jobsCache = [];
  _reportsCache = [];
  _orgUsersCache = [];
  _customersCache = [];
}

// Keeps the signed-in user's OWN role/active flags live-synced against
// Firestore for the duration of their session. Without this, a role change
// a manager makes (customer -> technician, or a revoke) would only take
// effect the next time the affected person logs back in — the route guard
// in app.js reads Auth.currentUser() synchronously from the in-memory
// _currentProfile, which was otherwise only ever set once at sign-in. This
// listener is what makes "next permission check" mean "immediately", not
// "next login".
function _startMyProfileListener(uid) {
  const db = _getFirestore();
  if (!db || !uid) return;
  _unsubMyProfile = db.collection("users").doc(uid)
    .onSnapshot(
      (doc) => {
        if (!doc.exists || !_currentProfile) return;
        const data = doc.data();
        const orgChanged = data.organizationId !== _currentProfile.organizationId;
        const roleOrActiveChanged = data.role !== _currentProfile.role || data.active !== _currentProfile.active;
        if (orgChanged || roleOrActiveChanged) {
          const roleChanged = data.role !== _currentProfile.role;
          _currentProfile = { ..._currentProfile, ...data };
          if (orgChanged || roleChanged) {
            // organizationId changed under this signed-in user — most
            // commonly a server-side migration correcting a stale value
            // via the Admin SDK (clients can never change this field
            // themselves; see roleAndOrgUnchanged() in firestore.rules).
            // The jobs/reports/users/customers listeners were opened with
            // the OLD organizationId baked into their query, so they must
            // be torn down and reopened against the new one — otherwise
            // every one of them starts failing with permission-denied,
            // because firestore.rules re-reads organizationId fresh on
            // every check and it no longer matches the query's filter.
            //
            // A role change (a manager just toggled this user between
            // customer <-> technician via isManagerRoleToggle()) needs the
            // exact same treatment: the jobs/reports queries are shaped
            // per-role (see startOrgListeners below), so the OLD role's
            // query is now the wrong query and has to be rebuilt too.
            startOrgListeners(data.organizationId);
          }
          // Role or active-flag changed under this user (e.g. a manager
          // just promoted, demoted, or revoked them) — tell the router to
          // re-evaluate route guards and re-render against the new role.
          _emitDataChanged();
        }
      },
      (e) => console.error("[Auth] own-profile listener error:", e)
    );
}

function startOrgListeners(orgId) {
  const db = _getFirestore();
  if (!db || !orgId) return;
  if (_unsubJobs) _unsubJobs();
  if (_unsubReports) _unsubReports();
  if (_unsubUsers) _unsubUsers();
  if (_unsubCustomers) _unsubCustomers();
  _jobsCache = [];
  _reportsCache = [];
  _orgUsersCache = [];
  _customersCache = [];

  // Jobs/reports are the two collections where firestore.rules grants
  // different people different SLICES of the org's data, not just an
  // org-wide yes/no: a manager can read every job, but a technician may
  // only read jobs assignedTo them, and a customer only jobs that are
  // theirs (see /jobs and /reports in firestore.rules). Firestore refuses
  // to run a LIST query at all — not "returns fewer results", but an
  // outright "Missing or insufficient permissions" on the whole query —
  // unless the query's own .where() filters make it structurally
  // impossible for it to return a document the rules would deny. So the
  // query shape here has to mirror the rule exactly for each role, not
  // just filter by organizationId and rely on the rule to sort it out.
  const role = _currentProfile && _currentProfile.role;
  const myUid = _currentProfile && _currentProfile.id;

  let jobsQuery = db.collection("jobs").where("organizationId", "==", orgId);
  if (role === "technician") jobsQuery = jobsQuery.where("assignedTo", "==", myUid);
  else if (role === "customer") jobsQuery = jobsQuery.where("customerId", "==", myUid);
  // managers keep the unfiltered org-wide query — matches isManager() in the rule

  _unsubJobs = jobsQuery.onSnapshot(
    (snap) => { _jobsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })); _emitDataChanged(); },
    (e) => _reportListenerError("Jobs", e)
  );

  // Same story for reports, with one extra wrinkle: the rule's customer
  // branch checks the PARENT JOB's customerId via get(jobs/...), and a
  // rule condition that depends on get()-ing a DIFFERENT document can
  // never be proven safe for a list query no matter how it's filtered —
  // there's no field on the query itself Firestore can point to as a
  // guarantee. So reports carry their own denormalized customerId,
  // stamped on at creation time (see Reports.create below), and both the
  // query here and the rule filter on that copy directly instead.
  let reportsQuery = db.collection("reports").where("organizationId", "==", orgId);
  if (role === "technician") reportsQuery = reportsQuery.where("technicianId", "==", myUid);
  else if (role === "customer") reportsQuery = reportsQuery.where("customerId", "==", myUid);

  _unsubReports = reportsQuery.onSnapshot(
    (snap) => { _reportsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })); _emitDataChanged(); },
    (e) => _reportListenerError("Reports", e)
  );

  // Every non-customer role (manager, manager_pending, technician, admin) —
  // customers are excluded and kept in their own cache below. Broadened
  // from "manager + technician only" so the Supreme Admin dashboard has
  // pending/active managers and the admin roster available locally too,
  // without opening a second live listener for the same collection.
  _unsubUsers = db.collection("users").where("organizationId", "==", orgId)
    .onSnapshot(
      (snap) => {
        _orgUsersCache = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((u) => u.role !== "customer");
        _emitDataChanged();
      },
      (e) => _reportListenerError("Technicians & Staff", e)
    );

  // Registered customer accounts — used so a manager can LINK a job to an
  // existing customer profile instead of re-typing their name/contact by
  // hand every time (avoids duplicate, inconsistent copies of the same
  // customer's details scattered across job records).
  _unsubCustomers = db.collection("users")
    .where("organizationId", "==", orgId).where("role", "==", "customer")
    .onSnapshot(
      (snap) => { _customersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })); _emitDataChanged(); },
      (e) => _reportListenerError("Customers", e)
    );
}

/* ---------- Users (managers + technicians, live from Firestore) ---------- */
const Users = {
  all: () => _orgUsersCache,
  get: (id) => {
    if (!id) return null;
    const found = _orgUsersCache.find((u) => u.id === id) || _customersCache.find((u) => u.id === id);
    if (found) return found;
    const me = Auth.currentUser();
    return me && me.id === id ? me : null;
  },
  technicians: () => _orgUsersCache.filter((u) => u.role === "technician" && u.active !== false),
  customers: () => _customersCache,
  // Manager + technician roster shown on the Staff page — deliberately
  // excludes manager_pending/admin/rejected accounts, which live on the
  // Supreme Admin's own Manager Approvals screen instead.
  staff: () => _orgUsersCache.filter((u) => u.role === "manager" || u.role === "technician"),
  managers: () => _orgUsersCache.filter((u) => u.role === "manager" && u.active !== false),
  pendingManagers: () => _orgUsersCache.filter((u) => u.role === "manager_pending" && u.active !== false),
  // Both a rejected pending request (role stayed manager_pending) and a
  // revoked former manager (role stayed manager) land here — both are
  // "not currently allowed in", both offer the same Reinstate action.
  rejectedManagers: () => _orgUsersCache.filter((u) => (u.role === "manager_pending" || u.role === "manager") && u.active === false),
  admins: () => _orgUsersCache.filter((u) => u.role === "admin"),
  fullName: (u) => (u ? (`${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || u.username || "Unknown") : "Unassigned"),
  update(id, patch) {
    _orgUsersCache = _orgUsersCache.map((u) => (u.id === id ? { ...u, ...patch } : u));
    _emitDataChanged();
    const db = _getFirestore();
    if (db) db.collection("users").doc(id).set(patch, { merge: true }).catch((e) => console.error("[Users] update error:", e));
  },

  /**
   * Manager-only: toggle someone between "customer" and "technician".
   * Deliberately does NOT accept "manager" as a target — promoting to
   * manager stays a self-service registration action, never a dropdown
   * click, and this is enforced again server-side by isManagerRoleToggle()
   * in firestore.rules (so a tampered client request is rejected too).
   *
   * Also keeps /tech_authorizations in sync so the existing Staff-page
   * "Revoke" control and technician-activation checks stay consistent
   * regardless of which path (authorize-and-activate vs. direct toggle)
   * originally granted the technician role.
   */
  async changeRole(userId, newRole) {
    if (!["customer", "technician"].includes(newRole)) {
      throw new Error("Role must be either 'customer' or 'technician'.");
    }
    const db = _getFirestore();
    if (!db) throw new Error("Firestore not available");
    const target = Users.get(userId);
    if (!target) throw new Error("User not found.");
    if (target.role === newRole) return;
    if (target.role === "manager" || newRole === "manager") {
      throw new Error("Manager role can't be changed here.");
    }

    const me = Auth.currentUser();
    const patch = {
      role: newRole,
      roleChangedAt: new Date().toISOString(),
      roleChangedBy: me ? me.id : "unknown",
      ...(newRole === "technician" ? { active: true } : {}),
    };
    await db.collection("users").doc(userId).set(patch, { merge: true });

    // Keep the tech_authorizations ledger consistent with the role flip.
    const email = (target.email || target.username || "").toLowerCase();
    if (email && me) {
      if (newRole === "technician") {
        await Auth.authorizeTechnician(me.organizationId || DEFAULT_ORG_ID, email, {
          firstName: target.firstName, lastName: target.lastName, employeeId: target.employeeId,
        });
      } else {
        await Auth.revokeTechnician(email);
      }
    }
  },

  /**
   * Supreme Admin-only: decide a manager account. This is the ONLY way a
   * self-registered "manager_pending" profile ever becomes a working
   * "manager" — enforced again server-side by isAdminManagerDecision() in
   * firestore.rules, so a tampered client request is rejected too.
   *   - "approve"    manager_pending -> manager, active: true
   *   - "reject"     manager_pending stays, active: false (blocked)
   *   - "revoke"     manager stays,         active: false (blocked)
   *   - "reinstate"  active: true again (role — pending or manager — is untouched)
   *   - "suspend"    manager stays, active: false (temporary pause — same as revoke internally)
   *   - "activate"   active: true  (un-suspend an active manager without changing role)
   */
  async setManagerStatus(userId, action) {
    const db = _getFirestore();
    if (!db) throw new Error("Firestore not available");
    const me = _currentProfile;
    if (!me || me.role !== "admin") throw new Error("Only the Supreme Admin can manage manager accounts.");
    const now = new Date().toISOString();
    const patch = {};
    if (action === "approve") {
      patch.role = "manager"; patch.active = true; patch.approvedAt = now; patch.approvedBy = me.id;
    } else if (action === "reject") {
      patch.active = false; patch.rejectedAt = now; patch.rejectedBy = me.id;
    } else if (action === "revoke") {
      patch.active = false; patch.revokedAt = now; patch.revokedBy = me.id;
    } else if (action === "reinstate" || action === "activate") {
      patch.active = true; patch.reinstatedAt = now; patch.reinstatedBy = me.id;
    } else if (action === "suspend") {
      patch.active = false; patch.suspendedAt = now; patch.suspendedBy = me.id;
    } else {
      throw new Error("Unknown manager action.");
    }
    await db.collection("users").doc(userId).set(patch, { merge: true });
  },

  /** Returns ALL technicians (including inactive) — for admin roster only. */
  allTechniciansForAdmin() {
    return _orgUsersCache.filter((u) => u.role === "technician");
  },
};

/* ---------- AdminStats — pure-compute analytics helpers ----------
   These never touch Firestore directly — they derive intelligence
   from the live caches that are already synced via onSnapshot. They
   can be called synchronously from any render function.
   ----------------------------------------------------------------- */
const AdminStats = {
  /**
   * Per-technician performance: completed jobs, avg rating, completion rate.
   * Returns array sorted by completedJobs desc.
   */
  technicianPerformance() {
    const techs = Users.allTechniciansForAdmin();
    const jobs  = Jobs.all();
    return techs.map((t) => {
      const myJobs      = jobs.filter((j) => j.assignedTo === t.id);
      const completed   = myJobs.filter((j) => j.status === "completed");
      const ratedJobs   = completed.filter((j) => j.rating);
      const avgRating   = ratedJobs.length
        ? (ratedJobs.reduce((s, j) => s + j.rating, 0) / ratedJobs.length)
        : 0;
      const activeJobs  = myJobs.filter((j) => ["assigned","in_progress"].includes(j.status)).length;
      const compRate    = myJobs.length ? Math.round((completed.length / myJobs.length) * 100) : 0;
      return { ...t, myJobs, completed, ratedJobs, avgRating, activeJobs, compRate };
    }).sort((a, b) => b.completed.length - a.completed.length);
  },

  /**
   * Per-manager aggregated overview: technician count, job counts, avg rating.
   * Returns array sorted by total jobs desc.
   */
  managerOverview() {
    const managers = Users.managers();
    const allTechs = Users.allTechniciansForAdmin();
    const jobs     = Jobs.all();
    const reviews  = Jobs.reviews();
    return managers.map((m) => {
      // In a single-tenant org every technician belongs to the same org as the
      // manager, so we count them org-wide (authorizedBy linkage would be ideal
      // but isn't guaranteed for every activation path).
      const techCount   = allTechs.length; // single-tenant: same pool
      const mgrJobs     = jobs; // single-tenant: manager sees all jobs
      const totalJobs   = mgrJobs.length;
      const activeJobs  = mgrJobs.filter((j) => ["assigned","in_progress"].includes(j.status)).length;
      const completedJ  = mgrJobs.filter((j) => j.status === "completed").length;
      const pendingJ    = mgrJobs.filter((j) => j.status === "pending").length;
      const ratedJobs   = reviews;
      const avgRating   = ratedJobs.length
        ? (ratedJobs.reduce((s, j) => s + j.rating, 0) / ratedJobs.length)
        : 0;
      return { ...m, techCount, totalJobs, activeJobs, completedJ, pendingJ, avgRating };
    });
  },

  /**
   * Build an activity feed from the existing caches.
   * Returns up to `limit` entries sorted newest-first.
   */
  activityFeed(limit = 30) {
    const events = [];
    const jobs   = Jobs.all();
    const techs  = Users.allTechniciansForAdmin();
    const allMgr = _orgUsersCache.filter((u) =>
      ["manager","manager_pending"].includes(u.role));

    // Job completions
    jobs.filter((j) => j.status === "completed" && j.completedAt).forEach((j) => {
      events.push({
        type: "job_completed", ts: j.completedAt,
        icon: "✅", color: "green",
        title: `Job ${j.jobNumber} completed`,
        meta: `Customer: ${j.customerName} · Technician: ${Users.fullName(Users.get(j.assignedTo))}`,
      });
    });
    // Customer reviews
    jobs.filter((j) => j.rating && j.reviewedAt).forEach((j) => {
      events.push({
        type: "review", ts: j.reviewedAt,
        icon: "⭐", color: "amber",
        title: `${j.rating}★ review from ${j.customerName}`,
        meta: `Job ${j.jobNumber}${j.reviewComment ? ` — "${j.reviewComment.slice(0,60)}${j.reviewComment.length>60?"…":""}"` : ""}`,
      });
    });
    // Manager registrations / approvals
    allMgr.forEach((m) => {
      if (m.createdAt) events.push({
        type: "manager_registered", ts: m.createdAt,
        icon: "👤", color: "blue",
        title: `${Users.fullName(m)} registered as manager`,
        meta: m.orgName || "Organization",
      });
      if (m.approvedAt) events.push({
        type: "manager_approved", ts: m.approvedAt,
        icon: "🛡", color: "green",
        title: `${Users.fullName(m)} approved`,
        meta: "Manager account activated",
      });
      if (m.revokedAt) events.push({
        type: "manager_revoked", ts: m.revokedAt,
        icon: "🚫", color: "red",
        title: `${Users.fullName(m)} access revoked`,
        meta: "Manager removed from active roster",
      });
    });
    // Technician accounts created
    techs.forEach((t) => {
      if (t.createdAt) events.push({
        type: "tech_created", ts: t.createdAt,
        icon: "🔧", color: "purple",
        title: `Technician account created for ${Users.fullName(t)}`,
        meta: t.employeeId ? `Employee ID: ${t.employeeId}` : "No employee ID set",
      });
    });

    return events
      .filter((e) => e.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, limit);
  },

  /** Derive technician status from live job data. */
  technicianStatus(techId) {
    const tech = Users.get(techId);
    if (!tech) return "offline";
    if (tech.active === false) return "inactive";
    const jobs = Jobs.all();
    const inProgress = jobs.find((j) => j.assignedTo === techId && j.status === "in_progress");
    if (inProgress) return "on-duty";
    if (tech.status === "on-break" || tech.status === "break") return "on-break";
    if (tech.status === "offline") return "offline";
    const assigned   = jobs.find((j) => j.assignedTo === techId && j.status === "assigned");
    if (assigned) return "available";
    return tech.status || "available";
  },
};


/* ---------- Jobs (Firestore-backed, org-scoped) ---------- */
// Job numbers used to be derived from `_jobsCache.length + 1`, which is a
// classic denormalization bug: two people booking/creating a job at the
// same instant would both read the same cached length and get the SAME
// job number (e.g. two "JOB-0007"s). The fix is a single authoritative
// counter document per organization, incremented atomically inside a
// Firestore transaction — there is exactly one source of truth for "what
// is the next job number", instead of every client guessing from its own
// local snapshot of the data.
function _reserveJobNumber(db, orgId) {
  const counterRef = db.collection("counters").doc(orgId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists ? (snap.data().jobSeq || 0) : 0) + 1;
    tx.set(counterRef, { jobSeq: next }, { merge: true });
    return next;
  }).then((seq) => `JOB-${String(seq).padStart(4, "0")}`);
}

const Jobs = {
  all: () => [..._jobsCache].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  get: (id) => _jobsCache.find((j) => j.id === id) || null,
  create(data) {
    const db = _getFirestore();
    const me = Auth.currentUser();
    const ref = db ? db.collection("jobs").doc() : { id: uid("job") };
    const orgId = (me && me.organizationId) || data.organizationId || DEFAULT_ORG_ID;
    const job = {
      id: ref.id,
      jobNumber: "JOB-…",  // placeholder — replaced with the real, race-safe number below
      createdAt: new Date().toISOString(),
      organizationId: orgId,
      status: data.assignedTo ? "assigned" : "pending",
      assignedAt: data.assignedTo ? new Date().toISOString() : null,
      ...data,
    };
    // Optimistic local insert so the UI feels instant; the listener
    // will reconcile with the authoritative Firestore copy moments later.
    _jobsCache.push(job);
    _emitDataChanged();
    if (db) {
      _reserveJobNumber(db, orgId)
        .then((jobNumber) => {
          job.jobNumber = jobNumber;
          return db.collection("jobs").doc(job.id).set(job);
        })
        .then(() => _emitDataChanged())
        .catch((e) => { console.error("[Jobs] create error:", e); toast("Couldn't save your request — check your connection and try again.", "error"); });
    }
    return job;
  },
  update(id, patch) {
    _jobsCache = _jobsCache.map((j) => (j.id === id ? { ...j, ...patch } : j));
    _emitDataChanged();
    const db = _getFirestore();
    if (db) db.collection("jobs").doc(id).set(patch, { merge: true }).catch((e) => console.error("[Jobs] update error:", e));
  },
  hasReport: (jobId) => _reportsCache.some((r) => r.jobId === jobId),
  reportFor: (jobId) => _reportsCache.find((r) => r.jobId === jobId) || null,
  // Every completed job a customer has left a star rating on — this is the
  // full org-wide feedback/review list a manager sees (the dashboard widget
  // only shows the latest 4; #reviews shows all of them).
  reviews: () => _jobsCache.filter((j) => j.rating).sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)),
};

/* ---------- Reports (Firestore-backed, org-scoped) ---------- */
const Reports = {
  all: () => [..._reportsCache].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)),
  get: (id) => _reportsCache.find((r) => r.id === id) || null,
  create(data) {
    const db = _getFirestore();
    const me = Auth.currentUser();
    const ref = db ? db.collection("reports").doc() : { id: uid("rpt") };
    const parentJob = Jobs.get(data.jobId);
    const report = {
      id: ref.id,
      status: "submitted",
      submittedAt: new Date().toISOString(),
      organizationId: (me && me.organizationId) || data.organizationId || DEFAULT_ORG_ID,
      // Copied from the parent job so the customer's report-listing query
      // (startOrgListeners above) can filter on customerId directly — see
      // the comment there for why a get()-based rule can't back a list
      // query no matter how it's filtered.
      customerId: parentJob ? parentJob.customerId : data.customerId,
      ...data,
    };
    _reportsCache.push(report);
    Jobs.update(data.jobId, { status: "completed", completedAt: new Date().toISOString() });
    _emitDataChanged();
    if (db) {
      db.collection("reports").doc(report.id).set(report)
        .catch((e) => { console.error("[Reports] create error:", e); toast("Couldn't save the report — check your connection.", "error"); });
    }
    return report;
  },
  update(id, patch) {
    _reportsCache = _reportsCache.map((r) => (r.id === id ? { ...r, ...patch } : r));
    _emitDataChanged();
    const db = _getFirestore();
    if (db) db.collection("reports").doc(id).set(patch, { merge: true }).catch((e) => console.error("[Reports] update error:", e));
  },
};

/* ============================================================
   FIREBASE AUTH + FIRESTORE  (single source of truth for identity)
   ============================================================ */

// In-memory cache of the current user's Firestore profile
let _currentProfile = null;

async function _readProfile(uid) {
  const db = _getFirestore();
  if (!db) return { exists: false, profile: null, failed: true };
  try {
    const doc = await db.collection("users").doc(uid).get();
    // doc.exists === false is a CONFIRMED "no profile" — safe to treat as
    // a genuine first-time sign-in. Any thrown error below is NOT the same
    // thing: it means we couldn't determine whether a profile exists at
    // all (offline, flaky network, blocked request, permission hiccup).
    // Conflating the two used to cause a serious bug: on a bad connection,
    // an EXISTING manager/technician's profile read would fail, the code
    // would assume "new user," and create/merge a fresh profile with the
    // default role "customer" — silently overwriting their real role in
    // Firestore. See loadProfile() below for how `failed` is used to stop
    // that from happening.
    return { exists: doc.exists, profile: doc.exists ? { id: uid, ...doc.data() } : null, failed: false };
  } catch (e) {
    console.error("[Auth] Firestore read error:", e);
    return { exists: false, profile: null, failed: true };
  }
}

async function _writeProfile(uid, data) {
  const db = _getFirestore();
  if (!db) return;
  try {
    await db.collection("users").doc(uid).set(data, { merge: true });
  } catch (e) {
    console.error("[Auth] Firestore write error:", e);
  }
}

const Auth = {
  /** Returns the cached Firestore profile (set after onAuthStateChanged fires). */
  currentUser() {
    return _currentProfile;
  },

  /**
   * Called from onAuthStateChanged. Reads Firestore profile, creates one if absent.
   * Returns the merged profile object used throughout the SPA.
   */
  async loadProfile(firebaseUser, overrides = {}) {
    if (!firebaseUser) {
      _currentProfile = null;
      stopOrgListeners();
      return null;
    }

    let { exists, profile, failed } = await _readProfile(firebaseUser.uid);

    if (failed) {
      // We could NOT confirm whether this user already has a profile —
      // do not guess. Guessing "no profile" here is what used to silently
      // demote existing managers/technicians to "customer" on a flaky
      // connection (see _readProfile above). Fail the sign-in loudly and
      // let the person retry instead.
      const err = new Error(
        "Couldn't verify your account — this usually means a slow or unstable connection. " +
        "Please check your internet connection and try signing in again."
      );
      err.code = "profile/read-failed";
      throw err;
    }

    if (!exists) {
      // First sign-in — create profile.
      // Default role is "customer" for plain self-service sign-ins (e.g. Google)
      // since customers are the only role that registers without prior
      // authorization. Manager/technician flows always pass an explicit
      // role override at registration/activation time.
      const displayName = firebaseUser.displayName || firebaseUser.email.split("@")[0];
      const nameParts = displayName.split(" ");
      profile = {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        firstName: nameParts[0] || "",
        lastName: nameParts.slice(1).join(" ") || "",
        role: overrides.role || "customer",
        organizationId: overrides.organizationId || DEFAULT_ORG_ID,
        orgName: overrides.orgName || "",
        employeeId: "",
        phone: overrides.phone || "",
        address: overrides.address || "",
        status: "available",
        active: true,
        createdAt: new Date().toISOString(),
      };
      await _writeProfile(firebaseUser.uid, profile);
    } else if (profile.organizationId && profile.organizationId !== DEFAULT_ORG_ID) {
      // Self-heal: this is a single-tenant deployment, so every account is
      // meant to share DEFAULT_ORG_ID. Some accounts were written with a
      // stale/mismatched organizationId before that was consistently
      // enforced across the app — invisible at the time, but it silently
      // hides that person's jobs from everyone else's org-scoped queries
      // (their jobs "exist" but never show up on the manager dashboard,
      // and vice versa). Correct it automatically on sign-in rather than
      // requiring a one-off Admin SDK migration script run by hand.
      // firestore.rules' isOrgSelfHeal() is what allows this specific,
      // narrow correction (move to the one canonical org, nothing else).
      try {
        await _writeProfile(firebaseUser.uid, { organizationId: DEFAULT_ORG_ID });
        profile = { ...profile, organizationId: DEFAULT_ORG_ID };
        console.log("[Auth] Self-healed stale organizationId ->", DEFAULT_ORG_ID);
      } catch (e) {
        console.error("[Auth] organizationId self-heal failed:", e);
      }
    }

    _currentProfile = {
      ...profile,
      id: firebaseUser.uid,          // SPA uses .id for comparisons
      username: firebaseUser.email,  // Shown in the sidebar
    };

    startOrgListeners(_currentProfile.organizationId);
    _startMyProfileListener(firebaseUser.uid);
    return _currentProfile;
  },

  /** Email + password sign-in. Returns Firebase user object. */
  async signInWithEmail(email, password) {
    const auth = _getAuth();
    if (!auth) throw new Error("Firebase Auth not initialized");
    const cred = await auth.signInWithEmailAndPassword(email, password);
    return cred.user;
  },

  /** Create a new Firebase account (manager registration, technician activation, customer sign-up). */
  async registerWithEmail(email, password, displayName) {
    const auth = _getAuth();
    if (!auth) throw new Error("Firebase Auth not initialized");
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    if (displayName) await cred.user.updateProfile({ displayName });
    return cred.user;
  },

  /** Starts a Google redirect sign-in (returns a promise, page will reload). */
  signInWithGoogle() {
    const auth = _getAuth();
    if (!auth) throw new Error("Firebase Auth not initialized");
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    return auth.signInWithRedirect(provider);
  },

  /** Call on page load to collect a pending Google redirect result. */
  async checkRedirectResult() {
    const auth = _getAuth();
    if (!auth) return null;
    try {
      const result = await auth.getRedirectResult();
      return result && result.user ? result.user : null;
    } catch (e) {
      console.error("[Auth] getRedirectResult error:", e);
      throw e;
    }
  },

  /**
   * Sends Firebase's built-in password-reset email — the secure, standard
   * way to give someone a new password without anyone (including a
   * manager or admin) ever needing to know or handle it. This is the only
   * password path available for an account that DIDN'T have its password
   * chosen by a manager/admin at creation (see managerCreateTechnician),
   * since Firebase Authentication only ever stores a one-way hash — there
   * is no API, client or admin, that can retrieve or set an arbitrary new
   * password for an existing account without the account holder present.
   */
  async sendPasswordReset(email) {
    const auth = _getAuth();
    if (!auth) throw new Error("Firebase Auth not initialized");
    await auth.sendPasswordResetEmail(email);
  },

  /** Whether an email is on the Supreme Admin allowlist (see ADMIN_ALLOWED_EMAILS above). */
  isAllowedAdminEmail(email) {
    return ADMIN_ALLOWED_EMAILS.includes((email || "").trim().toLowerCase());
  },

  /** Whether the one-time Supreme Admin claim is still unclaimed. */
  async isAdminBootstrapAvailable() {
    const db = _getFirestore();
    if (!db) return false;
    try {
      const doc = await db.collection("meta").doc("adminBootstrap").get();
      return !doc.exists || doc.data().claimed !== true;
    } catch (e) {
      console.error("[Auth] adminBootstrap check failed:", e);
      return false;
    }
  },

  /**
   * One-time claim of the Supreme Admin role. Creates a brand-new Firebase
   * Auth account and, in a single Firestore transaction, both (a) writes
   * its profile with role "admin" and (b) flips /meta/adminBootstrap to
   * claimed — see firestore.rules for why this pair is what makes the
   * claim safe even if two people click it at the exact same instant:
   * Firestore detects the conflicting write to the SAME bootstrap doc and
   * silently retries the loser, which then sees claimed:true and aborts.
   * If that happens, the just-created Auth account is deleted again so no
   * orphaned account is left behind.
   *
   * Also gated by ADMIN_ALLOWED_EMAILS above — even the very first person
   * to reach this screen can't claim Supreme Admin unless their email is
   * on that allowlist. This screen itself is never linked anywhere in the
   * UI (see renderLogin in app.js) — it's only reachable by navigating
   * directly to #claim-admin, so the door is both identity-gated and hidden.
   */
  async claimAdmin(email, password, firstName, lastName) {
    const auth = _getAuth();
    const db = _getFirestore();
    if (!auth || !db) throw new Error("Firebase not initialized");

    // Normalize once, up front — the Firestore rules' isAllowedAdminEmail()
    // does an exact string match with no case-folding, so a phone keyboard
    // capitalizing the first letter (very common on iOS/Android email
    // fields) would otherwise make the write silently fail with
    // permission-denied.
    email = (email || "").trim().toLowerCase();

    if (!Auth.isAllowedAdminEmail(email)) {
      throw new Error("This email isn't authorized to claim Supreme Admin access.");
    }

    const available = await Auth.isAdminBootstrapAvailable();
    if (!available) throw new Error("Supreme Admin access has already been claimed for this deployment. Please sign in normally.");

    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const displayName = `${firstName || ""} ${lastName || ""}`.trim();
    if (displayName) await cred.user.updateProfile({ displayName });

    const profile = {
      uid: cred.user.uid,
      email,
      firstName: firstName || "",
      lastName: lastName || "",
      role: "admin",
      organizationId: DEFAULT_ORG_ID,
      orgName: "Prime Telecoms Limited",
      active: true,
      createdAt: new Date().toISOString(),
    };

    try {
      await db.runTransaction(async (tx) => {
        const metaRef = db.collection("meta").doc("adminBootstrap");
        const metaSnap = await tx.get(metaRef);
        if (metaSnap.exists && metaSnap.data().claimed) {
          throw new Error("ALREADY_CLAIMED");
        }
        tx.set(metaRef, { claimed: true, claimedBy: cred.user.uid, claimedAt: new Date().toISOString() });
        tx.set(db.collection("users").doc(cred.user.uid), profile);
      });
    } catch (err) {
      // Lost the race, or some other failure — don't leave an orphaned
      // Auth account with no matching profile behind.
      await cred.user.delete().catch(() => {});
      if (err.message === "ALREADY_CLAIMED") {
        throw new Error("Someone else just claimed Supreme Admin access. Please sign in normally.");
      }
      throw err;
    }

    return cred.user;
  },

  /** Sign out of Firebase and clear in-memory profile + live listeners. */
  async signOut() {
    _currentProfile = null;
    stopOrgListeners();
    const auth = _getAuth();
    if (auth) await auth.signOut();
  },

  /**
   * Registers a callback that fires whenever Firebase auth state changes.
   * Returns the unsubscribe function.
   */
  onAuthStateChanged(callback) {
    const auth = _getAuth();
    if (!auth) { setTimeout(() => callback(null), 0); return () => {}; }
    return auth.onAuthStateChanged(callback);
  },

  /** Update profile fields in Firestore and in-memory cache. */
  async updateProfile(uid, data) {
    _currentProfile = { ..._currentProfile, ...data };
    await _writeProfile(uid, data);
    Users.update(uid, data);
  },

  // ── Technician management (called by manager — this IS the role-based
  //    access control gate: only a manager can grant the "technician" role,
  //    and only to a specific pre-approved email address) ─────────────────

  /** Manager authorizes a technician email for their organization. */
  async authorizeTechnician(orgId, techEmail, techData = {}) {
    const db = _getFirestore();
    if (!db) throw new Error("Firestore not available");
    await db.collection("tech_authorizations").doc(techEmail.toLowerCase()).set({
      email: techEmail.toLowerCase(),
      organizationId: orgId,
      status: "authorized",
      authorizedBy: _currentProfile ? _currentProfile.id : "unknown",
      createdAt: new Date().toISOString(),
      ...techData,
    }, { merge: true });
  },

  // ── Manager management (admin-only — this IS the "manager added by the
  //    admin" control the Supreme Admin uses instead of relying on
  //    self-registration; mirrors the technician flow directly below) ─────

  /** Admin authorizes a manager email for their organization. */
  async authorizeManager(orgId, mgrEmail, mgrData = {}) {
    const db = _getFirestore();
    if (!db) throw new Error("Firestore not available");
    await db.collection("manager_authorizations").doc(mgrEmail.toLowerCase()).set({
      email: mgrEmail.toLowerCase(),
      organizationId: orgId,
      status: "authorized",
      authorizedBy: _currentProfile ? _currentProfile.id : "unknown",
      createdAt: new Date().toISOString(),
      ...mgrData,
    }, { merge: true });
  },

  /** Admin revokes a manager authorization record (used to clean up a failed create). */
  async revokeManagerAuthorization(mgrEmail) {
    const db = _getFirestore();
    if (!db) throw new Error("Firestore not available");
    await db.collection("manager_authorizations").doc(mgrEmail.toLowerCase()).set({
      status: "revoked",
      revokedBy: _currentProfile ? _currentProfile.id : "unknown",
      revokedAt: new Date().toISOString(),
    }, { merge: true });
  },

  /**
   * Supreme-Admin-only: create a manager's Firebase Auth account AND their
   * Firestore profile directly, active immediately with role "manager" and
   * a password the ADMIN chooses — this is what lets the admin add a
   * manager from inside the system instead of waiting on self-registration.
   * Mirrors managerCreateTechnician exactly (see that function for why the
   * secondary app instance is required to avoid disturbing the admin's own
   * session), gated by isAdmin() rather than isManagerLike(), and backed by
   * the manager_authorizations ledger (server-enforced in firestore.rules)
   * rather than tech_authorizations.
   */
  async adminCreateManager(email, password, mgrData = {}) {
    const me = _currentProfile;
    if (!me || me.role !== "admin") throw new Error("Only the Supreme Admin can add a manager account.");
    email = (email || "").trim().toLowerCase();
    if (!email) throw new Error("Manager email is required.");
    if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");

    if (!window.PrimeFirebase || typeof window.PrimeFirebase.getSecondaryAuth !== "function") {
      throw new Error("Firebase isn't ready yet — please try again in a moment.");
    }
    const secAuth = window.PrimeFirebase.getSecondaryAuth();
    const secDb = window.PrimeFirebase.getSecondaryFirestore();
    if (!secAuth || !secDb) throw new Error("Couldn't start account creation — Firebase isn't initialized.");

    const orgId = me.organizationId || DEFAULT_ORG_ID;

    // Step 1 — authorize the email first, so the profile-create rule
    // (which checks manager_authorizations) is satisfied by the time we get to step 2.
    await Auth.authorizeManager(orgId, email, {
      firstName: mgrData.firstName || "", lastName: mgrData.lastName || "",
    });

    // Step 2 — create the Auth account + Firestore profile via the secondary app.
    let cred;
    try {
      cred = await secAuth.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      // Don't leave a "ghost" authorization behind for an account that
      // never actually got created.
      await Auth.revokeManagerAuthorization(email).catch(() => {});
      throw err;
    }

    try {
      const displayName = `${mgrData.firstName || ""} ${mgrData.lastName || ""}`.trim();
      if (displayName) await cred.user.updateProfile({ displayName });

      const profile = {
        uid: cred.user.uid,
        email,
        firstName: mgrData.firstName || "",
        lastName: mgrData.lastName || "",
        role: "manager",
        organizationId: orgId,
        orgName: mgrData.orgName || me.orgName || "",
        active: true,
        createdBy: me.id,
        createdAt: new Date().toISOString(),
        approvedAt: new Date().toISOString(),
        approvedBy: me.id,
      };
      await secDb.collection("users").doc(cred.user.uid).set(profile, { merge: true });
      // Stash the password the admin just chose, same private-subcollection
      // pattern as managerCreateTechnician — never on the /users doc itself.
      await secDb.collection("users").doc(cred.user.uid).collection("private").doc("credentials").set({
        lastKnownPassword: password,
        setAt: new Date().toISOString(),
        setBy: me.id,
        setByName: Users.fullName(me),
      });
      return { id: cred.user.uid, ...profile };
    } finally {
      // Always sign the secondary session back out, success or failure —
      // it must never linger as a second live session.
      await secAuth.signOut().catch(() => {});
    }
  },

  /** Manager revokes a technician's authorization (blocks future activation and access). */
  async revokeTechnician(techEmail) {
    const db = _getFirestore();
    if (!db) throw new Error("Firestore not available");
    await db.collection("tech_authorizations").doc(techEmail.toLowerCase()).set({
      status: "revoked",
      revokedBy: _currentProfile ? _currentProfile.id : "unknown",
      revokedAt: new Date().toISOString(),
    }, { merge: true });
  },

  /**
   * Manager-only: create a technician's Firebase Auth account AND their
   * Firestore profile directly, with a password the MANAGER chooses (not
   * a link the technician has to self-activate with). This is what makes
   * "let the manager set the technician's password" actually possible on a
   * pure client-side/serverless deployment with no Admin SDK backend:
   *
   *  1. Authorize the email in /tech_authorizations, same as before — this
   *     stays the server-enforced gate (firestore.rules) that decides who
   *     is even allowed to hold the "technician" role.
   *  2. Create the Firebase Auth user + Firestore profile using an
   *     isolated SECONDARY firebase app instance (see getSecondaryAuth in
   *     firebase-client.js). createUserWithEmailAndPassword always signs
   *     the new account into whichever `auth` you call it on — doing this
   *     on the secondary app means the technician's brand-new account is
   *     the one that's briefly "signed in" there, while the MANAGER's own
   *     session on the primary app is completely undisturbed throughout.
   *     The profile write happens through that same secondary Firestore
   *     handle, so it's authenticated as the new technician themselves —
   *     satisfying the ordinary isOwner(userId) create rule exactly as if
   *     they'd registered themselves, just driven by the manager instead.
   *  3. Immediately sign the secondary app back out. Its only job was to
   *     exist just long enough to create that one account.
   *
   * The technician can sign in right away with the email + password the
   * manager set. (They can change it themselves later from their own
   * account if they want to.)
   */
  async managerCreateTechnician(email, password, techData = {}) {
    const me = _currentProfile;
    if (!me || (me.role !== "manager" && me.role !== "admin")) throw new Error("Only a manager or the Supreme Admin can create a technician account.");
    email = (email || "").trim().toLowerCase();
    if (!email) throw new Error("Technician email is required.");
    if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");

    if (!window.PrimeFirebase || typeof window.PrimeFirebase.getSecondaryAuth !== "function") {
      throw new Error("Firebase isn't ready yet — please try again in a moment.");
    }
    const secAuth = window.PrimeFirebase.getSecondaryAuth();
    const secDb = window.PrimeFirebase.getSecondaryFirestore();
    if (!secAuth || !secDb) throw new Error("Couldn't start account creation — Firebase isn't initialized.");

    const orgId = me.organizationId || DEFAULT_ORG_ID;

    // Step 1 — authorize the email first, so the profile-create rule
    // (which checks tech_authorizations) is satisfied by the time we get to step 2.
    await Auth.authorizeTechnician(orgId, email, {
      firstName: techData.firstName || "", lastName: techData.lastName || "", employeeId: techData.employeeId || "",
    });

    // Step 2 — create the Auth account + Firestore profile via the secondary app.
    let cred;
    try {
      cred = await secAuth.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      // Don't leave a "ghost" authorization behind for an account that
      // never actually got created.
      await Auth.revokeTechnician(email).catch(() => {});
      throw err;
    }

    try {
      const displayName = `${techData.firstName || ""} ${techData.lastName || ""}`.trim();
      if (displayName) await cred.user.updateProfile({ displayName });

      const profile = {
        uid: cred.user.uid,
        email,
        firstName: techData.firstName || "",
        lastName: techData.lastName || "",
        role: "technician",
        organizationId: orgId,
        orgName: me.orgName || "",
        employeeId: techData.employeeId || "",
        phone: techData.phone || "",
        address: "",
        status: "available",
        active: true,
        createdBy: me.id,
        createdAt: new Date().toISOString(),
      };
      await secDb.collection("users").doc(cred.user.uid).set(profile, { merge: true });
      // Stash the password the manager/admin just chose, in the private
      // subcollection (never the /users doc itself — see firestore.rules)
      // so it can be shown back to a manager/admin later. This is the ONE
      // password this system can ever honestly display: it's only valid
      // until the technician changes it themselves, at which point
      // Firebase makes it unrecoverable again, same as any account.
      await secDb.collection("users").doc(cred.user.uid).collection("private").doc("credentials").set({
        lastKnownPassword: password,
        setAt: new Date().toISOString(),
        setBy: me.id,
        setByName: Users.fullName(me),
      });
      return { id: cred.user.uid, ...profile };
    } finally {
      // Always sign the secondary session back out, success or failure —
      // it must never linger as a second live session.
      await secAuth.signOut().catch(() => {});
    }
  },

  /**
   * Fetch the password stored for an account at creation time (see
   * managerCreateTechnician above), if any. Returns null if none was ever
   * stored — most commonly because the account self-registered (a
   * manager, or a technician who activated via their own link rather than
   * having a manager set their password directly).
   */
  async getStoredPassword(userId) {
    const db = _getFirestore();
    if (!db) return null;
    try {
      const doc = await db.collection("users").doc(userId).collection("private").doc("credentials").get();
      return doc.exists ? doc.data() : null;
    } catch (e) {
      console.error("[Auth] getStoredPassword failed:", e);
      return null;
    }
  },

  /** Check whether an email has been pre-authorized as a technician. */
  async getTechnicianAuthorization(email) {
    const db = _getFirestore();
    if (!db) return null;
    try {
      const doc = await db.collection("tech_authorizations").doc(email.toLowerCase()).get();
      return doc.exists ? doc.data() : null;
    } catch (e) { return null; }
  },

  /** Human-readable error messages for Firebase auth error codes. */
  getErrorMessage(code) {
    const map = {
      "auth/user-not-found":         "No account found with this email.",
      "auth/wrong-password":         "Incorrect password.",
      "auth/invalid-credential":     "Invalid email or password.",
      "auth/invalid-email":          "Please enter a valid email address.",
      "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
      "auth/weak-password":          "Password must be at least 6 characters.",
      "auth/user-disabled":          "This account has been disabled. Contact your manager.",
      "auth/too-many-requests":      "Too many failed attempts. Please wait before trying again.",
      "auth/network-request-failed": "Network error. Please check your connection.",
      "auth/popup-closed-by-user":   "Sign-in was cancelled.",
      "auth/cancelled-popup-request":"Sign-in was cancelled.",
      "auth/unauthorized-domain":    "This domain is not authorized for Firebase. Contact support.",
      "auth/api-key-not-valid":      "Firebase configuration error. Contact support.",
      "profile/read-failed":         "Couldn't verify your account — this usually means a slow or unstable connection. Please check your internet connection and try signing in again.",
    };
    return map[code] || "Authentication failed. Please try again.";
  },
};

/* ---------- Labels ---------- */
const LABELS = {
  jobType: {
    installation: "Installation", maintenance: "Maintenance",
    repair: "Repair", inspection: "Inspection",
  },
  priority: { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" },
  jobStatus: {
    pending: "Pending Assignment", assigned: "Assigned",
    in_progress: "In Progress", completed: "Completed", cancelled: "Cancelled",
  },
  reportStatus: { submitted: "Submitted", reviewed: "Reviewed", approved: "Approved" },
  role: {
    admin: "Supreme Admin",
    manager: "Operations Manager",
    manager_pending: "Manager (Pending Approval)",
    technician: "Field Technician",
    customer: "Customer",
  },
};
