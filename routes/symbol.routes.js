import { Router } from "express";
import { getSymbol, listSymbols, putSymbol } from "../controllers/symbol.controller.js";

export const symbolRouter = Router();

symbolRouter.get("/api/symbol", getSymbol);
symbolRouter.put("/api/symbol", putSymbol);
symbolRouter.get("/api/symbols", listSymbols);
