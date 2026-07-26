import * as newsService from "../services/news.service.js";

// Real-time-ish news aggregated from public RSS feeds of major financial outlets.
export async function getNews(req, res) {
  try {
    const news = await newsService.getNews({ forceRefresh: req.query.refresh === "1" });
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
