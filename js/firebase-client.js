/* ============================================================
   Prime Telecoms FSM — Centralized Firebase Client
   Project: planning-with-ai-f9dd4
   ============================================================ */

(function () {
  const DEFAULT_CONFIG = {
    apiKey:            "AIzaSyAXhvayFTtXjcNTJxINP-RlLb7eRMBaRmA",
    authDomain:        "planning-with-ai-f9dd4.firebaseapp.com",
    projectId:         "planning-with-ai-f9dd4",
    storageBucket:     "planning-with-ai-f9dd4.firebasestorage.app",
    messagingSenderId: "768312939810",
    appId:             "1:768312939810:web:6fb8aabab5f1eebf2dc17b",
  };

  function getLoadedConfig() {
    try {
      const configEl = document.getElementById("firebase-config");
      if (configEl && configEl.textContent) {
        const parsed = JSON.parse(configEl.textContent);
        if (parsed && parsed.apiKey) return parsed;
      }
    } catch (e) {
      console.warn("[PrimeFirebase] Embedded config parse warning:", e);
    }
    return DEFAULT_CONFIG;
  }

  const activeConfig = getLoadedConfig();

  let isReady = false;
  let auth      = null;
  let firestore = null;

  try {
    if (typeof firebase !== "undefined" && activeConfig && activeConfig.apiKey) {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(activeConfig);
      }
      auth = firebase.auth();

      // Initialize Firestore (compat SDK)
      if (typeof firebase.firestore === "function") {
        firestore = firebase.firestore();
      }

      isReady = true;
      console.log("[PrimeFirebase] Ready. Project:", activeConfig.projectId);
    } else {
      console.error("[PrimeFirebase] Firebase SDK missing or invalid config:", activeConfig);
    }
  } catch (err) {
    console.error("[PrimeFirebase] Initialization error:", err);
  }

  // ── Secondary app instance ──────────────────────────────────────────────
  // Used ONLY so a manager can create a technician's Firebase Auth account
  // (and set their initial password) from inside the manager's own signed-
  // in session. `createUserWithEmailAndPassword` always signs the NEW user
  // into whichever `auth` instance you call it on — calling it on the
  // primary `auth` above would silently kick the manager out of their own
  // session and log them in as the technician instead. A second, isolated
  // firebase.app() has its own independent Auth/Firestore context, so the
  // manager's session on the primary app is never touched. See
  // Auth.managerCreateTechnician in js/data.js for how this is used, and
  // note it's always signed out again immediately after use.
  function getSecondaryApp() {
    if (!isReady) return null;
    const existing = firebase.apps.find((a) => a.name === "PrimeSecondary");
    if (existing) return existing;
    try {
      return firebase.initializeApp(activeConfig, "PrimeSecondary");
    } catch (e) {
      console.error("[PrimeFirebase] Secondary app init error:", e);
      return null;
    }
  }

  window.PrimeFirebase = {
    isReady,
    auth,
    firestore,
    config: activeConfig,
    getSecondaryAuth() {
      const app = getSecondaryApp();
      return app ? app.auth() : null;
    },
    getSecondaryFirestore() {
      const app = getSecondaryApp();
      return app ? app.firestore() : null;
    },
  };
})();
