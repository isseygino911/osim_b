import { GoogleGenAI, Type } from "@google/genai";

// Optional Gemini analysis layer for news headlines. Key-gated: without
// GEMINI_API_KEY every export degrades gracefully and the heuristic engine in
// relevance.service.js carries the load. Never throws — errors surface as
// console.error and callers just get fewer analyzed items.
//
// "gemini-flash-latest" is Google's rolling alias for the newest flash model;
// pin a known-good default and let GEMINI_MODEL override.
const DEFAULT_MODEL = "gemini-2.5-flash";
const CACHE_CAP = 500;

let client = null;
const aiCache = new Map(); // key: item.link || item.title → analysis result (FIFO-capped)

export function isEnabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function keyOf(item) {
  return item.link || item.title;
}

function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER },
      relevant: { type: Type.BOOLEAN },
      relevanceScore: { type: Type.INTEGER },
      direction: { type: Type.STRING, enum: ["bullish", "bearish", "neutral"] },
      magnitude: { type: Type.INTEGER },
      reason: { type: Type.STRING },
    },
    required: ["id", "relevant", "relevanceScore", "direction", "magnitude", "reason"],
    propertyOrdering: ["id", "relevant", "relevanceScore", "direction", "magnitude", "reason"],
  },
};

// Batch-analyzes headlines: cached results return instantly, unseen ones go to
// Gemini in ONE structured-output call. Returns a Map keyed like the cache.
export async function analyzeItems(items) {
  const out = new Map();
  if (!isEnabled() || !items?.length) return out;

  const uncached = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const hit = aiCache.get(key);
    if (hit) out.set(key, hit);
    else uncached.push(item);
  }
  if (!uncached.length) return out;

  try {
    const res = await getClient().models.generateContent({
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      contents:
        "You score financial headlines for a QQQ (Nasdaq-100 ETF) short-dated options trader.\n" +
        "For EACH numbered item return: relevant (could it move QQQ within days?), relevanceScore 0-100,\n" +
        "direction of likely QQQ price impact (bullish/bearish/neutral), magnitude 1-3, and a reason\n" +
        "under 120 characters.\nItems:\n" +
        uncached.map((it, i) => `${i}. ${it.title} — ${(it.summary || "").slice(0, 200)}`).join("\n"),
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const rows = JSON.parse(res.text);
    for (const row of Array.isArray(rows) ? rows : []) {
      const item = Number.isInteger(row?.id) ? uncached[row.id] : null;
      if (!item || !["bullish", "bearish", "neutral"].includes(row.direction)) continue;
      const result = {
        relevant: Boolean(row.relevant),
        relevanceScore: Math.max(0, Math.min(100, Math.round(row.relevanceScore))),
        direction: row.direction,
        magnitude: Math.max(1, Math.min(3, Math.round(row.magnitude))),
        reason: String(row.reason ?? "").slice(0, 120),
      };
      const key = keyOf(item);
      aiCache.set(key, result);
      out.set(key, result);
    }
    while (aiCache.size > CACHE_CAP) {
      aiCache.delete(aiCache.keys().next().value); // Map is insertion-ordered → FIFO
    }
  } catch (e) {
    console.error("[newsAI] analysis failed, serving heuristic:", e.message);
  }
  return out;
}
