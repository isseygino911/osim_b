import { readAutopilotState, writeAutopilotState } from "../models/autopilot.model.js";
import { enrichSnapshot } from "./greeks.service.js";
import { getNews } from "./news.service.js";
import { computeSignal, decideExits, decideTrade } from "./strategy.service.js";

const CASH_START = 10000;
const LOOP_INTERVAL_MS = 60 * 1000;

function startOfWeek(d = new Date()) {
  const date = new Date(d);
  const day = date.getUTCDay();
  const diff = (day + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - diff);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function freshState() {
  const weekStart = startOfWeek();
  return {
    enabled: false,
    cash: CASH_START,
    positions: [], // {id, type, strike, expiration, qty, entryPrice, mark, openedAt}
    trades: [], // append-only log, newest first
    weekStart,
    weekStartEquity: CASH_START,
    dayStart: new Date().toISOString().slice(0, 10),
    dayStartEquity: CASH_START,
    weekHistory: [], // {weekStart, weekEnd, startEquity, endEquity, pnlPct}
    lastRunAt: null,
    lastDecision: null,
  };
}

let state = null;
let timer = null;

async function load() {
  try {
    state = await readAutopilotState();
  } catch {
    state = freshState();
  }
  return state;
}

async function persist() {
  await writeAutopilotState(state);
}

function equityOf(state) {
  const positionsValue = state.positions.reduce((sum, p) => sum + (p.mark ?? p.entryPrice) * 100 * p.qty, 0);
  return state.cash + positionsValue;
}

function rolloverWeekIfNeeded(state) {
  const wsIso = startOfWeek();
  if (wsIso !== state.weekStart) {
    const endEquity = equityOf(state);
    state.weekHistory.unshift({
      weekStart: state.weekStart,
      weekEnd: new Date().toISOString(),
      startEquity: state.weekStartEquity,
      endEquity,
      pnlPct: Number((((endEquity - state.weekStartEquity) / state.weekStartEquity) * 100).toFixed(2)),
    });
    state.weekHistory = state.weekHistory.slice(0, 26);
    state.weekStart = wsIso;
    state.weekStartEquity = endEquity;
  }
}

function rolloverDayIfNeeded(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== state.dayStart) {
    state.dayStart = today;
    state.dayStartEquity = equityOf(state);
  }
}

function markPositions(state, chains) {
  for (const pos of state.positions) {
    const c = chains[pos.expiration];
    const row = c?.strikes?.find((st) => st.strike === pos.strike);
    const q = row?.[pos.type];
    if (q) {
      pos.mark = Number.isFinite(q.bid) && Number.isFinite(q.ask) ? (q.bid + q.ask) / 2 : Number.isFinite(q.mark) ? q.mark : pos.mark;
    }
  }
}

function closePositionInternal(state, pos, reason) {
  const proceeds = (pos.mark ?? pos.entryPrice) * 100 * pos.qty;
  state.cash += proceeds;
  state.positions = state.positions.filter((p) => p.id !== pos.id);
  state.trades.unshift({
    id: pos.id,
    action: "SELL",
    type: pos.type,
    strike: pos.strike,
    expiration: pos.expiration,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    closePrice: pos.mark ?? pos.entryPrice,
    reason,
    at: new Date().toISOString(),
  });
}

function openPositionInternal(state, order, reason) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pos = {
    id,
    type: order.optionType,
    strike: order.strike,
    expiration: order.expiration,
    qty: order.qty,
    entryPrice: order.price,
    mark: order.price,
    openedAt: new Date().toISOString(),
  };
  state.cash -= order.cost;
  state.positions.push(pos);
  state.trades.unshift({
    id,
    action: "BUY",
    type: pos.type,
    strike: pos.strike,
    expiration: pos.expiration,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    reason,
    at: new Date().toISOString(),
  });
}

async function runOnce(readSnapshot) {
  if (!state) await load();
  const s = state;
  rolloverWeekIfNeeded(s);
  rolloverDayIfNeeded(s);

  let snapshot;
  try {
    // enrich with greeks (computed where Robinhood's are absent) so the strategy
    // can pick strikes by delta and dampen the signal on options conditions
    snapshot = enrichSnapshot(await readSnapshot());
  } catch (e) {
    s.lastRunAt = new Date().toISOString();
    s.lastDecision = { type: "none", reason: `No snapshot available: ${e.message}` };
    await persist();
    return s;
  }

  markPositions(s, snapshot.chains || {});

  // 1. Exit checks first (stop-loss / take-profit) — always run, even if disabled,
  //    so risk controls stay active on positions already open.
  const exits = decideExits(s.positions);
  for (const ex of exits) {
    closePositionInternal(s, ex.position, ex.reason);
  }

  if (!s.enabled) {
    s.lastRunAt = new Date().toISOString();
    if (exits.length) s.lastDecision = { type: "exit_only", reason: `Closed ${exits.length} position(s) on risk rules.` };
    await persist();
    return s;
  }

  // 2. Entry decision
  const news = await getNews().catch(() => null);
  const signal = computeSignal(snapshot, news);
  const equity = equityOf(s);
  const dayPnlPct = ((equity - s.dayStartEquity) / s.dayStartEquity) * 100;
  const decision = decideTrade({
    signal,
    snapshot,
    portfolio: { cash: s.cash, positions: s.positions, equity },
    dayPnlPct,
  });

  if (decision.type === "open") {
    openPositionInternal(s, decision.order, decision.reason);
  }

  s.lastRunAt = new Date().toISOString();
  s.lastDecision = { ...decision, signal: { action: signal.action, combinedScore: signal.combinedScore, reason: signal.reason } };
  await persist();
  return s;
}

export function getStatus() {
  if (!state) return null;
  const equity = equityOf(state);
  const weekPnlPct = Number((((equity - state.weekStartEquity) / state.weekStartEquity) * 100).toFixed(2));
  return {
    ...state,
    equity,
    weekPnlPct,
    weekGoalPct: 10,
    weekProgressPct: Number(Math.min(100, Math.max(0, (weekPnlPct / 10) * 100)).toFixed(1)),
  };
}

export async function init(readSnapshot) {
  await load();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runOnce(readSnapshot).catch((e) => console.error("[autopilot] loop error:", e.message));
  }, LOOP_INTERVAL_MS);
  return getStatus();
}

export async function setEnabled(enabled, readSnapshot) {
  if (!state) await load();
  state.enabled = enabled;
  await persist();
  if (enabled) runOnce(readSnapshot).catch((e) => console.error("[autopilot] loop error:", e.message));
  return getStatus();
}

export async function triggerRun(readSnapshot) {
  await runOnce(readSnapshot);
  return getStatus();
}

export async function resetState() {
  state = freshState();
  await persist();
  return getStatus();
}
