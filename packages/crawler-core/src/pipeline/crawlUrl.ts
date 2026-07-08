import { normalizeUrl } from "@crawler/shared";
import { extractLinks, countLinkScope } from "./extractLinks.js";
import { parseMeta } from "./parse.js";
import { SsrfError } from "./ssrfGuard.js";
import type { FetchResult } from "./fetch.js";
import type { RobotsRules } from "./robots.js";

export type CrawlOutcome = "ok" | "skipped-robots" | "blocked-ssrf" | "error";

/**
 * Injected dependencies, so the orchestrator is testable without network:
 * tests pass stubs; the CLI/worker pass the real `fetchPage` + a robots provider.
 */
export interface CrawlDeps {
  readonly fetch: (url: string) => Promise<FetchResult>;
  /** Resolve robots rules for an origin (e.g. "https://a.com"). Required if respectRobots. */
  readonly robotsFor?: (origin: string) => Promise<RobotsRules>;
}

export interface CrawlOptions {
  readonly sameHostOnly: boolean;
  readonly respectRobots: boolean;
}

export interface CrawlPageResult {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number | null;
  readonly contentType: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly links: string[];
  /** Outgoing links split by scope (M8 Step C). */
  readonly internalLinks: number;
  readonly externalLinks: number;
  /** Server response time in ms, or null for non-fetched outcomes (M8 Step C). */
  readonly responseTimeMs: number | null;
  /** Raw HTML body when the page is HTML, else null (for blob storage). */
  readonly html: string | null;
  /** Response headers (lowercased) — for analyzer plugins. */
  readonly headers: Record<string, string>;
  readonly outcome: CrawlOutcome;
  readonly error?: string;
}

const HTML_RE = /text\/html|application\/xhtml\+xml/i;

/**
 * Crawl a single URL: robots gate → fetch → parse → extract (workflow.md Phase 4).
 * Never throws for expected failures — a fetch error becomes `outcome: "error"`,
 * a robots block becomes `outcome: "skipped-robots"`.
 */
export async function crawlUrl(
  rawUrl: string,
  deps: CrawlDeps,
  options: CrawlOptions,
): Promise<CrawlPageResult> {
  const url = normalizeUrl(rawUrl);

  if (options.respectRobots && deps.robotsFor) {
    const { origin, pathname, search } = new URL(url);
    const rules = await deps.robotsFor(origin);
    if (!rules.isAllowed(pathname + search)) {
      return empty(url, "skipped-robots");
    }
  }

  let res: FetchResult;
  try {
    res = await deps.fetch(url);
  } catch (err) {
    // SSRF blocks are permanent — a distinct outcome, never retried (ADR-0005).
    if (err instanceof SsrfError) return empty(url, "blocked-ssrf");
    return { ...empty(url, "error"), error: (err as Error).message };
  }

  const isHtml = res.contentType !== null && HTML_RE.test(res.contentType);
  const meta = isHtml
    ? parseMeta(res.body)
    : { title: null, description: null };
  const links = isHtml
    ? extractLinks(res.body, url, { sameHostOnly: options.sameHostOnly })
    : [];
  const scope = isHtml
    ? countLinkScope(res.body, url)
    : { internal: 0, external: 0 };

  return {
    url,
    finalUrl: res.finalUrl,
    status: res.status,
    contentType: res.contentType,
    title: meta.title,
    description: meta.description,
    links,
    internalLinks: scope.internal,
    externalLinks: scope.external,
    responseTimeMs: res.responseTimeMs,
    html: isHtml ? res.body : null,
    headers: res.headers,
    outcome: "ok",
  };
}

function empty(url: string, outcome: CrawlOutcome): CrawlPageResult {
  return {
    url,
    finalUrl: null,
    status: null,
    contentType: null,
    title: null,
    description: null,
    links: [],
    internalLinks: 0,
    externalLinks: 0,
    responseTimeMs: null,
    html: null,
    headers: {},
    outcome,
  };
}
