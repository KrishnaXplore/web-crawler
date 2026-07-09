import type { AnalyzerPlugin, AnalyzerInput } from "./types.js";
import type { CheerioAPI } from "cheerio";

/**
 * Structured-data extractor (M11 Step 1 — docs/phase11.md). The cheap first tier of the
 * extraction engine: turn a page's embedded structured data into a normalized, typed
 * record. Tries JSON-LD → Schema.org microdata → OpenGraph, first hit wins, so the
 * `source`/`confidence` stay meaningful. Pure and rule-based; no AI.
 */

export interface StructuredRecord {
  /** Detected schema type (e.g. "Article", "Product"), "og:<type>", or null. */
  readonly type: string | null;
  /** 
   * Which tier produced the record.
   * "rules": Heuristic extraction based on DOM structure.
   * "none": Extraction failed or no data found.
   */
  readonly source: "json-ld" | "microdata" | "opengraph" | "rules" | "none";
  readonly fields: Record<string, string>;
  readonly confidence: "high" | "low" | "none";
}

function firstType(t: unknown): string | null {
  if (typeof t === "string") return t;
  if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  return null;
}

/** Flatten a JSON-LD node's scalar/string props into a flat field map. */
function flattenNode(node: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@")) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      // one level of nesting: pick a name/url-ish scalar (author.name, image.url…)
      const o = v as Record<string, unknown>;
      const pick = o.name ?? o.url ?? o["@id"];
      if (typeof pick === "string") out[k] = pick;
    } else if (Array.isArray(v) && typeof v[0] === "string") {
      out[k] = v.join(", ");
    }
  }
  return out;
}

/** Tier 1 — JSON-LD. Handles arrays and @graph; picks the richest typed node. */
function fromJsonLd($: CheerioAPI): StructuredRecord | null {
  const nodes: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const data = JSON.parse(raw) as unknown;
      const list = Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>)["@graph"] as unknown[]) ?? [data];
      for (const n of list) if (n && typeof n === "object") nodes.push(n as Record<string, unknown>);
    } catch {
      /* malformed JSON-LD — ignore this block */
    }
  });
  if (nodes.length === 0) return null;
  // Prefer the node with the most fields (usually the main entity, not breadcrumbs).
  const best = nodes
    .map((n) => ({ n, fields: flattenNode(n) }))
    .sort((a, b) => Object.keys(b.fields).length - Object.keys(a.fields).length)[0]!;
  if (Object.keys(best.fields).length === 0) return null;
  return {
    type: firstType(best.n["@type"]),
    source: "json-ld",
    fields: best.fields,
    confidence: "high",
  };
}

/** Tier 2 — Schema.org microdata (itemscope/itemprop). */
function fromMicrodata($: CheerioAPI): StructuredRecord | null {
  const scope = $("[itemscope][itemtype]").first();
  if (scope.length === 0) return null;
  const fields: Record<string, string> = {};
  scope.find("[itemprop]").each((_, el) => {
    const name = $(el).attr("itemprop");
    if (!name || fields[name]) return;
    const val =
      $(el).attr("content") ??
      $(el).attr("datetime") ??
      $(el).attr("href") ??
      $(el).text().trim();
    if (val) fields[name] = val.slice(0, 500);
  });
  if (Object.keys(fields).length === 0) return null;
  const itemtype = scope.attr("itemtype") ?? "";
  return {
    type: itemtype.split("/").pop() || null,
    source: "microdata",
    fields,
    confidence: "high",
  };
}

/** Tier 3 — OpenGraph floor. Thin but reliable. */
function fromOpenGraph($: CheerioAPI): StructuredRecord | null {
  const fields: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr("property")!.slice(3); // strip "og:"
    const content = $(el).attr("content")?.trim();
    if (content && !fields[prop]) fields[prop] = content;
  });
  if (Object.keys(fields).length === 0) return null;
  return {
    type: fields.type ? `og:${fields.type}` : null,
    source: "opengraph",
    fields,
    confidence: "low",
  };
}

export function extractStructured($: CheerioAPI): StructuredRecord {
  return (
    fromJsonLd($) ??
    fromMicrodata($) ??
    fromOpenGraph($) ?? { type: null, source: "none", fields: {}, confidence: "none" }
  );
}

export const structuredPlugin: AnalyzerPlugin = {
  name: "structured",
  analyze({ $ }: AnalyzerInput) {
    return { ...extractStructured($) };
  },
};
