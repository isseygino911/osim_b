import { clearRefresh, getStatus, listActiveRefreshes, requestRefresh } from "../services/refresh.service.js";
import { resolveSymbol } from "../services/symbol.service.js";

// "Go" in the client calls this — fetches directly from Tradier in-process.
export async function postRefreshRequest(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    const result = await requestRefresh(symbol);
    if (!result.ok) {
      return res.status(409).json({ error: "A refresh is already in progress or on cooldown for this symbol", status: result.status, retryAfterMs: result.retryAfterMs ?? null });
    }
    res.json(result.status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Clears a symbol's refresh tracking — used by "Reset snapshot" so a stale banner
// doesn't linger, and by the "what's running" list's X button.
export async function deleteRefreshRequest(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    await clearRefresh(symbol);
    res.json({ ok: true, symbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// The client's refresh indicator polls this while status is running.
export async function getRefreshStatus(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await getStatus(symbol));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Every symbol currently running a refresh — powers the client's "what's running" list.
export async function getAllRefreshes(_req, res) {
  try {
    res.json({ refreshes: await listActiveRefreshes() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
