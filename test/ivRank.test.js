import assert from "node:assert/strict";
import { test } from "node:test";

import { computeIvStats, frontMonthAtmIv, mergeIvSample } from "../services/ivRank.service.js";

function mkHistory(startDate, ivs) {
  const start = new Date(startDate);
  return ivs.map((atmIv, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { date: d.toISOString().slice(0, 10), atmIv };
  });
}

test("mergeIvSample: same-date sample replaces, not appends", () => {
  const history = mkHistory("2026-01-01", [0.2, 0.21, 0.22]);
  const merged = mergeIvSample(history, { date: "2026-01-03", atmIv: 0.5 });
  assert.equal(merged.length, 3);
  assert.equal(merged.find((e) => e.date === "2026-01-03").atmIv, 0.5);
});

test("mergeIvSample: stays sorted by date ascending", () => {
  const merged = mergeIvSample([{ date: "2026-01-03", atmIv: 0.3 }, { date: "2026-01-01", atmIv: 0.1 }], { date: "2026-01-02", atmIv: 0.2 });
  assert.deepEqual(merged.map((e) => e.date), ["2026-01-01", "2026-01-02", "2026-01-03"]);
});

test("mergeIvSample: trims to maxDays, keeping the most recent", () => {
  const history = mkHistory("2026-01-01", Array.from({ length: 10 }, (_, i) => 0.2 + i * 0.01));
  const merged = mergeIvSample(history, { date: "2026-01-11", atmIv: 0.5 }, 5);
  assert.equal(merged.length, 5);
  assert.equal(merged[0].date, "2026-01-07");
  assert.equal(merged[merged.length - 1].date, "2026-01-11");
});

test("computeIvStats: fewer than minDays entries reports insufficient history", () => {
  const history = mkHistory("2026-01-01", [0.2, 0.22, 0.19]);
  const stats = computeIvStats(history, { minDays: 30 });
  assert.equal(stats.insufficient, true);
  assert.equal(stats.days, 3);
  assert.equal(stats.ivRank, null);
  assert.equal(stats.ivPercentile, null);
});

test("computeIvStats: current IV at the window max scores ivRank 100", () => {
  const ivs = Array.from({ length: 40 }, (_, i) => 0.15 + i * 0.005); // strictly increasing, current = max
  const stats = computeIvStats(mkHistory("2026-01-01", ivs), { minDays: 30 });
  assert.equal(stats.insufficient, false);
  assert.equal(stats.ivRank, 100);
  assert.equal(stats.ivPercentile, 100 * (39 / 40));
});

test("computeIvStats: current IV at the window min scores ivRank 0", () => {
  const ivs = Array.from({ length: 40 }, (_, i) => 0.4 - i * 0.005); // strictly decreasing, current = min
  const stats = computeIvStats(mkHistory("2026-01-01", ivs), { minDays: 30 });
  assert.equal(stats.ivRank, 0);
  assert.equal(stats.ivPercentile, 0);
});

test("computeIvStats: flat IV history (high === low) yields null ivRank", () => {
  const ivs = Array.from({ length: 35 }, () => 0.2);
  const stats = computeIvStats(mkHistory("2026-01-01", ivs), { minDays: 30 });
  assert.equal(stats.insufficient, false);
  assert.equal(stats.ivRank, null);
  assert.equal(stats.ivPercentile, 0);
});

test("computeIvStats: empty history", () => {
  const stats = computeIvStats([]);
  assert.equal(stats.insufficient, true);
  assert.equal(stats.days, 0);
  assert.equal(stats.atmIv, null);
});

test("frontMonthAtmIv: picks the sorted-first expiration's ATM strike", () => {
  const snapshot = {
    underlying: { price: 100 },
    chains: {
      "2026-08-15": { strikes: [{ strike: 100, call: { iv: 0.3 }, put: { iv: 0.32 } }] },
      "2026-07-31": { strikes: [{ strike: 100, call: { iv: 0.2 }, put: { iv: 0.22 } }] },
    },
  };
  assert.equal(frontMonthAtmIv(snapshot), 0.21);
});

test("frontMonthAtmIv: null when chains or price are missing", () => {
  assert.equal(frontMonthAtmIv({ underlying: {}, chains: {} }), null);
  assert.equal(frontMonthAtmIv({ underlying: { price: 100 }, chains: {} }), null);
  assert.equal(frontMonthAtmIv(null), null);
});
