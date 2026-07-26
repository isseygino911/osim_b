import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "..", "..", "data", "snapshot.json");

// Raw file text — GET /api/snapshot serves this byte-identical, so no parse/re-stringify here.
export async function readSnapshotRaw() {
  return fs.readFile(SNAPSHOT_PATH, "utf-8");
}

export async function readSnapshot() {
  const raw = await fs.readFile(SNAPSHOT_PATH, "utf-8");
  return JSON.parse(raw);
}

export async function writeSnapshot(snapshot) {
  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
}
