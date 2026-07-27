import { readSettings, writeSettings } from "../models/settings.model.js";
import { listSnapshotSymbols, readSnapshot } from "../models/snapshot.model.js";
import { normalizeSymbol } from "../services/symbol.service.js";

// The active symbol is what POST /api/refresh targets when no ?symbol= is passed,
// and what every data endpoint falls back to. null until the user picks one via
// PUT /api/symbol (search + "Go" in the client).
export async function getSymbol(_req, res) {
  try {
    const settings = await readSettings();
    res.json({ activeSymbol: normalizeSymbol(settings.activeSymbol) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function putSymbol(req, res) {
  const symbol = normalizeSymbol(req.body?.symbol);
  if (!symbol) {
    return res.status(400).json({ error: "Invalid symbol — expected 1-6 letters (stocks/ETFs only)" });
  }
  try {
    await writeSettings({ activeSymbol: symbol });
    // Tell the client immediately whether it should show the awaiting-data state.
    let hasSnapshot = false;
    let fetchedAt = null;
    try {
      const snap = await readSnapshot(symbol);
      hasSnapshot = true;
      fetchedAt = snap.fetchedAt ?? null;
    } catch {}
    res.json({ activeSymbol: symbol, hasSnapshot, fetchedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function listSymbols(_req, res) {
  try {
    const [symbols, settings] = await Promise.all([listSnapshotSymbols(), readSettings()]);
    const entries = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const snap = await readSnapshot(symbol);
          return {
            symbol,
            fetchedAt: snap.fetchedAt ?? null,
            price: snap.underlying?.price ?? null,
            name: snap.underlying?.name ?? null,
          };
        } catch {
          return { symbol, fetchedAt: null, price: null, name: null };
        }
      })
    );
    res.json({ symbols: entries, activeSymbol: normalizeSymbol(settings.activeSymbol) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
