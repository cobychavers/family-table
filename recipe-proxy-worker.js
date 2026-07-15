export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST required" }), {
        status: 405,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      const body = await request.json();
      const { type } = body;

      if (type === "chef_chat") {
        // Handle recipe-idea chat - returns a plain-text reply, not a structured recipe
        const reply = await chefChat(body.messages, env.ANTHROPIC_API_KEY);
        return new Response(JSON.stringify({ success: true, reply }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      if (type === "ingredient_swap") {
        // Suggest substitutes for one ingredient in a recipe - returns its own
        // {success, original, suggestions} shape, not the {success, recipe} shape below
        const result = await ingredientSwap(body.recipeName, body.ingredients, body.recipeText, body.request, env.ANTHROPIC_API_KEY);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      let recipe;

      if (type === "scan") {
        // Handle image scanning
        recipe = await scanImages(body.images, env.ANTHROPIC_API_KEY);
      } else if (type === "url") {
        // Handle URL import
        recipe = await importFromUrl(body.url, env.ANTHROPIC_API_KEY);
      } else if (type === "pdf") {
        // Handle PDF import
        recipe = await importFromPdf(body.imageData, body.mimeType, env.ANTHROPIC_API_KEY);
      } else if (type === "parse_text") {
        // Handle text parsing
        recipe = await parseRecipeText(body.text, env.ANTHROPIC_API_KEY);
      } else {
        return new Response(JSON.stringify({ error: "Invalid type. Use 'scan', 'url', 'pdf', 'parse_text', 'chef_chat', or 'ingredient_swap'" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(JSON.stringify({ success: true, recipe }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

// Scan images to extract recipe
async function scanImages(images, apiKey) {
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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content }]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "API error");
  }

  const text = data.content?.find(b => b.type === "text")?.text || "";
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Could not extract recipe from image");
  }

  return JSON.parse(jsonMatch[0]);
}

// --- JSON-LD Recipe schema extraction (schema.org) ---
// Most recipe sites embed a <script type="application/ld+json"> block with
// a Recipe object, put there for Google's rich-result snippets. When present
// and complete, this gives perfectly structured data with no AI call needed
// at all - faster, free, and no hallucination risk.

function extractJsonLdRecipe(html) {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      const recipe = findRecipeInJsonLd(data);
      if (recipe) return recipe;
    } catch (e) {
      // Malformed JSON-LD block - skip it and keep looking
    }
  }
  return null;
}

function findRecipeInJsonLd(data) {
  let candidates;
  if (Array.isArray(data)) {
    candidates = data;
  } else if (data && Array.isArray(data["@graph"])) {
    candidates = data["@graph"];
  } else {
    candidates = [data];
  }
  for (const item of candidates) {
    if (!item) continue;
    const type = item["@type"];
    if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) {
      return item;
    }
  }
  return null;
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

// Mirrors the app's own parseIng() regex (index.html) so ingredient lines
// split into {qty, unit, name} the same way whether they came from AI
// extraction or straight off the page's structured data.
function parseIngredientLine(str) {
  str = (str || "").trim();
  if (!str) return { qty: "", unit: "", name: "" };
  const match = str.match(/^([\d.\/\s½¼¾⅓⅔⅛]+)?\s*(ct|oz|lbs|lb|g|kg|cups|cup|tbsp|tsp|teaspoons|teaspoon|tablespoons|tablespoon|ml|pkg|package|bag|cans|can|jars|jar|box|bunch|head|cloves|clove|slices|slice|pieces|piece|stalks|stalk|sprigs|sprig|ribs|rib|small|medium|large|sticks?|pounds?|L)?\b\s*[,.]?\s*(.+)$/i);
  if (match && (match[1] || match[2])) {
    let qty = (match[1] || "").trim();
    let unit = (match[2] || "").trim();
    let name = (match[3] || str).trim();
    if (name.startsWith("of ")) name = name.substring(3);
    return { qty, unit, name };
  }
  return { qty: "", unit: "", name: str };
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
async function importFromUrl(url, apiKey) {
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

  if (data.error) {
    throw new Error(data.error.message || "API error");
  }

  // Find the text response
  const textBlock = data.content?.find(b => b.type === "text");
  const text = textBlock?.text || "";

  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Could not extract recipe from URL");
  }

  return JSON.parse(jsonMatch[0]);
}

// Import from PDF
async function importFromPdf(imageData, mimeType, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
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
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "API error");
  }

  const text = data.content?.find(b => b.type === "text")?.text || "";
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Could not extract recipe from PDF");
  }

  return JSON.parse(jsonMatch[0]);
}

// Parse recipe from pasted text
async function parseRecipeText(text, apiKey) {
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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "API error");
  }

  const responseText = data.content?.find(b => b.type === "text")?.text || "";
  const cleaned = responseText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Could not parse recipe from text");
  }

  return JSON.parse(jsonMatch[0]);
}

// Recipe-idea brainstorming chat
async function chefChat(messages, apiKey) {
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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1200,
      system: systemPrompt,
      messages: anthropicMessages
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "API error");
  }

  const text = data.content?.find(b => b.type === "text")?.text || "";
  if (!text.trim()) {
    throw new Error("No reply from assistant");
  }

  return text.trim();
}

// Ingredient substitution suggestions for one ingredient in a recipe. The
// caller may not know the exact ingredient name (e.g. a free-typed chat
// request like "replace the butter in my cookies") - the model itself
// matches `request` against the recipe's ingredients and reports back which
// one it picked, so the app can apply the swap precisely.
async function ingredientSwap(recipeName, ingredients, recipeText, request, apiKey) {
  if (!request || !request.trim()) {
    throw new Error("No request provided");
  }
  if ((!ingredients || ingredients.length === 0) && (!recipeText || !recipeText.trim())) {
    throw new Error("No recipe context provided");
  }

  const ingredientsList = ingredients && ingredients.length
    ? ingredients.map(i => "- " + [i.qty, i.unit, i.name].filter(Boolean).join(" ")).join("\n")
    : null;

  const recipeContext = ingredientsList
    ? `Recipe: ${recipeName || "Untitled"}\nIngredients:\n${ingredientsList}`
    : `Recipe: ${recipeName || "Untitled"}\nRecipe text:\n${recipeText}`;

  const prompt = `A user is looking at this recipe and wants an ingredient substitution.

${recipeContext}

Their request: "${request}"

Figure out which single ingredient from the recipe above they mean, even if their wording doesn't exactly match it, then suggest 2-3 good substitutes for it. Each suggestion needs a short, practical note (ratio adjustments, flavor or texture differences, etc). If you can't confidently tell which ingredient they mean (e.g. nothing in the recipe matches their request), set "success" to false and put a short friendly clarifying question in "message" - leave "original" and "suggestions" empty in that case.

Return ONLY this JSON object with no other text, no markdown code fences, and no explanation before or after it:
{"success":true,"original":"the exact ingredient name as it appears in the recipe (empty string if success is false)","suggestions":[{"substitute":"name","note":"short practical note"}],"message":"only used when success is false"}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data2 = await response.json();

  if (data2.error) {
    throw new Error(data2.error.message || "API error");
  }

  const replyText = data2.content?.find(b => b.type === "text")?.text || "";
  const cleaned = replyText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Could not get substitution suggestions" + (replyText ? (": " + replyText.slice(0, 200)) : " (empty response)"));
  }

  return JSON.parse(jsonMatch[0]);
}
