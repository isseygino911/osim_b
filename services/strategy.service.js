import { yearFraction } from "./blackScholes.service.js";
import { assessChain, computeGammaExposure, computeOptionsBias, computeVolSurface } from "./greeks.service.js";
import { candlesFor, computeIndicators } from "./indicators.service.js";

// Risk controls — deliberately aggressive since the stated goal is 10%/week,
// which is only reachable with real position sizing, but still bounded so a
// single bad signal can't wipe the account.
export const RISK = {
  maxPositionPctOfEquity: 0.35, // no single position larger than this share of total equity
  maxDailyLossPct: 0.15, // stop opening new positions once daily loss exceeds this
  maxOpenPositions: 3,
  stopLossPct: 0.35, // close a position once it's down this % from entry
  takeProfitPct: 0.6, // close a position once it's up this % from entry
  minSignalScoreToTrade: 30, // |composite score| must exceed this to act
  // greeks-aware knobs — every check is skipped when the snapshot lacks the field,
  // so a v1 (bid/ask-only) snapshot reproduces the pre-greeks behavior exactly
  targetDelta: 0.4, // directional long call/put sweet spot
  minOpenInterest: 100, // liquidity floor, enforced only when OI is present
  maxSpreadPct: 0.1, // (ask-bid)/mark ceiling, enforced only when mark is derivable
  maxDailyThetaPct: 0.06, // skip expirations whose ATM theta burns >6% of premium per day
};

function pickExpiration(expirations, chains, spot, minDaysOut = 3, maxDaysOut = 10) {
  const now = new Date();
  // same 21:00 UTC market-close convention as yearFraction (used for actual BS pricing/theta
  // on this same expiration string), so the DTE filter and theta-burn gate never disagree
  const candidates = expirations
    .filter((d) => chains[d])
    .map((d) => ({ d, days: yearFraction(d, now) * 365 }))
    .filter((x) => x.days >= minDaysOut && x.days <= maxDaysOut)
    .sort((a, b) => a.days - b.days);
  // nearest-first, but step past expirations whose ATM theta burn is brutal —
  // only when greeks exist to say so, and never past the last usable candidate
  for (let i = 0; i < candidates.length; i++) {
    const { dailyThetaPctAtm } = assessChain(chains[candidates[i].d], spot, { minOpenInterest: RISK.minOpenInterest });
    const burnTooHot = Number.isFinite(dailyThetaPctAtm) && dailyThetaPctAtm > RISK.maxDailyThetaPct;
    if (!burnTooHot || i === candidates.length - 1) return candidates[i].d;
  }
  const anyWithChain = expirations.find((d) => chains[d]);
  return anyWithChain ?? expirations[0] ?? null;
}

