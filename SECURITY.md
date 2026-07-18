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
- **Anonymous AI-worker abuse.** The Cloudflare AI proxy accepted POSTs from
  anyone with the URL. It now requires a valid Firebase ID token on every
  request (RS256 verified against Google's JWK keys, plus aud/iss/exp checks),
  so only signed-in users of this project can call it.
- **AI-worker call flooding / runaway cost.** On top of token verification, the
  worker enforces two per-user guards using a Cloudflare KV namespace bound as
  `AI_RATE_LIMIT`, keyed by the token's uid:
  - **Burst window** (default 30 calls / 10 min) stops rapid loops.
  - **Monthly budget** (default $1.00 / user / calendar month, UTC) caps real
    Anthropic spend. Each call's actual token + web-search usage is read from
    the API response and charged against the allowance in integer
    "micro-dollars" (millionths of $1), priced at claude-sonnet-5 *standard*
    rates so the budget reflects worst-case cost. The call-type mix is therefore
    irrelevant — a free JSON-LD import costs nothing, a cheap chef chat a little,
    an expensive URL import more. The allowance is scaled by a per-user tier
    multiplier read from KV key `tier:<uid>` (integer, default 1), so a future
    payment flow can grant 2×/3×/… by writing that key; the worker only reads it.
  Both guards fail open if the binding or KV is unavailable, so they never break
  AI for real users. Tunable at the top of `recipe-proxy-worker.js`.

  **Not yet built:** the payment collection that would *set* `tier:<uid>` (App
  Store IAP or Stripe + receipt validation). Until that exists every user sits
  at the 1× / $1.00 allowance.

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

### 3. Orphaned photos on recipe deletion
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
