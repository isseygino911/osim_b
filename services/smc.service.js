// Smart Money Concepts: market structure (BOS/CHoCH), order blocks, equal highs/lows and
// fair value gaps over OHLCV candles: [{ t, open, high, low, close, volume }], oldest first.
// Pure/I-O-free, same contract as indicators.service.js.
//
// Every anchor in the returned shape is an ISO timestamp, never a bar index — the client
// trims candles to a visible date range, and index anchors would silently desync from it.

const SWING_LENGTH = 50; // pivot lookback ceiling for the major ("swing") structure
const INTERNAL_LENGTH = 5; // pivot lookback ceiling for the minor ("internal") structure
const BARS_PER_SWING = 20; // auto-scaling target: roughly one major pivot per this many bars
const EQUAL_ATR_MULT = 0.1; // two pivots within this * ATR of each other count as equal
const MAX_ORDER_BLOCKS = 5; // per direction, newest kept
const MAX_FVG = 10;
const ATR_PERIOD = 14;

// Rolling-mean true range. Used only as the yardstick for "equal" highs/lows, so a plain
// mean (rather than indicators.service.js' Wilder smoothing) is precise enough here.
function atrSeries(bars, period = ATR_PERIOD) {
  const out = new Array(bars.length).fill(null);
  const trs = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period) sum -= trs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  // head padding would leave early pivots without a tolerance — fall back to the first
  // resolved value so equal-level detection still runs at the start of a short series
  const first = out.find((v) => v != null) ?? null;
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = first;
  return out;
}

// A pivot high is the maximum of the [i-len, i+len] window, and is only *known* len bars
// after the fact — that confirmation delay is what the structure walk below replays, so a
// break can never be detected against a pivot the market hadn't formed yet.
// Ties break to the left (bars before must be strictly lower, bars after may equal), so a
// flat double-top yields one pivot at its first bar instead of none at all.
function findPivots(bars, len, side) {
  const key = side === "high" ? "high" : "low";
  const out = [];
  for (let i = len; i < bars.length - len; i++) {
    const v = bars[i][key];
    let ok = true;
    for (let j = i - len; j <= i + len; j++) {
      if (j === i) continue;
      const other = bars[j][key];
      const beats = j < i ? (side === "high" ? other >= v : other <= v) : side === "high" ? other > v : other < v;
      if (beats) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ index: i, price: v, side, strength: "weak" });
  }
  return out;
}

// The order block behind a break: the last candle opposing the impulse, between the broken
// pivot and the bar that closed through it. Its full range becomes the zone. An unbroken
// run of same-direction candles has no opposing bar at all — the impulse's extreme candle
// stands in for it there, which is where the move originated either way.
function orderBlockFor(bars, fromIndex, toIndex, direction) {
  let extreme = null;
  for (let i = toIndex; i > fromIndex; i--) {
    const bearish = bars[i].close < bars[i].open;
    if (direction === "bullish" ? bearish : !bearish) {
      return { direction, top: bars[i].high, bottom: bars[i].low, index: i };
    }
    if (
      extreme === null ||
      (direction === "bullish" ? bars[i].low < bars[extreme].low : bars[i].high > bars[extreme].high)
    ) {
      extreme = i;
    }
  }
  return extreme === null ? null : { direction, top: bars[extreme].high, bottom: bars[extreme].low, index: extreme };
}

// Walks the bars once, in confirmation order, tracking the unbroken pivot high/low. A close
// through one is a BOS when it continues the prevailing trend and a CHoCH when it reverses it.
function detectStructure(bars, len, scale) {
  const structure = [];
  const swings = [];
  const orderBlocks = [];
  const highs = findPivots(bars, len, "high");
  const lows = findPivots(bars, len, "low");
  for (const p of [...highs, ...lows]) p.scale = scale;
  const confirmAt = new Map(); // bar index -> pivots that become known on that bar
  for (const p of [...highs, ...lows]) {
    const at = p.index + len;
    if (!confirmAt.has(at)) confirmAt.set(at, []);
    confirmAt.get(at).push(p);
  }

  let currentHigh = null;
  let currentLow = null;
  let trend = 0; // 1 bullish, -1 bearish, 0 undecided

  for (let i = 0; i < bars.length; i++) {
    for (const p of confirmAt.get(i) ?? []) {
      swings.push(p);
      if (p.side === "high") currentHigh = p;
      else currentLow = p;
    }

    const close = bars[i].close;
    if (currentHigh && close > currentHigh.price) {
      const kind = trend === -1 ? "CHoCH" : "BOS";
      structure.push({ kind, direction: "bullish", scale, price: currentHigh.price, fromIndex: currentHigh.index, toIndex: i });
      // the low the rally came from held and produced a break — that makes it a strong low;
      // the high price just ran through failed as resistance and stays weak
      if (currentLow) currentLow.strength = "strong";
      const ob = orderBlockFor(bars, currentHigh.index, i, "bullish");
      if (ob) orderBlocks.push({ ...ob, scale });
      trend = 1;
      currentHigh = null;
    } else if (currentLow && close < currentLow.price) {
      const kind = trend === 1 ? "CHoCH" : "BOS";
      structure.push({ kind, direction: "bearish", scale, price: currentLow.price, fromIndex: currentLow.index, toIndex: i });
      if (currentHigh) currentHigh.strength = "strong";
      const ob = orderBlockFor(bars, currentLow.index, i, "bearish");
      if (ob) orderBlocks.push({ ...ob, scale });
      trend = -1;
      currentLow = null;
    }
  }

  return { structure, swings, orderBlocks, trend };
}

