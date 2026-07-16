import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * Website Intelligence Layer — per-domain memory (M12, architecture-v3 §2.45). Global
 * (objective) facts about a domain, accumulated as a side effect of crawling. Rules
 * (per-org) and the page-type map / fingerprints come in later steps; this model leaves
 * room but the thin slice only fills the core facts.
 */
const domainProfileSchema = new Schema(
  {
    _id: { type: String, required: true }, // the domain (hostname)
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    pagesObserved: { type: Number, default: 0 },
    techStack: { type: [String], default: [] },
    renderModesSeen: { type: [String], default: [] }, // "http" and/or "browser"
    lastStatusOk: { type: Boolean, default: true },
    // M20: an HTTP-mode fetch looked like a bot-detection challenge (tiny body, no
    // real links, challenge-page phrasing) — feeds needsRender so future crawls of
    // this domain route to the renderer automatically. See botChallenge.ts.
    httpChallengeSeen: { type: Boolean, default: false },
    // Discovery Engine Step B (M18): learned "this path worked for this ask"
    // shortcuts. Capped at 20 most recent on write — see intelligence.ts.
    pathHints: {
      type: [
        {
          _id: false,
          keywords: { type: [String], default: [] },
          path: { type: String, required: true },
          confirmedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { versionKey: false, _id: false },
);

export const DomainProfileModel = model("DomainProfile", domainProfileSchema);
