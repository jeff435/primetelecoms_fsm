/**
 * Prime Telecoms FSM — one-time organizationId migration
 * -------------------------------------------------------
 * Fixes any /users, /jobs, /reports documents whose organizationId
 * is not exactly TARGET_ORG_ID. Must run with the Admin SDK (a
 * service account key), because firestore.rules deliberately blocks
 * every client — including a document's own owner — from ever
 * changing organizationId on an existing document (see
 * roleAndOrgUnchanged() in firestore.rules).
 *
 * tech_authorizations and counters are intentionally NOT touched here:
 * neither collection carries an organizationId field that access rules
 * depend on in the same way, so they're unaffected by this bug class.
 *
 * IMPORTANT — after running --apply:
 * Any user who is currently signed in with a browser tab open will have
 * the OLD organizationId cached in memory. As of this fix, the app's own
 * profile listener (_startMyProfileListener in js/data.js) detects the
 * server-side change and transparently restarts their listeners with the
 * new organizationId, so no action should be needed. If you're running
 * an older build without that fix, affected users need to sign out and
 * back in once after migration.
 *
 * SETUP
 *   1. cd scripts && npm install firebase-admin
 *   2. Firebase Console → Project Settings → Service Accounts →
 *      "Generate new private key" → save as serviceAccountKey.json
 *      in this same folder (DO NOT commit/share this file — it's
 *      already in .gitignore).
 *
 * USAGE
 *   node migrate-organization-id.js            # dry run — reports only, writes nothing
 *   node migrate-organization-id.js --apply    # actually performs the fix
 */

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const TARGET_ORG_ID = "org_primetelecoms";
const APPLY = process.argv.includes("--apply");
const COLLECTIONS = ["users", "jobs", "reports"];

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://planning-with-ai-f9dd4-default-rtdb.asia-southeast1.firebasedatabase.app"
});
const db = admin.firestore();

async function migrateCollection(name) {
  const snap = await db.collection(name).get();
  const bad = [];

  snap.forEach((doc) => {
    const data = doc.data();
    if (data.organizationId !== TARGET_ORG_ID) {
      bad.push({ id: doc.id, current: data.organizationId ?? "(missing)" });
    }
  });

  console.log(`\n${name}: ${snap.size} total, ${bad.length} mismatched`);
  bad.forEach((b) => console.log(`  - ${b.id}  current="${b.current}"`));

  if (APPLY && bad.length) {
    // Firestore batches cap at 500 writes; chunk defensively.
    for (let i = 0; i < bad.length; i += 450) {
      const chunk = bad.slice(i, i + 450);
      const batch = db.batch();
      chunk.forEach((b) => {
        batch.update(db.collection(name).doc(b.id), { organizationId: TARGET_ORG_ID });
      });
      await batch.commit();
    }
    console.log(`  -> fixed ${bad.length} document(s) in ${name}`);
  }

  return bad.length;
}

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY RUN (no writes)"}`);
  console.log(`Target organizationId: ${TARGET_ORG_ID}`);

  let totalBad = 0;
  for (const col of COLLECTIONS) {
    totalBad += await migrateCollection(col);
  }

  console.log(`\nTotal mismatched documents found: ${totalBad}`);
  if (!APPLY && totalBad > 0) {
    console.log("Re-run with --apply to fix them.");
  }
  process.exit(0);
})().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
