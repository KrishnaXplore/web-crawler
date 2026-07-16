import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * Extraction Engine (M11 Step 2) — Rule Library.
 * Stores the target extraction schema for a domain, defining which CSS/XPath
 * selectors to run. 
 * Note: Globally keyed by domain for now, per-org scoping deferred to M15.
 */
const ruleSchema = new Schema(
  {
    // The domain for detail rules (e.g., quotes.toscrape.com); "<domain>#list"
    // for list rules (M22) — two independent rule docs per domain, zero
    // migration for pre-M22 docs.
    _id: { type: String, required: true },
    schemaType: { type: String, required: true }, // e.g., "Product" or "Quote"
    fields: {
      type: Map,
      of: String, // Field name -> CSS/XPath selector
      required: true
    },
    // List rules only (M22): selector matching each repeating item container;
    // `fields` selectors resolve relative to each match.
    listItem: { type: String, default: null },
    // Feedback loop (architecture-v3 §2.45 / gap-analysis fix #7): who produced this
    // rule, how many times it's been regenerated, and its observed success rate —
    // the signal a future self-heal step watches for staleness (falling hit rate).
    generatedBy: { type: String, enum: ["operator", "llm"], default: "operator" },
    version: { type: Number, default: 1 },
    hits: { type: Number, default: 0 },
    misses: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null }, // last successful extraction
    updatedAt: { type: Date, default: Date.now }
  },
  { versionKey: false, _id: false }
);

export const RuleModel = model("Rule", ruleSchema);
