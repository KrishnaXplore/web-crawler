import * as cheerio from "cheerio";
import { normalizeUrl, hostOf, InvalidUrlError } from "@crawler/shared";

export interface ExtractOptions {
  /** Drop links whose host differs from the page's host. */
  readonly sameHostOnly: boolean;
}

/**
 * Extract, resolve, normalize, scope-filter, and de-dupe the `<a href>` links in
 * an HTML document (workflow.md Phase 4.5).
 *
 * `pageUrl` is the normalized URL the HTML was fetched from; relative links
 * resolve against it, honoring a `<base href>` if present. Links that are not
 * http(s) (mailto:, tel:, javascript:, in-page #anchors) are silently skipped.
 */
export function extractLinks(
  html: string,
  pageUrl: string,
  options: ExtractOptions,
): string[] {
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
  const out = new Set<string>();

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
    out.add(normalized);
  });

  return [...out];
}
