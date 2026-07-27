// Direct Tradier REST integration backing POST /api/refresh — a plain in-process fetch
// chain (single-digit seconds). Requires TRADIER_API_KEY in server/.env; every export
// here throws if it's unset.

const BASE_URL = "https://api.tradier.com/v1";
const DTE_MIN_DAYS = 3;
const DTE_MAX_DAYS = 15;
const STRIKES_PER_SIDE = 5;

export function isTradierConfigured() {
  return Boolean(process.env.TRADIER_API_KEY);
}

function apiKey() {
  const key = process.env.TRADIER_API_KEY;
  if (!key) throw new Error("TRADIER_API_KEY is not set — cannot fetch from Tradier");
  return key;
}

async function tradierGet(path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey()}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tradier ${path} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return res.json();
}

function round(x, dp = 4) {
  return Number.isFinite(x) ? Number(x.toFixed(dp)) : undefined;
}

async function fetchQuote(symbol) {
  const data = await tradierGet("/markets/quotes", { symbols: symbol });
  const quote = data?.quotes?.quote;
  if (!quote || Array.isArray(quote)) throw new Error(`No quote returned for ${symbol}`);
  return {
    price: quote.last,
    priorClose: quote.prevclose,
    name: quote.description,
  };
}

function daysBetween(dateStr) {
  const ms = new Date(`${dateStr}T00:00:00Z`).getTime() - Date.now();
  return ms / (1000 * 60 * 60 * 24);
}

async function fetchExpirations(symbol) {
  const data = await tradierGet("/markets/options/expirations", { symbol, includeAllRoots: "false" });
  const dates = data?.expirations?.date;
  const all = Array.isArray(dates) ? dates : dates ? [dates] : [];
  return all.filter((d) => {
    const dte = daysBetween(d);
    return dte >= DTE_MIN_DAYS && dte <= DTE_MAX_DAYS;
  });
}

// Exactly 10 strikes centered on spot (5 nearest below + 5 at-or-above), same rule the
// manual refresh-snapshot skill uses — keeps a refresh's contract count small.
export function pickStrikesAroundSpot(strikes, spot) {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const below = sorted.filter((s) => s < spot).slice(-STRIKES_PER_SIDE);
  const atOrAbove = sorted.filter((s) => s >= spot).slice(0, STRIKES_PER_SIDE);
  return new Set([...below, ...atOrAbove]);
}

export function mapContract(opt) {
  const g = opt.greeks ?? {};
  // Prefer the bid/ask midpoint over `last` — `last` is the most recent trade price,
  // which can be stale/outside the current spread (e.g. from before a fast underlying
  // move) and otherwise skews the server's BS-implied-vol cross-check against Tradier's
  // own quoted IV, flagging spurious ivDivergence on every strike.
  const hasQuote = Number.isFinite(opt.bid) && Number.isFinite(opt.ask) && opt.bid + opt.ask > 0;
  const mark = hasQuote ? round((opt.bid + opt.ask) / 2) : Number.isFinite(opt.last) && opt.last > 0 ? opt.last : undefined;
  return {
    bid: round(opt.bid),
    ask: round(opt.ask),
    mark,
    delta: round(g.delta),
    gamma: round(g.gamma),
    theta: round(g.theta),
    vega: round(g.vega),
    rho: round(g.rho),
    iv: round(g.mid_iv ?? g.smv_vol),
    openInterest: opt.open_interest,
    volume: opt.volume,
  };
}

async function fetchChain(symbol, expiration, spot) {
  const data = await tradierGet("/markets/options/chains", { symbol, expiration, greeks: "true" });
  const options = data?.options?.option;
  const all = Array.isArray(options) ? options : options ? [options] : [];
  if (!all.length) return null;

  const keptStrikes = pickStrikesAroundSpot(
    all.map((o) => o.strike),
    spot,
  );
  const byStrike = new Map();
  for (const opt of all) {
    if (!keptStrikes.has(opt.strike)) continue;
    const entry = byStrike.get(opt.strike) ?? { strike: opt.strike };
    entry[opt.option_type] = mapContract(opt);
    byStrike.set(opt.strike, entry);
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  return strikes.length ? { strikes } : null;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchDailyCandles(symbol) {
  const end = new Date();
  const start = new Date(end.getTime() - 100 * 24 * 60 * 60 * 1000);
  const data = await tradierGet("/markets/history", {
    symbol,
    interval: "daily",
    start: ymd(start),
    end: ymd(end),
  });
  const days = data?.history?.day;
  const all = Array.isArray(days) ? days : days ? [days] : [];
  return all.map((d) => ({ t: `${d.date}T00:00:00Z`, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
}

// Tradier's intraday granularity tops out at 15min (timesales); 30m/1h are built by
// aggregating the 15min bars rather than a second, redundant round-trip per interval.
async function fetch15mCandles(symbol, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");
  const data = await tradierGet("/markets/timesales", {
    symbol,
    interval: "15min",
    start: fmt(start),
    end: fmt(end),
    session_filter: "open",
  });
  const rows = data?.series?.data;
  const all = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return all.map((r) => ({ t: new Date(r.time.replace(" ", "T") + "Z").toISOString(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

export function aggregateCandles(bars, groupSize) {
  const out = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    const group = bars.slice(i, i + groupSize);
    if (!group.length) continue;
    out.push({
      t: group[0].t,
      open: group[0].open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, b) => sum + (b.volume ?? 0), 0),
    });
  }
  return out;
}

async function fetchCandles(symbol) {
  const [daily, fifteenMin] = await Promise.all([fetchDailyCandles(symbol), fetch15mCandles(symbol, 5)]);
  return {
    "1d": daily,
    "1h": aggregateCandles(fifteenMin, 4),
    "30m": aggregateCandles(fifteenMin, 2),
    "15m": fifteenMin,
  };
}

// Builds a full schema-v2 snapshot body (same shape POST /api/snapshot expects) via
// direct Tradier calls, run concurrently where the data doesn't depend on each other.
export async function fetchSnapshot(symbol) {
  const [{ price, priorClose, name }, expirations, candles] = await Promise.all([fetchQuote(symbol), fetchExpirations(symbol), fetchCandles(symbol)]);

  const chains = {};
  const chainResults = await Promise.all(expirations.map(async (expiration) => [expiration, await fetchChain(symbol, expiration, price)]));
  for (const [expiration, chain] of chainResults) {
    if (chain) chains[expiration] = chain;
  }

  return {
    schemaVersion: 2,
    symbol,
    underlying: { price, priorClose, name },
    expirations: Object.keys(chains),
    chains,
    candles,
    sourcedAt: new Date().toISOString(),
    sourceNote: "Fetched directly via Tradier API",
  };
}
