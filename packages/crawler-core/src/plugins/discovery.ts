import type { AnalyzerPlugin, AnalyzerInput } from "./types.js";
import type { CheerioAPI } from "cheerio";

// Schema.org types that mark a page as a single detail record, not a hub —
// matched against JSON-LD @type (real sites, Amazon included, overwhelmingly
// use JSON-LD for this, not the itemscope/itemtype microdata the explicit-
// signal check below was originally limited to; a page can have review-section
// pagination AND be a genuine product page, and without this the pagination
// signal alone was winning that conflict).
const DETAIL_SCHEMA_TYPES = /^(product|article|newsarticle|blogposting|recipe|event|jobposting|person)$/i;

// Strong single-item URL conventions (/dp/ on Amazon, /gp/product/, /item/,
// /itm/ on eBay, /p/<id> on Flipkart/Target). Needed because rendered pages can
// lack schema markup entirely — observed live 2026-07-11: Amazon's hydrated
// product DOM ships zero JSON-LD blocks (the plain-HTTP variant has them), so
// without a schema-independent detail signal, a product page's related-items
// carousel + review pagination flips it to `listing` on the browser path.
// Exported for reuse by focused-crawl link filtering (M23) — the same "does
// this URL look like a single-item page" test that anchors classification.
export const DETAIL_URL_PATTERNS = /\/(dp|gp\/product|item|itm)\/[^/]|\/p\/[a-z0-9]/i;

/** Does this URL's path look like a single product/detail page? (M23) */
export function looksLikeDetailUrl(url: string): boolean {
  try {
    return DETAIL_URL_PATTERNS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Does any JSON-LD block on the page declare a detail-shaped @type? Cheap existence
 *  check only (discovery decides whether to run the real extractor, not extract
 *  itself) — malformed JSON-LD is ignored, same as the structured-data plugin. */
function hasJsonLdDetailSchema($: CheerioAPI): boolean {
  let found = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const data = JSON.parse(raw) as unknown;
      const nodes = Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>)["@graph"] as unknown[]) ?? [data];
      for (const n of nodes) {
        if (!n || typeof n !== "object") continue;
        const t = (n as Record<string, unknown>)["@type"];
        const typeStr = Array.isArray(t) ? t.join(" ") : String(t ?? "");
        if (DETAIL_SCHEMA_TYPES.test(typeStr)) {
          found = true;
          return;
        }
      }
    } catch {
      /* malformed JSON-LD block — ignore, same tolerance as the structured plugin */
    }
  });
  return found;
}

// Repeated-item-grid signal (M22 follow-up): search/category pages stamp every
// result card with the same machine-readable attribute — Amazon's
// data-component-type="s-search-result", the data-testid="product-card"
// convention elsewhere. Many identically-tagged containers, each with a link
// and real text, is a far stronger "this page lists things" signal than text
// density (which misclassified Amazon's mobile-phones category as `detail`,
// observed live 2026-07-11: 235 links, one lonely extracted price).
const MIN_GRID_ITEMS = 8;
const MIN_AVG_ITEM_TEXT_CHARS = 50; // real cards carry title+price; nav <li>s don't
const MIN_LINKED_RATIO = 0.8;
const MAX_ATTR_VALUE_LEN = 60; // skip JSON-blob data attributes
const MAX_TRACKED_PER_GROUP = 30;

/** The largest group of elements sharing one data-* name/value pair that looks
 *  like an item grid (≥8 members, ≥80% containing a link, avg text ≥50 chars),
 *  or null. Element refs are collected in one DOM pass; the (more expensive)
 *  text/link inspection only runs for groups big enough to qualify. */
function findRepeatedItemGrid($: CheerioAPI): { key: string; count: number } | null {
  const groups = new Map<string, { count: number; els: unknown[] }>();
  $("body *").each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs;
    if (!attribs) return;
    for (const [name, value] of Object.entries(attribs)) {
      if (!name.startsWith("data-") || !value || value.length > MAX_ATTR_VALUE_LEN) continue;
      const key = `${name}="${value}"`;
      const g = groups.get(key) ?? { count: 0, els: [] };
      g.count++;
      if (g.els.length < MAX_TRACKED_PER_GROUP) g.els.push(el);
      groups.set(key, g);
    }
  });

  let best: { key: string; count: number } | null = null;
  for (const [key, g] of groups) {
    if (g.count < MIN_GRID_ITEMS) continue;
    if (best && g.count <= best.count) continue;
    let linked = 0;
    let textLen = 0;
    for (const el of g.els) {
      const $el = $(el as never);
      if ($el.find("a").length > 0) linked++;
      textLen += $el.text().replace(/\s+/g, " ").trim().length;
    }
    const sampled = g.els.length;
    if (linked / sampled < MIN_LINKED_RATIO) continue;
    if (textLen / sampled < MIN_AVG_ITEM_TEXT_CHARS) continue;
    best = { key, count: g.count };
  }
  return best;
}

