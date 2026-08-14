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

  window.PrimeFirebase = {
    isReady,
    auth,
    firestore,
    config: activeConfig,
  };
})();
