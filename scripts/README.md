# scripts/

## migrate-organization-id.js

One-time Admin SDK fix for `/users`, `/jobs`, and `/reports` documents whose
`organizationId` doesn't match `org_primetelecoms`. Needed because
`firestore.rules` blocks any client — including a document's own owner —
from ever changing `organizationId` on an existing document, so bad values
already sitting in Firestore can't be self-healed by the app itself.

```
cd scripts
npm install firebase-admin
# download a service account key: Firebase Console → Project Settings →
# Service Accounts → "Generate new private key" → save here as
# serviceAccountKey.json (never commit this file — it's in .gitignore)

node migrate-organization-id.js            # dry run — reports counts only
node migrate-organization-id.js --apply    # applies the fix
```

Run the dry run first and read the output before applying.

### Why clients used to break right after running this

Running `--apply` changes documents on the server while a user may still be
signed in with a browser tab open. Previously, the app's own-profile
listener only reacted to `role`/`active` changing, so a signed-in client's
in-memory `organizationId` went stale the moment this script updated their
`/users/{uid}` doc — every subsequent query and write from that tab then
disagreed with what `firestore.rules` computed fresh from the server, and
failed with `permission-denied`. That listener now also reacts to
`organizationId` changes and reopens the org-scoped listeners automatically,
so this should no longer require an affected user to sign out and back in.
