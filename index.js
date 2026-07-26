import cors from "cors";
import express from "express";
import { readSnapshot } from "./models/snapshot.model.js";
import { autopilotRouter } from "./routes/autopilot.routes.js";
import { newsRouter } from "./routes/news.routes.js";
import { snapshotRouter } from "./routes/snapshot.routes.js";
import { init as initAutopilot } from "./services/autopilot.service.js";

const PORT = process.env.PORT || 8787;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(snapshotRouter);
app.use(newsRouter);
app.use(autopilotRouter);

app.listen(PORT, async () => {
  console.log(`[server] Snapshot server listening on http://localhost:${PORT}`);
  await initAutopilot(readSnapshot);
  console.log("[server] Autopilot loop initialized (disabled by default — POST /api/autopilot/enable to start).");
});
