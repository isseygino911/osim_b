import { Router } from "express";
import { deleteRefreshRequest, getAllRefreshes, getRefreshStatus, postRefreshProgress, postRefreshRequest } from "../controllers/refresh.controller.js";

export const refreshRouter = Router();

refreshRouter.post("/api/refresh", postRefreshRequest);
refreshRouter.delete("/api/refresh", deleteRefreshRequest);
refreshRouter.post("/api/refresh/progress", postRefreshProgress);
refreshRouter.get("/api/refresh/status", getRefreshStatus);
refreshRouter.get("/api/refresh/all", getAllRefreshes);
