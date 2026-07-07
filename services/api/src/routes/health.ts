import express from "express";

export const healthRouter: express.Router = express.Router();

healthRouter.get("/", (_req, res) => {
  res.json({ status: "ok" });
});
