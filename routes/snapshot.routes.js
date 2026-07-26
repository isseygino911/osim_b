import { Router } from "express";
import { getChain, getGreeks, getIndicators, getSignal, getSnapshot, postSnapshot } from "../controllers/snapshot.controller.js";

export const snapshotRouter = Router();

snapshotRouter.get("/api/snapshot", getSnapshot);
snapshotRouter.post("/api/snapshot", postSnapshot);
snapshotRouter.get("/api/chain", getChain);
snapshotRouter.get("/api/indicators", getIndicators);
snapshotRouter.get("/api/signal", getSignal);
snapshotRouter.get("/api/greeks", getGreeks);
