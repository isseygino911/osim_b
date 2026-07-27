import { bsGreeks, impliedVol, yearFraction } from "./blackScholes.service.js";
import { candlesFor } from "./indicators.service.js";

// Snapshot enrichment happens on READ, never on write — data/snapshot.json stays a
// faithful record of whatever Tradier returned, and computed values are derived per
// request. Every field here is optional-tolerant: a v1 snapshot (bid/ask only) passes
// through with whatever can be derived, and nothing downstream may assume a greek is present.

export const DEFAULT_RISK_FREE_RATE = 0.04;
// QQQ trailing 12m yield, used as continuous q. This is only the fallback —
// per-symbol accuracy comes from Claude supplying dividendYield in the snapshot.
export const DEFAULT_DIVIDEND_YIELD = 0.006;
const IV_DIVERGENCE_FLAG = 0.05; // provider-quoted IV vs our BS-implied IV — beyond this the quote data is suspect

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
    q.ivSource = q.ivSource ?? "provider";
    // cross-check provider IV against what the mark implies — divergence flags stale/bad quotes
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
    q.greeksSource = q.greeksSource ?? "provider";
  }
  // backfill whatever greeks are still missing (gamma/theta/vega/rho, and delta itself
  // when absent) from the computed IV — independent of whether delta was already present
  if (Number.isFinite(q.iv)) {
    const g = bsGreeks({ ...base, sigma: q.iv });
    if (g) {
      let filledAny = false;
      for (const k of GREEK_KEYS) {
        if (!Number.isFinite(q[k])) {
          q[k] = round(g[k]);
          filledAny = true;
        }
      }
      if (filledAny) q.greeksSource = q.greeksSource ?? "computed";
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
// Baselines below are tuned for QQQ/index ETFs; single names typically run flatter
// skew and lower put/call OI. They only feed the informational newsVsOptions bias,
// never combinedScore/action, so per-symbol miscalibration is display-only.
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

function atmIvOf(chain, spot) {
  if (!chain?.strikes?.length || !Number.isFinite(spot)) return null;
  let atm = null;
  let atmDiff = Infinity;
  for (const row of chain.strikes) {
    if (!Number.isFinite(row?.strike)) continue;
    const diff = Math.abs(row.strike - spot);
    if (diff < atmDiff) {
      atmDiff = diff;
      atm = row;
    }
  }
  const ivs = [atm?.call?.iv, atm?.put?.iv].filter(Number.isFinite);
  return ivs.length ? round(ivs.reduce((a, b) => a + b, 0) / ivs.length) : null;
}

function nearestByDeltaEither(strikes, sign, targetDelta, tolerance) {
  let best = null;
  let bestDiff = Infinity;
  for (const row of strikes) {
    const side = sign > 0 ? "call" : "put";
    const q = row[side];
    if (!q || !Number.isFinite(q.delta) || !Number.isFinite(q.iv)) continue;
    const diff = Math.abs(q.delta - sign * targetDelta);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = q;
    }
  }
  return bestDiff <= tolerance ? best : null;
}

// 20-session annualized close-to-close realized volatility from daily candles —
// same lookback convention as a typical historical-vol reading, used only as a
// comparison point for ATM IV (the volatility risk premium), never for pricing.
const REALIZED_VOL_LOOKBACK = 20;
const TRADING_DAYS_PER_YEAR = 252;

export function computeRealizedVol(snapshot, lookback = REALIZED_VOL_LOOKBACK) {
  const closes = candlesFor(snapshot, "1d")
    .map((b) => b?.close)
    .filter(Number.isFinite);
  if (closes.length < lookback + 1) return null;
  const window = closes.slice(-(lookback + 1));
  const logReturns = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] > 0 && window[i] > 0) logReturns.push(Math.log(window[i] / window[i - 1]));
  }
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  return round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR));
}

// Volatility surface: skew at two deltas (25Δ, and 10Δ wing when the chain is wide
// enough to bracket it), term-structure slope between the nearest and farthest
// expiration actually in the snapshot's 3-15 DTE window, and the volatility risk
// premium (ATM IV vs. realized vol from the daily candles already on the snapshot).
// Purely informational — mirrors computeOptionsBias's "null when data's too thin"
// contract; never feeds combinedScore/action.
const WING_DELTA_TARGET = 0.1;
const WING_DELTA_TOLERANCE = 0.06;

