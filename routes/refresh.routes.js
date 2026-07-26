import { Router } from "express";
import { getRefreshStatus, postRefreshProgress, postRefreshRequest } from "../controllers/refresh.controller.js";

export const refreshRouter = Router();

refreshRouter.post("/api/refresh", postRefreshRequest);
refreshRouter.post("/api/refresh/progress", postRefreshProgress);
refreshRouter.get("/api/refresh/status", getRefreshStatus);
