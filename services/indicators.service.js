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

function vwap(bars) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumVol = 0;
  for (let i = 0; i < bars.length; i++) {
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

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

// Computes the full indicator suite and a simple composite signal from OHLCV bars.
export function computeIndicators(bars) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return { insufficientData: true };
  }
  const closes = bars.map((b) => b.close);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes);
  const bb = bollingerBands(closes, 20, 2);
  const vwapSeries = vwap(bars);
  const atr14 = atr(bars, 14);
  const stoch = stochastic(bars, 14, 3);

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

  // Composite scoring: each signal votes -1..+1, averaged into one -100..+100 score.
  const votes = [];
  if (lastRsi != null) votes.push(lastRsi < 30 ? 1 : lastRsi > 70 ? -1 : (50 - lastRsi) / 20);
  if (lastMacd != null && lastSignal != null) votes.push(lastMacd > lastSignal ? 1 : -1);
  if (lastSma20 != null && lastSma50 != null) votes.push(lastSma20 > lastSma50 ? 1 : -1);
  if (lastBBUpper != null && lastBBLower != null) {
    if (price <= lastBBLower) votes.push(1);
    else if (price >= lastBBUpper) votes.push(-1);
    else votes.push(0);
  }
  if (lastK != null && lastD != null) votes.push(lastK < 20 ? 1 : lastK > 80 ? -1 : lastK > lastD ? 0.3 : -0.3);
  if (lastVwap != null) votes.push(price > lastVwap ? 0.5 : -0.5);

  const score = votes.length ? (votes.reduce((a, b) => a + b, 0) / votes.length) * 100 : 0;
  const label = score >= 40 ? "strong_buy" : score >= 12 ? "buy" : score <= -40 ? "strong_sell" : score <= -12 ? "sell" : "neutral";

  return {
    series: {
      sma20,
      sma50,
      ema12,
      ema26,
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
    },
    composite: { score: Number(score.toFixed(1)), label },
  };
}
