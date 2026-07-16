import express from "express";
import { getRuleWithMeta, upsertRule } from "@crawler/db";

export const rulesRouter: express.Router = express.Router();

// GET /rules/:domain — extraction fields + the feedback-loop signal (version,
// generatedBy, hits/misses, derived hitRate, last-verified). See gap-analysis fix #7.
rulesRouter.get("/:domain", async (req, res, next) => {
  try {
    const rule = await getRuleWithMeta(req.params.domain);
    if (!rule) {
      res.status(404).json({ error: "No rules found for this domain" });
      return;
    }
    res.json(rule);
  } catch (err) {
    next(err);
  }
});

// PUT /rules/:domain
rulesRouter.put("/:domain", express.json(), async (req, res, next) => {
  try {
    const { schemaType, fields } = req.body;
    if (!schemaType || typeof schemaType !== "string") {
      res.status(400).json({ error: "schemaType is required and must be a string" });
      return;
    }
    if (!fields || typeof fields !== "object") {
      res.status(400).json({ error: "fields is required and must be an object" });
      return;
    }

    await upsertRule(
      { domain: req.params.domain, schemaType, fields },
      { generatedBy: "operator" },
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
