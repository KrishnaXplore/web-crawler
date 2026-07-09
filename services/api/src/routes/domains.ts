import express from "express";
import { getDomainProfile } from "@crawler/db";

/**
 * Website Intelligence Layer read API (M12). Returns the accumulated per-domain profile
 * — global objective facts (tech, render need, activity). No secrets; no auth beyond the
 * app-level API key.
 */
export const domainsRouter: express.Router = express.Router();

// GET /domains/:domain
domainsRouter.get("/:domain", async (req, res, next) => {
  try {
    const profile = await getDomainProfile(req.params.domain);
    if (profile === null) {
      res.status(404).json({ error: "domain not seen yet" });
      return;
    }
    res.json(profile);
  } catch (err) {
    next(err);
  }
});
