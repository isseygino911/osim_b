import { readRefreshStatus, writeRefreshRequest, writeRefreshStatus } from "../models/refresh.model.js";

export const TOTAL_REFRESH_STEPS = 6;
const COOLDOWN_MS = 15_000; // after a completed/errored run, block re-requests for this long

// Drives the launchd-triggered "Go" refresh: writes the trigger file the watcher
// listens for, then seeds a "pending" status the client polls via GET /api/refresh/status.
// Refuses to re-trigger while a run is in flight or still inside its cooldown window,
// since each request costs a real headless Claude + Robinhood round-trip.
export async function requestRefresh(symbol) {
  const existing = await readRefreshStatus(symbol);
  if (existing) {
    if (existing.status === "pending" || existing.status === "running") {
      return { ok: false, conflict: true, status: existing };
    }
    const elapsed = Date.now() - new Date(existing.updatedAt).getTime();
    if (elapsed < COOLDOWN_MS) {
      return { ok: false, conflict: true, status: existing, retryAfterMs: COOLDOWN_MS - elapsed };
    }
  }
  const now = new Date().toISOString();
  const status = {
    symbol,
    status: "pending",
    step: 0,
    totalSteps: TOTAL_REFRESH_STEPS,
    message: "Refresh requested — waiting for the local watcher to pick it up…",
    error: null,
    requestedAt: now,
    updatedAt: now,
  };
  await writeRefreshStatus(symbol, status);
  await writeRefreshRequest(symbol, now);
  return { ok: true, status };
}

// Called by the headless refresh-snapshot run (POST /api/refresh/progress) as it
// works through the fetch pipeline, so the client's loading screen reflects real steps.
export async function recordProgress(symbol, { status, step, totalSteps, message, error }) {
  const existing = await readRefreshStatus(symbol);
  const next = {
    symbol,
    status: status ?? existing?.status ?? "running",
    step: step ?? existing?.step ?? 0,
    totalSteps: totalSteps ?? existing?.totalSteps ?? TOTAL_REFRESH_STEPS,
    message: message ?? existing?.message ?? "",
    error: error ?? null,
    requestedAt: existing?.requestedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeRefreshStatus(symbol, next);
  return next;
}

export async function getStatus(symbol) {
  const existing = await readRefreshStatus(symbol);
  return (
    existing ?? {
      symbol,
      status: "idle",
      step: 0,
      totalSteps: TOTAL_REFRESH_STEPS,
      message: "",
      error: null,
      requestedAt: null,
      updatedAt: null,
    }
  );
}
