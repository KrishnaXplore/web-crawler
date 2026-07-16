import * as cheerio from "cheerio";

/**
 * Pagination detection (M25 — docs/phase25.md). Finds the "next page" link on a
 * listing page so a collection crawl can walk the whole result set. Pure and
 * cheerio-based — same discipline as the other pipeline helpers.
 *
 * Detection order, most reliable first:
 *   1. <link rel="next"> / <a rel="next">  — the semantic standard
 *   2. aria-label containing "next"
 *   3. class-based: li.next > a, a.next, .pagination-next > a
 *   4. text-based anchor ("next", "›", "»", ">", "older") inside a pagination
 *      container
 *
 * Returns an absolute http(s) URL, or null. Never returns the page's own URL
 * (a self-referential "next" would loop — though enqueue dedup would also catch
 * it).
 */

const NEXT_ARIA = /next/i;
const NEXT_TEXT = /^\s*(next(\s+page)?|older(\s+posts?)?|›|»|>|→)\s*$/i;

function resolve(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) {
    return null;
  }
  try {
    const abs = new URL(trimmed, baseUrl).toString();
    if (!/^https?:/i.test(abs)) return null;
    // Ignore a "next" that just points back at the current page.
    if (abs === baseUrl || abs === `${baseUrl}#`) return null;
    return abs;
  } catch {
    return null;
  }
}

export function findNextPageUrl(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);

  // 1. rel="next" (link or anchor). `rel~=` matches a space-separated token.
  let hit = resolve(
    $('link[rel~="next"], a[rel~="next"]').first().attr("href"),
    baseUrl,
  );
  if (hit) return hit;

  // 2. aria-label mentioning "next".
  $("a[aria-label]").each((_, el) => {
    if (hit) return;
    if (NEXT_ARIA.test($(el).attr("aria-label") ?? "")) {
      hit = resolve($(el).attr("href"), baseUrl);
    }
  });
  if (hit) return hit;

  // 3. class-based next anchors.
  hit = resolve(
    $("li.next > a, a.next, .next > a, .pagination-next > a, .pagination-next")
      .first()
      .attr("href"),
    baseUrl,
  );
  if (hit) return hit;

  // 4. text-based pagination anchors, scoped to a pagination-ish container so a
  //    stray ">" elsewhere on the page doesn't match.
  $('.pagination a, .pager a, [class*="pag" i] a, nav[aria-label*="pag" i] a').each(
    (_, el) => {
      if (hit) return;
      if (NEXT_TEXT.test($(el).text())) {
        hit = resolve($(el).attr("href"), baseUrl);
      }
    },
  );
  return hit;
}
