// --- Firebase ID token verification ---------------------------------------
// Gates the AI endpoints behind a real Firebase ID token, so only signed-in
// users of this project can call them. The RS256 signature is checked against
// Google's published secure-token public keys (JWK form, so WebCrypto can
// import them directly - the x509/PEM endpoint would need ASN.1 parsing).
// No external library and no KV binding required.
const FIREBASE_PROJECT_ID = "the-family-table-81b4d";
const FIREBASE_JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Google rotates these keys ~daily. Cache them for the isolate's lifetime and
// refetch on a kid miss (a freshly-rotated key the cache hasn't seen yet).
let _fbKeyCache = { keys: null, fetchedAt: 0 };

function b64urlToString(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
function b64urlToBytes(s) {
  const bin = b64urlToString(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getFirebaseKeys(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && _fbKeyCache.keys && (now - _fbKeyCache.fetchedAt) < 3600 * 1000) {
    return _fbKeyCache.keys;
  }
  const res = await fetch(FIREBASE_JWK_URL);
  if (!res.ok) throw new Error("Could not fetch Google public keys");
  const data = await res.json();
  _fbKeyCache = { keys: data.keys || [], fetchedAt: now };
  return _fbKeyCache.keys;
}

async function verifyFirebaseToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const header = JSON.parse(b64urlToString(parts[0]));
  const payload = JSON.parse(b64urlToString(parts[1]));

  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");

  // Cheap claim checks first, before spending a signature verification.
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("Wrong audience");
  if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID) throw new Error("Wrong issuer");
  if (!payload.sub) throw new Error("Missing subject");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Token expired");
  if (typeof payload.iat !== "number" || payload.iat > now + 300) throw new Error("Token issued in the future");

  // Verify the RS256 signature against the matching Google key.
  let keys = await getFirebaseKeys(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getFirebaseKeys(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("No matching signing key");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlToBytes(parts[2]), signed);
  if (!valid) throw new Error("Invalid token signature");

  return payload; // includes sub (the user's uid)
}

// --- Per-user limits --------------------------------------------------------
// Token verification ties every AI call to an account, but nothing stops one
// account from looping the endpoints. Two independent guards, both backed by a
// KV namespace bound as AI_RATE_LIMIT. If the binding is missing or KV errors,
// every check FAILS OPEN (allows the call) - an optional guard must never break
// AI for real users, so the worker is safe to deploy before the binding exists.
//
//   1. Burst window (count-based)  - stops rapid loops / hammering.
//   2. Monthly budget (cost-based) - caps real Anthropic spend per user. Each
//      call's actual token usage is read from the API response and charged
//      against a per-user, per-month dollar allowance, so the *mix* of call
//      types is irrelevant: everyone gets the same dollar budget, spent however
//      they like. A cheap chef chat draws a little, an expensive URL import
//      draws more, a free JSON-LD import draws nothing. The allowance can be
//      raised per user via a "tier" multiplier (see getTierMultiplier) that a
//      future payment flow would set.

// Burst window
const RATE_LIMIT_MAX = 30;            // max requests...
const RATE_LIMIT_WINDOW_SEC = 600;    // ...per this many seconds (10 minutes)

// Monthly budget. All money is tracked in "micro-dollars" (millionths of $1) as
// integers, so there is no floating-point drift in KV. claude-sonnet-5 STANDARD
// pricing is used deliberately (not the cheaper intro rate that expires
// 2026-08-31), so the budget always reflects worst-case real cost.
const PRICE_IN_PER_TOK = 3;           // $3  / 1M input tokens  -> 3 µ$/token
const PRICE_OUT_PER_TOK = 15;         // $15 / 1M output tokens -> 15 µ$/token
const PRICE_WEB_SEARCH = 10000;       // $10 / 1k web searches  -> 10000 µ$/search
const MONTHLY_BUDGET_MICRO = 1000000; // $1.00 base allowance per user per month
const MONTH_TTL_SEC = 60 * 60 * 24 * 63; // ~63 days: outlive the month, then auto-clean

function monthKeyFor(prefix, uid) {
  return prefix + uid + ":" + new Date().toISOString().slice(0, 7); // "...:YYYY-MM" (UTC)
}

// Accumulates the real cost of every Anthropic call made while handling one
// request, in micro-dollars. callAnthropic() feeds it each response's usage.
function createMeter() {
  return {
    microDollars: 0,
    record(usage) {
      if (!usage) return;
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
      this.microDollars += inTok * PRICE_IN_PER_TOK + outTok * PRICE_OUT_PER_TOK + searches * PRICE_WEB_SEARCH;
    }
  };
}

// Burst limit: check + increment the 10-minute counter. Returns true if allowed.
async function checkBurst(env, uid) {
  const kv = env.AI_RATE_LIMIT;
  if (!kv) return true; // binding not configured yet -> don't block anyone
  try {
    const windowId = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SEC);
    const key = "rl:" + uid + ":" + windowId;
    const current = parseInt((await kv.get(key)) || "0", 10);
    if (current >= RATE_LIMIT_MAX) return false;
    // read-then-write isn't atomic; a burst can slip a couple extra through,
    // which is fine for abuse prevention. TTL cleans up old windows.
    await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC * 2 });
    return true;
  } catch (e) {
    return true; // KV hiccup -> fail open rather than break AI
  }
}

