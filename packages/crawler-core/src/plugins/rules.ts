import type { AnalyzerPlugin, AnalyzerInput } from "./types.js";
import type { CheerioAPI } from "cheerio";
import type { StructuredRecord } from "./structured.js";

/**
 * The Rule Library tier of the Extraction Engine (M11 Step 2, multi-record M22).
 * Given operator-configured CSS/XPath selectors (passed via `options.rules`),
 * extracts a normalized structured record — or, when the rule carries a
 * `listItem` container selector, one record per matching container.
 */

export interface RuleOptions {
  readonly schemaType: string;
  readonly fields: Record<string, string>; // name -> css selector
  /** List rule (M22): field selectors resolve relative to each match of this. */
  readonly listItem?: string;
}

/** A `StructuredRecord` that can carry multiple records (list rules, M22).
 * `fields` stays the first record so every single-record consumer (coverage
 * check, hit/miss recording, row previews) works unchanged. */
export interface RulesRecord extends StructuredRecord {
  readonly records?: readonly Record<string, string>[];
}

// A list selector accidentally matching every <div> shouldn't turn one page
// into thousands of rows.
const MAX_LIST_RECORDS = 100;

function extractFromRules($: CheerioAPI, ruleOpt: RuleOptions): RulesRecord {
  if (ruleOpt.listItem) {
    const records: Record<string, string>[] = [];
    $(ruleOpt.listItem)
      .slice(0, MAX_LIST_RECORDS)
      .each((_, el) => {
        const item = $(el);
        const record: Record<string, string> = {};
        for (const [name, selector] of Object.entries(ruleOpt.fields)) {
          const val = item.find(selector).first().text().trim();
          if (val) record[name] = val;
        }
        // A container where nothing matched is noise, not an empty record.
        if (Object.keys(record).length > 0) records.push(record);
      });

    const hasRecords = records.length > 0;
    return {
      type: hasRecords ? ruleOpt.schemaType : null,
      source: hasRecords ? "rules" : "none",
      fields: records[0] ?? {},
      records,
      confidence: hasRecords ? "high" : "none",
    };
  }

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
