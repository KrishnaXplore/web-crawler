import type { JobConfig } from "@crawler/shared";
import { PageModel } from "./models/page.js";
import { JobModel } from "./models/job.js";

export interface JobRecordInput extends JobConfig {
  readonly jobId: string;
  readonly seedUrl: string;
}

/** Create the durable job record (status starts "pending"). */
export async function createJob(input: JobRecordInput): Promise<void> {
  await JobModel.create({
    _id: input.jobId,
    seedUrl: input.seedUrl,
    maxDepth: input.maxDepth,
    maxPages: input.maxPages,
    sameHostOnly: input.sameHostOnly,
    respectRobots: input.respectRobots,
    storeHtml: input.storeHtml,
    plugins: input.plugins,
    webhookUrl: input.webhookUrl ?? null,
    renderMode: input.renderMode ?? "http",
    requestHeaders: input.requestHeaders ?? null,
    exposurePatterns: input.exposurePatterns ?? [],
    exposureReveal: input.exposureReveal ?? false,
  });
}

/**
 * Finalize a job (idempotent — only from a non-terminal state). The completion path
 * picks `cancelled` vs `completed` from the Redis tombstone (M6 Step A) — one code
 * path, one branch, no second termination mechanism.
 */
export async function markJobFinished(
  jobId: string,
  status: "completed" | "cancelled",
): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId, status: { $in: ["pending", "running", "cancelling"] } },
    { $set: { status, completedAt: new Date() } },
  );
}

/** Flip a job's status to completed (idempotent — only from a non-terminal state). */
export async function markJobCompleted(jobId: string): Promise<void> {
  await markJobFinished(jobId, "completed");
}

/**
 * First phase of cancel (M6 Step A): flag intent while in-flight URLs finish.
 * The completion path lands the terminal `cancelled` state. Idempotent.
 */
export async function markJobCancelling(jobId: string): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId, status: { $in: ["pending", "running"] } },
    { $set: { status: "cancelling" } },
  );
}

export interface JobRecord {
  readonly jobId: string;
  readonly seedUrl: string;
  readonly status: string;
  readonly maxDepth: number;
  readonly maxPages: number;
  readonly sameHostOnly: boolean;
  readonly respectRobots: boolean;
  readonly storeHtml: boolean;
  readonly webhookUrl: string | null;
  readonly renderMode: "http" | "browser";
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** The full durable job record (for the API's status endpoint). */
export async function getJob(jobId: string): Promise<JobRecord | null> {
  const d = await JobModel.findById(jobId).lean();
  if (d === null) return null;
  return {
    jobId: d._id,
    seedUrl: d.seedUrl,
    status: d.status ?? "pending",
    maxDepth: d.maxDepth,
    maxPages: d.maxPages,
    sameHostOnly: d.sameHostOnly,
    respectRobots: d.respectRobots,
    storeHtml: d.storeHtml ?? false,
    webhookUrl: d.webhookUrl ?? null,
    renderMode: (d.renderMode as "http" | "browser" | undefined) ?? "http",
    createdAt: (d.createdAt ?? new Date()).toISOString(),
    completedAt: d.completedAt ? d.completedAt.toISOString() : null,
  };
}

export async function getJobConfig(jobId: string): Promise<JobConfig | null> {
  const doc = await JobModel.findById(jobId).lean();
  if (doc === null) return null;
  return {
    maxDepth: doc.maxDepth,
    maxPages: doc.maxPages,
    sameHostOnly: doc.sameHostOnly,
    respectRobots: doc.respectRobots,
    storeHtml: doc.storeHtml ?? false,
    plugins: doc.plugins ?? [],
    webhookUrl: doc.webhookUrl ?? null,
    renderMode: (doc.renderMode as "http" | "browser" | undefined) ?? "http",
    requestHeaders:
      (doc.requestHeaders as Record<string, string> | null | undefined) ?? null,
    exposurePatterns: doc.exposurePatterns ?? [],
    exposureReveal: doc.exposureReveal ?? false,
  };
}

export interface PageInput {
  readonly jobId: string;
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number | null;
  readonly contentType: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly depth: number;
  readonly parentUrl: string | null;
  readonly discoveredLinks: number;
  readonly internalLinks?: number;
  readonly externalLinks?: number;
  readonly responseTimeMs?: number | null;
  readonly htmlKey?: string | null;
  readonly htmlBytes?: number | null;
  readonly analysis?: Record<string, unknown> | null;
}

/**
 * Idempotent page write, keyed on the unique `(jobId, url)`. Re-processing a URL
 * updates in place. A concurrent-insert duplicate-key race (E11000) is treated as a
 * successful dedup, not an error (ADR-0004 durable backstop).
 */
export async function upsertPage(page: PageInput): Promise<void> {
  try {
    await PageModel.updateOne(
      { jobId: page.jobId, url: page.url },
      { $set: { ...page, fetchedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export interface PageRow {
  readonly url: string;
  readonly status: number | null;
  readonly title: string | null;
  readonly depth: number;
  readonly discoveredLinks: number;
  readonly analysis: Record<string, unknown> | null;
}

export async function getPages(jobId: string, limit = 50): Promise<PageRow[]> {
  const docs = await PageModel.find({ jobId })
    .sort({ depth: 1, url: 1 })
    .limit(limit)
    .lean();
  return docs.map((d) => ({
    url: d.url,
    status: d.status ?? null,
    title: d.title ?? null,
    depth: d.depth,
    discoveredLinks: d.discoveredLinks,
    analysis: (d.analysis as Record<string, unknown> | null) ?? null,
  }));
}


export function countPages(jobId: string): Promise<number> {
  return PageModel.countDocuments({ jobId });
}

/** Full-text search over page title/description (M5 Step E). */
export async function searchPages(
  q: string,
  jobId: string | null,
  limit = 50,
): Promise<PageRow[]> {
  const filter: Record<string, unknown> = { $text: { $search: q } };
  if (jobId !== null) filter.jobId = jobId;
  const docs = await PageModel.find(filter, { score: { $meta: "textScore" } })
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .lean();
  return docs.map((d) => ({
    url: d.url,
    status: d.status ?? null,
    title: d.title ?? null,
    depth: d.depth,
    discoveredLinks: d.discoveredLinks,
    analysis: (d.analysis as Record<string, unknown> | null) ?? null,
  }));
}

export interface PageExport {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly depth: number;
  readonly discoveredLinks: number;
}

/** Stream a job's pages from a Mongo cursor (M5 Step E) — bounded memory for export. */
export async function* iteratePages(
  jobId: string,
): AsyncGenerator<PageExport> {
  const cursor = PageModel.find({ jobId }).sort({ depth: 1, url: 1 }).lean().cursor();
  for await (const d of cursor) {
    yield {
      url: d.url,
      finalUrl: d.finalUrl ?? null,
      status: d.status ?? null,
      title: d.title ?? null,
      description: d.description ?? null,
      depth: d.depth,
      discoveredLinks: d.discoveredLinks,
    };
  }
}

/** The stored-HTML blob key for a specific page, if any. */
export async function getPageHtmlKey(
  jobId: string,
  url: string,
): Promise<string | null> {
  const doc = await PageModel.findOne({ jobId, url }, { htmlKey: 1 }).lean();
  return doc?.htmlKey ?? null;
}
