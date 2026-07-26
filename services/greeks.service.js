import { bsGreeks, impliedVol, yearFraction } from "./blackScholes.service.js";

// Snapshot enrichment happens on READ, never on write — data/snapshot.json stays a
// faithful record of what Robinhood returned, and computed values are derived per request.
// Every field here is optional-tolerant: a v1 snapshot (bid/ask only) passes through with
// whatever can be derived, and nothing downstream may assume a greek is present.

export const DEFAULT_RISK_FREE_RATE = 0.04;
export const DEFAULT_DIVIDEND_YIELD = 0.006; // QQQ trailing 12m yield, used as continuous q
const IV_DIVERGENCE_FLAG = 0.05; // Robinhood IV vs our BS-implied IV — beyond this the quote data is suspect

const GREEK_KEYS = ["delta", "gamma", "theta", "vega", "rho"];

function round(x, dp = 4) {
  return Number.isFinite(x) ? Number(x.toFixed(dp)) : x;
}

function enrichSide(q, { S, K, T, r, divYield, type }) {
  if (!q || typeof q !== "object") return;

  if (!Number.isFinite(q.mark) && Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid + q.ask > 0) {
    q.mark = round((q.bid + q.ask) / 2);
  }

  const base = { S, K, T, r, q: divYield, type };

  if (Number.isFinite(q.iv)) {
    q.ivSource = q.ivSource ?? "robinhood";
    // cross-check broker IV against what the mark implies — divergence flags stale/bad quotes
    if (Number.isFinite(q.mark) && q.mark > 0) {
      const check = impliedVol({ price: q.mark, ...base });
      if (check.converged) q.ivDivergence = round(Math.abs(q.iv - check.iv));
    }
  } else if (Number.isFinite(q.mark) && q.mark > 0) {
    const solved = impliedVol({ price: q.mark, ...base });
    if (solved.converged) {
      q.iv = round(solved.iv);
      q.ivSource = "computed";
    }
  }

  if (Number.isFinite(q.delta)) {
    q.greeksSource = q.greeksSource ?? "robinhood";
  } else if (Number.isFinite(q.iv)) {
    const g = bsGreeks({ ...base, sigma: q.iv });
    if (g) {
      for (const k of GREEK_KEYS) {
        if (!Number.isFinite(q[k])) q[k] = round(g[k]);
      }
      q.greeksSource = "computed";
    }
  }
}

// Returns a deep-enriched copy; the input snapshot object is never mutated.
export function enrichSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const out = structuredClone(snapshot);
  const S = out.underlying?.price;
  if (!Number.isFinite(S)) return out;
  const r = Number.isFinite(out.riskFreeRate) ? out.riskFreeRate : DEFAULT_RISK_FREE_RATE;
  const divYield = Number.isFinite(out.dividendYield) ? out.dividendYield : DEFAULT_DIVIDEND_YIELD;

  for (const [expiration, chain] of Object.entries(out.chains ?? {})) {
    const T = yearFraction(expiration);
    if (!Number.isFinite(T) || !chain?.strikes?.length) continue;
    for (const row of chain.strikes) {
      if (!Number.isFinite(row?.strike)) continue;
      enrichSide(row.call, { S, K: row.strike, T, r, divYield, type: "call" });
      enrichSide(row.put, { S, K: row.strike, T, r, divYield, type: "put" });
    }
  }
  return out;
}

// Directional read of options positioning, distinct from the quality-only options
// score: 25-delta put/call IV skew (fear gauge) blended with put/call open-interest
// ratio when available. Positive bias = bullish positioning. Runs on an ENRICHED
// chain — v1 snapshots work via computed IV/delta; OI is genuinely optional.
export const BASELINE_PUT_SKEW = 0.03; // QQQ 25Δ put-call IV skew is normally ~+3 vol pts
const SKEW_SPAN = 0.05; // 5 vol pts beyond/below baseline saturates the score
const OI_BASELINE_RATIO = 1.2; // normal put/call OI for an index ETF (hedging flow)
const DELTA_TARGET = 0.25;
const DELTA_TOLERANCE = 0.15; // chain too narrow to bracket 25Δ → skew factor is null

function clamp100(x) {
  return Math.max(-100, Math.min(100, x));
}

function nearestByDelta(strikes, side, sign) {
  let best = null;
  let bestDiff = Infinity;
  for (const row of strikes) {
    const q = row[side];
    if (!q || !Number.isFinite(q.delta) || !Number.isFinite(q.iv)) continue;
    const diff = Math.abs(q.delta - sign * DELTA_TARGET);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = q;
    }
  }
  return bestDiff <= DELTA_TOLERANCE ? best : null;
}

