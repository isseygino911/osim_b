// Pure technical-analysis math over OHLCV candles: [{ t, open, high, low, close, volume }], oldest first.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const macdValues = macdLine.filter((v) => v != null);
  const signalRaw = ema(macdValues, signalPeriod);
  const signalLine = new Array(closes.length).fill(null);
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] != null) {
      signalLine[i] = signalRaw[j] ?? null;
      j++;
    }
  }
  const histogram = closes.map((_, i) => (macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null));
  return { macdLine, signalLine, histogram };
}

function bollingerBands(closes, period = 20, stdDevMult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + stdDevMult * sd;
    lower[i] = mean - stdDevMult * sd;
  }
  return { upper, mid, lower };
}

// Session VWAP: resets its cumulative sum/volume at each new calendar day (UTC date of
// bar.t) rather than accumulating over the whole array — real VWAP is anchored to the
// start of the trading session, not an all-time average. Assumes intraday bars; the
// caller skips this entirely for the "1d" interval, where every bar is its own session
// and a reset VWAP would just equal that bar's own typical price.
function vwap(bars) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumVol = 0;
  let sessionDay = null;
  for (let i = 0; i < bars.length; i++) {
    const day = bars[i].t.slice(0, 10);
    if (day !== sessionDay) {
      sessionDay = day;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    cumPV += typical * bars[i].volume;
    cumVol += bars[i].volume;
    out[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return out;
}

function atr(bars, period = 14) {
  const trs = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  return ema(trs, period);
}

function stochastic(bars, period = 14, smoothK = 3) {
  const rawK = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    const slice = bars.slice(i - period + 1, i + 1);
    const hi = Math.max(...slice.map((b) => b.high));
    const lo = Math.min(...slice.map((b) => b.low));
    rawK[i] = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
  }
  const validK = rawK.filter((v) => v != null);
  const smoothed = sma(validK, smoothK);
  const kOut = new Array(bars.length).fill(null);
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    if (rawK[i] != null) {
      kOut[i] = smoothed[j] ?? null;
      j++;
    }
  }
  // %D is an SMA of %K. It has to be averaged over the compacted valid values
  // (same as %K above) — feeding the null-padded array in poisons sma()'s
  // running sum with NaN and every output comes back null.
  const dSmoothed = sma(kOut.filter((v) => v != null), 3);
  const dOut = new Array(bars.length).fill(null);
  let m = 0;
  for (let i = 0; i < bars.length; i++) {
    if (kOut[i] != null) {
      dOut[i] = dSmoothed[m] ?? null;
      m++;
    }
  }
  return { k: kOut, d: dOut };
}

// Wilder-smoothed +DI/-DI/ADX. Deliberately not built on ema() — Wilder's alpha (1/period)
// differs from the standard EMA alpha (2/(period+1)) used everywhere else in this file.
function adx(bars, period = 14) {
  const n = bars.length;
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const adxOut = new Array(n).fill(null);
  if (n <= period) return { adx: adxOut, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }

  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smoothTR += tr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }
  const dx = new Array(n).fill(null);
  const setDI = (i) => {
    plusDI[i] = smoothTR === 0 ? 0 : (100 * smoothPlusDM) / smoothTR;
    minusDI[i] = smoothTR === 0 ? 0 : (100 * smoothMinusDM) / smoothTR;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  };
  setDI(period);
  for (let i = period + 1; i < n; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    setDI(i);
  }

  const firstAdxIdx = 2 * period - 1;
  if (firstAdxIdx < n) {
    let sumDx = 0;
    for (let i = period; i <= firstAdxIdx; i++) sumDx += dx[i];
    let prevAdx = sumDx / period;
    adxOut[firstAdxIdx] = prevAdx;
    for (let i = firstAdxIdx + 1; i < n; i++) {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
      adxOut[i] = prevAdx;
    }
  }

  return { adx: adxOut, plusDI, minusDI };
}

