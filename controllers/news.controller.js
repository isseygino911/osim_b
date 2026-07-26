import { readSnapshot } from "../models/snapshot.model.js";
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