// Per-user monthly allowance = base budget x tier multiplier. The multiplier is
// read from KV key "tier:<uid>" (an integer, default 1). A payment flow is the
// thing that writes that key - 2 for a 2x purchase, 3 for 3x, etc. The worker
// only consumes it, and clamps to a sane range.
async function getTierMultiplier(env, uid) {
  const kv = env.AI_RATE_LIMIT;
  if (!kv) return 1;
  try {
    const t = parseInt((await kv.get("tier:" + uid)) || "1", 10);
    return (t >= 1 && t <= 20) ? t : 1;
  } catch (e) {
    return 1;
  }
}

// Budget limit: read-only pre-check. Returns true if the user still has budget
// left this month. The call's real cost is recorded AFTER it completes (see
// recordSpend), so a single call can push the total slightly past the cap -
// worst case one call's worth (a few cents), which is acceptable.
async function withinBudget(env, uid) {
  const kv = env.AI_RATE_LIMIT;
  if (!kv) return true;
  try {
    const spent = parseInt((await kv.get(monthKeyFor("cost:", uid))) || "0", 10);
    const allowance = MONTHLY_BUDGET_MICRO * (await getTierMultiplier(env, uid));
    return spent < allowance;
  } catch (e) {
    return true;
  }
}

// Add this request's metered cost to the user's monthly total. Best-effort:
// a KV hiccup just means one call goes uncounted, never a broken response.
async function recordSpend(env, uid, microDollars) {
  if (!microDollars) return;
  const kv = env.AI_RATE_LIMIT;
  if (!kv) return;
  try {
    const key = monthKeyFor("cost:", uid);
    const spent = parseInt((await kv.get(key)) || "0", 10);
    await kv.put(key, String(spent + microDollars), { expirationTtl: MONTH_TTL_SEC });
  } catch (e) {
    // best-effort accounting; ignore
  }
}

