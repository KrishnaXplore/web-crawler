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
    _id: { type: String, required: true }, // The domain (e.g., quotes.toscrape.com)
    schemaType: { type: String, required: true }, // e.g., "Product" or "Quote"
    fields: { 
      type: Map, 
      of: String, // Field name -> CSS/XPath selector
      required: true 
    },
    updatedAt: { type: Date, default: Date.now }
  },
  { versionKey: false, _id: false }
);

export const RuleModel = model("Rule", ruleSchema);
