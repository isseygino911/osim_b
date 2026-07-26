import assert from "node:assert/strict";
import { test } from "node:test";

import { computeIndicators } from "../services/indicators.service.js";

// Deterministic OHLCV fixture: close drives the trend, high/low/volume derived from it.
function mkBars(closes) {
  return closes.map((c, i) => ({
    t: new Date(2026, 0, i + 1).toISOString(),
    open: c - 0.3,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 1_000_000,
  }));
}

function uptrend(n) {
  return Array.from({ length: n }, (_, i) => 100 + i * 1.5);
}
function downtrend(n) {
  return Array.from({ length: n }, (_, i) => 100 - i * 1.5);
}
function flat(n) {
  return Array.from({ length: n }, () => 100);
}
function oscillating(n) {
  return Array.from({ length: n }, (_, i) => 100 + 10 * Math.sin(i / 3));
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

test("new series/latest keys are present", () => {
  const { series, latest, composite } = computeIndicators(mkBars(oscillating(60)));
  for (const key of ["ema9", "ema21", "ema50", "adx14", "plusDI", "minusDI", "stochRsiK", "stochRsiD"]) {
    assert.ok(key in series, `series missing ${key}`);
    assert.ok(key in latest, `latest missing ${key}`);
  }
  assert.ok(composite.score >= -100 && composite.score <= 100);
  assert.ok(["strong_buy", "buy", "neutral", "sell", "strong_sell"].includes(composite.label));
});

test("ADX: strong uptrend has high ADX and +DI > -DI", () => {
  const { series } = computeIndicators(mkBars(uptrend(60)));
  const a = last(series.adx14);
  const plus = last(series.plusDI);
  const minus = last(series.minusDI);
  assert.ok(a > 25, `expected ADX > 25, got ${a}`);
  assert.ok(plus > minus, `expected +DI > -DI, got +DI=${plus} -DI=${minus}`);
});

test("ADX: strong downtrend has high ADX and -DI > +DI", () => {
  const { series } = computeIndicators(mkBars(downtrend(60)));
  const a = last(series.adx14);
  const plus = last(series.plusDI);
  const minus = last(series.minusDI);
  assert.ok(a > 25, `expected ADX > 25, got ${a}`);
  assert.ok(minus > plus, `expected -DI > +DI, got +DI=${plus} -DI=${minus}`);
});

test("ADX: flat bars never produce NaN and DIs are 0", () => {
  const bars = mkBars(flat(60)).map((b) => ({ ...b, high: b.close, low: b.close }));
  const { series } = computeIndicators(bars);
  for (const arr of [series.adx14, series.plusDI, series.minusDI]) {
    for (const v of arr) assert.ok(v === null || Number.isFinite(v), "found NaN/Infinity");
  }
  const plus = last(series.plusDI);
  const minus = last(series.minusDI);
  assert.equal(plus, 0);
  assert.equal(minus, 0);
});

test("ADX: leading nulls end exactly at 2*period-1, short input is all-null", () => {
  const period = 14;
  const { series } = computeIndicators(mkBars(uptrend(60)));
  assert.equal(series.adx14[2 * period - 2], null);
  assert.notEqual(series.adx14[2 * period - 1], null);

  const { series: shortSeries } = computeIndicators(mkBars(uptrend(10)));
  assert.ok(shortSeries.adx14.every((v) => v === null));
});

test("StochRSI: bounded [0,100], and pinned at 50 when RSI itself is flat", () => {
  // A perfectly linear uptrend drives RSI to a constant 100 (avgLoss stays 0 forever),
  // so StochRSI's own min===max window guard kicks in — this is the flat-RSI edge case,
  // not a "trend" assertion.
  const up = computeIndicators(mkBars(uptrend(60))).series;
  const down = computeIndicators(mkBars(downtrend(60))).series;
  for (const arr of [up.stochRsiK, up.stochRsiD, down.stochRsiK, down.stochRsiD]) {
    for (const v of arr) {
      if (v == null) continue;
      assert.ok(v >= 0 && v <= 100, `out of bounds: ${v}`);
    }
  }
  assert.equal(last(up.stochRsiK), 50);
  assert.equal(last(down.stochRsiK), 50);
});

test("StochRSI: responds to real swings — spans both low and high readings", () => {
  const { series } = computeIndicators(mkBars(oscillating(80)));
  const vals = series.stochRsiK.filter((v) => v != null);
  assert.ok(vals.some((v) => v < 30), "expected some low StochRSI readings on an oscillating series");
  assert.ok(vals.some((v) => v > 70), "expected some high StochRSI readings on an oscillating series");
});

test("StochRSI: no null-poisoning — non-null at the tail of a long series", () => {
  const { series } = computeIndicators(mkBars(oscillating(80)));
  assert.notEqual(last(series.stochRsiK), null);
  assert.notEqual(last(series.stochRsiD), null);
});

test("EMA 9/21/50 track price and are ordered on a strong uptrend", () => {
  const { latest } = computeIndicators(mkBars(uptrend(60)));
  assert.ok(latest.ema9 > latest.ema21 && latest.ema21 > latest.ema50, "expected ema9 > ema21 > ema50 on an uptrend");
});
