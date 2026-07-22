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
- **`favoriteCounts/{owner_recipeId}`** — per-recipe favorite counters. **Dead**
  since Explore was removed: nothing reads or writes these. The collection and
  its rules block are inert and can be deleted when convenient.
- **`households/{householdId}`** — a family group: `{name, members[], createdBy,
  inviteCode}`. `members` is a uid array and is the authority for who may read
  whose data. Nothing is stored per-household: every calendar, recipe, and list
  keeps its own owner, and membership only widens *read* access.
- **`householdInvites/{code}`** — `{householdId}`, keyed by the invite code
  itself so joining is a direct `get` of a code you were given. Allows `get`,
  denies `list`, the same shape as `usernames`.
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

## Households (family linking)

Family linking deliberately does **not** move or merge data. Every calendar,
recipe, and list keeps its own owner; a household only changes who may *read*.

**Calendars and recipes stay read-only to the family.** They require
`ownerUid == request.auth.uid` to write, so a family member can see a calendar
but never modify it. The client mirrors this — every write path goes through
`getOwnMealsForDay`, never the display accessor, so another member's week can't
be read into a save — but the rule is the actual boundary.

**The grocery list is the one exception, and is writable by the household.**
One person plans the meals, another does the shopping, so ticking items off has
to work on someone else's list. The rule carves this out by key prefix
(`isGroceryData`) plus household membership, and additionally pins ownership:

```
request.resource.data.ownerUid == resource.data.ownerUid
```

so a write to a family member's list cannot change who owns it. The client
enforces the same thing from the other side — every write stamps the *list
owner's* uid rather than the writer's. Both halves matter:

- Stamping the writer's uid (the default in `window.storage.set`) would
  transfer the document and lock the real owner out under the owner-only rule.
- Omitting `ownerUid` instead would look safe but is worse: on a document that
  doesn't exist yet it creates an **ownerless** document, and every later
  update fails, because the rules dereference `resource.data.ownerUid`.

Naming the true owner is the only option correct on both the create and update
paths.

Note the ordering in the rule: `resource.data.ownerUid == request.auth.uid` is
tested first, so the household lookup (which costs Firestore `get()` calls)
never runs on the common path of a user writing their own data.

The checked and hidden documents are also **live-subscribed** (`flags.watch`)
so two people shopping the same list see each other's ticks. Only those two are
watched, and deliberately so: they hold booleans, where an incoming update can
never land on top of something being edited. The manual-items and generated-list
documents hold text a user may be part-way through changing, so they stay
load-time reads.

**Reads on `data` are scoped — owner, family, and the share inbox.** For a long
time reads were open to any authenticated user, because Explore and profile
viewing loaded arbitrary users' recipe documents and "is this recipe public?"
lived inside the JSON string value where rules can't see it. That meant *any*
signed-in user could read *any* user's private recipes and meal plans by
constructing the key — private-by-obscurity, not enforced.

Removing Explore and following/followers closed the loophole that forced it
open. Nothing reads arbitrary users' documents anymore; the only cross-account
reads left are a family member's docs and the share inbox. So the read rule now
enforces that:

```
allow read: if request.auth != null && (
    !('ownerUid' in resource.data)                 // legacy doc, no owner stamp
    || resource.data.ownerUid == request.auth.uid  // mine
    || isSocialData(document)                       // share inbox
    || sameHousehold(resource.data.ownerUid)        // my family
  );
```

`sameHousehold` (also used by the grocery write rule) requires both sides to
carry the same non-null household id:

```
sameHousehold(otherUid) =
  householdIdOf(request.auth.uid) != null
  && householdIdOf(request.auth.uid) == householdIdOf(otherUid)
```

The `!= null` half is load-bearing. Without it two users in no household both
resolve to `null`, `null == null` is true, and every account becomes family with
every other — which would defeat the read scoping and silently grant strangers
write access to each other's grocery lists.

**Residual, deliberately accepted:** the `!('ownerUid' in resource.data)` clause
keeps documents that predate `ownerUid` stamping readable the way they always
were, rather than making them unreadable to their own owner (ownership can't be
proven without the field). That pool is world-readable but only shrinks — every
save stamps `ownerUid`, moving the doc under the strict rule. The full fix for
even those is a one-time backfill that re-saves the owner's own legacy docs.

**Joining** is a self-service `update` that appends only your own uid: the rule
lets a non-member add `request.auth.uid` to `members` while forbidding removal
of anyone already there. Household ids aren't enumerable, so the only way to
learn one is a valid invite code. Codes are 8 characters from a 31-symbol
alphabet (~8.5e11 combinations; `O`/`0` and `I`/`1` removed so they can be read
aloud) and are rotatable from the Family screen, which points a new invite
document at the household and deletes the old one.

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

### 2. The share inbox is writable by any authenticated user
`dm_inbox_*` is written by users *other* than its subject by design: sharing a
recipe appends it to the recipient's inbox. The rules carve it out (via
`isSocialData`) and keep any-authenticated-writer behaviour. The follower-related
prefixes (`dm_followers_*`, `dm_following_*`, `dm_followrequests_*`,
`dm_mypending_*`) are still in `isSocialData` but no app code writes them
anymore — following/followers was removed — so they only matter for any legacy
documents that still exist.

- **Impact:** a malicious user could spam or tamper with another user's inbox.
- **Real fix:** server-side logic (Cloud Functions) that validates each inbox
  append, or an append-only structure with per-item ownership. Needs the Blaze
  plan.

### 3. Orphaned photos on recipe deletion
Deleting a recipe does not delete its Storage photo. This is intentional:
recipes are *copied* between users and copies share the photo URL, so eager
deletion would break another user's saved copy. Storage therefore only grows.

- **Real fix:** reference counting, or copy-on-save so each copy owns its own
  file. Storage cost, not a correctness or security issue.

## Scale ceilings still present (not security, but related)

- **`window.users.all()` still reads every user.** One caller remains — the
  user-data load effect, which pulls all profiles to resolve the signed-in
  user's own avatar and to hold `allUsers` in memory. This is the last
  O(all-users) read in the app now that Explore and friend search are gone; it
  should become a single `users.get(uid)` for the own-profile case. Not a
  correctness issue, just a read-count one.
- **Family cookbook reads scale with household size, not user base.** It reads
  the recipe index and documents of each household member — a handful of point
  reads, cheap by construction.
- **`favoriteCounts` collection is dead.** Nothing reads or writes it since
  Explore was removed; its rules block and any existing counter documents are
  inert and can be deleted when convenient.
- **Legacy `dm_users` document** still exists, now unread, kept as a rollback
  path. Safe to delete once the per-user split has proven itself.
