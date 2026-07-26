import { readSnapshot } from "../models/snapshot.model.js";
import * as autopilotService from "../services/autopilot.service.js";

// --- Autopilot: server-side simulated trading toward the 10%/week goal ---

export async function getAutopilot(_req, res) {
  try {
    res.json(autopilotService.getStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function enableAutopilot(_req, res) {
  try {
    res.json(await autopilotService.setEnabled(true, readSnapshot));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function disableAutopilot(_req, res) {
  try {
    res.json(await autopilotService.setEnabled(false, readSnapshot));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function runAutopilotNow(_req, res) {
  try {
    res.json(await autopilotService.triggerRun(readSnapshot));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function resetAutopilot(_req, res) {
  try {
    res.json(await autopilotService.resetState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
