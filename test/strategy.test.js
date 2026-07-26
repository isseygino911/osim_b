import assert from "node:assert/strict";
import { test } from "node:test";

import { computeSignal, decideTrade } from "../services/strategy.service.js";

// 60 synthetic daily candles, gently trending up — enough history for every indicator.
function candles() {
  const out = [];
  let close = 100;
  for (let i = 0; i < 60; i++) {
    close *= 1 + (i % 5 === 0 ? -0.004 : 0.006);
    out.push({
      t: new Date(Date.UTC(2026, 4, 1 + i)).toISOString(),
      open: close * 0.998,
      high: close * 1.005,
      low: close * 0.994,
      close,
      volume: 1_000_000 + i * 1000,
    });
  }
  return out;
}

function expiryIso(daysOut) {
  return new Date(Date.now() + daysOut * 86400000).toISOString().slice(0, 10);
}

const PORTFOLIO = { cash: 10000, positions: [], equity: 10000 };

function strikeRowV1(strike) {
  return { strike, call: { bid: 2.0, ask: 2.1 }, put: { bid: 1.9, ask: 2.0 } };
}

test("decideTrade without deltas falls back to the 1%-OTM strike rule", () => {
  const exp = expiryIso(5);
  const snapshot = {
    underlying: { price: 100 },
    expirations: [exp],
    chains: { [exp]: { strikes: [99, 100, 101, 102, 103].map(strikeRowV1) } },
    candles: candles(),
  };
  const signal = { action: "buy_call", reason: "test", combinedScore: 50 };
  const decision = decideTrade({ signal, snapshot, portfolio: PORTFOLIO, dayPnlPct: 0 });
  assert.equal(decision.type, "open");
  assert.equal(decision.order.strike, 101); // spot 100 * 1.01
  assert.equal(decision.order.delta, null); // nothing to record without greeks
});

test("decideTrade with deltas targets ~0.40 delta and skips illiquid rows", () => {
  const exp = expiryIso(5);
  const row = (strike, delta, openInterest) => ({
    strike,
    call: { bid: 2.0, ask: 2.1, mark: 2.05, delta, iv: 0.22, theta: -0.05, openInterest },
    put: { bid: 1.9, ask: 2.0, mark: 1.95, delta: delta - 1, iv: 0.22, theta: -0.05, openInterest },
  });
  const snapshot = {
    underlying: { price: 100 },
    expirations: [exp],
    chains: {
      [exp]: {
        strikes: [
          row(101, 0.45, 500),
          row(102, 0.41, 5), // closest to target but OI below the 100 floor — must be skipped
          row(103, 0.33, 500),
        ],
      },
    },
    candles: candles(),
  };
  const signal = { action: "buy_call", reason: "test", combinedScore: 50 };
  const decision = decideTrade({ signal, snapshot, portfolio: PORTFOLIO, dayPnlPct: 0 });
  assert.equal(decision.type, "open");
  assert.equal(decision.order.strike, 101); // 0.45 beats 0.33 for |delta - 0.40| among liquid rows
  assert.equal(decision.order.delta, 0.45);
  assert.equal(decision.order.iv, 0.22);
});

test("computeSignal without chains reduces to the plain tech/news blend", () => {
  const snapshot = { underlying: { price: 100 }, expirations: [], chains: {}, candles: candles() };
  const sig = computeSignal(snapshot, null);
  assert.equal(sig.optionsScore, 0);
  assert.equal(sig.optionsFactors, null);
  assert.equal(sig.combinedScore, Number((sig.techScore * 0.75 + sig.newsScore * 0.25).toFixed(1)));
});

test("computeSignal dampens the score in a hostile options environment", () => {
  const exp = expiryIso(5);
  const hostileRow = {
    strike: 100,
    call: { bid: 1.0, ask: 1.6, mark: 1.3, delta: 0.5, iv: 0.9, theta: -0.05, openInterest: 10 },
    put: { bid: 1.0, ask: 1.6, mark: 1.3, delta: -0.5, iv: 0.9, theta: -0.05, openInterest: 10 },
  };
  const base = { underlying: { price: 100 }, expirations: [exp], candles: candles() };
  const calm = computeSignal({ ...base, chains: {} }, null);
  const hostile = computeSignal({ ...base, chains: { [exp]: { strikes: [hostileRow] } } }, null);
  assert.ok(hostile.optionsScore < 0, "hostile chain produces a negative options score");
  assert.ok(Math.abs(hostile.combinedScore) < Math.abs(calm.combinedScore), "conviction dampened");
  assert.equal(Math.sign(hostile.combinedScore), Math.sign(calm.combinedScore), "direction never flips");
});
