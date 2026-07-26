import assert from "node:assert/strict";
import { test } from "node:test";

import { compileProfile, RELEVANCE_THRESHOLD, scoreDirection, scoreRelevance } from "../services/relevance.service.js";

test("word boundaries: no substring false positives", () => {
  assert.equal(scoreDirection("Circuit breaker triggered on exchange").score, 0, "'cut' must not match 'circuit'");
  assert.equal(scoreRelevance("Corporate governance overhaul announced").score, 0, "'rate' must not match 'corporate'");
  assert.equal(scoreRelevance("Accurate polling data released").score, 0);
});

test("phrase overrides beat component words", () => {
  const rateCut = scoreDirection("Fed announces rate cut in surprise move");
  assert.equal(rateCut.direction, "bullish", "'rate cut' is bullish, not a bearish 'cut'");
  assert.ok(rateCut.score >= 2);

  assert.equal(scoreDirection("Fed signals rate hike ahead").direction, "bearish");
  assert.equal(scoreDirection("Nvidia misses estimates for Q2").direction, "bearish");
  assert.equal(scoreDirection("Apple beats expectations on services growth").direction, "bullish");
  assert.equal(scoreDirection("Inflation cools more than forecast").direction, "bullish");
  assert.equal(scoreDirection("Treasury yields surge on hot data").direction, "bearish");
});

test("topical words are no longer directional on their own", () => {
  assert.equal(scoreDirection("Inflation report due Thursday").direction, "neutral");
  assert.equal(scoreDirection("Volatility index ticks up").direction, "neutral");
  assert.equal(scoreDirection("High stakes for tech sector").direction, "neutral", "'high' alone is not bullish");
});

test("relevance weighting: index > holdings > macro > generic", () => {
  const qqq = scoreRelevance("QQQ slides in early trading").score;
  const nvda = scoreRelevance("Nvidia unveils new chip").score;
  const macro = scoreRelevance("Inflation cools in June").score;
  const generic = scoreRelevance("Stocks slide on Wall Street").score;
  assert.ok(qqq > nvda && nvda > macro && macro > generic, `${qqq} > ${nvda} > ${macro} > ${generic}`);
  assert.ok(macro >= RELEVANCE_THRESHOLD, "single macro topic passes threshold");
  assert.ok(generic < RELEVANCE_THRESHOLD, "generic-only never passes");
});

test("multi-hit diminishing sum, capped at 100", () => {
  const single = scoreRelevance("Nasdaq futures rise").score;
  const multi = scoreRelevance("Nasdaq climbs as Nvidia and Apple lead tech; Fed decision looms").score;
  assert.ok(multi > single);
  assert.ok(multi <= 100);
  const kitchen = scoreRelevance("QQQ Nasdaq Nvidia Apple Microsoft Amazon Meta Tesla Fed inflation earnings treasury stocks markets").score;
  assert.equal(kitchen, 100);
});

test("label alternatives dedupe to one hit", () => {
  const one = scoreRelevance("Powell speaks").matched;
  const three = scoreRelevance("Fed's Powell addresses FOMC").matched;
  assert.equal(one.length, 1);
  assert.equal(three.length, 1, "fed + powell + fomc are the same fed-policy label");
  assert.equal(three[0].label, "fed-policy");
});

test("ambiguous tickers match uppercase only", () => {
  assert.equal(scoreRelevance("The cost of living keeps rising").score, 0, "'cost' lowercase is not COST");
  assert.ok(scoreRelevance("COST rallies after earnings beat").score >= RELEVANCE_THRESHOLD);
  assert.equal(scoreRelevance("What ai tools do students use?").score, 0, "'ai' lowercase is not AI");
  assert.ok(scoreRelevance("AI spending boom lifts chipmakers").score >= RELEVANCE_THRESHOLD);
});

test("compileProfile: per-symbol tier-1 from ticker + company name", () => {
  const aapl = compileProfile("AAPL", "Apple Inc");
  assert.ok(scoreRelevance("Apple beats earnings estimates", aapl).score >= RELEVANCE_THRESHOLD);
  assert.ok(scoreRelevance("AAPL slides after downgrade", aapl).score >= RELEVANCE_THRESHOLD);
  const other = scoreRelevance("Costco raises guidance for holiday quarter", aapl);
  assert.ok(!other.matched.some((m) => m.weight === 45), "unrelated single name must not hit AAPL tier-1");
});

test("compileProfile: ticker stays case-sensitive, macro tiers shared", () => {
  const cost = compileProfile("COST", "Costco Wholesale Corporation");
  assert.equal(scoreRelevance("The cost of living keeps rising", cost).matched.some((m) => m.weight === 45), false);
  assert.ok(scoreRelevance("COST rallies after earnings beat", cost).score >= RELEVANCE_THRESHOLD);
  assert.ok(scoreRelevance("Costco rallies after earnings beat", cost).score >= RELEVANCE_THRESHOLD);
  assert.ok(scoreRelevance("Fed signals rate cut", cost).score >= RELEVANCE_THRESHOLD, "macro tier applies to every symbol");
});

test("compileProfile: QQQ returns the hand-tuned default profile", () => {
  const qqq = compileProfile("QQQ", "Invesco QQQ Trust");
  assert.equal(scoreRelevance("Nvidia unveils new chip", qqq).score, scoreRelevance("Nvidia unveils new chip").score);
});

test("direction score is clamped to [-5, 5]", () => {
  const pump = scoreDirection("Stocks surge soar rally jump climb rise boost rebound gains record beats estimates");
  assert.ok(pump.score <= 5 && pump.direction === "bullish");
  const dump = scoreDirection("Stocks plunge crash slump tumble fall drop selloff fears warning losses misses estimates");
  assert.ok(dump.score >= -5 && dump.direction === "bearish");
});
