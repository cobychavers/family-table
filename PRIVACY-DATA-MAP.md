# The Family Table — Data Collection Inventory

Reference for filling out **Apple App Privacy** (App Store Connect) and **Google Play Data Safety**. Derived from an audit of `index.html` + `recipe-proxy-worker.js` on 2026-08-12.

## Summary posture
- **No** third-party analytics, ads, ad IDs, tracking, or location.
- **No** data sold or shared for advertising or cross-app tracking → answer **"No"** to Apple's "used for tracking" for every item, and Google's "shared for advertising."
- All collection is to run the app + AI features you invoke. Account + content are deletable in-app (Delete Account).

## What is collected, and mapping

| Data | Collected? | Apple category | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|---|
| Email address | Yes | Contact Info → Email Address | Yes | No | App functionality, account, verification email |
| Name / username | Yes | Contact Info → Name (username) | Yes | No | App functionality (identity, household) |
| Phone number | Optional | Contact Info → Phone Number | Yes | No | App functionality (optional at signup) |
| Password | Yes (Firebase Auth) | Not a listed data type — managed by Firebase; not stored in readable form | Yes | No | Authentication |
| Recipes, meal plans, grocery lists, pantry, Chef preferences | Yes | User Content → Other User Content | Yes | No | Core app functionality; household sharing |
| Photos (profile + recipe) | Yes | User Content → Photos or Videos | Yes | No | Core app functionality |
| AI prompts + context sent to Claude | Yes (when AI used) | User Content → Other User Content | Yes | No | Provide AI Chef / scanning features |
| Rate-limit / usage counters (Cloudflare KV) | Yes | Usage Data → Product Interaction (counts only, no content) | Yes (keyed to account ID) | No | Prevent abuse / cost control |

### Not collected (answer "No")
Location, Contacts, Browsing/Search history, Identifiers (advertising/device tracking IDs), Health/Fitness, Financial info, Sensitive info, Diagnostics/Crash analytics (none integrated).

## Third parties / subprocessors (list in both forms)
- **Google Firebase** — Authentication, Firestore (content), Cloud Storage (photos).
- **Cloudflare** — Workers (relays AI requests; stores only anonymous usage counters).
- **Anthropic** — Claude API (processes AI request content to generate responses; does not train on API inputs/outputs).

## Apple "Account Deletion" question
Answer **Yes** — in-app account deletion exists (profile menu → Delete Account), satisfying Guideline 5.1.1(v).

## Required URLs at submission
- **Privacy Policy URL**: host `privacy.html` (e.g. `https://cobychavers.github.io/family-table/privacy.html`) and paste that URL into App Store Connect + Play Console.

## Open items to confirm before submitting
1. Contact email in the policy — currently `coby.chavers@yahoo.com`; swap if you want a dedicated address.
2. Whether you'll register as an individual or a business (affects the "provider" name and any legal entity references).
3. If you expect EU/California users at scale, consider adding explicit GDPR/CCPA rights sections (the policy already covers the substance; named-law sections can be added).

> Not legal advice — a template to get you accurate and consistent across the store forms and the hosted policy.
