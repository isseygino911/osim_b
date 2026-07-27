import cors from "cors";
import express from "express";
import { migrateAutopilotLayout } from "./models/autopilot.model.js";
import { migrateSnapshotLayout, readSnapshot } from "./models/snapshot.model.js";
import { autopilotRouter } from "./routes/autopilot.routes.js";
import { newsRouter } from "./routes/news.routes.js";
import { refreshRouter } from "./routes/refresh.routes.js";
import { snapshotRouter } from "./routes/snapshot.routes.js";
import { symbolRouter } from "./routes/symbol.routes.js";
import { init as initAutopilot } from "./services/autopilot.service.js";
import { initAutoRefresh } from "./services/refresh.service.js";
import { isTradierConfigured } from "./services/tradier.service.js";

const PORT = process.env.PORT || 8787;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://osim.isseylab.com",
];
const ALLOWED_ORIGINS = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : DEFAULT_ALLOWED_ORIGINS;

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server, same-origin) — allow.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));

app.use(snapshotRouter);
app.use(newsRouter);
app.use(autopilotRouter);
app.use(symbolRouter);
app.use(refreshRouter);

app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  res.status(500).json({ error: err.message });
});

app.listen(PORT, async () => {
  console.log(`[server] Snapshot server listening on http://localhost:${PORT}`);
  try {
    // Legacy single-file data moves into the per-symbol layout before anything reads it.
    await migrateSnapshotLayout();
    await migrateAutopilotLayout();
    await initAutopilot(readSnapshot);
    console.log("[server] Autopilot loop initialized (disabled by default — POST /api/autopilot/enable to start).");
    if (isTradierConfigured()) {
      initAutoRefresh();
    } else {
      console.log("[server] TRADIER_API_KEY not set — snapshot refresh is disabled until it's added to server/.env.");
    }
  } catch (e) {
    console.error("[server] Autopilot init failed:", e.message);
  }
});
