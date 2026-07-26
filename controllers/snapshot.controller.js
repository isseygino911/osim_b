import { readSnapshot, readSnapshotRaw, writeSnapshot } from "../models/snapshot.model.js";
import { assessChain, DEFAULT_RISK_FREE_RATE, enrichSnapshot } from "../services/greeks.service.js";
import { computeIndicators } from "../services/indicators.service.js";
import { getNews } from "../services/news.service.js";
import { computeSignal, previewPicks, RISK } from "../services/strategy.service.js";

// Serves whatever Robinhood data was last written to data/snapshot.json.
// That file is produced out-of-band by Claude (which holds the authenticated
// Robinhood MCP connection) — this server never talks to Robinhood or Anthropic itself.
export async function getSnapshot(_req, res) {
  try {
    const raw = await readSnapshotRaw();
    res.type("application/json").send(raw);
  } catch (e) {
    if (e.code === "ENOENT") {
      return res.status(404).json({ error: "No snapshot yet — ask Claude to refresh QQQ data." });
    }
    res.status(500).json({ error: e.message });
  }
}

// Lets Claude (or any trusted local process) push a freshly-fetched snapshot.
export async function postSnapshot(req, res) {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }
  try {
    await writeSnapshot({ ...body, fetchedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Technical indicators computed from whatever snapshot is currently on disk.
export async function getIndicators(_req, res) {
  try {
    const snap = await readSnapshot();
    res.json(computeIndicators(snap.candles || []));
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: "No snapshot yet." });
    res.status(500).json({ error: e.message });
  }
}

// Combined technical + news trading signal (does not place any trade).
// The snapshot is greek-enriched first so options conditions can dampen the score.
export async function getSignal(_req, res) {
  try {
    const snap = enrichSnapshot(await readSnapshot());
    const news = await getNews().catch(() => null);
    res.json(computeSignal(snap, news));
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: "No snapshot yet." });
    res.status(500).json({ error: e.message });
  }
}

// Greek-enriched chains plus a per-expiration quality summary. Enrichment is derived
// per request — the on-disk snapshot keeps only what Robinhood actually returned.
export async function getGreeks(_req, res) {
  try {
    const enriched = enrichSnapshot(await readSnapshot());
    const spot = enriched.underlying?.price;
    const summary = {};
    for (const [expiration, chain] of Object.entries(enriched.chains ?? {})) {
      summary[expiration] = assessChain(chain, spot, { minOpenInterest: RISK.minOpenInterest });
    }
    res.json({
      schemaVersion: enriched.schemaVersion ?? 1,
      riskFreeRate: enriched.riskFreeRate ?? DEFAULT_RISK_FREE_RATE,
      underlying: enriched.underlying ?? null,
      chains: enriched.chains ?? {},
      summary,
      preview: previewPicks(enriched),
      fetchedAt: enriched.fetchedAt ?? null,
    });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: "No snapshot yet." });
    res.status(500).json({ error: e.message });
  }
}