// Single choke point for every Anthropic Messages API call. Does the fetch,
// meters the response's real token/tool usage, and surfaces API errors.
async function callAnthropic(requestBody, apiKey, meter) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(requestBody)
  });
  const data = await response.json();
  if (meter && data && data.usage) meter.record(data.usage);
  if (data && data.error) throw new Error(data.error.message || "API error");
  return data;
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight. Authorization must be listed here: the client now
    // sends a Bearer token, which makes the request non-simple and triggers
    // this preflight - if the header isn't allowed, the browser blocks the
    // real request before it's ever sent.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST required" }), {
        status: 405,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Require a valid Firebase ID token for every AI operation. Without this,
    // anyone who found this URL in the client JS could POST to it and spend the
    // Anthropic budget. Verifying the token restricts calls to signed-in users
    // of this specific Firebase project, and ties each call to a uid.
    const authHeader = request.headers.get("Authorization") || "";
    const bearer = authHeader.match(/^Bearer (.+)$/);
    if (!bearer) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    let uid;
    try {
      const claims = await verifyFirebaseToken(bearer[1]);
      uid = claims.sub;
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid or expired session - please sign in again." }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Guard 1: burst limit (abuse). Checked before dispatch, so even malformed
    // requests count - an attacker's loop is throttled regardless of payload.
    if (!(await checkBurst(env, uid))) {
      return new Response(JSON.stringify({ error: "You're doing that a lot - please wait a few minutes and try again." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Guard 2: monthly budget (cost). If the user has already spent their dollar
    // allowance for the month, block until it resets.
    if (!(await withinBudget(env, uid))) {
      return new Response(JSON.stringify({ error: "You've used this month's AI budget. It resets at the start of next month." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // One meter per request accumulates the real cost of whatever AI calls the
    // chosen handler makes; recordSpend() charges it to the monthly budget.
    const meter = createMeter();
    try {
      const body = await request.json();
      const { type } = body;
      let payload;

      if (type === "chef_chat") {
        // Recipe-idea chat - returns a plain-text reply, not a structured recipe
        payload = { success: true, reply: await chefChat(body.messages, env.ANTHROPIC_API_KEY, meter) };
      } else if (type === "ingredient_swap") {
        // Substitutes for one ingredient - returns its own {success, original,
        // suggestions} shape, not the {success, recipe} shape
        payload = await ingredientSwap(body.recipeName, body.ingredients, body.recipeText, body.request, env.ANTHROPIC_API_KEY, meter);
      } else if (type === "scan") {
        payload = { success: true, recipe: await scanImages(body.images, env.ANTHROPIC_API_KEY, meter) };
      } else if (type === "url") {
        payload = { success: true, recipe: await importFromUrl(body.url, env.ANTHROPIC_API_KEY, meter) };
      } else if (type === "pdf") {
        payload = { success: true, recipe: await importFromPdf(body.imageData, body.mimeType, env.ANTHROPIC_API_KEY, meter) };
      } else if (type === "parse_text") {
        payload = { success: true, recipe: await parseRecipeText(body.text, env.ANTHROPIC_API_KEY, meter) };
      } else if (type === "grocery_scan") {
        // Extract a plain grocery list from a photo or PDF - returns { text }
        // (a newline-separated list), which the client parses its own way.
        payload = { success: true, text: await groceryScan(body.images, body.pdf, env.ANTHROPIC_API_KEY, meter) };
      } else {
        return new Response(JSON.stringify({ error: "Invalid type. Use 'scan', 'url', 'pdf', 'parse_text', 'chef_chat', 'ingredient_swap', or 'grocery_scan'" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Charge the metered cost against the user's monthly budget.
      await recordSpend(env, uid, meter.microDollars);

      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (err) {
      // A call can fail after the API already ran (e.g. the reply didn't parse) -
      // that still cost tokens, so record whatever was metered before failing.
      await recordSpend(env, uid, meter.microDollars);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

// Scan images to extract recipe
async function scanImages(images, apiKey, meter) {
  if (!images || images.length === 0) {
    throw new Error("No images provided");
  }

  // Build content array with all images
  const content = images.map(img => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType || "image/jpeg",
      data: img.base64
    }
  }));

  // Add the prompt
  const prompt = images.length > 1
    ? "These images show different parts of the same recipe (e.g. front and back of a recipe card). Extract the complete recipe combining information from all images. Return ONLY valid JSON with no other text: {\"name\":\"Recipe Name\",\"time\":\"30 min\",\"ingredients\":[{\"qty\":\"2\",\"unit\":\"cup\",\"name\":\"flour\"}],\"notes\":\"1. First step\\n2. Second step\\n3. Third step\",\"recipeType\":\"other\"} IMPORTANT: The 'name' field should ONLY contain the recipe title (e.g. 'Crockpot Italian Sausage Pasta'), NOT cooking times or instructions. Put ALL cooking time info in the 'time' field (e.g. 'LOW 6 hours or HIGH 3.5-4 hours'). Format the notes as NUMBERED STEPS (1. 2. 3.) each on its own line. Valid recipeType values: chicken, beef, pork, seafood, pasta, mexican, asian, soup, salad, vegetarian, breakfast, dessert, drinks, cocktails, other"
    : "Extract the recipe from this image. Return ONLY valid JSON with no other text: {\"name\":\"Recipe Name\",\"time\":\"30 min\",\"ingredients\":[{\"qty\":\"2\",\"unit\":\"cup\",\"name\":\"flour\"}],\"notes\":\"1. First step\\n2. Second step\\n3. Third step\",\"recipeType\":\"other\"} IMPORTANT: The 'name' field should ONLY contain the recipe title (e.g. 'Crockpot Italian Sausage Pasta'), NOT cooking times or instructions. Put ALL cooking time info in the 'time' field (e.g. 'LOW 6 hours or HIGH 3.5-4 hours'). Format the notes as NUMBERED STEPS (1. 2. 3.) each on its own line. Valid recipeType values: chicken, beef, pork, seafood, pasta, mexican, asian, soup, salad, vegetarian, breakfast, dessert, drinks, cocktails, other";

  content.push({ type: "text", text: prompt });

  const data = await callAnthropic({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    messages: [{ role: "user", content }]
  }, apiKey, meter);

  const text = data.content?.find(b => b.type === "text")?.text || "";
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Could not extract recipe from image");
  }
  return parsed;
}

// Extract a plain grocery list from a photo or PDF. Unlike scanImages (which
// returns a structured recipe), this just returns the model's newline-separated
// list of items as text - the client runs its own parser/cleaner over it.
async function groceryScan(images, pdf, apiKey, meter) {
  let content, noun;
  if (images && images.length) {
    content = images.map(img => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.base64 }
    }));
    noun = "image";
  } else if (pdf && pdf.data) {
    content = [{
      type: "document",
      source: { type: "base64", media_type: pdf.mimeType || "application/pdf", data: pdf.data }
    }];
    noun = "document";
  } else {
    throw new Error("No image or PDF provided");
  }
  content.push({
    type: "text",
    text: "Extract the grocery list items from this " + noun + ". Return ONLY a simple list with one item per line. If there are quantities, include them. No explanations, just the list items."
  });

  const data = await callAnthropic({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    messages: [{ role: "user", content }]
  }, apiKey, meter);

  return data.content?.find(b => b.type === "text")?.text || "";
}

// --- JSON-LD Recipe schema extraction (schema.org) ---
// Most recipe sites embed a <script type="application/ld+json"> block with
// a Recipe object, put there for Google's rich-result snippets. When present
// and complete, this gives perfectly structured data with no AI call needed
// at all - faster, free, and no hallucination risk.

function tryParseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Pull the first complete, balanced JSON object out of a model reply, ignoring
// braces that appear inside strings and any prose the model wrapped around it.
// More robust than a greedy /\{[\s\S]*\}/ match, which over-grabs on trailing
// text and then throws on the whole thing instead of degrading. Returns the
// parsed object, or null if nothing usable is present.
function extractJsonObject(text) {
  const cleaned = (text || "").replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return tryParseJson(cleaned.slice(start, i + 1)); }
  }
  // Unbalanced (e.g. a reply truncated at max_tokens) - try the whole span.
  return tryParseJson(cleaned.slice(start));
}

// Some sites HTML-escape their JSON-LD (&quot; for the quotes, &amp; for &).
// Decoding lets those blocks parse. &amp; is decoded last so a genuine "&amp;"
// in text doesn't get turned into "&" and then mis-decoded.
function decodeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#0*34;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#0*10;/g, "\n").replace(/&#0*9;/g, "\t")
    .replace(/&amp;/g, "&");
}

function extractJsonLdRecipe(html) {
  // The `type` value is matched with OPTIONAL quotes and optional whitespace
  // around '=': Yoast (the most common WordPress SEO plugin) emits
  // `<script type=application/ld+json ...>` with no quotes when minified, and
  // the old quote-required regex silently missed every such page - a large
  // slice of real recipe sites. \b keeps it from matching e.g. "mimetype=".
  const scriptRegex = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    let raw = match[1]
      // Strip CDATA / HTML-comment wrappers some CMSes add around the JSON.
      .replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
      .replace(/^\s*<!--/, "").replace(/-->\s*$/, "")
      .trim();
    // Parse as-is first (the common, well-formed case), then fall back to
    // entity-decoding for HTML-escaped blocks.
    let data = tryParseJson(raw) || tryParseJson(decodeHtmlEntities(raw));
    if (!data) continue;
    const recipe = findRecipeInJsonLd(data);
    if (recipe) return recipe;
  }
  return null;
}

// Walk the whole JSON-LD graph for a Recipe node, not just the top level.
// Sites nest it under @graph, mainEntity, mainEntityOfPage, or inside arrays;
// the old one-level scan missed all of those.
function findRecipeInJsonLd(data) {
  const seen = new Set();
  function search(node) {
    if (!node || typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) { const r = search(item); if (r) return r; }
      return null;
    }
    const type = node["@type"];
    if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) return node;
    for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
      if (node[key]) { const r = search(node[key]); if (r) return r; }
    }
    return null;
  }
  return search(data);
}

function isoDurationToReadable(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m || (!m[1] && !m[2])) return "";
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const parts = [];
  if (h) parts.push(h + " hr" + (h > 1 ? "s" : ""));
  if (min) parts.push(min + " min");
  return parts.join(" ");
}