export function computeVolSurface(snapshot, expiration) {
  const spot = snapshot?.underlying?.price;
  const chain = expiration ? snapshot?.chains?.[expiration] : null;
  if (!chain?.strikes?.length || !Number.isFinite(spot)) {
    return { skew: null, term: null, vol: null };
  }

  const call25 = nearestByDeltaEither(chain.strikes, 1, DELTA_TARGET, DELTA_TOLERANCE);
  const put25 = nearestByDeltaEither(chain.strikes, -1, DELTA_TARGET, DELTA_TOLERANCE);
  const call10 = nearestByDeltaEither(chain.strikes, 1, WING_DELTA_TARGET, WING_DELTA_TOLERANCE);
  const put10 = nearestByDeltaEither(chain.strikes, -1, WING_DELTA_TARGET, WING_DELTA_TOLERANCE);
  const skew =
    call25 || put25 || call10 || put10
      ? {
          call25d: call25 ? round(call25.iv) : null,
          put25d: put25 ? round(put25.iv) : null,
          call10d: call10 ? round(call10.iv) : null,
          put10d: put10 ? round(put10.iv) : null,
        }
      : null;

  const expirationsWithChains = (snapshot.expirations ?? []).filter((d) => snapshot.chains?.[d]?.strikes?.length);
  let term = null;
  if (expirationsWithChains.length >= 2) {
    const sorted = [...expirationsWithChains].sort();
    const nearExpiration = sorted[0];
    const farExpiration = sorted[sorted.length - 1];
    const nearAtmIv = atmIvOf(snapshot.chains[nearExpiration], spot);
    const farAtmIv = atmIvOf(snapshot.chains[farExpiration], spot);
    if (Number.isFinite(nearAtmIv) && Number.isFinite(farAtmIv) && nearExpiration !== farExpiration) {
      term = { nearExpiration, nearAtmIv, farExpiration, farAtmIv, slope: round(farAtmIv - nearAtmIv) };
    }
  }

  const atmIv = atmIvOf(chain, spot);
  const realizedVol20d = computeRealizedVol(snapshot);
  const vol =
    Number.isFinite(atmIv) && Number.isFinite(realizedVol20d)
      ? { atmIv, realizedVol20d, vrp: round(atmIv - realizedVol20d) }
      : atmIv != null
        ? { atmIv, realizedVol20d: null, vrp: null }
        : null;

  return { skew, term, vol };
}

// Net dealer gamma exposure (GEX), SqueezeMetrics-style convention: sum of
// gamma * openInterest * 100 * spot^2 * 0.01 across all strikes, calls positive and
// puts negative. This assumes dealers are net short the options retail/institutions
// are long — a standard but unverified approximation, not a measured position — so
// treat the sign/magnitude as a directional read on hedging flow, not a certainty.
// Positive net GEX: dealers hedge by buying dips/selling rallies (dampens moves,
// "pins" price near high-OI strikes). Negative: hedging amplifies moves.
export function computeGammaExposure(snapshot) {
  const spot = snapshot?.underlying?.price;
  if (!Number.isFinite(spot)) return { netGex: null, zeroGammaStrike: null, byStrike: [] };

  const byStrikeMap = new Map();
  for (const chain of Object.values(snapshot?.chains ?? {})) {
    for (const row of chain?.strikes ?? []) {
      if (!Number.isFinite(row?.strike)) continue;
      let strikeGex = 0;
      let hasData = false;
      for (const [side, sign] of [["call", 1], ["put", -1]]) {
        const q = row[side];
        if (!q || !Number.isFinite(q.gamma) || !Number.isFinite(q.openInterest)) continue;
        strikeGex += sign * q.gamma * q.openInterest * 100 * spot * spot * 0.01;
        hasData = true;
      }
      if (!hasData) continue;
      byStrikeMap.set(row.strike, (byStrikeMap.get(row.strike) ?? 0) + strikeGex);
    }
  }

  if (!byStrikeMap.size) return { netGex: null, zeroGammaStrike: null, byStrike: [] };

  const byStrike = [...byStrikeMap.entries()]
    .map(([strike, gex]) => ({ strike, gex: round(gex, 0) }))
    .sort((a, b) => a.strike - b.strike);
  const netGex = round(
    byStrike.reduce((sum, r) => sum + r.gex, 0),
    0,
  );

  // Strike where cumulative signed gamma crosses zero — an approximation of the
  // "zero gamma" flip level between dealer-dampening and dealer-amplifying regimes.
  let zeroGammaStrike = null;
  let bestAbs = Infinity;
  for (const row of byStrike) {
    const abs = Math.abs(row.gex);
    if (abs < bestAbs) {
      bestAbs = abs;
      zeroGammaStrike = row.strike;
    }
  }

  return { netGex, zeroGammaStrike, byStrike };
}
