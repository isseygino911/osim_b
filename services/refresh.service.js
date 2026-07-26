import { clearRefreshState, listRefreshStatuses, readRefreshStatus, writeRefreshRequest, writeRefreshStatus } from "../models/refresh.model.js";

export const TOTAL_REFRESH_STEPS = 6;
const COOLDOWN_MS = 15_000; // after a completed/errored run, block re-requests for this long
const MAX_LOG_ENTRIES = 300; // generous cap; a real run posts on the order of tens of entries

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
  const initialMessage = "Refresh requested — waiting for the local watcher to pick it up…";
  const status = {
    symbol,
    status: "pending",
    step: 0,
    totalSteps: TOTAL_REFRESH_STEPS,
    message: initialMessage,
    error: null,
    log: [{ step: 0, message: initialMessage, ts: now }],
    requestedAt: now,
    updatedAt: now,
  };
  await writeRefreshStatus(symbol, status);
  await writeRefreshRequest(symbol, now);
  return { ok: true, status };
}

// Called by the headless refresh-snapshot run (POST /api/refresh/progress) as it works
// through the fetch pipeline. Every call with a message is a discrete, real sub-step
// (one Robinhood call, one batch, one expiration) — appended to `log` so the client's
// loading screen can render the full step-by-step trail in real time, not just the
// latest message. `step`/`totalSteps` still drive the progress bar's percentage.
export async function recordProgress(symbol, { status, step, totalSteps, message, error }) {
  const existing = await readRefreshStatus(symbol);
  const prevLog = Array.isArray(existing?.log) ? existing.log : [];
  const now = new Date().toISOString();
  const nextStep = step ?? existing?.step ?? 0;
  const appended =
    message && message !== existing?.message
      ? [...prevLog, { step: nextStep, message, ts: now }].slice(-MAX_LOG_ENTRIES)
      : prevLog;
  const next = {
    symbol,
    status: status ?? existing?.status ?? "running",
    step: nextStep,
    totalSteps: totalSteps ?? existing?.totalSteps ?? TOTAL_REFRESH_STEPS,
    message: message ?? existing?.message ?? "",
    error: error ?? null,
    log: appended,
    requestedAt: existing?.requestedAt ?? now,
    updatedAt: now,
  };
  await writeRefreshStatus(symbol, next);
  return next;
}

// Cancels a queued-but-not-yet-started refresh (deletes the trigger file so the watcher
// never picks it up). Can't stop a "running" job — that's already a separate headless
// process the server has no handle on — so this only succeeds while still "pending".
export async function cancelRefresh(symbol) {
  const existing = await readRefreshStatus(symbol);
  if (!existing || existing.status !== "pending") {
    return { ok: false, status: existing ?? null };
  }
  await clearRefreshState(symbol);
  return { ok: true };
}

// Every symbol with an active/recent refresh, across all symbols — not just whichever
// one is currently selected in the client. Powers the "what's running" list.
export async function listActiveRefreshes() {
  const all = await listRefreshStatuses();
  return all.filter((s) => s.status === "pending" || s.status === "running");
}

// Unconditionally clears a symbol's refresh tracking (the list's "X" button) — unlike
// cancelRefresh above, this works regardless of status. For a "running" job this only
// removes the status file; it can't kill the underlying headless process (no PID is
// tracked anywhere), so that process — if still alive — keeps running invisibly.
export async function clearRefresh(symbol) {
  await clearRefreshState(symbol);
  return { ok: true };
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
      log: [],
      requestedAt: null,
      updatedAt: null,
    }
  );
}
