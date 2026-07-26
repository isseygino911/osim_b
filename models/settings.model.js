import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(__dirname, "..", "..", "data", "settings.json");

export async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { activeSymbol: "QQQ" };
  }
}

export async function writeSettings(settings) {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmpPath = `${SETTINGS_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2));
  await fs.rename(tmpPath, SETTINGS_PATH);
}
