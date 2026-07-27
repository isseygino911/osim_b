import { clearRefreshState, listRefreshStatuses, readRefreshStatus, writeRefreshStatus } from "../models/refresh.model.js";
import { listSnapshotSymbols, writeSnapshot } from "../models/snapshot.model.js";
import { isTradierConfigured, fetchSnapshot as fetchTradierSnapshot } from "./tradier.service.js";

const COOLDOWN_MS = 15_000; // after a completed/errored run, block re-requests for this long
const AUTO_REFRESH_INTERVAL_MS = 3 * 60 * 1000; // Tradier's real-time-for-account-holders data supports a
// tight loop — 3min keeps every symbol within "a few minutes delay, not overnight" without
// leaning on the rate limit (120 req/min prod; a full refresh is well under that per symbol).
let autoRefreshTimer = null;

// Runs the direct Tradier fetch in-process and writes the resulting snapshot straight
// to disk. Fire-and-forget from requestRefresh's point of view — the client polls
// GET /api/refresh/status for the terminal done/error state.
async function runTradierRefresh(symbol) {
  try {
    const snapshot = await fetchTradierSnapshot(symbol);
    await writeSnapshot(symbol, { ...snapshot, fetchedAt: new Date().toISOString() });
    await writeRefreshStatus(symbol, {
      symbol,
      status: "done",
      message: `Snapshot updated: ${symbol} $${snapshot.underlying?.price}`,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    await writeRefreshStatus(symbol, {
      symbol,
      status: "error",
      message: e.message,
      updatedAt: new Date().toISOString(),
    });
  }
}

// Drives the "Go" refresh: fetches directly from Tradier in-process (a few seconds).
// Refuses to re-trigger while a run is in flight or still inside its cooldown window.
export async function requestRefresh(symbol) {
  if (!isTradierConfigured()) {
    throw new Error("TRADIER_API_KEY is not set — cannot refresh. Add it to server/.env and restart the server.");
  }
  const existing = await readRefreshStatus(symbol);
  if (existing) {
    if (existing.status === "running") {
      return { ok: false, conflict: true, status: existing };
    }
    const elapsed = Date.now() - new Date(existing.updatedAt).getTime();
    if (elapsed < COOLDOWN_MS) {
      return { ok: false, conflict: true, status: existing, retryAfterMs: COOLDOWN_MS - elapsed };
    }
  }
  const now = new Date().toISOString();
  const status = { symbol, status: "running", message: "Fetching from Tradier…", updatedAt: now };
  await writeRefreshStatus(symbol, status);
  runTradierRefresh(symbol); // intentionally not awaited — client polls status
  return { ok: true, status };
}

// Every symbol currently running a refresh — powers the client's "what's running" list.
export async function listActiveRefreshes() {
  const all = await listRefreshStatuses();
  return all.filter((s) => s.status === "running");
}

// Unconditionally clears a symbol's refresh tracking (e.g. the snapshot-reset button).
export async function clearRefresh(symbol) {
  await clearRefreshState(symbol);
  return { ok: true };
}

// Keeps every symbol that already has a snapshot fresh on a fixed interval, without
// waiting for anyone to click "Go".
async function autoRefreshTick() {
  for (const symbol of await listSnapshotSymbols()) {
    const existing = await readRefreshStatus(symbol);
    if (existing?.status === "running") continue;
    runTradierRefresh(symbol).catch((e) => console.error(`[refresh] auto-refresh error (${symbol}):`, e.message));
  }
}

// Paused: background auto-refresh was burning too many Tradier calls (every symbol
// with a snapshot got refetched every 3min, regardless of whether anyone was still
// looking at it or autopilot was trading it). AUTO_REFRESH_ENABLED gates the timer;
// autoRefreshTick/AUTO_REFRESH_INTERVAL_MS/autoRefreshTimer are left wired up so
// flipping this back to true is the only change needed to re-enable the loop.
const AUTO_REFRESH_ENABLED = false;

export function initAutoRefresh() {
  if (!AUTO_REFRESH_ENABLED) {
    console.log("[refresh] Tradier auto-refresh loop is paused — use manual refresh instead.");
    return;
  }
  if (!isTradierConfigured()) return;
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    autoRefreshTick().catch((e) => console.error("[refresh] auto-refresh loop error:", e.message));
  }, AUTO_REFRESH_INTERVAL_MS);
  console.log(`[refresh] Tradier auto-refresh loop started (every ${AUTO_REFRESH_INTERVAL_MS / 1000}s).`);
}

export async function getStatus(symbol) {
  const existing = await readRefreshStatus(symbol);
  return existing ?? { symbol, status: "idle", message: "", updatedAt: null };
}
