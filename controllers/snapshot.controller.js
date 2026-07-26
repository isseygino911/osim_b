import { clearRefreshState } from "../models/refresh.model.js";
import { deleteSnapshot, readSnapshot, readSnapshotRaw, writeSnapshot } from "../models/snapshot.model.js";
import { assessChain, DEFAULT_RISK_FREE_RATE, enrichSnapshot } from "../services/greeks.service.js";
import { candlesFor, computeIndicators } from "../services/indicators.service.js";
import { getIvStats, recordIvSample } from "../services/ivRank.service.js";
import { getNews } from "../services/news.service.js";
import { computeSignal, previewPicks, RISK } from "../services/strategy.service.js";
import { normalizeSymbol, resolveSymbol } from "../services/symbol.service.js";

// Serves whatever Robinhood data was last written for the symbol (explicit
// ?symbol= or the active one). That file is produced out-of-band by Claude
// (which holds the authenticated Robinhood MCP connection) — this server never
// talks to Robinhood or Anthropic itself.
export async function getSnapshot(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    const raw = await readSnapshotRaw(symbol);
    res.type("application/json").send(raw);
  } catch (e) {
    if (e.code === "ENOENT") {
      return res.status(404).json({ error: `No snapshot for ${symbol} yet — ask Claude to refresh ${symbol} data.` });
    }
    res.status(500).json({ error: e.message });
  }
}

// Lets Claude (or any trusted local process) push a freshly-fetched snapshot.
export async function postSnapshot(req, res) {
  const snapshotToken = process.env.SNAPSHOT_TOKEN;
  if (snapshotToken && req.get("X-Snapshot-Token") !== snapshotToken) {
    return res.status(401).json({ error: "Invalid or missing snapshot token" });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }
  if (!body.underlying || !body.expirations || !body.chains || !body.candles) {
    return res.status(400).json({ error: "Body must include underlying, expirations, chains, and candles" });
  }
  if (body.symbol !== undefined && !normalizeSymbol(body.symbol)) {
    return res.status(400).json({ error: `Invalid body symbol: ${body.symbol}` });
  }
  const bodySymbol = body.symbol !== undefined ? normalizeSymbol(body.symbol) : null;
  const querySymbol = req.query.symbol !== undefined ? normalizeSymbol(req.query.symbol) : null;
  if (req.query.symbol !== undefined && !querySymbol) {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  if (bodySymbol && querySymbol && bodySymbol !== querySymbol) {
    return res.status(400).json({ error: `Body symbol ${bodySymbol} does not match query symbol ${querySymbol}` });
  }
  const symbol = bodySymbol ?? querySymbol ?? (await resolveSymbol(undefined));
  if (!symbol) {
    return res.status(400).json({ error: "No symbol in body/query and no active symbol set — include a symbol." });
  }
  try {
    const stored = { ...body, symbol, fetchedAt: new Date().toISOString() };
    await writeSnapshot(symbol, stored);
    // Best-effort IV-history append for IV Rank/Percentile — never fails the snapshot POST.
    recordIvSample(symbol, stored).catch((e) => console.error("[iv]", e.message));
    res.json({ ok: true, symbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Lets the client wipe a symbol's fetched data (the "Reset snapshot" button) so the
// next refresh starts clean instead of layering onto stale strikes/candles. Also
// clears any stuck refresh-status/request so no dangling banner survives the reset.
export async function deleteSnapshotEndpoint(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    await deleteSnapshot(symbol);
    await clearRefreshState(symbol);
    res.json({ ok: true, symbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Single-expiration chain, enriched with computed greeks/IV, for the client's
// expiration picker. Data still only comes from the on-disk snapshot — a 404 here
// means Claude hasn't fetched that expiration yet, not that the date is invalid.
export async function getChain(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  const expiration = req.query.expiration;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration || "")) {
    return res.status(400).json({ error: "Invalid expiration — expected YYYY-MM-DD" });
  }
  try {
    const enriched = enrichSnapshot(await readSnapshot(symbol));
    const chain = enriched.chains?.[expiration];
    if (!chain) {
      return res.status(404).json({ error: `No chain data for ${symbol} ${expiration} yet — ask Claude to refresh ${symbol} including this expiration.` });
    }
    res.json({
      symbol,
      expiration,
      chain,
      summary: assessChain(chain, enriched.underlying?.price, { minOpenInterest: RISK.minOpenInterest }),
      fetchedAt: enriched.fetchedAt ?? null,
    });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: `No snapshot for ${symbol} yet.` });
    res.status(500).json({ error: e.message });
  }
}

const CANDLE_INTERVALS = ["15m", "30m", "1h", "1d"];

// Technical indicators computed from whatever snapshot is currently on disk.
export async function getIndicators(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  const interval = req.query.interval !== undefined ? req.query.interval : "1d";
  if (!CANDLE_INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `Invalid interval: ${interval}` });
  }
  try {
    const snap = await readSnapshot(symbol);
    const ind = computeIndicators(candlesFor(snap, interval));
    const iv = await getIvStats(symbol).catch(() => null);
    res.json({ ...ind, iv });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: `No snapshot for ${symbol} yet.` });
    res.status(500).json({ error: e.message });
  }
}

// Combined technical + news trading signal (does not place any trade).
// The snapshot is greek-enriched first so options conditions can dampen the score.
export async function getSignal(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    const snap = enrichSnapshot(await readSnapshot(symbol));
    const news = await getNews({ symbol, name: snap.underlying?.name }).catch(() => null);
    res.json(computeSignal(snap, news));
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: `No snapshot for ${symbol} yet.` });
    res.status(500).json({ error: e.message });
  }
}

// Greek-enriched chains plus a per-expiration quality summary. Enrichment is derived
// per request — the on-disk snapshot keeps only what Robinhood actually returned.
export async function getGreeks(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    const enriched = enrichSnapshot(await readSnapshot(symbol));
    const spot = enriched.underlying?.price;
    const summary = {};
    for (const [expiration, chain] of Object.entries(enriched.chains ?? {})) {
      summary[expiration] = assessChain(chain, spot, { minOpenInterest: RISK.minOpenInterest });
    }
    res.json({
      symbol,
      schemaVersion: enriched.schemaVersion ?? 1,
      riskFreeRate: enriched.riskFreeRate ?? DEFAULT_RISK_FREE_RATE,
      underlying: enriched.underlying ?? null,
      chains: enriched.chains ?? {},
      summary,
      preview: previewPicks(enriched),
      fetchedAt: enriched.fetchedAt ?? null,
    });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: `No snapshot for ${symbol} yet.` });
    res.status(500).json({ error: e.message });
  }
}
