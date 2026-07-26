import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const IV_HISTORY_DIR = path.join(DATA_DIR, "iv-history");

// Controllers validate symbols via symbol.service.js; re-assert here (models can't
// import services) so no unvalidated string can ever become a path segment.
const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;

function ivHistoryPath(symbol) {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  return path.join(IV_HISTORY_DIR, `${symbol}.json`);
}

export async function readIvHistory(symbol) {
  try {
    const raw = await fs.readFile(ivHistoryPath(symbol), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeIvHistory(symbol, entries) {
  const filePath = ivHistoryPath(symbol);
  await fs.mkdir(IV_HISTORY_DIR, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2));
  await fs.rename(tmpPath, filePath);
}
