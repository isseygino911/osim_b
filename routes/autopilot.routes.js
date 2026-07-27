import { Router } from "express";
import {
  deleteAutopilotEndpoint,
  disableAutopilot,
  enableAutopilot,
  getAutopilot,
  resetAutopilot,
  runAutopilotNow,
} from "../controllers/autopilot.controller.js";

export const autopilotRouter = Router();

autopilotRouter.get("/api/autopilot", getAutopilot);
autopilotRouter.post("/api/autopilot/enable", enableAutopilot);
autopilotRouter.post("/api/autopilot/disable", disableAutopilot);
autopilotRouter.post("/api/autopilot/run-now", runAutopilotNow);
autopilotRouter.post("/api/autopilot/reset", resetAutopilot);
autopilotRouter.delete("/api/autopilot", deleteAutopilotEndpoint);
