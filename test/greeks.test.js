import assert from "node:assert/strict";
import { test } from "node:test";

import { BASELINE_PUT_SKEW, computeOptionsBias } from "../services/greeks.service.js";

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
