import { Router } from "express";
import { getNews, getNewsDetail } from "../controllers/news.controller.js";

export const newsRouter = Router();

newsRouter.get("/api/news", getNews);
newsRouter.get("/api/news/detail", getNewsDetail);