export function computeOptionsBias(chain, spot) {
  const empty = { bias: 0, factors: null };
  if (!chain?.strikes?.length || !Number.isFinite(spot)) return empty;

  const call25 = nearestByDelta(chain.strikes, "call", 1);
  const put25 = nearestByDelta(chain.strikes, "put", -1);
  let skewBias = null;
  let ivSkew = null;
  if (call25 && put25) {
    ivSkew = round(put25.iv - call25.iv);
    // skew at baseline → 0; panic put bid (+0.08) → -100 bearish; flat/inverted → bullish
    skewBias = clamp100((-(ivSkew - BASELINE_PUT_SKEW) / SKEW_SPAN) * 100);
  }

  let oiBias = null;
  let oiRatio = null;
  let putOi = 0;
  let callOi = 0;
  let oiRows = 0;
  for (const row of chain.strikes) {
    if (Number.isFinite(row.call?.openInterest) && Number.isFinite(row.put?.openInterest)) {
      callOi += row.call.openInterest;
      putOi += row.put.openInterest;
      oiRows += 1;
    }
  }
  if (oiRows >= 3 && callOi > 0) {
    oiRatio = round(putOi / callOi, 2);
    // log-symmetric around the hedging-flow baseline: ratio 2.4 → -100, 0.6 → +100
    oiBias = clamp100((-Math.log(oiRatio / OI_BASELINE_RATIO) / Math.LN2) * 100);
  }

  if (skewBias === null && oiBias === null) return empty;
  const bias = skewBias !== null && oiBias !== null ? 0.7 * skewBias + 0.3 * oiBias : (skewBias ?? oiBias);

  // ATM IV for display context, same nearest-strike approach as assessChain
  let atmIv = null;
  let atmDiff = Infinity;
  for (const row of chain.strikes) {
    const diff = Math.abs(row.strike - spot);
    if (diff < atmDiff && Number.isFinite(row.call?.iv)) {
      atmDiff = diff;
      atmIv = round(row.call.iv);
    }
  }

  return {
    bias: Number(bias.toFixed(1)),
    factors: {
      ivSkew,
      callIv25: call25 ? round(call25.iv) : null,
      putIv25: put25 ? round(put25.iv) : null,
      oiRatio,
      atmIv,
    },
  };
}

// Chain-quality summary for one expiration, evaluated around the ATM strike.
// Feeds the options-conditions dampener in strategy.service and GET /api/greeks.
export function assessChain(chain, spot, { minOpenInterest = 100 } = {}) {
  const empty = { atmIv: null, avgSpreadPct: null, dailyThetaPctAtm: null, liquidityOk: true, flags: [] };
  if (!chain?.strikes?.length || !Number.isFinite(spot)) return empty;

  let atm = null;
  let atmDiff = Infinity;
  const spreadPcts = [];
  const flags = [];

  for (const row of chain.strikes) {
    if (!Number.isFinite(row?.strike)) continue;
    const diff = Math.abs(row.strike - spot);
    if (diff < atmDiff) {
      atmDiff = diff;
      atm = row;
    }
    for (const side of ["call", "put"]) {
      const q = row[side];
      if (!q) continue;
      if (Number.isFinite(q.bid) && Number.isFinite(q.ask) && Number.isFinite(q.mark) && q.mark > 0) {
        spreadPcts.push((q.ask - q.bid) / q.mark);
      }
      if (Number.isFinite(q.ivDivergence) && q.ivDivergence > IV_DIVERGENCE_FLAG) {
        flags.push(`iv-divergence ${row.strike}${side === "call" ? "C" : "P"} (${q.ivDivergence})`);
      }
    }
  }
  if (!atm) return empty;

  const ivs = [atm.call?.iv, atm.put?.iv].filter(Number.isFinite);
  const atmIv = ivs.length ? round(ivs.reduce((a, b) => a + b, 0) / ivs.length) : null;

  // theta burn as a % of premium — how much of the option melts per calendar day at the money
  let dailyThetaPctAtm = null;
  for (const side of ["call", "put"]) {
    const q = atm[side];
    if (q && Number.isFinite(q.theta) && Number.isFinite(q.mark) && q.mark > 0) {
      dailyThetaPctAtm = round(Math.abs(q.theta) / q.mark);
      break;
    }
  }

  const avgSpreadPct = spreadPcts.length ? round(spreadPcts.reduce((a, b) => a + b, 0) / spreadPcts.length) : null;

  const atmOis = [atm.call?.openInterest, atm.put?.openInterest].filter(Number.isFinite);
  const liquidityOk = atmOis.length ? atmOis.every((oi) => oi >= minOpenInterest) : true;
  if (!liquidityOk) flags.push(`low-oi at ${atm.strike} (min ${minOpenInterest})`);

  return { atmIv, avgSpreadPct, dailyThetaPctAtm, liquidityOk, flags };
}
