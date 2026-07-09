import type { AnalyzerPlugin, AnalyzerInput } from "./types.js";

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
      // Usually, explicit product/article schema wins.
      if (signals.includes("has_product_schema") || signals.includes("has_article_schema")) {
        return { pageType: "detail", confidence: "low", signals };
      }
      return { pageType: "listing", confidence: "low", signals };
    }

    return { pageType: "unknown", confidence: "low", signals };
  },
};