export interface DiscoveryRecord {
  /** The classified type of the page. */
  readonly pageType: "listing" | "detail" | "unknown";
  /** The confidence of this classification based on heuristics. */
  readonly confidence: "high" | "low";
  /** The heuristic signals that triggered this classification. */
  readonly signals: string[];
  [key: string]: unknown;
}

/**
 * The Discovery plugin analyzes the DOM to classify the structural purpose
 * of the page (listing vs. detail). This gives the crawler "spatial awareness"
 * to avoid running heavy extraction on navigation hubs (ADR-0006, M12).
 */
export const discoveryPlugin: AnalyzerPlugin = {
  name: "discovery",
  analyze(args: AnalyzerInput): DiscoveryRecord {
    const { $ } = args;
    const signals: string[] = [];
    let isDetail = false;
    let isListing = false;

    // 1. Explicit Semantic Signals (High Confidence)
    if ($("article").length > 0) {
      signals.push("has_article_tag");
      isDetail = true;
    }
    if ($("[itemscope][itemtype*='Product']").length > 0) {
      signals.push("has_product_schema");
      isDetail = true;
    }
    if ($("[itemscope][itemtype*='Article']").length > 0) {
      signals.push("has_article_schema");
      isDetail = true;
    }
    if (hasJsonLdDetailSchema($)) {
      signals.push("has_jsonld_detail_schema");
      isDetail = true;
    }
    if (looksLikeDetailUrl(args.url)) {
      signals.push("detail_url_pattern");
      isDetail = true;
    }

    // 2. Explicit Navigation/Listing Signals
    const paginationSelectors = [
      ".pagination",
      "[class*='pagination']",
      ".next",
      "[rel='next']",
      ".page-numbers",
      "[class*='nav-links']"
    ];
    for (const selector of paginationSelectors) {
      if ($(selector).length > 0) {
        signals.push(`has_pagination(${selector})`);
        isListing = true;
      }
    }

    // Repeated identically-tagged item containers — the s-search-result pattern.
    // Detail pages with "related products" carousels can fire this too; the
    // conflict resolution below lets their explicit detail schema win.
    const grid = findRepeatedItemGrid($);
    if (grid !== null) {
      signals.push(`repeated_item_grid(${grid.key} x${grid.count})`);
      isListing = true;
    }

    // 3. Structural Heuristics (Text vs Link density)
    const body = $("body");
    const totalTextLength = body.text().replace(/\s+/g, "").length;
    const allLinks = $("body a");
    const linkTextLength = allLinks.text().replace(/\s+/g, "").length;
    const linkCount = allLinks.length;

    // A detail page usually has a large amount of non-link text.
    const nonLinkTextLength = totalTextLength - linkTextLength;
    
    if (nonLinkTextLength > 2000) {
      signals.push("high_text_density");
      isDetail = true;
    }

    // A listing page typically has a high number of links relative to its text.
    if (linkCount > 50 && (linkTextLength / (totalTextLength || 1)) > 0.4) {
      signals.push("high_link_density");
      isListing = true;
    }

    // Resolution Logic
    if (isDetail && !isListing) {
      return { pageType: "detail", confidence: signals.length > 1 ? "high" : "low", signals };
    }
    if (isListing && !isDetail) {
      return { pageType: "listing", confidence: signals.length > 1 ? "high" : "low", signals };
    }
    
    // Conflicting or missing signals
    if (isListing && isDetail) {
      // If it has pagination BUT a massive article, it might be a paginated article.
      // Usually, explicit product/article schema wins — including JSON-LD, which
      // is how most real sites (Amazon among them) actually declare it — and, on
      // rendered pages that ship no schema at all, a single-item URL convention.
      if (
        signals.includes("has_product_schema") ||
        signals.includes("has_article_schema") ||
        signals.includes("has_jsonld_detail_schema") ||
        signals.includes("detail_url_pattern")
      ) {
        return { pageType: "detail", confidence: "low", signals };
      }
      return { pageType: "listing", confidence: "low", signals };
    }

    return { pageType: "unknown", confidence: "low", signals };
  },
};
