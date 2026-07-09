import type { AnalyzerPlugin, AnalyzerInput } from "./types.js";
import type { CheerioAPI } from "cheerio";
import type { StructuredRecord } from "./structured.js";

/**
 * The Rule Library tier of the Extraction Engine (M11 Step 2).
 * Given operator-configured CSS/XPath selectors (passed via `options.rules`),
 * extracts a normalized structured record.
 */

export interface RuleOptions {
  readonly schemaType: string;
  readonly fields: Record<string, string>; // name -> css selector
}

function extractFromRules($: CheerioAPI, ruleOpt: RuleOptions): StructuredRecord {
  const fields: Record<string, string> = {};
  
  for (const [name, selector] of Object.entries(ruleOpt.fields)) {
    const val = $(selector).first().text().trim();
    if (val) {
      fields[name] = val;
    }
  }

  // If no fields matched, we consider it a failed extraction.
  const hasFields = Object.keys(fields).length > 0;
  
  return {
    type: hasFields ? ruleOpt.schemaType : null,
    source: hasFields ? "rules" : "none",
    fields,
    confidence: hasFields ? "high" : "none",
  };
}

export const rulesPlugin: AnalyzerPlugin = {
  name: "rules",
  analyze({ $, options }: AnalyzerInput) {
    const ruleOpt = options?.rules as RuleOptions | undefined;
    if (!ruleOpt || !ruleOpt.schemaType || !ruleOpt.fields) {
      return { type: null, source: "none", fields: {}, confidence: "none" };
    }
    return { ...extractFromRules($, ruleOpt) };
  },
};
