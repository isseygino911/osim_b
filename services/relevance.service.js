// QQQ-aware news scoring: graded relevance (weighted entities/topics) and
// direction-aware sentiment (phrase overrides before word counting). Pure — no I/O.
//
// All matching is word-boundary regex, never substring, so "cut" can't match
// "circuit" and "rate" can't match "corporate".

export const RELEVANCE_THRESHOLD = 25;

// Ambiguous uppercase-only tickers would false-positive as common words if matched
// case-insensitively ("cost", "ai", "meta" is fine as a word) — match them strictly.
const TIERS = [
  { weight: 45, labels: { "qqq": "qqq|invesco qqq", "nasdaq": "nasdaq(?:[- ]100)?" } },
  {
    weight: 32,
    labels: {
      "nvidia": "nvidia|NVDA",
      "apple": "apple|AAPL",
      "microsoft": "microsoft|MSFT",
      "amazon": "amazon|AMZN",
      "alphabet": "alphabet|google|GOOGL?",
      "meta": "meta|META",
    },
  },
  {
    weight: 25,
    labels: {
      "broadcom": "broadcom|AVGO",
      "tesla": "tesla|TSLA",
      "netflix": "netflix|NFLX",
      "costco": "costco|COST",
      "amd": "AMD|advanced micro",
      "qualcomm": "qualcomm|QCOM",
      "palantir": "palantir|PLTR",
      "intel": "intel|INTC",
      "fed-policy": "fed|fomc|federal reserve|powell|interest rates?|rate cuts?|rate hikes?",
      "inflation": "inflation|CPI|PCE",
      "jobs": "jobs report|nonfarm payrolls|unemployment",
      "semis-ai": "semiconductors?|chipmakers?|artificial intelligence|AI",
      "tariffs": "tariffs?|trade war",
      "yields": "treasury|10-year|yields?",
      "growth": "GDP|recession",
      "earnings": "earnings",
    },
  },
  {
    weight: 8,
    labels: {
      "generic-stocks": "stocks?|equities",
      "generic-markets": "markets?|wall street",
      "generic-indexes": "s&p|dow|futures",
      "generic-investors": "investors?",
    },
  },
];

// Compile once at module load. A pattern is case-sensitive iff it contains an
// uppercase letter (ticker forms); everything else matches case-insensitively.
const COMPILED = TIERS.flatMap(({ weight, labels }) =>
  Object.entries(labels).map(([label, pattern]) => {
    const parts = pattern.split("|").map((p) => (/[A-Z]/.test(p) ? { p, flags: "" } : { p, flags: "i" }));
    return {
      label,
      weight,
      regexes: parts.map(({ p, flags }) => new RegExp(`\\b(?:${p.replace(/ /g, "\\s+")})\\b`, flags)),
    };
  })
);

// Full credit for the strongest matched label, half credit for each additional
// one — a QQQ headline that also mentions the Fed outranks either alone, but a
// pile of generic market words can never fake index-level relevance.
export function scoreRelevance(text) {
  const matched = [];
  for (const { label, weight, regexes } of COMPILED) {
    if (regexes.some((re) => re.test(text))) matched.push({ label, weight });
  }
  if (!matched.length) return { score: 0, matched };
  matched.sort((a, b) => b.weight - a.weight);
  const rest = matched.slice(1).reduce((sum, m) => sum + m.weight, 0);
  return { score: Math.min(100, Math.round(matched[0].weight + 0.5 * rest)), matched };
}

// Phrase overrides carry ±2 and are decisive on their own; matched spans are
// blanked out before word scoring so "rate cut" can't also count a bearish "cut".
const BULLISH_PHRASES = [
  /rate\s+cuts?|cuts?\s+rates|cutting\s+rates/i,
  /(?:beats?|tops?|exceeds?)\s+(?:estimates|expectations|forecasts)/i,
  /raises?\s+(?:guidance|outlook|forecast)/i,
  /record\s+high|all-time\s+high/i,
  /upgraded?\b[^.]{0,20}\b(?:buy|overweight|outperform)/i,
  /inflation\s+(?:cools?|eases?|slows?)|cooler-than-expected/i,
  /yields?\s+(?:fall|slip|drop|ease)/i,
];
const BEARISH_PHRASES = [
  /rate\s+hikes?|hikes?\s+rates|raises?\s+rates/i,
  /(?:misses|falls\s+short\s+of)\s+(?:estimates|expectations)/i,
  /(?:cuts?|lowers?)\s+(?:guidance|outlook|forecast)/i,
  /inflation\s+(?:rises?|accelerates?|jumps?)|hotter-than-expected/i,
  /yields?\s+(?:rise|jump|surge|climb)/i,
  /profit\s+warning/i,
  /sell-?off/i,
];

// Word lists inherit from the old scorer minus the traps: "high"/"highs" (only
// bullish in "record high", now a phrase), and the topical/ambiguous negatives
// "inflation", "volatile", "volatility", "cut", "cuts" (phrase-only now).
const POSITIVE_WORDS = [
  "surge", "soar", "rally", "gain", "gains", "jump", "jumps", "beat", "beats", "record",
  "upgrade", "upgraded", "bullish", "growth", "strong", "outperform", "rebound", "recover", "recovery",
  "optimism", "boost", "rise", "rises", "rising", "climb", "climbs", "profit", "profits", "exceeds",
];
const NEGATIVE_WORDS = [
  "plunge", "plunges", "crash", "crashes", "slump", "tumble", "tumbles", "fall", "falls", "falling",
  "drop", "drops", "miss", "misses", "downgrade", "downgraded", "bearish", "recession", "weak", "weakness",
  "underperform", "fear", "fears", "warning", "warns", "layoff", "layoffs", "default", "bankruptcy",
  "loss", "losses", "decline", "declines",
];
const POSITIVE_RE = new RegExp(`\\b(?:${POSITIVE_WORDS.join("|")})\\b`, "gi");
const NEGATIVE_RE = new RegExp(`\\b(?:${NEGATIVE_WORDS.join("|")})\\b`, "gi");

export function scoreDirection(text) {
  let remaining = text;
  const phrases = [];
  let phraseScore = 0;
  for (const re of BULLISH_PHRASES) {
    const m = remaining.match(re);
    if (m) {
      phrases.push(m[0]);
      phraseScore += 2;
      remaining = remaining.replace(re, " ");
    }
  }
  for (const re of BEARISH_PHRASES) {
    const m = remaining.match(re);
    if (m) {
      phrases.push(m[0]);
      phraseScore -= 2;
      remaining = remaining.replace(re, " ");
    }
  }

  const posHits = remaining.match(POSITIVE_RE)?.length ?? 0;
  const negHits = remaining.match(NEGATIVE_RE)?.length ?? 0;
  const score = Math.max(-5, Math.min(5, phraseScore + Math.sign(posHits - negHits) * Math.min(Math.abs(posHits - negHits), 5)));

  // ±2 band keeps single stray words neutral; any one phrase override is decisive
  const direction = score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
  return { direction, score, phrases };
}
