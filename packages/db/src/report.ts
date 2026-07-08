import { PageModel } from "./models/page.js";
import { JobModel } from "./models/job.js";

/**
 * Website Health Report (M8 Step A — see docs/phase8.md). A crawl's per-page results
 * aggregated into a summary a *user* can act on ("2 pages missing H1, 0 broken") rather
 * than raw crawl telemetry. Almost everything here is derived from data already stored
 * (M3–M6); this is a read-side aggregation, not new crawling.
 *
 * The aggregation runs over a LEAN projection (a handful of small fields per page — no
 * HTML, no full analysis blob), streamed from a cursor and folded incrementally, so a
 * large job doesn't load full documents into memory.
 */

/** The minimal per-page shape the reducer needs. */
export interface ReportPage {
  readonly status: number | null;
  readonly discoveredLinks: number;
  readonly parentUrl: string | null;
  readonly h1Count?: number;
  readonly hasMetaDescription?: boolean;
  readonly imagesMissingAlt?: number;
  readonly techDetected?: readonly string[];
  readonly securityScore?: string;
}

export interface HealthReport {
  readonly pagesCrawled: number;
  readonly statusBreakdown: Record<"2xx" | "3xx" | "4xx" | "5xx" | "other", number>;
  readonly brokenPages: number;
  readonly totalDiscoveredLinks: number;
  readonly avgLinksPerPage: number;
  readonly pagesMissingH1: number;
  readonly pagesMissingMetaDescription: number;
  readonly imagesMissingAlt: number;
  readonly technology: readonly string[];
  readonly securityScore: string | null;
  readonly mostLinkedPage: { url: string; inLinks: number } | null;
  // From the job record, not the pages:
  readonly crawlDurationMs: number | null;
  readonly robotsRespected: boolean;
}

export interface ReportMeta {
  readonly crawlDurationMs: number | null;
  readonly robotsRespected: boolean;
}

function statusClass(status: number | null): keyof HealthReport["statusBreakdown"] {
  if (status === null) return "other";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

/** Pure fold over the page projection — unit-testable with no Mongo. */
export function reduceReport(
  pages: readonly ReportPage[],
  meta: ReportMeta,
): HealthReport {
  const statusBreakdown = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
  let totalLinks = 0;
  let missingH1 = 0;
  let missingMeta = 0;
  let imagesMissingAlt = 0;
  const techCounts = new Map<string, number>();
  const securityCounts = new Map<string, number>();
  const inLinks = new Map<string, number>(); // parentUrl → in-degree

  for (const p of pages) {
    statusBreakdown[statusClass(p.status)] += 1;
    totalLinks += p.discoveredLinks;
    if (p.h1Count === 0) missingH1 += 1;
    if (p.hasMetaDescription === false) missingMeta += 1;
    if (typeof p.imagesMissingAlt === "number") imagesMissingAlt += p.imagesMissingAlt;
    for (const t of p.techDetected ?? [])
      techCounts.set(t, (techCounts.get(t) ?? 0) + 1);
    if (p.securityScore !== undefined)
      securityCounts.set(p.securityScore, (securityCounts.get(p.securityScore) ?? 0) + 1);
    if (p.parentUrl !== null)
      inLinks.set(p.parentUrl, (inLinks.get(p.parentUrl) ?? 0) + 1);
  }

  const pagesCrawled = pages.length;
  const brokenPages = statusBreakdown["4xx"] + statusBreakdown["5xx"];

  // Technology: names seen on any page, most frequent first.
  const technology = [...techCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  // Security score: the modal per-page score (most pages share the site's headers).
  let securityScore: string | null = null;
  let best = -1;
  for (const [score, n] of securityCounts) if (n > best) (best = n), (securityScore = score);

  // Most-linked page: highest in-degree from the parentUrl graph.
  let mostLinkedPage: { url: string; inLinks: number } | null = null;
  for (const [url, n] of inLinks)
    if (mostLinkedPage === null || n > mostLinkedPage.inLinks) mostLinkedPage = { url, inLinks: n };

  return {
    pagesCrawled,
    statusBreakdown,
    brokenPages,
    totalDiscoveredLinks: totalLinks,
    avgLinksPerPage: pagesCrawled === 0 ? 0 : Math.round((totalLinks / pagesCrawled) * 10) / 10,
    pagesMissingH1: missingH1,
    pagesMissingMetaDescription: missingMeta,
    imagesMissingAlt,
    technology,
    securityScore,
    mostLinkedPage,
    crawlDurationMs: meta.crawlDurationMs,
    robotsRespected: meta.robotsRespected,
  };
}

/**
 * Build a job's health report from MongoDB. Streams a lean projection via a cursor
 * (bounded memory) and folds it with reduceReport. Returns null if the job doesn't
 * exist. A cancelled job yields a partial report over the pages it managed to crawl.
 */
export async function buildReport(jobId: string): Promise<HealthReport | null> {
  const job = await JobModel.findById(jobId).lean();
  if (job === null) return null;

  const cursor = PageModel.find(
    { jobId },
    { status: 1, discoveredLinks: 1, parentUrl: 1, analysis: 1, _id: 0 },
  )
    .lean()
    .cursor();

  const pages: ReportPage[] = [];
  for await (const d of cursor) {
    const a = (d.analysis ?? {}) as Record<string, any>;
    pages.push({
      status: d.status ?? null,
      discoveredLinks: d.discoveredLinks ?? 0,
      parentUrl: d.parentUrl ?? null,
      h1Count: a.seo?.h1Count,
      hasMetaDescription: a.seo?.hasMetaDescription,
      imagesMissingAlt: a.seo?.imagesMissingAlt,
      techDetected: a.tech?.detected,
      securityScore: a.security?.score,
    });
  }

  const created = job.createdAt ? new Date(job.createdAt).getTime() : null;
  const completed = job.completedAt ? new Date(job.completedAt).getTime() : null;
  return reduceReport(pages, {
    crawlDurationMs: created !== null && completed !== null ? completed - created : null,
    robotsRespected: job.respectRobots ?? true,
  });
}