// Two consecutive same-side pivots sitting within EQUAL_ATR_MULT * ATR of each other —
// the liquidity pools price tends to sweep before reversing.
function findEqualLevels(swings, bars, atr, mult) {
  const out = [];
  for (const side of ["high", "low"]) {
    const list = swings.filter((s) => s.side === side);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const tol = (atr[b.index] ?? 0) * mult;
      if (tol > 0 && Math.abs(a.price - b.price) <= tol) {
        out.push({
          kind: side === "high" ? "EQH" : "EQL",
          price: (a.price + b.price) / 2,
          fromT: bars[a.index].t,
          toT: bars[b.index].t,
        });
      }
    }
  }
  return out;
}

// Three-candle imbalance: the wick of bar i never overlaps bar i-2's, leaving an untraded
// pocket that price commonly returns to fill. Filled gaps are dropped rather than drawn.
function findFvg(bars, maxKeep) {
  const open = [];
  for (let i = 2; i < bars.length; i++) {
    let gap = null;
    if (bars[i].low > bars[i - 2].high) gap = { direction: "bullish", top: bars[i].low, bottom: bars[i - 2].high, index: i - 1 };
    else if (bars[i].high < bars[i - 2].low) gap = { direction: "bearish", top: bars[i - 2].low, bottom: bars[i].high, index: i - 1 };
    if (!gap) continue;
    let filled = false;
    for (let j = i + 1; j < bars.length; j++) {
      if (gap.direction === "bullish" ? bars[j].low <= gap.bottom : bars[j].high >= gap.top) {
        filled = true;
        break;
      }
    }
    if (!filled) open.push(gap);
  }
  return open.slice(-maxKeep);
}

// Drops zones price has already traded back through, then keeps the newest few per side —
// a chart carrying every historical order block is unreadable.
function liveOrderBlocks(orderBlocks, bars, maxPerSide) {
  const alive = orderBlocks.filter((ob) => {
    for (let j = ob.index + 1; j < bars.length; j++) {
      if (ob.direction === "bullish" ? bars[j].close < ob.bottom : bars[j].close > ob.top) return false;
    }
    return true;
  });
  return [
    ...alive.filter((ob) => ob.direction === "bullish").slice(-maxPerSide),
    ...alive.filter((ob) => ob.direction === "bearish").slice(-maxPerSide),
  ];
}

const biasTrend = (trend) => (trend === 1 ? "bullish" : trend === -1 ? "bearish" : "neutral");

// a factory, not a shared constant — callers get their own arrays to hold onto
const emptySmc = () => ({ structure: [], swings: [], orderBlocks: [], equalLevels: [], fvg: [], bias: { trend: "neutral", lastEvent: null } });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A pivot of length L needs 2L+1 bars to form and several times that to produce structure,
// so the lookback scales with how much history is loaded rather than sitting at a constant.
// The ceilings are the familiar 50/5 — reached once a few thousand bars are on the chart,
// which is the setup those defaults were written for; this chart usually shows hundreds.
function autoLengths(n) {
  const swing = clamp(Math.round(n / BARS_PER_SWING), 6, SWING_LENGTH);
  return { swing, internal: clamp(Math.round(swing / 3), 2, INTERNAL_LENGTH) };
}

export function computeSmc(bars, options = {}) {
  if (!Array.isArray(bars) || bars.length < 5) return emptySmc();
  const n = bars.length;
  const auto = autoLengths(n);
  // Explicitly passed lengths are honored as given — only the defaults auto-scale.
  const {
    swingLength = auto.swing,
    internalLength = auto.internal,
    equalAtrMult = EQUAL_ATR_MULT,
    maxOrderBlocks = MAX_ORDER_BLOCKS,
    maxFvg = MAX_FVG,
  } = options;

  const fit = (len) => clamp(len, 2, Math.max(2, Math.floor((n - 1) / 2)));
  const atr = atrSeries(bars);
  const swing = detectStructure(bars, fit(swingLength), "swing");
  const internal = detectStructure(bars, Math.min(fit(internalLength), fit(swingLength)), "internal");

  const structure = [...swing.structure, ...internal.structure].map((s) => ({
    kind: s.kind,
    direction: s.direction,
    scale: s.scale,
    price: s.price,
    fromT: bars[s.fromIndex].t,
    toT: bars[s.toIndex].t,
  }));

  const swings = [...swing.swings, ...internal.swings]
    .filter((s) => s.side === "high" || s.side === "low")
    .map((s) => ({
      kind: s.side === "high" ? "high" : "low",
      strength: s.strength,
      scale: s.scale,
      price: s.price,
      t: bars[s.index].t,
    }));

  const orderBlocks = liveOrderBlocks([...swing.orderBlocks, ...internal.orderBlocks], bars, maxOrderBlocks).map((ob) => ({
    direction: ob.direction,
    scale: ob.scale,
    top: ob.top,
    bottom: ob.bottom,
    startT: bars[ob.index].t,
  }));

  const equalLevels = findEqualLevels(swing.swings, bars, atr, equalAtrMult);

  const fvg = findFvg(bars, maxFvg).map((g) => ({
    direction: g.direction,
    top: g.top,
    bottom: g.bottom,
    startT: bars[g.index].t,
  }));

  const lastEvent = structure.filter((s) => s.scale === "swing").at(-1) ?? structure.at(-1) ?? null;

  return {
    structure,
    swings,
    orderBlocks,
    equalLevels,
    fvg,
    // the slow scale can go a whole window without breaking anything — the minor structure
    // still says which way the market is leaning, so it stands in rather than reading neutral
    bias: { trend: biasTrend(swing.trend || internal.trend), lastEvent },
  };
}
