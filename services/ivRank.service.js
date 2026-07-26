import { readIvHistory, writeIvHistory } from "../models/ivHistory.model.js";
import { assessChain, enrichSnapshot } from "./greeks.service.js";

// IV Rank/Percentile needs a real history of daily ATM IV readings, which the snapshot
// itself doesn't carry — every POST /api/snapshot appends one sample (see recordIvSample),
// so this only becomes meaningful after weeks of live refreshes.
export const IV_HISTORY_MAX_DAYS = 370;
export const IV_MIN_DAYS = 30;
const IV_WINDOW_DAYS = 365;

function round(x, dp = 1) {
  return Number.isFinite(x) ? Number(x.toFixed(dp)) : x;
}

// ATM IV of the nearest expiration — "front month" in spirit, though this app trades
// weeklies/short-dated chains rather than literal monthly expirations.
export function frontMonthAtmIv(enrichedSnapshot) {
  if (!enrichedSnapshot || typeof enrichedSnapshot !== "object") return null;
  const spot = enrichedSnapshot.underlying?.price;
  const chains = enrichedSnapshot.chains;
  if (!Number.isFinite(spot) || !chains || typeof chains !== "object") return null;
  const expirations = Object.keys(chains).sort();
  if (!expirations.length) return null;
  const { atmIv } = assessChain(chains[expirations[0]], spot);
  return atmIv;
}

// Pure merge: same-date sample replaces (handles same-day re-posts), result stays sorted
// by date ascending and capped to the most recent maxDays entries.
export function mergeIvSample(history, sample, maxDays = IV_HISTORY_MAX_DAYS) {
  const list = Array.isArray(history) ? history : [];
  const withoutSameDate = list.filter((e) => e?.date !== sample.date);
  const merged = [...withoutSameDate, sample].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return merged.slice(-maxDays);
}

// Pure stats over a (date-sorted or unsorted) history array.
export function computeIvStats(history, { minDays = IV_MIN_DAYS } = {}) {
  const empty = { atmIv: null, high52w: null, low52w: null, ivRank: null, ivPercentile: null, days: 0, insufficient: true };
  const list = Array.isArray(history) ? history.filter((e) => Number.isFinite(e?.atmIv) && e?.date) : [];
  if (!list.length) return empty;

  const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const current = sorted[sorted.length - 1].atmIv;
  const latestDate = new Date(sorted[sorted.length - 1].date);
  const windowStart = new Date(latestDate);
  windowStart.setDate(windowStart.getDate() - IV_WINDOW_DAYS);
  const window = sorted.filter((e) => new Date(e.date) >= windowStart);
  const days = window.length;

  if (days < minDays) {
    return { atmIv: round(current, 4), high52w: null, low52w: null, ivRank: null, ivPercentile: null, days, insufficient: true };
  }

  const ivs = window.map((e) => e.atmIv);
  const high52w = Math.max(...ivs);
  const low52w = Math.min(...ivs);
  const ivRank = high52w === low52w ? null : round(((current - low52w) / (high52w - low52w)) * 100);
  const below = ivs.filter((v) => v < current).length;
  const ivPercentile = round((100 * below) / days);

  return { atmIv: round(current, 4), high52w: round(high52w, 4), low52w: round(low52w, 4), ivRank, ivPercentile, days, insufficient: false };
}

// IO wrapper: append today's ATM IV sample from a freshly-posted snapshot. Silent no-op
// when IV can't be derived (no chains, no ATM strike, thin quotes) — this must never fail
// the POST /api/snapshot request it rides along with.
export async function recordIvSample(symbol, snapshot) {
  const atmIv = frontMonthAtmIv(enrichSnapshot(snapshot));
  if (!Number.isFinite(atmIv)) return;
  const date = (snapshot?.fetchedAt ?? new Date().toISOString()).slice(0, 10);
  const history = await readIvHistory(symbol);
  const merged = mergeIvSample(history, { date, atmIv }, IV_HISTORY_MAX_DAYS);
  await writeIvHistory(symbol, merged);
}

// IO wrapper: read history + compute stats for GET /api/indicators.
export async function getIvStats(symbol) {
  const history = await readIvHistory(symbol);
  return computeIvStats(history);
}
