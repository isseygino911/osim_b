import { getStatus, recordProgress, requestRefresh } from "../services/refresh.service.js";
import { normalizeSymbol, resolveSymbol } from "../services/symbol.service.js";

// "Go" in the client calls this — writes the trigger file the launchd watcher picks
// up and seeds a "pending" status for the client to start polling immediately.
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

// Called by the headless refresh-snapshot run (never by the browser) — gated behind
// the same SNAPSHOT_TOKEN as POST /api/snapshot since it's the same local-trusted-process
// trust boundary.
export async function postRefreshProgress(req, res) {
  const snapshotToken = process.env.SNAPSHOT_TOKEN;
  if (snapshotToken && req.get("X-Snapshot-Token") !== snapshotToken) {
    return res.status(401).json({ error: "Invalid or missing snapshot token" });
  }
  const symbol = normalizeSymbol(req.body?.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid or missing symbol" });
  const { status, step, totalSteps, message, error } = req.body ?? {};
  try {
    const next = await recordProgress(symbol, { status, step, totalSteps, message, error });
    res.json(next);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// The client's loading screen polls this while status is pending/running.
export async function getRefreshStatus(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await getStatus(symbol));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
