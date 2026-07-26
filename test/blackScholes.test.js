import assert from "node:assert/strict";
import { test } from "node:test";

import { bsGreeks, bsPrice, impliedVol, normCdf, yearFraction } from "../services/blackScholes.service.js";

// Hull, "Options, Futures, and Other Derivatives" — the canonical worked example.
const HULL = { S: 42, K: 40, T: 0.5, r: 0.1, sigma: 0.2, q: 0 };

function approx(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) < tol, `${label}: expected ~${expected}, got ${actual}`);
}

test("normCdf matches known values", () => {
  approx(normCdf(0), 0.5, 1e-7, "N(0)");
  approx(normCdf(1.96), 0.975, 1e-4, "N(1.96)");
  approx(normCdf(-1.96), 0.025, 1e-4, "N(-1.96)");
});

test("Hull textbook reference prices", () => {
  approx(bsPrice({ ...HULL, type: "call" }), 4.759, 1e-3, "call");
  approx(bsPrice({ ...HULL, type: "put" }), 0.808, 1e-3, "put");
});

test("put-call parity holds across a strike sweep", () => {
  const { S, T, r, sigma } = HULL;
  const q = 0.015;
  for (let K = 30; K <= 55; K += 2.5) {
    const call = bsPrice({ S, K, T, r, sigma, q, type: "call" });
    const put = bsPrice({ S, K, T, r, sigma, q, type: "put" });
    const parity = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    approx(call - put, parity, 1e-6, `parity K=${K}`);
  }
});

test("greeks sanity", () => {
  const q = 0.006;
  const call = bsGreeks({ ...HULL, q, type: "call" });
  const put = bsGreeks({ ...HULL, q, type: "put" });
  assert.ok(call.delta > 0 && call.delta < 1, "call delta in (0,1)");
  approx(put.delta, call.delta - Math.exp(-q * HULL.T), 1e-9, "put delta = call delta - e^(-qT)");
  approx(call.gamma, put.gamma, 1e-12, "shared gamma");
  approx(call.vega, put.vega, 1e-12, "shared vega");
  assert.ok(call.gamma > 0 && call.vega > 0, "gamma/vega positive");

  const atm = bsGreeks({ S: 100, K: 100, T: 30 / 365, r: 0.04, sigma: 0.25, type: "call" });
  assert.ok(atm.theta < 0, "ATM long call theta is negative");
});

test("implied vol round-trips the pricing model", () => {
  const sigma = 0.25;
  const price = bsPrice({ ...HULL, sigma, type: "call" });
  const { iv, converged } = impliedVol({ price, S: HULL.S, K: HULL.K, T: HULL.T, r: HULL.r, type: "call" });
  assert.equal(converged, true);
  approx(iv, sigma, 1e-4, "recovered sigma");
});

test("bisection fallback: short-dated ITM high-vol contract Newton can't reach from its 0.3 seed", () => {
  const args = { S: 100, K: 85, T: 7 / 365, r: 0.04, type: "call" };
  const price = bsPrice({ ...args, sigma: 1.5 });
  const { iv, converged } = impliedVol({ price, ...args });
  assert.equal(converged, true);
  approx(iv, 1.5, 1e-2, "recovered high sigma via bisection");
});

test("T <= 0 returns intrinsic value with step delta", () => {
  assert.equal(bsPrice({ S: 105, K: 100, T: 0, r: 0.04, sigma: 0.2, type: "call" }), 5);
  assert.equal(bsPrice({ S: 105, K: 100, T: 0, r: 0.04, sigma: 0.2, type: "put" }), 0);
  const g = bsGreeks({ S: 105, K: 100, T: 0, r: 0.04, sigma: 0.2, type: "call" });
  assert.equal(g.delta, 1);
  assert.equal(g.gamma, 0);
  assert.equal(g.vega, 0);
});

test("price below intrinsic floor returns the 0.30 non-converged fallback", () => {
  const res = impliedVol({ price: 0.5, S: 110, K: 100, T: 0.25, r: 0.04, type: "call" });
  assert.equal(res.converged, false);
  assert.equal(res.iv, 0.3);
});

test("invalid inputs return null / fallback instead of NaN", () => {
  assert.equal(bsPrice({ S: NaN, K: 100, T: 0.5, r: 0.04, sigma: 0.2, type: "call" }), null);
  assert.equal(bsGreeks({ S: 100, K: -5, T: 0.5, r: 0.04, sigma: 0.2, type: "put" }), null);
  assert.equal(bsPrice({ S: 100, K: 100, T: 0.5, r: 0.04, sigma: 0.2, type: "straddle" }), null);
  assert.equal(impliedVol({ price: -1, S: 100, K: 100, T: 0.5, r: 0.04, type: "call" }).converged, false);
});

test("dividend yield lowers call prices", () => {
  const noDiv = bsPrice({ S: 100, K: 100, T: 0.5, r: 0.04, sigma: 0.2, q: 0, type: "call" });
  const withDiv = bsPrice({ S: 100, K: 100, T: 0.5, r: 0.04, sigma: 0.2, q: 0.02, type: "call" });
  assert.ok(withDiv < noDiv, "q=0.02 call cheaper than q=0");
});

test("yearFraction: calendar/365, clamped positive, null on garbage", () => {
  const now = new Date("2026-07-26T14:00:00Z");
  approx(yearFraction("2026-07-31", now), (5 * 86400000 + 7 * 3600000) / 86400000 / 365, 1e-9, "5d7h out");
  assert.ok(yearFraction("2026-07-20", now) > 0, "past expiry clamps positive");
  assert.equal(yearFraction("not-a-date", now), null);
});