// Mirrors the app's own parseIng() (index.html) so ingredient lines split into
// {qty, unit, name} the same way whether they came from AI extraction or
// straight off the page's structured data. Handles whole numbers, decimals,
// fractions ("1/2"), mixed numbers ("1 1/2"), unicode fractions ("½", "1½"),
// and RANGES ("1-2", "2 to 3", "1–2") - the last of which the old regex
// mangled into qty:"1", name:"-2 balls burrata". Unit is only taken when a
// quantity preceded it, so "red onion" doesn't treat "red" as a unit.
const ING_NUM = "(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.?\\d+[½¼¾⅓⅔⅛⅜⅝⅞]?|[½¼¾⅓⅔⅛⅜⅝⅞])";
const ING_QTY_RE = new RegExp("^(" + ING_NUM + "(?:\\s*(?:-|–|—|to)\\s*" + ING_NUM + ")?)\\s*", "i");
const ING_UNIT_RE = /^(fl\s*oz|oz|lbs?|pounds?|grams?|g|kilograms?|kg|cups?|tbsps?|tablespoons?|tsps?|teaspoons?|milliliters?|ml|liters?|litres?|l|pints?|pt|quarts?|qt|gallons?|gal|pkgs?|packages?|bags?|cans?|jars?|bottles?|boxe?s?|bunch(?:es)?|heads?|cloves?|slices?|pieces?|stalks?|sprigs?|ribs?|sticks?|balls?|ct|count|small|medium|large|pinch(?:es)?|dash(?:es)?|handfuls?)\b\.?\s*/i;
function parseIngredientLine(str) {
  str = (str || "").trim();
  if (!str) return { qty: "", unit: "", name: "" };
  // Strip a leading list marker (bullet, or "- " dash-space) but NOT a "-2"
  // range fragment - the marker must be followed by whitespace.
  str = str.replace(/^\s*[-•●▪▸*·]\s+/, "").trim();
  let qty = "", unit = "", rest = str;
  const qm = str.match(ING_QTY_RE);
  if (qm) {
    qty = qm[1].replace(/\s*(?:-|–|—)\s*|\s+to\s+/i, "-").replace(/\s+/g, " ").trim();
    rest = str.slice(qm[0].length);
    // A parenthetical amount right after the quantity is a secondary measure
    // ("1 (14.5 oz) can", "2 (15 oz) cans") - drop it so the real unit after
    // it is recognized instead of the "(" blocking the unit match.
    rest = rest.replace(/^\s*\([^)]*\)\s*/, "");
    const um = rest.match(ING_UNIT_RE);
    if (um) { unit = um[1].replace(/\s+/g, " ").trim(); rest = rest.slice(um[0].length); }
    // And a parenthetical between the unit and the name ("2 cups (240g) flour")
    // - the metric weight sites like King Arthur put beside the volume.
    rest = rest.replace(/^\s*\([^)]*\)\s*/, "");
  }
  rest = rest.replace(/^of\s+/i, "").replace(/^[,.\s]+/, "").trim();
  return { qty, unit, name: rest || str };
}

