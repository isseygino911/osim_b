import { readSnapshot } from "../models/snapshot.model.js";
import * as autopilotService from "../services/autopilot.service.js";
import { resolveSymbol } from "../services/symbol.service.js";

// --- Autopilot: server-side simulated trading toward the 10%/week goal ---
// One isolated portfolio per symbol; ?symbol= defaults to the active symbol.

export async function getAutopilot(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await autopilotService.getStatus(symbol));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function enableAutopilot(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await autopilotService.setEnabled(symbol, true, readSnapshot));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function disableAutopilot(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await autopilotService.setEnabled(symbol, false, readSnapshot));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function runAutopilotNow(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await autopilotService.triggerRun(symbol, readSnapshot));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function resetAutopilot(req, res) {
  const symbol = await resolveSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
  try {
    res.json(await autopilotService.resetState(symbol));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
