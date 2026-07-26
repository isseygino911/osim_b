import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT_STATE_PATH = path.join(__dirname, "..", "..", "data", "autopilot.json");

export async function readAutopilotState() {
  const raw = await fs.readFile(AUTOPILOT_STATE_PATH, "utf-8");
  return JSON.parse(raw);
}

export async function writeAutopilotState(state) {
  await fs.mkdir(path.dirname(AUTOPILOT_STATE_PATH), { recursive: true });
  const tmpPath = `${AUTOPILOT_STATE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
  await fs.rename(tmpPath, AUTOPILOT_STATE_PATH);
}
