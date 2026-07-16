import * as cheerio from "cheerio";
import { normalizeUrl, hostOf, InvalidUrlError } from "@crawler/shared";

export interface ExtractOptions {
  /** Drop links whose host differs from the page's host. */
  readonly sameHostOnly: boolean;
}

/**
 * A discovered link plus its visible anchor text (M16) — the anchor text is the
 * cheapest, highest-value signal for the Discovery Engine's pre-fetch link
 * scorer (packages/crawler-core/src/discovery/linkScorer.ts) to decide crawl
 * order. Read once here rather than thrown away, so nothing needs a second pass.
 */
export interface LinkCandidate {
  readonly url: string;
  readonly anchorText: string;
}

/**
 * Extract, resolve, normalize, scope-filter, and de-dupe the `<a href>` links in
 * an HTML document (workflow.md Phase 4.5), keeping each link's anchor text.
 *
 * `pageUrl` is the normalized URL the HTML was fetched from; relative links
 * resolve against it, honoring a `<base href>` if present. Links that are not
 * http(s) (mailto:, tel:, javascript:, in-page #anchors) are silently skipped.
 */
export function extractLinks(
  html: string,
  pageUrl: string,
  options: ExtractOptions,
): LinkCandidate[] {
  const $ = cheerio.load(html);

  // Honor <base href> for relative resolution; ignore a malformed one.
  let base = pageUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref) {
    try {
      base = normalizeUrl(baseHref, pageUrl);
    } catch {
      /* keep pageUrl as base */
    }
  }

  const self = normalizeUrl(pageUrl);
  const pageHost = hostOf(pageUrl);
  const out = new Map<string, string>(); // normalized url -> first-seen anchor text

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let normalized: string;
    try {
      normalized = normalizeUrl(href, base);
    } catch (err) {
      if (err instanceof InvalidUrlError) return; // non-http(s) or junk link
      throw err;
    }
    // Drop self-links (e.g. a bare "#anchor" resolves to the page itself) so a
    // page never re-enqueues the URL currently being crawled.
    if (normalized === self) return;
    if (options.sameHostOnly && hostOf(normalized) !== pageHost) return;
    if (!out.has(normalized)) out.set(normalized, $(el).text().trim());
  });

  return [...out.entries()].map(([url, anchorText]) => ({ url, anchorText }));
}

/**
 * Count a page's outgoing links split by scope (M8 Step C) — internal (same host as
 * the page) vs external. Unlike extractLinks, this counts ALL links regardless of the
 * crawl's sameHostOnly setting, so the report reflects the page's real link profile.
 * De-duped by normalized URL.
 */
export function countLinkScope(
  html: string,
  pageUrl: string,
): { internal: number; external: number } {
  const $ = cheerio.load(html);
  const pageHost = hostOf(pageUrl);
  const self = normalizeUrl(pageUrl);
  const seen = new Set<string>();
  let internal = 0;
  let external = 0;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let normalized: string;
    try {
      normalized = normalizeUrl(href, pageUrl);
    } catch (err) {
      if (err instanceof InvalidUrlError) return;
      throw err;
    }
    if (normalized === self || seen.has(normalized)) return;
    seen.add(normalized);
    if (hostOf(normalized) === pageHost) internal += 1;
    else external += 1;
  });

  return { internal, external };
}
