import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const AUTOPILOT_DIR = path.join(DATA_DIR, "autopilot");
const LEGACY_AUTOPILOT_PATH = path.join(DATA_DIR, "autopilot.json");

// Same defensive re-assert as snapshot.model.js — symbols become filenames.
const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;

function autopilotPath(symbol) {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  return path.join(AUTOPILOT_DIR, `${symbol}.json`);
}

export async function readAutopilotState(symbol) {
  const raw = await fs.readFile(autopilotPath(symbol), "utf-8");
  return JSON.parse(raw);
}

export async function writeAutopilotState(symbol, state) {
  const filePath = autopilotPath(symbol);
  await fs.mkdir(AUTOPILOT_DIR, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
  await fs.rename(tmpPath, filePath);
}

export async function listAutopilotSymbols() {
  try {
    const files = await fs.readdir(AUTOPILOT_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((s) => SYMBOL_RE.test(s)).sort();
  } catch {
    return [];
  }
}

// One-time layout migration: the pre-multi-symbol data/autopilot.json was always QQQ.
export async function migrateAutopilotLayout() {
  try {
    await fs.access(LEGACY_AUTOPILOT_PATH);
  } catch {
    return;
  }
  const target = autopilotPath("QQQ");
  try {
    await fs.access(target);
    return;
  } catch {
    await fs.mkdir(AUTOPILOT_DIR, { recursive: true });
    await fs.rename(LEGACY_AUTOPILOT_PATH, target);
    console.log("[server] Migrated data/autopilot.json → data/autopilot/QQQ.json");
  }
}
