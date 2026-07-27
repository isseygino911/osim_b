import Parser from "rss-parser";

import { analyzeItems, getUsage as aiUsage, isEnabled as aiEnabled } from "./newsAI.service.js";
import { compileProfile, RELEVANCE_THRESHOLD, scoreDirection, scoreRelevance } from "./relevance.service.js";

const parser = new Parser({ timeout: 8000 });

// Public, no-key-required RSS feeds from top financial news sources.
const FEEDS = [
  { source: "CNBC Markets", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
  { source: "CNBC Technology", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
  { source: "MarketWatch Top Stories", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { source: "MarketWatch Market Pulse", url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse" },
  { source: "Investing.com", url: "https://www.investing.com/rss/news_25.rss" },
  { source: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { source: "Seeking Alpha Market Currents", url: "https://seekingalpha.com/market_currents.xml" },
];

const RAW_TTL_MS = 10 * 60 * 1000;
const SCORED_CAP = 10;

// The RSS fan-out is symbol-independent, so raw (unscored) items are cached once
// and shared; each symbol then gets its own scored view on top.
let rawCache = { items: [], fetchedAt: null };
let inflight = null;
const scoredCache = new Map(); // symbol → scored news payload (FIFO-capped)

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 15).map((item) => ({
      source: feed.source,
      title: item.title || "(untitled)",
      link: item.link,
      publishedAt: item.isoDate || item.pubDate || null,
      summary: (item.contentSnippet || "").slice(0, 240),
    }));
  } catch {
    return [];
  }
}

async function fetchRawItems({ forceRefresh = false } = {}) {
  const ageMs = rawCache.fetchedAt ? Date.now() - new Date(rawCache.fetchedAt).getTime() : Infinity;
  if (!forceRefresh && ageMs < RAW_TTL_MS && rawCache.items.length) {
    return rawCache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const results = await Promise.all(FEEDS.map(fetchFeed));
    const all = results.flat();
    all.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    rawCache = { items: all, fetchedAt: new Date().toISOString() };
    return rawCache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// Overall market read: each item's direction (normalized to [-1, 1]) weighted by
// how symbol-relevant it is — one high-relevance Fed headline outweighs a flood of
// low-relevance chatter. Range stays -100..100 for computeSignal.
function computeOverall(all) {
  const relevant = all.filter((a) => a.relevant);
  const pool = relevant.length >= 5 ? relevant : all;
  const totalWeight = pool.reduce((sum, a) => sum + a.relevanceScore, 0);
  const weighted = totalWeight === 0
    ? 0
    : (pool.reduce((sum, a) => sum + (a.directionScore / 5) * a.relevanceScore, 0) / totalWeight) * 100;
  const score = Number(weighted.toFixed(1));
  return {
    sentiment: score > 10 ? "bullish" : score < -10 ? "bearish" : "neutral",
    score,
    positive: pool.filter((a) => a.direction === "bullish").length,
    negative: pool.filter((a) => a.direction === "bearish").length,
    sampleSize: pool.length,
  };
}

export async function getNews({ symbol = "QQQ", name = null, forceRefresh = false } = {}) {
  const raw = await fetchRawItems({ forceRefresh });
  const cached = scoredCache.get(symbol);
  if (cached && cached.rawFetchedAt === raw.fetchedAt) {
    return cached;
  }

  const profile = compileProfile(symbol, name);
  const all = raw.items.map((item) => {
    const text = `${item.title} ${item.summary}`;
    const { score: relevanceScore } = scoreRelevance(text, profile);
    const { direction, score: directionScore } = scoreDirection(text);
    return {
      ...item,
      relevanceScore,
      relevant: relevanceScore >= RELEVANCE_THRESHOLD,
      direction,
      directionScore,
      // compat aliases — older readers key on sentiment/sentimentScore
      sentiment: direction,
      sentimentScore: directionScore,
      analysisSource: "heuristic",
      aiReason: null,
    };
  });

  // Gemini overlay, synchronous with a timeout race: keeps items/overall/newsScore
  // consistent within one response. On timeout this refresh serves heuristic values
  // while the uncancelled call keeps filling the per-headline cache for the next one.
  if (aiEnabled()) {
    const timeout = new Promise((resolve) => setTimeout(resolve, 8000, null));
    const aiResults = await Promise.race([analyzeItems(all, { symbol, name }), timeout]).catch(() => null);
    if (aiResults) {
      for (const item of all) {
        const ai = aiResults.get(`${symbol}:${item.link || item.title}`);
        if (!ai) continue;
        item.relevanceScore = ai.relevanceScore;
        item.relevant = ai.relevant && ai.relevanceScore >= RELEVANCE_THRESHOLD;
        item.direction = ai.direction;
        // magnitude 1..3 → ±1.7/±3.3/±5, same scale as the heuristic directionScore
        item.directionScore = ai.direction === "neutral" ? 0 : (ai.direction === "bullish" ? 1 : -1) * Number(((ai.magnitude / 3) * 5).toFixed(1));
        item.sentiment = ai.direction;
        item.sentimentScore = item.directionScore;
        item.analysisSource = "gemini";
        item.aiReason = ai.reason;
      }
    }
  }

  const relevantItems = all
    .filter((a) => a.relevant)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 30);

  const scored = {
    symbol,
    items: all.slice(0, 60),
    relevantItems,
    overall: computeOverall(all),
    analysisMode: aiEnabled() ? "gemini" : "heuristic",
    aiUsage: aiEnabled() ? aiUsage() : null,
    fetchedAt: new Date().toISOString(),
    rawFetchedAt: raw.fetchedAt,
  };
  scoredCache.set(symbol, scored);
  while (scoredCache.size > SCORED_CAP) {
    scoredCache.delete(scoredCache.keys().next().value); // Map is insertion-ordered → FIFO
  }
  return scored;
}
