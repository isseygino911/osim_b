import { readSettings } from "../models/settings.model.js";

// Stocks/ETFs only (BRK.B-style class suffixes allowed). Symbols become filenames,
// so this regex is also the path-traversal guard — nothing outside it ever reaches a path.
export const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;

export function normalizeSymbol(raw) {
  if (typeof raw !== "string") return null;
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

// Explicit ?symbol= wins; otherwise the server-side active symbol (what Claude
// refreshes when no symbol is named). Returns null for an invalid explicit symbol or
// when no active symbol has been chosen yet (fresh install, no PUT /api/symbol yet).
export async function resolveSymbol(querySymbol) {
  if (querySymbol !== undefined) return normalizeSymbol(querySymbol);
  const settings = await readSettings();
  return normalizeSymbol(settings.activeSymbol);
}
