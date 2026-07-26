import Parser from "rss-parser";

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

const POSITIVE_WORDS = [
  "surge", "soar", "rally", "gain", "gains", "jump", "jumps", "beat", "beats", "record", "high", "highs",
  "upgrade", "upgraded", "bullish", "growth", "strong", "outperform", "rebound", "recover", "recovery",
  "optimism", "boost", "rise", "rises", "rising", "climb", "climbs", "profit", "profits", "exceeds",
];
const NEGATIVE_WORDS = [
  "plunge", "plunges", "crash", "crashes", "slump", "tumble", "tumbles", "fall", "falls", "falling",
  "drop", "drops", "miss", "misses", "downgrade", "downgraded", "bearish", "recession", "weak", "weakness",
  "underperform", "selloff", "sell-off", "fear", "fears", "warning", "warns", "cut", "cuts", "layoff",
  "layoffs", "inflation", "default", "bankruptcy", "loss", "losses", "decline", "declines", "volatile", "volatility",
];

function scoreSentiment(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) if (lower.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (lower.includes(w)) score -= 1;
  if (score > 1) return { sentiment: "positive", score };
  if (score < -1) return { sentiment: "negative", score };
  return { sentiment: "neutral", score };
}

const RELEVANT_TERMS = [
  "qqq", "nasdaq", "s&p", "stock", "stocks", "market", "markets", "fed", "federal reserve",
  "rate", "rates", "inflation", "earnings", "tech", "technology", "apple", "microsoft", "nvidia",
  "amazon", "google", "alphabet", "meta", "tesla", "treasury", "yield", "economy", "gdp", "jobs report",
];

function isMarketRelevant(text) {
  const lower = text.toLowerCase();
  return RELEVANT_TERMS.some((t) => lower.includes(t));
}

let cache = { items: [], fetchedAt: null };
let inflight = null;

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 15).map((item) => {
      const text = `${item.title || ""} ${item.contentSnippet || ""}`;
      const { sentiment, score } = scoreSentiment(text);
      return {
        source: feed.source,
        title: item.title || "(untitled)",
        link: item.link,
        publishedAt: item.isoDate || item.pubDate || null,
        summary: (item.contentSnippet || "").slice(0, 240),
        sentiment,
        sentimentScore: score,
        relevant: isMarketRelevant(text),
      };
    });
  } catch {
    return [];
  }
}

export async function getNews({ forceRefresh = false } = {}) {
  const ageMs = cache.fetchedAt ? Date.now() - new Date(cache.fetchedAt).getTime() : Infinity;
  if (!forceRefresh && ageMs < 3 * 60 * 1000 && cache.items.length) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const results = await Promise.all(FEEDS.map(fetchFeed));
    const all = results.flat();
    all.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    const relevant = all.filter((a) => a.relevant);
    const pool = relevant.length >= 5 ? relevant : all;
    const posCount = pool.filter((a) => a.sentiment === "positive").length;
    const negCount = pool.filter((a) => a.sentiment === "negative").length;
    const total = pool.length || 1;
    const netSentimentScore = Number((((posCount - negCount) / total) * 100).toFixed(1));
    const overallSentiment = netSentimentScore > 10 ? "bullish" : netSentimentScore < -10 ? "bearish" : "neutral";

    cache = {
      items: all.slice(0, 60),
      relevantItems: relevant.slice(0, 30),
      overall: { sentiment: overallSentiment, score: netSentimentScore, positive: posCount, negative: negCount, sampleSize: pool.length },
      fetchedAt: new Date().toISOString(),
    };
    return cache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