function pickStrike(chain, price, type, otmPct = 0.01) {
  if (!chain?.strikes?.length) return null;
  const targetStrike = type === "call" ? price * (1 + otmPct) : price * (1 - otmPct);
  let best = chain.strikes[0];
  let bestDiff = Infinity;
  for (const s of chain.strikes) {
    const diff = Math.abs(s.strike - targetStrike);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// Delta-targeted strike selection with liquidity filters. Filters only apply to fields
// that are actually present, and rows without a delta are handled by the caller's
// fallback to the 1%-OTM pickStrike above.
function pickStrikeByDelta(chain, type, targetDelta) {
  let best = null;
  let bestDiff = Infinity;
  for (const s of chain?.strikes ?? []) {
    const q = s[type];
    if (!q || !Number.isFinite(q.delta)) continue;
    if (Number.isFinite(q.openInterest) && q.openInterest < RISK.minOpenInterest) continue;
    if (Number.isFinite(q.mark) && q.mark > 0 && Number.isFinite(q.bid) && Number.isFinite(q.ask) && (q.ask - q.bid) / q.mark > RISK.maxSpreadPct) continue;
    const diff = Math.abs(Math.abs(q.delta) - targetDelta);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// Options-conditions score: quality of the trading environment, not direction.
// Penalty-only, in [-100, 0]; used as a dampener on the directional signal so
// snapshots without greeks (all penalties 0) leave the score bit-for-bit unchanged.
function computeOptionsScore(snapshot) {
  const spot = snapshot.underlying?.price;
  const expiration = pickExpiration(snapshot.expirations || [], snapshot.chains || {}, spot);
  const chain = expiration ? snapshot.chains?.[expiration] : null;
  if (!chain) return { optionsScore: 0, optionsFactors: null };

  const { atmIv, avgSpreadPct, liquidityOk, flags } = assessChain(chain, spot, { minOpenInterest: RISK.minOpenInterest });
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const penaltyIv = Number.isFinite(atmIv) ? clamp01((atmIv - 0.35) / 0.35) * 50 : 0; // rich premium hurts long options
  const penaltySpread = Number.isFinite(avgSpreadPct) ? clamp01((avgSpreadPct - 0.02) / 0.08) * 30 : 0;
  const penaltyOi = liquidityOk ? 0 : 20;
  const optionsScore = -Math.min(100, penaltyIv + penaltySpread + penaltyOi);

  // Same record-a-reason pattern as indicators.service.js's composite score — one
  // entry per penalty (or its absence) so "CONDITIONS -42" is backed by an explicit
  // list instead of just the raw factor rows already shown in the UI.
  const reasons = [];
  if (Number.isFinite(atmIv)) {
    reasons.push({
      factor: "Implied volatility",
      direction: penaltyIv > 0 ? "bearish" : "neutral",
      why: penaltyIv > 0
        ? `ATM IV is ${(atmIv * 100).toFixed(0)}% — rich premium, costing ${penaltyIv.toFixed(1)} points off the conditions score since buyers overpay for options here.`
        : `ATM IV is ${(atmIv * 100).toFixed(0)}% — reasonably priced, no penalty.`,
    });
  }
  if (Number.isFinite(avgSpreadPct)) {
    reasons.push({
      factor: "Bid/ask spread",
      direction: penaltySpread > 0 ? "bearish" : "neutral",
      why: penaltySpread > 0
        ? `Average spread is ${(avgSpreadPct * 100).toFixed(1)}% of the option's price — wide, costing ${penaltySpread.toFixed(1)} points since you'd give up more just entering/exiting.`
        : `Average spread is ${(avgSpreadPct * 100).toFixed(1)}% of the option's price — tight, no penalty.`,
    });
  }
  reasons.push({
    factor: "Liquidity (open interest)",
    direction: penaltyOi > 0 ? "bearish" : "neutral",
    why: penaltyOi > 0
      ? `Open interest at the at-the-money strike is below the ${RISK.minOpenInterest}-contract floor — thin liquidity, costing ${penaltyOi} points since real fills would likely be worse than the quoted price.`
      : "Open interest at the at-the-money strike clears the liquidity floor, no penalty.",
  });
  if (flags?.length) {
    reasons.push({
      factor: "Quality flags",
      direction: "bearish",
      why: `${flags.length} flag${flags.length > 1 ? "s" : ""} raised on this chain: ${flags.join(", ")}.`,
    });
  }

  return {
    optionsScore: Number(optionsScore.toFixed(1)),
    optionsFactors: {
      expiration,
      atmIv,
      avgSpreadPct,
      liquidityOk,
      penalties: { iv: Number(penaltyIv.toFixed(1)), spread: Number(penaltySpread.toFixed(1)), oi: penaltyOi },
      reasons,
    },
  };
}

// What the bot would buy right now, per side — surfaced in the UI so the strike
// selection logic is observable without waiting for a live trade. Pure, no I/O.
export function previewPicks(snapshot) {
  const spot = snapshot?.underlying?.price;
  if (!Number.isFinite(spot)) return null;
  const expiration = pickExpiration(snapshot.expirations || [], snapshot.chains || {}, spot);
  if (!expiration) return null;
  const chain = snapshot.chains?.[expiration];
  const out = { expiration, call: null, put: null };
  for (const type of ["call", "put"]) {
    const hasDeltas = chain?.strikes?.some((s) => Number.isFinite(s[type]?.delta));
    const row = hasDeltas ? pickStrikeByDelta(chain, type, RISK.targetDelta) : pickStrike(chain, spot, type);
    if (row) {
      const q = row[type];
      out[type] = {
        strike: row.strike,
        delta: Number.isFinite(q?.delta) ? q.delta : null,
        iv: Number.isFinite(q?.iv) ? q.iv : null,
        theta: Number.isFinite(q?.theta) ? q.theta : null,
        mid: Number.isFinite(q?.bid) && Number.isFinite(q?.ask) ? Number(((q.bid + q.ask) / 2).toFixed(2)) : null,
        mode: hasDeltas ? "delta-targeted" : "1%-OTM fallback",
      };
    } else if (hasDeltas) {
      out[type] = { strike: null, mode: "all strikes filtered (OI/spread)" };
    }
  }
  return out;
}

// Compares what the news says against what the options market is pricing.
// INFORMATIONAL ONLY — the verdict never feeds combinedScore or action; the
// penalty-only dampener contract ("direction never flips") stays intact.
const DIVERGENCE_NEWS_MIN = 10; // matches the news sentiment band
const DIVERGENCE_BIAS_MIN = 15;

// Same record-a-reason pattern as indicators.service.js's composite score — one
// entry for the news side, one for the options side, so the verdict is backed by
// the same two numbers the UI already shows rather than just a canned sentence.
function divergenceReasons(newsScore, optionsBias, factors) {
  const reasons = [
    {
      factor: "News sentiment",
      direction: newsScore > 0 ? "bullish" : newsScore < 0 ? "bearish" : "neutral",
      why: `Headline sentiment scores ${newsScore > 0 ? "+" : ""}${newsScore.toFixed(1)} — ${Math.abs(newsScore) < DIVERGENCE_NEWS_MIN ? "too weak to count as real conviction" : newsScore > 0 ? "leaning bullish" : "leaning bearish"}.`,
    },
    {
      factor: "Options positioning",
      direction: optionsBias > 0 ? "bullish" : optionsBias < 0 ? "bearish" : "neutral",
      why: `Options positioning scores ${optionsBias > 0 ? "+" : ""}${optionsBias.toFixed(1)} — ${Math.abs(optionsBias) < DIVERGENCE_BIAS_MIN ? "too weak to count as real conviction" : optionsBias > 0 ? "pricing skewed bullish" : "pricing skewed bearish"}.`,
    },
  ];
  if (Number.isFinite(factors?.ivSkew)) {
    reasons.push({
      factor: "25Δ IV skew (put − call)",
      direction: factors.ivSkew > 0.01 ? "bearish" : factors.ivSkew < -0.01 ? "bullish" : "neutral",
      why: `Put IV sits ${(factors.ivSkew * 100).toFixed(1)}pts ${factors.ivSkew >= 0 ? "above" : "below"} call IV — ${factors.ivSkew > 0.01 ? "the market is paying up for downside protection" : factors.ivSkew < -0.01 ? "the market is paying up for upside exposure" : "no meaningful skew"}.`,
    });
  }
  if (Number.isFinite(factors?.oiRatio)) {
    reasons.push({
      factor: "Put/call open interest",
      direction: factors.oiRatio > 1.1 ? "bearish" : factors.oiRatio < 0.9 ? "bullish" : "neutral",
      why: `Put/call open interest ratio is ${factors.oiRatio.toFixed(2)} — ${factors.oiRatio > 1.1 ? "more open interest sits in puts, a hedging/bearish lean" : factors.oiRatio < 0.9 ? "more open interest sits in calls, a bullish lean" : "roughly balanced between puts and calls"}.`,
    });
  }
  return reasons;
}

export function assessDivergence(newsScore, optionsBias, factors = null) {
  const reasons = divergenceReasons(newsScore, optionsBias, factors);
  if (Math.abs(newsScore) < DIVERGENCE_NEWS_MIN || Math.abs(optionsBias) < DIVERGENCE_BIAS_MIN) {
    return { verdict: "neutral", implication: "Neither news flow nor options positioning shows strong conviction.", reasons };
  }
  if (Math.sign(newsScore) === Math.sign(optionsBias)) {
    const lean = newsScore > 0 ? "bullish" : "bearish";
    return { verdict: "aligned", implication: `News flow and options positioning both lean ${lean} — confirmation.`, reasons };
  }
  if (newsScore > 0) {
    return {
      verdict: "divergent",
      implication: "Headlines lean bullish but options are pricing downside protection — contrarian caution on calls.",
      reasons,
    };
  }
  return {
    verdict: "divergent",
    implication: "Headlines lean bearish but options positioning looks complacent — downside moves could be sharp; puts relatively cheap.",
    reasons,
  };
}

// Combines technical composite score with news sentiment into one -100..100 signal.
export function computeSignal(snapshot, news) {
  const indicators = computeIndicators(candlesFor(snapshot, "1d"));
  if (indicators.insufficientData) {
    return { action: "hold", reason: "insufficient candle data", indicators, techScore: 0, newsScore: 0, combinedScore: 0 };
  }
  const techScore = indicators.composite.score;
  const newsScore = news?.overall?.score ?? 0;
  // Technicals weighted higher than news; news nudges/confirms rather than dominates.
  const directionalScore = techScore * 0.75 + newsScore * 0.25;

  // Options conditions (IV richness, spreads, liquidity) dampen conviction — a -100
  // environment halves the directional score; a greeks-free snapshot changes nothing.
  const { optionsScore, optionsFactors } = computeOptionsScore(snapshot);
  const combinedScore = Number((directionalScore * (1 + optionsScore / 200)).toFixed(1));

  let action = "hold";
  if (combinedScore >= RISK.minSignalScoreToTrade) action = "buy_call";
  else if (combinedScore <= -RISK.minSignalScoreToTrade) action = "buy_put";

  // Directional comparison for the UI — informational only, never moves the score
  const biasChain = optionsFactors ? snapshot.chains?.[optionsFactors.expiration] : null;
  const { bias: optionsBias, factors: biasFactors } = biasChain
    ? computeOptionsBias(biasChain, snapshot.underlying?.price)
    : { bias: 0, factors: null };
  const { verdict, implication, reasons: divergenceReasonList } = assessDivergence(newsScore, optionsBias, biasFactors);

  // Volatility surface + dealer gamma exposure — informational context alongside
  // newsVsOptions, same "never touches combinedScore/action" contract.
  const volSurface = optionsFactors ? computeVolSurface(snapshot, optionsFactors.expiration) : { skew: null, term: null, vol: null };
  const gammaExposure = computeGammaExposure(snapshot);

  const optionsNote = optionsScore < 0 ? `, options=${optionsScore.toFixed(1)}` : "";
  return {
    action,
    combinedScore,
    techScore,
    newsScore,
    optionsScore,
    optionsFactors,
    volSurface,
    gammaExposure,
    newsVsOptions: {
      newsScore,
      newsSentiment: news?.overall?.sentiment ?? "unknown",
      sampleSize: news?.overall?.sampleSize ?? 0,
      optionsBias,
      verdict,
      implication,
      factors: biasFactors,
      reasons: divergenceReasonList,
    },
    indicators,
    reason: `tech=${techScore.toFixed(1)} (${indicators.composite.label}), news=${newsScore.toFixed(1)} (${news?.overall?.sentiment ?? "unknown"})${optionsNote}`,
  };
}

// Given current portfolio + a signal, decide what simulated trade(s) to place.
// Pure function — no I/O, no mutation — so it's easy to test and to call from
// both the autopilot loop and any manual "suggest a trade" UI action.
export function decideTrade({ signal, snapshot, portfolio, dayPnlPct }) {
  const { cash, positions } = portfolio;
  const equity = portfolio.equity;

  if (dayPnlPct <= -RISK.maxDailyLossPct * 100) {
    return { type: "none", reason: `Daily loss limit hit (${dayPnlPct.toFixed(1)}%) — no new positions today.` };
  }
  if (positions.length >= RISK.maxOpenPositions) {
    return { type: "none", reason: `Max open positions (${RISK.maxOpenPositions}) reached.` };
  }
  if (signal.action === "hold") {
    return { type: "none", reason: signal.reason };
  }

  const type = signal.action === "buy_call" ? "call" : "put";
  const spot = snapshot?.underlying?.price;
  if (!Number.isFinite(spot)) return { type: "none", reason: "No underlying price in snapshot." };
  const expiration = pickExpiration(snapshot.expirations || [], snapshot.chains || {}, spot);
  if (!expiration) return { type: "none", reason: "No usable expiration in snapshot." };
  const chain = snapshot.chains[expiration];

  // Delta-targeted selection when the chain carries greeks; otherwise the legacy 1%-OTM rule.
  const hasDeltas = chain?.strikes?.some((s) => Number.isFinite(s[type]?.delta));
  const strikeRow = hasDeltas ? pickStrikeByDelta(chain, type, RISK.targetDelta) : pickStrike(chain, spot, type);
  if (!strikeRow) {
    return {
      type: "none",
      reason: hasDeltas ? "No strike passed delta/liquidity filters (OI/spread too thin)." : "No strikes available for expiration.",
    };
  }

  const quote = strikeRow[type];
  const mid = (quote.bid + quote.ask) / 2;
  if (!(mid > 0)) return { type: "none", reason: "Invalid quote for selected strike." };

  const maxSpend = equity * RISK.maxPositionPctOfEquity;
  const contractCost = mid * 100;
  let qty = Math.floor(Math.min(maxSpend, cash) / contractCost);
  if (qty < 1) return { type: "none", reason: "Position size limit / cash too low for 1 contract." };

  return {
    type: "open",
    order: {
      optionType: type,
      strike: strikeRow.strike,
      expiration,
      qty,
      price: mid,
      cost: mid * 100 * qty,
      // greeks at entry (when known) — recorded for the trade log, not used for sizing
      delta: Number.isFinite(quote.delta) ? quote.delta : null,
      iv: Number.isFinite(quote.iv) ? quote.iv : null,
      theta: Number.isFinite(quote.theta) ? quote.theta : null,
    },
    reason: signal.reason,
    signal,
  };
}

// Evaluate open positions against stop-loss / take-profit rules.
export function decideExits(positions) {
  const exits = [];
  for (const p of positions) {
    const mark = p.mark ?? p.entryPrice;
    const pnlPct = (mark - p.entryPrice) / p.entryPrice;
    if (pnlPct <= -RISK.stopLossPct) {
      exits.push({ position: p, reason: `Stop-loss hit (${(pnlPct * 100).toFixed(1)}%)` });
    } else if (pnlPct >= RISK.takeProfitPct) {
      exits.push({ position: p, reason: `Take-profit hit (+${(pnlPct * 100).toFixed(1)}%)` });
    }
  }
  return exits;
}
