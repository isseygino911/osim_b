import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateCandles, isTradierConfigured, mapContract, pickStrikesAroundSpot } from "../services/tradier.service.js";

test("pickStrikesAroundSpot keeps 5 nearest below + 5 at-or-above spot", () => {
  const strikes = [670, 675, 680, 682, 684, 685, 686, 688, 690, 695, 700, 705];
  const kept = pickStrikesAroundSpot(strikes, 685);
  assert.deepEqual([...kept].sort((a, b) => a - b), [670, 675, 680, 682, 684, 685, 686, 688, 690, 695]);
});

test("pickStrikesAroundSpot takes what's available when one side is short", () => {
  const strikes = [683, 684, 685, 686];
  const kept = pickStrikesAroundSpot(strikes, 680);
  assert.deepEqual([...kept].sort((a, b) => a - b), [683, 684, 685, 686]);
});

test("pickStrikesAroundSpot dedupes repeated strikes", () => {
  const kept = pickStrikesAroundSpot([680, 680, 685, 685], 680);
  assert.deepEqual([...kept].sort((a, b) => a - b), [680, 685]);
});

test("mapContract maps Tradier fields onto the schema-v2 contract shape", () => {
  const mapped = mapContract({
    bid: 10.75,
    ask: 10.88,
    last: 10.82,
    open_interest: 4210,
    volume: 1830,
    greeks: { delta: 0.52, gamma: 0.031, theta: -0.42, vega: 0.38, rho: 0.06, mid_iv: 0.216 },
  });
  assert.equal(mapped.bid, 10.75);
  assert.equal(mapped.ask, 10.88);
  assert.equal(mapped.mark, 10.815);
  assert.equal(mapped.delta, 0.52);
  assert.equal(mapped.iv, 0.216);
  assert.equal(mapped.openInterest, 4210);
  assert.equal(mapped.volume, 1830);
});

test("mapContract falls back to bid/ask midpoint when last is missing", () => {
  const mapped = mapContract({ bid: 10, ask: 11, greeks: {} });
  assert.equal(mapped.mark, 10.5);
});

test("mapContract prefers bid/ask midpoint over a stale last price outside the spread", () => {
  // `last` can be a trade from before a fast underlying move — well outside the current
  // bid/ask — which would otherwise poison the server's BS-implied-vol cross-check.
  const mapped = mapContract({ bid: 12.27, ask: 12.44, last: 11.86, greeks: {} });
  assert.equal(mapped.mark, 12.355);
});

test("mapContract falls back to last when bid/ask are both missing", () => {
  const mapped = mapContract({ last: 5.5, greeks: {} });
  assert.equal(mapped.mark, 5.5);
});

test("mapContract falls back to smv_vol when mid_iv is absent", () => {
  const mapped = mapContract({ bid: 1, ask: 1, greeks: { smv_vol: 0.3 } });
  assert.equal(mapped.iv, 0.3);
});

test("aggregateCandles groups bars with correct OHLCV rollup", () => {
  const bars = [
    { t: "2026-07-25T13:30:00Z", open: 1, high: 3, low: 1, close: 2, volume: 100 },
    { t: "2026-07-25T13:45:00Z", open: 2, high: 4, low: 2, close: 3, volume: 200 },
  ];
  const [grouped] = aggregateCandles(bars, 2);
  assert.equal(grouped.t, "2026-07-25T13:30:00Z");
  assert.equal(grouped.open, 1);
  assert.equal(grouped.high, 4);
  assert.equal(grouped.low, 1);
  assert.equal(grouped.close, 3);
  assert.equal(grouped.volume, 300);
});

test("aggregateCandles drops a trailing partial group's fields correctly (uses what's there)", () => {
  const bars = [{ t: "2026-07-25T13:30:00Z", open: 1, high: 2, low: 1, close: 1.5, volume: 50 }];
  const grouped = aggregateCandles(bars, 4);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].volume, 50);
});

test("aggregateCandles chains correctly for 5m -> 15m -> 1h -> 4h (groupSizes 3, 4, 4)", () => {
  // 48 5-minute bars = 4 hours of 5m data; verifies the same chained-aggregation shape
  // fetchCandles uses (5m fetched natively, everything else derived from it) rolls up
  // to exactly one 4h bar with volume conserved end-to-end.
  const fiveMin = Array.from({ length: 48 }, (_, i) => ({
    t: new Date(Date.UTC(2026, 6, 25, 13, 30 + i * 5)).toISOString(),
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i + 0.5,
    volume: 10,
  }));
  const fifteenMin = aggregateCandles(fiveMin, 3);
  const oneHour = aggregateCandles(fifteenMin, 4);
  const fourHour = aggregateCandles(oneHour, 4);
  assert.equal(fifteenMin.length, 16);
  assert.equal(oneHour.length, 4);
  assert.equal(fourHour.length, 1);
  assert.equal(fourHour[0].volume, 480); // 48 bars * 10, conserved through every rollup
  assert.equal(fourHour[0].open, fiveMin[0].open);
  assert.equal(fourHour[0].close, fiveMin[fiveMin.length - 1].close);
});

test("isTradierConfigured reflects TRADIER_API_KEY presence", () => {
  const original = process.env.TRADIER_API_KEY;
  delete process.env.TRADIER_API_KEY;
  assert.equal(isTradierConfigured(), false);
  process.env.TRADIER_API_KEY = "test-token";
  assert.equal(isTradierConfigured(), true);
  if (original === undefined) delete process.env.TRADIER_API_KEY;
  else process.env.TRADIER_API_KEY = original;
});
