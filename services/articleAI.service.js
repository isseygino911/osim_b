import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { GoogleGenAI, Type } from "@google/genai";

// On-demand, per-article deep dive: fetches the full article page (not just the RSS
// snippet), extracts readable text with Readability, and asks Gemini for key points
// plus a fuller bullish/bearish rationale. Only called when a user opens the news
// detail drawer for one headline — never as part of the /api/news batch scoring.
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const CACHE_CAP = 200;
const FETCH_TIMEOUT_MS = 8000;
const MAX_ARTICLE_CHARS = 6000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let client = null;
const articleCache = new Map(); // key: link → analysis result (FIFO-capped)
const usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };

export function isEnabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function getUsage() {
  return { ...usage, model: process.env.GEMINI_MODEL || DEFAULT_MODEL };
}

function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

// Never throws — a failed fetch/parse just means the caller falls back to the RSS summary.
async function fetchArticleText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent || article.textContent.trim().length < 200) return null;
    return article.textContent.trim();
  } catch {
    return null;
  }
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    direction: { type: Type.STRING, enum: ["bullish", "bearish", "neutral"] },
    magnitude: { type: Type.INTEGER },
    reason: { type: Type.STRING },
  },
  required: ["keyPoints", "direction", "magnitude", "reason"],
  propertyOrdering: ["keyPoints", "direction", "magnitude", "reason"],
};

// Deep-dives one article: full text (falling back to the RSS summary if extraction
// fails) → key points + a fuller bullish/bearish rationale. Cached by link. Returns
// null on any failure (no key, fetch/parse/Gemini error) — never throws.
export async function analyzeArticle({ link, title, summary, symbol = "QQQ", name = null }) {
  if (!isEnabled() || !link) return null;

  const cached = articleCache.get(link);
  if (cached) return cached;

  const articleText = (await fetchArticleText(link)) || summary || "";
  if (!articleText) return null;

  const subject = symbol === "QQQ" ? "QQQ (Nasdaq-100 ETF)" : name ? `${symbol} (${name})` : symbol;
  try {
    const res = await getClient().models.generateContent({
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      contents:
        `You are analyzing one financial news article for a ${subject} short-dated options trader.\n` +
        `Read the article below and return: keyPoints (3-6 short bullet-point facts drawn from the\n` +
        `article body itself, not just a rephrased headline), direction of likely ${symbol} price\n` +
        "impact (bullish/bearish/neutral), magnitude 1-3, and reason (under 400 characters) explaining\n" +
        `WHY those key points make ${symbol} likely to move that way.\n\n` +
        `Headline: ${title}\n\nArticle:\n${articleText.slice(0, MAX_ARTICLE_CHARS)}`,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const meta = res.usageMetadata;
    if (meta) {
      usage.promptTokens += meta.promptTokenCount || 0;
      usage.outputTokens += (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
      usage.totalTokens += meta.totalTokenCount || 0;
      usage.calls += 1;
    }

    const row = JSON.parse(res.text);
    if (!row || !["bullish", "bearish", "neutral"].includes(row.direction)) return null;

    const result = {
      keyPoints: Array.isArray(row.keyPoints) ? row.keyPoints.map((p) => String(p)).slice(0, 6) : [],
      direction: row.direction,
      magnitude: Math.max(1, Math.min(3, Math.round(row.magnitude))),
      reason: String(row.reason ?? "").slice(0, 400),
    };
    articleCache.set(link, result);
    while (articleCache.size > CACHE_CAP) {
      articleCache.delete(articleCache.keys().next().value); // Map is insertion-ordered → FIFO
    }
    return result;
  } catch (e) {
    console.error("[articleAI] analysis failed:", e.message);
    return null;
  }
}