function extractInstructions(ri) {
  if (!ri) return "";
  const steps = [];
  function walk(item) {
    if (!item) return;
    if (typeof item === "string") {
      steps.push(item);
    } else if (item["@type"] === "HowToSection" && item.itemListElement) {
      const list = Array.isArray(item.itemListElement) ? item.itemListElement : [item.itemListElement];
      list.forEach(walk);
    } else if (item.text) {
      steps.push(item.text);
    }
  }
  (Array.isArray(ri) ? ri : [ri]).forEach(walk);
  const cleaned = steps
    .map(s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return cleaned.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

function extractJsonLdImage(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return extractJsonLdImage(img[0]);
  if (img.url) return img.url;
  return "";
}

function classifyRecipeType(recipe) {
  const keywords = Array.isArray(recipe.keywords) ? recipe.keywords.join(" ") : (recipe.keywords || "");
  const text = [recipe.name, recipe.recipeCategory, keywords, recipe.recipeCuisine].filter(Boolean).join(" ").toLowerCase();
  const checks = [
    { type: "seafood", kws: ["salmon", "shrimp", "fish", "seafood", "crab", "scallop", "tuna", "tilapia", "cod"] },
    { type: "beef", kws: ["beef", "steak", "burger", "brisket"] },
    { type: "pork", kws: ["pork", "bacon", "ham", "sausage"] },
    { type: "chicken", kws: ["chicken", "poultry"] },
    { type: "pasta", kws: ["pasta", "spaghetti", "noodle", "lasagna"] },
    { type: "mexican", kws: ["mexican", "taco", "burrito", "enchilada", "quesadilla"] },
    { type: "asian", kws: ["asian", "chinese", "thai", "japanese", "stir fry", "stir-fry", "sushi", "curry"] },
    { type: "soup", kws: ["soup", "stew", "chili"] },
    { type: "salad", kws: ["salad"] },
    { type: "breakfast", kws: ["breakfast", "brunch", "pancake", "waffle", "omelet"] },
    { type: "dessert", kws: ["dessert", "cake", "cookie", "pie", "brownie", "sweet"] },
    { type: "vegetarian", kws: ["vegetarian", "vegan", "plant-based", "meatless"] },
    // Bare short spirit names ("gin", "rum") are deliberately excluded - "gin"
    // is a substring of "original" and "rum" of "drumstick", neither of
    // which has anything to do with cocktails.
    { type: "cocktails", kws: ["cocktail", "margarita", "martini", "mojito", "daiquiri", "mimosa", "sangria", "old fashioned", "whiskey sour", "spritz", "negroni", "bourbon", "tequila", "vodka"] },
    { type: "drinks", kws: ["smoothie", "lemonade", "mocktail", "iced tea", "punch", "milkshake", "juice", "hot chocolate", "cider"] }
  ];
  for (const c of checks) {
    if (c.kws.some(k => text.includes(k))) return c.type;
  }
  return "other";
}

// Converts a raw schema.org Recipe object into this app's recipe shape.
// Returns null if the JSON-LD is missing the fields we actually need
// (name + at least one ingredient), so the caller can fall back to AI
// extraction rather than returning a half-empty recipe.
function jsonLdToAppRecipe(recipe, fallbackPhotoUrl) {
  const name = (recipe.name || "").trim();
  const rawIngredients = Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient
    : Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  if (!name || rawIngredients.length === 0) return null;

  const time = isoDurationToReadable(recipe.totalTime)
    || [isoDurationToReadable(recipe.prepTime), isoDurationToReadable(recipe.cookTime)].filter(Boolean).join(" prep + ")
    || isoDurationToReadable(recipe.cookTime);

  return {
    name,
    time: time || "",
    ingredients: rawIngredients.map(parseIngredientLine),
    notes: extractInstructions(recipe.recipeInstructions),
    recipeType: classifyRecipeType(recipe),
    photo: extractJsonLdImage(recipe.image) || fallbackPhotoUrl || ""
  };
}

// Import from URL - fetch the page directly then use AI to extract
async function importFromUrl(url, apiKey, meter) {
  // First, try to fetch the URL directly
  let pageContent = "";
  let photoUrl = "";

  try {
    const pageResponse = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RecipeBot/1.0)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (pageResponse.ok) {
      const html = await pageResponse.text();

      // Try the site's own structured recipe data first (JSON-LD Recipe
      // schema, used by nearly every recipe site for Google rich results).
      // When present and complete, this needs no AI call at all.
      const ldRecipe = extractJsonLdRecipe(html);
      if (ldRecipe) {
        const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
        const appRecipe = jsonLdToAppRecipe(ldRecipe, ogImageMatch ? ogImageMatch[1] : "");
        if (appRecipe) return appRecipe;
      }

      // Extract text content (strip HTML tags but keep structure)
      pageContent = html
        // Remove script and style content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        // Convert common elements to preserve structure
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<\/h[1-6]>/gi, "\n\n")
        // Remove remaining HTML tags
        .replace(/<[^>]+>/g, " ")
        // Clean up whitespace
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#\d+;/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Try to extract og:image or main recipe image
      const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      if (ogImageMatch) {
        photoUrl = ogImageMatch[1];
      } else {
        // Try to find a recipe image
        const imgMatch = html.match(/<img[^>]*class=["'][^"']*recipe[^"']*["'][^>]*src=["']([^"']+)["']/i);
        if (imgMatch) {
          photoUrl = imgMatch[1];
        }
      }

      // Limit content length
      if (pageContent.length > 15000) {
        pageContent = pageContent.substring(0, 15000);
      }

      // If the fetch succeeded but returned almost no real text, this is
      // very likely a JS-rendered page whose content hadn't loaded yet in
      // the server-side response (just an empty shell). Treat it the same
      // as a failed fetch so we fall back to the AI's own web search
      // instead of quietly asking it to extract a recipe from a page that
      // has none of the actual content - a class of failure that
      // otherwise happens silently with no error and no useful log.
      if (pageContent.length < 500) {
        console.log("Page content suspiciously short (" + pageContent.length + " chars) - likely JS-rendered, falling back to web search");
        pageContent = "";
      }
    }
  } catch (fetchError) {
    // If direct fetch fails, we'll rely on web search
    console.log("Direct fetch failed:", fetchError.message);
  }

  // Build the prompt
  let prompt;
  if (pageContent) {
    prompt = `Extract the recipe from this webpage content. The URL is: ${url}

WEBPAGE CONTENT:
${pageContent}

Return ONLY valid JSON with no other text:
{
  "name": "Recipe Name",
  "time": "30 min",
  "ingredients": [{"qty": "2", "unit": "cup", "name": "flour"}],
  "notes": "1. First step\\n2. Second step\\n3. Third step",
  "recipeType": "other",
  "photo": "${photoUrl || ""}"
}

IMPORTANT: The "name" field should ONLY contain the recipe title (e.g. "Crockpot Italian Sausage Pasta"), NOT cooking times or instructions.
Put ALL cooking time info in the "time" field (e.g. "LOW 6 hours or HIGH 3.5-4 hours").
Valid recipeType: chicken, beef, pork, seafood, pasta, mexican, asian, soup, salad, vegetarian, breakfast, dessert, drinks, cocktails, other
Format the notes as NUMBERED STEPS (1. 2. 3.) each on its own line.
For photo, use the provided photo URL if available, or extract from the content if found.`;
  } else {
    // Fallback to web search if direct fetch failed
    prompt = `Search for and extract the recipe from this URL: ${url}

Return ONLY valid JSON with no other text:
{
  "name": "Recipe Name",
  "time": "30 min",
  "ingredients": [{"qty": "2", "unit": "cup", "name": "flour"}],
  "notes": "1. First step\\n2. Second step\\n3. Third step",
  "recipeType": "other",
  "photo": "https://example.com/photo.jpg"
}

IMPORTANT: The "name" field should ONLY contain the recipe title (e.g. "Crockpot Italian Sausage Pasta"), NOT cooking times or instructions.
Put ALL cooking time info in the "time" field (e.g. "LOW 6 hours or HIGH 3.5-4 hours").
Valid recipeType: chicken, beef, pork, seafood, pasta, mexican, asian, soup, salad, vegetarian, breakfast, dessert, drinks, cocktails, other
Format the notes as NUMBERED STEPS (1. 2. 3.) each on its own line.
For photo, include the main recipe image URL if found.`;
  }

  const requestBody = {
    model: "claude-sonnet-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }]
  };

  // Only add web search tool if we didn't get page content
  if (!pageContent) {
    requestBody.tools = [{
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 3
    }];
  }

  const data = await callAnthropic(requestBody, apiKey, meter);

  // Find the text response
  const textBlock = data.content?.find(b => b.type === "text");
  const text = textBlock?.text || "";

  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Could not extract recipe from URL");
  }
  return parsed;
}

