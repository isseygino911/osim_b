import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeSymbol, SYMBOL_RE } from "../services/symbol.service.js";

test("normalizeSymbol uppercases and trims valid symbols", () => {
  assert.equal(normalizeSymbol("qqq"), "QQQ");
  assert.equal(normalizeSymbol(" aapl "), "AAPL");
  assert.equal(normalizeSymbol("brk.b"), "BRK.B");
  assert.equal(normalizeSymbol("SPY"), "SPY");
});

test("normalizeSymbol rejects invalid input", () => {
  assert.equal(normalizeSymbol("../etc"), null);
  assert.equal(normalizeSymbol("..\\etc"), null);
  assert.equal(normalizeSymbol("QQQQQQQ"), null); // 7 letters
  assert.equal(normalizeSymbol(""), null);
  assert.equal(normalizeSymbol("   "), null);
  assert.equal(normalizeSymbol("BTC-USD"), null); // crypto pairs unsupported
  assert.equal(normalizeSymbol("a b"), null);
  assert.equal(normalizeSymbol("AAPL;rm"), null);
  assert.equal(normalizeSymbol(null), null);
  assert.equal(normalizeSymbol(42), null);
});

test("SYMBOL_RE never accepts path separators or dots beyond a class suffix", () => {
  assert.equal(SYMBOL_RE.test("A/B"), false);
  assert.equal(SYMBOL_RE.test("A.B.C"), false);
  assert.equal(SYMBOL_RE.test(".."), false);
  assert.equal(SYMBOL_RE.test("BRK.B"), true);
});
