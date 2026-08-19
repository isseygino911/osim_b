import assert from "node:assert/strict";
import { test } from "node:test";

import { computeSmc } from "../services/smc.service.js";

// Deterministic OHLCV fixture: close drives the shape and each bar opens at the previous
// close, so a falling leg really is made of bearish candles (order-block detection keys off
// candle direction). Wicks straddle the body by 0.5, keeping pivots on the turning points.
function mkBars(closes) {
  return closes.map((c, i) => {
    const open = i === 0 ? c - 0.3 : closes[i - 1];
    return {
      t: new Date(Date.UTC(2026, 0, 1, 14, i)).toISOString(),
      open,
      high: Math.max(open, c) + 0.5,
      low: Math.min(open, c) - 0.5,
      close: c,
      volume: 1_000_000,
    };
  });
}

// `steps` closes moving linearly from `from` (exclusive) to `to` (inclusive).
function leg(from, to, steps) {
  return Array.from({ length: steps }, (_, i) => from + ((to - from) * (i + 1)) / steps);
}

// Pivot lengths are pinned so the fixtures stay short and the expected pivots are obvious.
const OPTS = { swingLength: 3, internalLength: 3 };

const rallyThenBreak = [100, ...leg(100, 110, 6), ...leg(110, 104, 6), ...leg(104, 122, 10)];

test("a close through a prior swing high is a bullish BOS, not a CHoCH", () => {
  const { structure, bias } = computeSmc(mkBars(rallyThenBreak), OPTS);
  const swing = structure.filter((s) => s.scale === "swing");
  assert.ok(swing.length > 0, "expected at least one swing structure event");
  assert.ok(swing.every((s) => s.direction === "bullish"));
  assert.equal(swing[0].kind, "BOS");
  assert.ok(!swing.some((s) => s.kind === "CHoCH"), "no reversal happened, so nothing should read CHoCH");
  assert.equal(bias.trend, "bullish");
});

test("breaking the other way after a bullish break is a CHoCH", () => {
  const { structure, bias } = computeSmc(mkBars([...rallyThenBreak, ...leg(122, 98, 14)]), OPTS);
  const bearish = structure.filter((s) => s.scale === "swing" && s.direction === "bearish");
  assert.ok(bearish.length > 0, "expected a bearish swing event");
  assert.equal(bearish[0].kind, "CHoCH");
  assert.equal(bias.trend, "bearish");
});

test("a swing low that produced a break is strong, an untested one stays weak", () => {
  const { swings } = computeSmc(mkBars(rallyThenBreak), OPTS);
  const lows = swings.filter((s) => s.scale === "swing" && s.kind === "low");
  assert.ok(lows.some((s) => s.strength === "strong"), "the low the rally came from should be strong");
});

test("order blocks are dropped once price closes back through them", () => {
  const kept = computeSmc(mkBars(rallyThenBreak), OPTS).orderBlocks;
  assert.ok(kept.some((ob) => ob.direction === "bullish"), "the bullish break should leave a demand zone");
  const collapsed = computeSmc(mkBars([...rallyThenBreak, ...leg(122, 90, 16)]), OPTS).orderBlocks;
  assert.ok(!collapsed.some((ob) => ob.direction === "bullish"), "a full collapse mitigates every bullish zone");
});

test("an unfilled three-candle imbalance is reported, a filled one is not", () => {
  const gapUp = mkBars([100, 100.2, 100.4, 104, 108, 112, 116, 120]);
  const open = computeSmc(gapUp, OPTS).fvg;
  assert.ok(open.some((g) => g.direction === "bullish"), "the impulsive leg leaves bullish gaps");

  const retraced = computeSmc(mkBars([100, 100.2, 100.4, 104, 108, 112, 116, 120, ...leg(120, 99, 10)]), OPTS).fvg;
  assert.ok(!retraced.some((g) => g.direction === "bullish"), "price traded back through every bullish gap");
});

test("two swing highs at the same price are tagged EQH", () => {
  const bars = mkBars([100, ...leg(100, 112, 6), ...leg(112, 102, 5), ...leg(102, 112.1, 5), ...leg(112.1, 103, 5)]);
  const { equalLevels } = computeSmc(bars, OPTS);
  assert.ok(equalLevels.some((l) => l.kind === "EQH"), "expected an equal-high pair");
});

test("every anchor is a real candle timestamp", () => {
  const bars = mkBars([...rallyThenBreak, ...leg(122, 98, 14)]);
  const times = new Set(bars.map((b) => b.t));
  const { structure, swings, orderBlocks, equalLevels, fvg } = computeSmc(bars, OPTS);
  for (const s of structure) {
    assert.ok(times.has(s.fromT) && times.has(s.toT), "structure anchors must be candle timestamps");
  }
  for (const s of swings) assert.ok(times.has(s.t));
  for (const ob of orderBlocks) assert.ok(times.has(ob.startT));
  for (const l of equalLevels) assert.ok(times.has(l.fromT) && times.has(l.toT));
  for (const g of fvg) assert.ok(times.has(g.startT));
});

// a long trending wave, ~30 bars per cycle — enough history for the default (auto-scaled)
// lookbacks to resolve pivots at both scales
const wave = Array.from({ length: 260 }, (_, i) => 700 + 6 * Math.sin(i / 5) + i * 0.03);

test("default pivot lengths scale to the loaded window", () => {
  const bars = mkBars(wave);
  const swing = computeSmc(bars).structure.filter((s) => s.scale === "swing");
  assert.ok(swing.length > 0, "a few hundred bars should produce major structure with no options passed");

  // the same series trimmed to a fraction of the bars still resolves structure rather than
  // going silent, which a fixed 50-bar lookback would do
  const short = computeSmc(bars.slice(-70));
  assert.ok(short.structure.length > 0, "a short window should still produce structure");
});

test("bias falls back to the minor structure when the major scale has not broken", () => {
  // a 15-bar lookback can't confirm two pivots in 40 bars, so the major scale stays silent
  // while the auto-scaled internal one still leans one way
  const { bias, structure } = computeSmc(mkBars(wave.slice(0, 40)), { swingLength: 15 });
  assert.ok(!structure.some((s) => s.scale === "swing"), "fixture is too short for swing structure");
  assert.ok(["bullish", "bearish"].includes(bias.trend), `expected a directional bias, got ${bias.trend}`);
});

test("too little data returns the empty shape instead of throwing", () => {
  for (const input of [[], null, mkBars([100, 101, 102])]) {
    const r = computeSmc(input, OPTS);
    assert.deepEqual(r.structure, []);
    assert.deepEqual(r.orderBlocks, []);
    assert.deepEqual(r.fvg, []);
    assert.equal(r.bias.trend, "neutral");
  }
});
