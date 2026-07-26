import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const LEGACY_SNAPSHOT_PATH = path.join(DATA_DIR, "snapshot.json");

// Controllers validate symbols via symbol.service.js; re-assert here (models can't
// import services) so no unvalidated string can ever become a path segment.
const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;

function snapshotPath(symbol) {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  return path.join(SNAPSHOT_DIR, `${symbol}.json`);
}

// Raw file text — GET /api/snapshot serves this byte-identical, so no parse/re-stringify here.
export async function readSnapshotRaw(symbol) {
  return fs.readFile(snapshotPath(symbol), "utf-8");
}

export async function readSnapshot(symbol) {
  const raw = await fs.readFile(snapshotPath(symbol), "utf-8");
  return JSON.parse(raw);
}

export async function writeSnapshot(symbol, snapshot) {
  const filePath = snapshotPath(symbol);
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2));
  await fs.rename(tmpPath, filePath);
}

export async function listSnapshotSymbols() {
  try {
    const files = await fs.readdir(SNAPSHOT_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((s) => SYMBOL_RE.test(s)).sort();
  } catch {
    return [];
  }
}

// One-time layout migration: the pre-multi-symbol data/snapshot.json was always QQQ.
// fs.rename keeps the bytes identical, preserving the raw-passthrough invariant.
export async function migrateSnapshotLayout() {
  try {
    await fs.access(LEGACY_SNAPSHOT_PATH);
  } catch {
    return;
  }
  const target = snapshotPath("QQQ");
  try {
    await fs.access(target);
    return; // already migrated — leave the stray legacy file alone
  } catch {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    await fs.rename(LEGACY_SNAPSHOT_PATH, target);
    console.log("[server] Migrated data/snapshot.json → data/snapshots/QQQ.json");
  }
}
