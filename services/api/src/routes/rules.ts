import express from "express";
import { getRulesForDomain, upsertRule } from "@crawler/db";

export const rulesRouter: express.Router = express.Router();

// GET /rules/:domain
rulesRouter.get("/:domain", async (req, res, next) => {
  try {
    const rules = await getRulesForDomain(req.params.domain);
    if (!rules) {
      res.status(404).json({ error: "No rules found for this domain" });
      return;
    }
    res.json(rules);
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

    await upsertRule({
      domain: req.params.domain,
      schemaType,
      fields,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
