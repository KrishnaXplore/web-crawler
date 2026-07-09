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
  },
  { versionKey: false, _id: false },
);

export const DomainProfileModel = model("DomainProfile", domainProfileSchema);
