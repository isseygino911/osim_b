import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const REQUEST_DIR = path.join(DATA_DIR, "refresh-requests");
const STATUS_DIR = path.join(DATA_DIR, "refresh-status");

// Controllers validate symbols via symbol.service.js; re-assert here (models can't
// import services) so no unvalidated string can ever become a path segment.
const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;

function requestPath(symbol) {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  return path.join(REQUEST_DIR, `${symbol}.request`);
}

function statusPath(symbol) {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  return path.join(STATUS_DIR, `${symbol}.json`);
}

// Trigger file for the launchd WatchPaths watcher — a plain marker, never read back
// by the server itself. Kept in its own directory so status updates (below) never
// touch a watched path and cause the watcher to refire on its own progress writes.
export async function writeRefreshRequest(symbol, requestedAt) {
  await fs.mkdir(REQUEST_DIR, { recursive: true });
  const filePath = requestPath(symbol);
  await fs.writeFile(filePath, JSON.stringify({ symbol, requestedAt }, null, 2));
}

export async function readRefreshStatus(symbol) {
  try {
    const raw = await fs.readFile(statusPath(symbol), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeRefreshStatus(symbol, status) {
  const filePath = statusPath(symbol);
  await fs.mkdir(STATUS_DIR, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(status, null, 2));
  await fs.rename(tmpPath, filePath);
}

// Every symbol with a refresh-status file, regardless of which one is currently
// active in the client — powers a global "what's running" list across symbols.
export async function listRefreshStatuses() {
  let files;
  try {
    files = await fs.readdir(STATUS_DIR);
  } catch {
    return [];
  }
  const symbols = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((s) => SYMBOL_RE.test(s));
  const statuses = await Promise.all(symbols.map((s) => readRefreshStatus(s)));
  return statuses.filter(Boolean);
}

// Clears any stuck/stale status (and a still-pending trigger file, if the watcher
// never claimed it) so a snapshot reset doesn't leave a dangling banner behind.
export async function clearRefreshState(symbol) {
  await Promise.all([
    fs.unlink(statusPath(symbol)).catch((e) => { if (e.code !== "ENOENT") throw e; }),
    fs.unlink(requestPath(symbol)).catch((e) => { if (e.code !== "ENOENT") throw e; }),
  ]);
}
