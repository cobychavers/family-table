# Security notes

This is a running record of the app's data-access model and the risks that
are known and deliberately still open. It exists so these aren't buried in
commit messages or a chat log.

## Data model recap

- **Firestore `data` collection** — the original flat key/value store
  (`dm_meals_<user>`, `dm_recipe_<user>_<id>`, etc.). Each document carries an
  `ownerUid` field stamped on write.
- **`users/{uid}`** — one profile document per user, keyed by Firebase uid.
- **`usernames/{username}`** — public username → email/uid lookup, needed to
  resolve a typed username to an email before sign-in.
- **`favoriteCounts/{owner_recipeId}`** — per-recipe favorite counters.
- **Cloud Storage** — recipe and profile photos, keyed by owner uid
  (`recipePhotos/<uid>/…`, `profilePics/<uid>/…`).

Security rules for Firestore and Storage live only in the Firebase console;
there is no rules file in the repo. Keep this document in sync by hand when
the rules change.

## Closed

- **User enumeration / bulk email dump.** `dm_users` was a single
  world-readable document holding every user's email, phone, and avatar.
  Reads now require auth, and username resolution goes through `usernames`,
  which allows `get` but denies `list` — a known username resolves, the set
  can't be enumerated.
- **Weak password hashes.** A legacy 32-bit non-cryptographic `passHash` sat
  in that world-readable doc and was accepted at login. Removed entirely; all
  accounts use Firebase Auth.
- **Cross-user overwrite of private data.** Any signed-in user could overwrite
  any `data` document. Writes to non-social documents now require
  `ownerUid == request.auth.uid`.
- **Signup ceiling / lost updates.** Profiles were one shared document with a
  read-modify-write on every change (1 MiB cap, ~1 write/sec, silent
  last-write-wins). Split into per-uid documents with targeted merges.

## Open — known and accepted

### 1. Key squatting on not-yet-created `data` keys
Ownership lives in a document *field* (`ownerUid`), not the document *path*,
because usernames may contain underscores and the key can't be parsed
reliably. An authenticated attacker who knows a victim's exact username can
`create` a document at a key the victim hasn't used yet (e.g.
`dm_theme_<victim>`) stamped with the attacker's own uid. The victim's client
then can't write that key, because `update` requires the *existing*
`ownerUid` to be theirs.

- **Impact:** griefing / denial of a specific feature-key. Not data theft —
  existing documents are fully protected, and usernames aren't enumerable.
- **Real fix:** per-user document paths (`users/{uid}/data/{key}`), where the
  key space is namespaced by uid and nobody can write into another user's
  namespace. This is a large change touching every read and write path.

### 2. Social documents are writable by any authenticated user
`dm_followers_*`, `dm_following_*`, `dm_followrequests_*`, `dm_inbox_*`, and
`dm_mypending_*` are written by users *other* than their subject by design
(following someone writes their follower list). The rules carve these out by
key prefix and keep the old any-authenticated-writer behaviour.

- **Impact:** a malicious user could tamper with another user's follower or
  inbox lists.
- **Real fix:** server-side logic (Cloud Functions) that validates each social
  mutation, or restructuring follows into per-edge documents with ownership.
  Needs the Blaze plan.

### 3. AI proxy worker has no auth or rate limit
`recipe-proxy-worker.js` (Cloudflare) accepts POSTs from any origin with no
authentication and no rate limiting. Anyone who reads the client JS can call
it in a loop and run up the Anthropic bill.

- **Real fix:** verify a Firebase ID token server-side in the worker, plus a
  per-user/IP rate limit. An `Origin` allowlist is a weaker stopgap (the
  header is spoofable) but deters casual abuse.

### 4. Orphaned photos on recipe deletion
Deleting a recipe does not delete its Storage photo. This is intentional:
recipes are *copied* between users and copies share the photo URL, so eager
deletion would break another user's saved copy. Storage therefore only grows.

- **Real fix:** reference counting, or copy-on-save so each copy owns its own
  file. Storage cost, not a correctness or security issue.

## Scale ceilings still present (not security, but related)

- **Explore / friend search load every user.** `loadPublicRecipes` iterates
  all users and `searchFriends` scans the whole user base client-side. Fine at
  small scale; needs a `publicRecipes` collection and prefix/paginated queries
  before a large user base.
- **Legacy `dm_users` document** still exists, now unread, kept as a rollback
  path. Safe to delete once the per-user split has proven itself.
