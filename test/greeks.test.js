import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASELINE_PUT_SKEW,
  computeGammaExposure,
  computeOptionsBias,
  computeRealizedVol,
  computeVolSurface,
} from "../services/greeks.service.js";

// Synthetic enriched chain: call/put deltas bracketing 25Δ, controllable IVs and OI.
function chain({ putSkew = BASELINE_PUT_SKEW, oi = null } = {}) {
  const baseIv = 0.2;
  const rows = [
    { strike: 95, callDelta: 0.75, putDelta: -0.25 },
    { strike: 100, callDelta: 0.5, putDelta: -0.5 },
    { strike: 105, callDelta: 0.25, putDelta: -0.75 },
  ];
  return {
    strikes: rows.map((r, i) => ({
      strike: r.strike,
      call: {
        bid: 1, ask: 1.1, delta: r.callDelta, iv: baseIv,
        ...(oi ? { openInterest: oi.call[i] } : {}),
      },
      put: {
        bid: 1, ask: 1.1, delta: r.putDelta, iv: baseIv + putSkew,
        ...(oi ? { openInterest: oi.put[i] } : {}),
      },
    })),
  };
}

test("baseline put skew reads as neutral positioning", () => {
  const { bias, factors } = computeOptionsBias(chain(), 100);
  assert.ok(Math.abs(bias) < 5, `expected ~0, got ${bias}`);
  assert.ok(Math.abs(factors.ivSkew - BASELINE_PUT_SKEW) < 1e-9);
});

test("panic put skew (+0.08) reads strongly bearish", () => {
  const { bias } = computeOptionsBias(chain({ putSkew: 0.08 }), 100);
  assert.ok(bias <= -90, `expected <= -90, got ${bias}`);
});

test("flat skew (puts no dearer than calls) reads bullish", () => {
  const { bias } = computeOptionsBias(chain({ putSkew: 0 }), 100);
  assert.ok(bias > 30, `expected positive, got ${bias}`);
});

test("heavy put OI drags bias bearish; no OI means skew-only", () => {
  const heavyPuts = computeOptionsBias(chain({ oi: { call: [1000, 1000, 1000], put: [2400, 2400, 2400] } }), 100);
  assert.equal(heavyPuts.factors.oiRatio, 2.4);
  assert.ok(heavyPuts.bias < -20, `OI ratio 2.4 should pull bias negative, got ${heavyPuts.bias}`);

  const noOi = computeOptionsBias(chain(), 100);
  assert.equal(noOi.factors.oiRatio, null);
  assert.ok(Math.abs(noOi.bias) < 5, "without OI the baseline-skew chain stays neutral");
});

test("no deltas or empty chain degrades to zero bias, null factors", () => {
  const bare = { strikes: [{ strike: 100, call: { bid: 1, ask: 1.1 }, put: { bid: 1, ask: 1.1 } }] };
  assert.deepEqual(computeOptionsBias(bare, 100), { bias: 0, factors: null });
  assert.deepEqual(computeOptionsBias(null, 100), { bias: 0, factors: null });
  assert.deepEqual(computeOptionsBias(chain(), NaN), { bias: 0, factors: null });
});

test("narrow chain that cannot bracket 25-delta yields null skew", () => {
  const atmOnly = {
    strikes: [{ strike: 100, call: { bid: 1, ask: 1.1, delta: 0.5, iv: 0.2 }, put: { bid: 1, ask: 1.1, delta: -0.5, iv: 0.23 } }],
  };
  const { bias, factors } = computeOptionsBias(atmOnly, 100);
  assert.equal(bias, 0);
  assert.equal(factors, null);
});

// 22 gently up-trending daily closes — enough for a 20-session realized-vol window.
function dailyCandles() {
  const out = [];
  let close = 100;
  for (let i = 0; i < 22; i++) {
    close *= 1 + (i % 4 === 0 ? -0.01 : 0.012);
    out.push({ t: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(), open: close, high: close, low: close, close, volume: 1000 });
  }
  return out;
}

function surfaceSnapshot({ putSkew = BASELINE_PUT_SKEW } = {}) {
  const nearExp = "2026-08-01";
  const farExp = "2026-08-15";
  return {
    underlying: { price: 100 },
    expirations: [nearExp, farExp],
    chains: { [nearExp]: chain({ putSkew }), [farExp]: chain({ putSkew }) },
    candles: { "1d": dailyCandles() },
  };
}

test("computeRealizedVol needs at least lookback+1 closes, else null", () => {
  assert.equal(computeRealizedVol({ candles: { "1d": dailyCandles().slice(0, 10) } }), null);
  const vol = computeRealizedVol({ candles: { "1d": dailyCandles() } });
  assert.ok(Number.isFinite(vol) && vol > 0, `expected a positive annualized vol, got ${vol}`);
});

test("computeVolSurface returns skew/term/vol for a two-expiration chain", () => {
  const snap = surfaceSnapshot();
  const { skew, term, vol } = computeVolSurface(snap, "2026-08-01");
  assert.ok(skew && Number.isFinite(skew.put25d) && Number.isFinite(skew.call25d));
  assert.ok(term && term.nearExpiration === "2026-08-01" && term.farExpiration === "2026-08-15");
  assert.equal(term.slope, 0); // identical chains at both expirations in this fixture
  assert.ok(vol && Number.isFinite(vol.atmIv) && Number.isFinite(vol.vrp));
});

test("computeVolSurface degrades gracefully with no expiration/spot/chain", () => {
  assert.deepEqual(computeVolSurface({}, null), { skew: null, term: null, vol: null });
  assert.deepEqual(computeVolSurface({ underlying: { price: 100 } }, "2026-08-01"), { skew: null, term: null, vol: null });
});

function gexRow(strike, callGamma, putGamma, oi = 500) {
  return {
    strike,
    call: { bid: 1, ask: 1.1, gamma: callGamma, openInterest: oi },
    put: { bid: 1, ask: 1.1, gamma: putGamma, openInterest: oi },
  };
}

test("computeGammaExposure nets positive gamma per-strike into a signed netGex", () => {
  const snapshot = {
    underlying: { price: 100 },
    chains: { "2026-08-01": { strikes: [gexRow(95, 0.03, 0.03), gexRow(100, 0.05, 0.05), gexRow(105, 0.03, 0.03)] } },
  };
  const { netGex, zeroGammaStrike, byStrike } = computeGammaExposure(snapshot);
  assert.equal(byStrike.length, 3);
  // equal call/put gamma+OI at every strike cancels to exactly zero net gamma
  assert.equal(netGex, 0);
  assert.ok([95, 100, 105].includes(zeroGammaStrike));
});

test("computeGammaExposure skips strikes missing gamma/OI and returns empty when none qualify", () => {
  const snapshot = {
    underlying: { price: 100 },
    chains: { "2026-08-01": { strikes: [{ strike: 100, call: { bid: 1, ask: 1.1 }, put: { bid: 1, ask: 1.1 } }] } },
  };
  assert.deepEqual(computeGammaExposure(snapshot), { netGex: null, zeroGammaStrike: null, byStrike: [] });
  assert.deepEqual(computeGammaExposure({ underlying: {} }), { netGex: null, zeroGammaStrike: null, byStrike: [] });
});