// Stochastic oscillator applied to RSI instead of price — more sensitive, more whipsaw-prone.
function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const n = closes.length;
  const rsiSeries = rsi(closes, rsiPeriod);
  // compact to a null-free series so the raw-%K window can slice by count, not index
  const validRsi = rsiSeries.filter((v) => v != null);
  const rawKCompact = new Array(validRsi.length).fill(null);
  for (let i = stochPeriod - 1; i < validRsi.length; i++) {
    const slice = validRsi.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...slice);
    const lo = Math.min(...slice);
    rawKCompact[i] = hi === lo ? 50 : ((validRsi[i] - lo) / (hi - lo)) * 100;
  }

  // %K/%D smoothing must run over the compacted non-null values, same reasoning as
  // stochastic() above — sma() fed a null-padded array poisons its running sum.
  const kSmoothedCompact = sma(rawKCompact.filter((v) => v != null), kSmooth);
  const kCompact = new Array(validRsi.length).fill(null);
  let j = 0;
  for (let i = 0; i < validRsi.length; i++) {
    if (rawKCompact[i] != null) {
      kCompact[i] = kSmoothedCompact[j] ?? null;
      j++;
    }
  }
  const dSmoothedCompact = sma(kCompact.filter((v) => v != null), dSmooth);
  const dCompact = new Array(validRsi.length).fill(null);
  let m = 0;
  for (let i = 0; i < validRsi.length; i++) {
    if (kCompact[i] != null) {
      dCompact[i] = dSmoothedCompact[m] ?? null;
      m++;
    }
  }

  // expand both compacted series back to full, null-padded-at-head alignment with closes
  const kOut = new Array(n).fill(null);
  const dOut = new Array(n).fill(null);
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (rsiSeries[i] == null) continue;
    kOut[i] = kCompact[c] ?? null;
    dOut[i] = dCompact[c] ?? null;
    c++;
  }
  return { k: kOut, d: dOut };
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

// Resolves a snapshot's candles for a given interval. Snapshots may still hold a legacy
// flat array (pre-multi-interval) — that array is treated as "1d" data.
export function candlesFor(snapshot, interval = "1d") {
  const c = snapshot?.candles;
  if (Array.isArray(c)) return interval === "1d" ? c : [];
  return c?.[interval] || [];
}

