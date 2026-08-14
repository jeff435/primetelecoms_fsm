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
        if (data.role !== _currentProfile.role || data.active !== _currentProfile.active) {
          _currentProfile = { ..._currentProfile, ...data };
          // Role or active-flag changed under this user (e.g. a manager
          // just promoted, demoted, or revoked them). organizationId is
          // unchanged, so the existing jobs/reports/users/customers
          // listeners stay valid as-is — just tell the router to
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

  _unsubJobs = db.collection("jobs").where("organizationId", "==", orgId)
    .onSnapshot(
      (snap) => { _jobsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })); _emitDataChanged(); },
      (e) => console.error("[Jobs] listener error:", e)
    );

  _unsubReports = db.collection("reports").where("organizationId", "==", orgId)
    .onSnapshot(
      (snap) => { _reportsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })); _emitDataChanged(); },
      (e) => console.error("[Reports] listener error:", e)
    );

  // Managers + technicians only (customers are excluded from the staff roster)
  _unsubUsers = db.collection("users").where("organizationId", "==", orgId)
    .onSnapshot(
      (snap) => {
        _orgUsersCache = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((u) => u.role === "manager" || u.role === "technician");
        _emitDataChanged();
      },
      (e) => console.error("[Users] listener error:", e)
    );

  // Registered customer accounts — used so a manager can LINK a job to an
  // existing customer profile instead of re-typing their name/contact by
  // hand every time (avoids duplicate, inconsistent copies of the same
  // customer's details scattered across job records).
  _unsubCustomers = db.collection("users")
    .where("organizationId", "==", orgId).where("role", "==", "customer")
    .onSnapshot(
      (snap) => { _customersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })); _emitDataChanged(); },
      (e) => console.error("[Customers] listener error:", e)
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
};

/* ---------- Reports (Firestore-backed, org-scoped) ---------- */
const Reports = {
  all: () => [..._reportsCache].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)),
  get: (id) => _reportsCache.find((r) => r.id === id) || null,
  create(data) {
    const db = _getFirestore();
    const me = Auth.currentUser();
    const ref = db ? db.collection("reports").doc() : { id: uid("rpt") };
    const report = {
      id: ref.id,
      status: "submitted",
      submittedAt: new Date().toISOString(),
      organizationId: (me && me.organizationId) || data.organizationId || DEFAULT_ORG_ID,
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
  if (!db) return null;
  try {
    const doc = await db.collection("users").doc(uid).get();
    return doc.exists ? { id: uid, ...doc.data() } : null;
  } catch (e) {
    console.error("[Auth] Firestore read error:", e);
    return null;
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

    let profile = await _readProfile(firebaseUser.uid);

    if (!profile) {
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
  role: { manager: "Operations Manager", technician: "Field Technician", customer: "Customer" },
};