// Import from PDF
async function importFromPdf(imageData, mimeType, apiKey, meter) {
  const data = await callAnthropic({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: mimeType || "application/pdf",
            data: imageData
          }
        },
        {
          type: "text",
          text: `Extract the recipe from this PDF. Return ONLY valid JSON with no other text:
{
  "name": "Recipe Name",
  "time": "30 min",
  "ingredients": [{"qty": "2", "unit": "cup", "name": "flour"}],
  "notes": "1. First step\\n2. Second step\\n3. Third step",
  "recipeType": "other"
}

Format the notes as NUMBERED STEPS (1. 2. 3.) each on its own line.
Valid recipeType: chicken, beef, pork, seafood, pasta, mexican, asian, soup, salad, vegetarian, breakfast, dessert, drinks, cocktails, other`
        }
      ]
    }]
  }, apiKey, meter);

  const text = data.content?.find(b => b.type === "text")?.text || "";
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Could not extract recipe from PDF");
  }
  return parsed;
}

// Parse recipe from pasted text
async function parseRecipeText(text, apiKey, meter) {
  if (!text || !text.trim()) {
    throw new Error("No text provided");
  }

  const prompt = `Parse this recipe text and extract the structured data. The text may contain the recipe name, ingredients, instructions, cooking time, and other details mixed together.

TEXT TO PARSE:
${text}

Return ONLY valid JSON with no other text:
{
  "name": "Recipe Name",
  "time": "30 min",
  "ingredients": [{"qty": "2", "unit": "cup", "name": "flour"}],
  "notes": "1. First step here\\n2. Second step here\\n3. Third step here",
  "recipeType": "other",
  "credit": "source if mentioned"
}

Important:
- The "name" field should ONLY contain the recipe title (e.g. "Crockpot Italian Sausage Pasta"), NOT cooking times or instructions
- Put ALL cooking time info in the "time" field (e.g. "LOW 6 hours or HIGH 3.5-4 hours, plus 25-35 min for pasta")
- Parse each ingredient into qty, unit, and name
- For the "notes" field, format instructions as NUMBERED STEPS (1. 2. 3. etc), each on its own line separated by \\n
- Valid recipeType: chicken, beef, pork, seafood, pasta, mexican, asian, soup, salad, vegetarian, breakfast, dessert, drinks, cocktails, other
- If a source/credit is mentioned, include it`;

  const data = await callAnthropic({
    model: "claude-sonnet-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }]
  }, apiKey, meter);

  const responseText = data.content?.find(b => b.type === "text")?.text || "";
  const parsed = extractJsonObject(responseText);
  if (!parsed) {
    throw new Error("Could not parse recipe from text");
  }
  return parsed;
}

