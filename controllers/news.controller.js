import { readSnapshot } from "../models/snapshot.model.js";
import * as articleAI from "../services/articleAI.service.js";
import * as newsService from "../services/news.service.js";
import { resolveSymbol } from "../services/symbol.service.js";

// Real-time-ish news aggregated from public RSS feeds of major financial outlets,
// scored against the requested symbol. Works even before a snapshot exists —
// the company name (better keyword matching) just comes in once Claude POSTs one.
export async function getNews(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    const name = await readSnapshot(symbol).then((s) => s.underlying?.name ?? null).catch(() => null);
    const news = await newsService.getNews({ symbol, name, forceRefresh: req.query.refresh === "1" });
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// On-demand full-article deep dive for one headline — fetches the article page,
// extracts key points, and explains why it's bullish/bearish. The client already
// has title/summary from the /api/news batch response, so it passes them through
// rather than the server re-deriving them from the link.
export async function getNewsDetail(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  const { link, title, summary } = req.query;
  if (!link || !title) return res.status(400).json({ error: "link and title are required" });
  if (!articleAI.isEnabled()) return res.status(503).json({ error: "Gemini analysis is not configured" });
  try {
    const name = await readSnapshot(symbol).then((s) => s.underlying?.name ?? null).catch(() => null);
    const result = await articleAI.analyzeArticle({ link, title, summary, symbol, name });
    if (!result) return res.status(502).json({ error: "Could not analyze this article" });
    res.json({ link, title, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
