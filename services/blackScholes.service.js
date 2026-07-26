// Black-Scholes pricing, greeks, and implied-vol solver, ported from the MIT-licensed
// staskh/trading_skills Python reference. Pure math — no I/O, no imports — so it can be
// unit-tested in isolation and reused by greeks/strategy services.
//
// Conventions (match the Python reference):
//   theta — per calendar day (annual / 365)
//   vega  — per 1 vol point (i.e. per 0.01 change in sigma)
//   rho   — per 1% rate change
//   T     — calendar days to expiry / 365

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const IV_LOWER = 0.001;
const IV_UPPER = 5.0;
const IV_TOL = 1e-6;
const IV_MAX_ITERS = 100;
const IV_FALLBACK = 0.3; // parity with the Python reference when the solver fails
const MIN_YEAR_FRACTION = 0.5 / 365; // never let T collapse to 0 on expiry day

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Abramowitz–Stegun 7.1.26 erf approximation, |error| < 1.5e-7 — plenty for quote-level precision.
export function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

function validType(type) {
  return type === "call" || type === "put";
}

function validCommon(S, K, T, r, q) {
  return Number.isFinite(S) && S > 0 && Number.isFinite(K) && K > 0 && Number.isFinite(T) && Number.isFinite(r) && Number.isFinite(q);
}

function dValues(S, K, T, r, sigma, q) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return { d1, d2: d1 - sigma * sqrtT, sqrtT };
}

export function bsPrice({ S, K, T, r, sigma, q = 0, type }) {
  if (!validCommon(S, K, T, r, q) || !Number.isFinite(sigma) || !validType(type)) return null;
  if (T <= 0) return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  if (sigma <= 0) {
    // deterministic limit: option worth its discounted forward intrinsic
    const fwd = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    return type === "call" ? Math.max(0, fwd) : Math.max(0, -fwd);
  }
  const { d1, d2 } = dValues(S, K, T, r, sigma, q);
  const dfDiv = Math.exp(-q * T);
  const dfRate = Math.exp(-r * T);
  if (type === "call") return S * dfDiv * normCdf(d1) - K * dfRate * normCdf(d2);
  return K * dfRate * normCdf(-d2) - S * dfDiv * normCdf(-d1);
}

export function bsGreeks({ S, K, T, r, sigma, q = 0, type }) {
  if (!validCommon(S, K, T, r, q) || !Number.isFinite(sigma) || !validType(type)) return null;
  if (T <= 0 || sigma <= 0) {
    // expired / deterministic contract: intrinsic value, step delta, flat everything else
    const price = bsPrice({ S, K, T: Math.max(T, 0), r, sigma: 0, q, type });
    const itm = type === "call" ? S > K : S < K;
    const delta = itm ? (type === "call" ? 1 : -1) * Math.exp(-q * Math.max(T, 0)) : 0;
    return { price, delta, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const { d1, d2, sqrtT } = dValues(S, K, T, r, sigma, q);
  const dfDiv = Math.exp(-q * T);
  const dfRate = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const gamma = (dfDiv * pdf) / (S * sigma * sqrtT);
  const vega = (S * dfDiv * pdf * sqrtT) / 100;
  const decay = -(S * dfDiv * pdf * sigma) / (2 * sqrtT);
  if (type === "call") {
    const price = S * dfDiv * normCdf(d1) - K * dfRate * normCdf(d2);
    return {
      price,
      delta: dfDiv * normCdf(d1),
      gamma,
      theta: (decay - r * K * dfRate * normCdf(d2) + q * S * dfDiv * normCdf(d1)) / 365,
      vega,
      rho: (K * T * dfRate * normCdf(d2)) / 100,
    };
  }
  const price = K * dfRate * normCdf(-d2) - S * dfDiv * normCdf(-d1);
  return {
    price,
    delta: dfDiv * (normCdf(d1) - 1),
    gamma,
    theta: (decay + r * K * dfRate * normCdf(-d2) - q * S * dfDiv * normCdf(-d1)) / 365,
    vega,
    rho: (-K * T * dfRate * normCdf(-d2)) / 100,
  };
}

// Newton–Raphson seeded at 0.3 with a bisection fallback on [0.001, 5.0].
// Never throws — unsolvable inputs return { iv: 0.30, converged: false }.
export function impliedVol({ price, S, K, T, r, q = 0, type }) {
  const fallback = { iv: IV_FALLBACK, converged: false };
  if (!validCommon(S, K, T, r, q) || !validType(type) || !Number.isFinite(price) || price <= 0 || T <= 0) return fallback;

  // no vol can price below the discounted forward intrinsic — bail before the solver thrashes
  const fwd = S * Math.exp(-q * T) - K * Math.exp(-r * T);
  const intrinsicFloor = type === "call" ? Math.max(0, fwd) : Math.max(0, -fwd);
  if (price < intrinsicFloor - IV_TOL) return fallback;

  let sigma = IV_FALLBACK;
  for (let i = 0; i < IV_MAX_ITERS; i++) {
    const diff = bsPrice({ S, K, T, r, sigma, q, type }) - price;
    if (Math.abs(diff) < IV_TOL) return { iv: sigma, converged: true };
    const { d1, sqrtT } = dValues(S, K, T, r, sigma, q);
    const vegaRaw = S * Math.exp(-q * T) * normPdf(d1) * sqrtT; // dPrice/dSigma, unscaled
    if (vegaRaw < 1e-10) break; // flat spot — Newton would blow up, hand off to bisection
    const next = sigma - diff / vegaRaw;
    if (!Number.isFinite(next) || next <= IV_LOWER || next >= IV_UPPER) break;
    sigma = next;
  }

  let lo = IV_LOWER;
  let hi = IV_UPPER;
  // price is monotonic in sigma, so f(lo)'s sign never flips as lo tightens upward
  const fLo = bsPrice({ S, K, T, r, sigma: lo, q, type }) - price;
  const fHi = bsPrice({ S, K, T, r, sigma: hi, q, type }) - price;
  if (fLo * fHi > 0) return fallback; // target price outside the reachable range
  for (let i = 0; i < IV_MAX_ITERS; i++) {
    const mid = (lo + hi) / 2;
    const fMid = bsPrice({ S, K, T, r, sigma: mid, q, type }) - price;
    if (Math.abs(fMid) < IV_TOL) return { iv: mid, converged: true };
    if (fLo * fMid < 0) hi = mid;
    else lo = mid;
  }
  return { iv: (lo + hi) / 2, converged: true }; // interval collapsed to tolerance-level width
}

// Calendar days / 365, clamped so an expiry-day contract still gets a positive T.
export function yearFraction(expirationISO, now = new Date()) {
  // date-only strings are treated as expiring at 21:00 UTC (~4pm ET market close)
  const ts = /^\d{4}-\d{2}-\d{2}$/.test(expirationISO) ? Date.parse(`${expirationISO}T21:00:00Z`) : Date.parse(expirationISO);
  if (!Number.isFinite(ts)) return null;
  const years = (ts - now.getTime()) / 86400000 / 365;
  return Math.max(years, MIN_YEAR_FRACTION);
}