// Recipe-idea brainstorming chat
async function chefChat(messages, apiKey, meter) {
  if (!messages || messages.length === 0) {
    throw new Error("No messages provided");
  }

  const systemPrompt = `You are a warm, concise recipe-brainstorming assistant inside a home meal-planning app called The Family Table.

The user will tell you what ingredients they have on hand (fridge/pantry), or describe a mood or craving. Suggest 2-4 specific, realistic recipe ideas, each as a short bolded name followed by a one-sentence description. Keep the whole reply brief - this is a quick back-and-forth, not an essay.

If the user asks for more detail on a specific idea (e.g. "tell me more about the second one" or "how do I make that"), respond with ONE full recipe for that dish: the name, total time, a complete ingredient list with quantities, and numbered steps. This detailed reply should be self-contained enough that someone could cook from it without seeing the rest of the conversation.

Keep tone practical and friendly. No long preambles, no markdown headers, no emoji spam - the app already has its own visual style.`;

  const anthropicMessages = messages.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text
  }));

  const data = await callAnthropic({
    model: "claude-sonnet-5",
    max_tokens: 1200,
    system: systemPrompt,
    messages: anthropicMessages
  }, apiKey, meter);

  const text = data.content?.find(b => b.type === "text")?.text || "";
  if (!text.trim()) {
    throw new Error("No reply from assistant");
  }

  return text.trim();
}

