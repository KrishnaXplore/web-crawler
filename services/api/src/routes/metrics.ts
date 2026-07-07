import express from "express";
import { metricsText, contentType } from "@crawler/metrics";

export const metricsRouter: express.Router = express.Router();

metricsRouter.get("/", async (_req, res, next) => {
  try {
    res.setHeader("Content-Type", contentType);
    res.send(await metricsText());
  } catch (err) {
    next(err);
  }
});
