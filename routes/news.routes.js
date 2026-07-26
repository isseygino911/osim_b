import { Router } from "express";
import { getNews } from "../controllers/news.controller.js";

export const newsRouter = Router();

newsRouter.get("/api/news", getNews);
