import * as cheerio from "cheerio";

export interface PageMeta {
  readonly title: string | null;
  readonly description: string | null;
}

/**
 * Extract basic page metadata from HTML (workflow.md Phase 4.5). Richer analyses
 * (SEO, security, a11y, …) are the job of the analyzer plugins (Phase 4.6), not
 * this function.
 */
export function parseMeta(html: string): PageMeta {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || null;
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;

  return { title, description };
}