// Computes the full indicator suite and a simple composite signal from OHLCV bars.
// VWAP is a session-based (intraday) concept — on "1d" bars each candle is already its
// own session, so a session-reset VWAP would be degenerate (equal to that bar's own
// typical price); it's skipped entirely there and returned as an all-null series.
export function computeIndicators(bars, interval = "1d") {
  if (!Array.isArray(bars) || bars.length < 2) {
    return { insufficientData: true };
  }
  const closes = bars.map((b) => b.close);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes);
  const bb = bollingerBands(closes, 20, 2);
  const vwapSeries = interval === "1d" ? new Array(bars.length).fill(null) : vwap(bars);
  const atr14 = atr(bars, 14);
  const stoch = stochastic(bars, 14, 3);
  const adxRes = adx(bars, 14);
  const stochRsiRes = stochRsi(closes, 14, 14, 3, 3);

  const price = closes[closes.length - 1];
  const lastRsi = last(rsi14);
  const lastMacd = last(macdLine);
  const lastSignal = last(signalLine);
  const lastHist = last(histogram);
  const lastBBUpper = last(bb.upper);
  const lastBBLower = last(bb.lower);
  const lastSma20 = last(sma20);
  const lastSma50 = last(sma50);
  const lastVwap = last(vwapSeries);
  const lastAtr = last(atr14);
  const lastK = last(stoch.k);
  const lastD = last(stoch.d);
  const lastAdx = last(adxRes.adx);
  const lastPlusDI = last(adxRes.plusDI);
  const lastMinusDI = last(adxRes.minusDI);

  // Composite scoring: each signal votes -1..+1, averaged into one -100..+100 score.
  // Every vote is recorded alongside a plain-English reason so the composite label
  // (STRONG BUY/SELL/etc.) can be explained, not just stated.
  const votes = [];
  const reasons = [];
  const record = (indicator, vote, why) => {
    votes.push(vote);
    reasons.push({ indicator, vote: Number(vote.toFixed(2)), direction: vote > 0 ? "bullish" : vote < 0 ? "bearish" : "neutral", why });
  };

  if (lastRsi != null) {
    if (lastRsi < 30) record("RSI (14)", 1, `RSI is ${lastRsi.toFixed(1)}, below 30 — oversold, often precedes a bounce.`);
    else if (lastRsi > 70) record("RSI (14)", -1, `RSI is ${lastRsi.toFixed(1)}, above 70 — overbought, often precedes a pullback.`);
    else record("RSI (14)", (50 - lastRsi) / 20, `RSI is ${lastRsi.toFixed(1)}, in the neutral 30-70 band; leans slightly ${lastRsi < 50 ? "bullish" : "bearish"} since it's ${lastRsi < 50 ? "below" : "above"} the midpoint 50.`);
  }
  if (lastMacd != null && lastSignal != null) {
    const above = lastMacd > lastSignal;
    record("MACD", above ? 1 : -1, `MACD line (${lastMacd.toFixed(2)}) is ${above ? "above" : "below"} its signal line (${lastSignal.toFixed(2)}) — momentum is ${above ? "picking up to the upside" : "fading to the downside"}.`);
  }
  if (lastSma20 != null && lastSma50 != null) {
    const above = lastSma20 > lastSma50;
    record("SMA 20/50", above ? 1 : -1, `The 20-period average (${lastSma20.toFixed(2)}) is ${above ? "above" : "below"} the 50-period average (${lastSma50.toFixed(2)}) — the shorter-term trend is ${above ? "up" : "down"} relative to the longer-term one.`);
  }
  if (lastBBUpper != null && lastBBLower != null) {
    if (price <= lastBBLower) record("Bollinger Bands", 1, `Price (${price.toFixed(2)}) is at/below the lower band (${lastBBLower.toFixed(2)}) — stretched to the downside, a mean-reversion bounce is more likely.`);
    else if (price >= lastBBUpper) record("Bollinger Bands", -1, `Price (${price.toFixed(2)}) is at/above the upper band (${lastBBUpper.toFixed(2)}) — stretched to the upside, a mean-reversion pullback is more likely.`);
    else record("Bollinger Bands", 0, `Price (${price.toFixed(2)}) sits inside the bands (${lastBBLower.toFixed(2)}-${lastBBUpper.toFixed(2)}) — no extreme, no vote either way.`);
  }
  if (lastK != null && lastD != null) {
    if (lastK < 20) record("Stochastic", 1, `Stochastic %K is ${lastK.toFixed(1)}, below 20 — oversold.`);
    else if (lastK > 80) record("Stochastic", -1, `Stochastic %K is ${lastK.toFixed(1)}, above 80 — overbought.`);
    else if (lastK > lastD) record("Stochastic", 0.3, `Stochastic %K (${lastK.toFixed(1)}) is above %D (${lastD.toFixed(1)}) — mild upward momentum, but not in an extreme zone.`);
    else record("Stochastic", -0.3, `Stochastic %K (${lastK.toFixed(1)}) is below %D (${lastD.toFixed(1)}) — mild downward momentum, but not in an extreme zone.`);
  }
  if (lastVwap != null) {
    const above = price > lastVwap;
    record("VWAP", above ? 0.5 : -0.5, `Price (${price.toFixed(2)}) is trading ${above ? "above" : "below"} session VWAP (${lastVwap.toFixed(2)}) — the average trader today is ${above ? "underwater, favoring buyers" : "in profit, favoring sellers"}.`);
  }
  // ADX itself is non-directional (trend strength only); the DI cross supplies direction,
  // gated by ADX>=25 so a choppy/sideways market doesn't cast a vote at all. Weighted below
  // the +/-1 votes since DI crosses are noisier. StochRSI deliberately does NOT vote here —
  // it's a derivative of RSI, which already votes, and would triple-count the same momentum.
  if (lastAdx != null && lastPlusDI != null && lastMinusDI != null) {
    if (lastAdx >= 25) {
      const bullish = lastPlusDI > lastMinusDI;
      record("ADX/DI", bullish ? 0.75 : -0.75, `ADX is ${lastAdx.toFixed(1)} (>=25, a real trend) and +DI (${lastPlusDI.toFixed(1)}) is ${bullish ? "above" : "below"} -DI (${lastMinusDI.toFixed(1)}) — trending ${bullish ? "up" : "down"}.`);
    } else {
      record("ADX/DI", 0, `ADX is ${lastAdx.toFixed(1)}, below 25 — no established trend, so the +DI/-DI cross is ignored.`);
    }
  }

  const score = votes.length ? (votes.reduce((a, b) => a + b, 0) / votes.length) * 100 : 0;
  const label = score >= 40 ? "strong_buy" : score >= 12 ? "buy" : score <= -40 ? "strong_sell" : score <= -12 ? "sell" : "neutral";
  const topDrivers = reasons
    .filter((r) => r.direction !== "neutral")
    .sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote));

  return {
    series: {
      sma20,
      sma50,
      ema12,
      ema26,
      ema9,
      ema21,
      ema50,
      rsi14,
      macdLine,
      signalLine,
      histogram,
      bbUpper: bb.upper,
      bbMid: bb.mid,
      bbLower: bb.lower,
      vwap: vwapSeries,
      atr14,
      stochK: stoch.k,
      stochD: stoch.d,
      adx14: adxRes.adx,
      plusDI: adxRes.plusDI,
      minusDI: adxRes.minusDI,
      stochRsiK: stochRsiRes.k,
      stochRsiD: stochRsiRes.d,
    },
    latest: {
      price,
      rsi14: lastRsi,
      macd: lastMacd,
      macdSignal: lastSignal,
      macdHistogram: lastHist,
      sma20: lastSma20,
      sma50: lastSma50,
      bbUpper: lastBBUpper,
      bbLower: lastBBLower,
      vwap: lastVwap,
      atr14: lastAtr,
      stochK: lastK,
      stochD: lastD,
      ema9: last(ema9),
      ema21: last(ema21),
      ema50: last(ema50),
      adx14: lastAdx,
      plusDI: lastPlusDI,
      minusDI: lastMinusDI,
      stochRsiK: last(stochRsiRes.k),
      stochRsiD: last(stochRsiRes.d),
    },
    composite: { score: Number(score.toFixed(1)), label, reasons, topDrivers },
  };
}
