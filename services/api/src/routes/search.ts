import express from "express";
import { searchPages } from "@crawler/db";

export const searchRouter: express.Router = express.Router();

// GET /search?q=...&jobId=...&limit=...
searchRouter.get("/", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim() === "") {
      res.status(400).json({ error: "missing query parameter q" });
      return;
    }
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : null;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const results = await searchPages(q, jobId, limit);
    res.json({ q, count: results.length, results });
  } catch (err) {
    next(err);
  }
});