// Ingredient substitution suggestions for one ingredient, optionally in the
// context of a recipe. The caller may not know the exact ingredient name
// (e.g. a free-typed chat request like "replace the butter in my cookies")
// - the model matches `request` against the recipe's ingredients and reports
// back which one it picked, so the app can apply the swap precisely. When no
// recipe context is given at all (ingredients/recipeText both absent), this
// falls back to a standalone-ingredient prompt for requests like "what can I
// use instead of buttermilk" that aren't tied to any saved recipe.
async function ingredientSwap(recipeName, ingredients, recipeText, request, apiKey, meter) {
  if (!request || !request.trim()) {
    throw new Error("No request provided");
  }

  const ingredientsList = ingredients && ingredients.length
    ? ingredients.map(i => "- " + [i.qty, i.unit, i.name].filter(Boolean).join(" ")).join("\n")
    : null;
  const hasRecipeContext = !!(ingredientsList || (recipeText && recipeText.trim()));

  const prompt = hasRecipeContext ? `A user is looking at this recipe and wants an ingredient substitution.

${ingredientsList ? `Recipe: ${recipeName || "Untitled"}\nIngredients:\n${ingredientsList}` : `Recipe: ${recipeName || "Untitled"}\nRecipe text:\n${recipeText}`}

Their request: "${request}"

Figure out which single ingredient from the recipe above they mean, even if their wording doesn't exactly match it, then suggest 2-3 good substitutes for it. Each suggestion needs a short, practical note (ratio adjustments, flavor or texture differences, etc). If you can't confidently tell which ingredient they mean (e.g. nothing in the recipe matches their request), set "success" to false and put a short friendly clarifying question in "message" - leave "original" and "suggestions" empty in that case.

Return ONLY this JSON object with no other text, no markdown code fences, and no explanation before or after it:
{"success":true,"original":"the exact ingredient name as it appears in the recipe (empty string if success is false)","suggestions":[{"substitute":"name","note":"short practical note"}],"message":"only used when success is false"}` : `A user wants an ingredient substitution suggestion. This request is NOT tied to any specific recipe.

Their request: "${request}"

Identify the single ingredient they're asking about - it may be named directly ("substitute for buttermilk") or embedded in a longer question - then suggest 2-3 good general-purpose substitutes for it. Each suggestion needs a short, practical note (ratio adjustments, flavor or texture differences, etc). If the request isn't actually about substituting an ingredient, set "success" to false and put a short friendly clarifying question in "message" - leave "original" and "suggestions" empty in that case.

Return ONLY this JSON object with no other text, no markdown code fences, and no explanation before or after it:
{"success":true,"original":"the ingredient name you identified (empty string if success is false)","suggestions":[{"substitute":"name","note":"short practical note"}],"message":"only used when success is false"}`;

  const data2 = await callAnthropic({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }]
  }, apiKey, meter);

  const replyText = data2.content?.find(b => b.type === "text")?.text || "";
  const parsed = extractJsonObject(replyText);
  if (!parsed) {
    throw new Error("Could not get substitution suggestions" + (replyText ? (": " + replyText.slice(0, 200)) : " (empty response)"));
  }
  return parsed;
}
