/**
 * Domain types shared across services. Pure — no I/O, safe to import anywhere
 * (including the browser bundle). See docs/project-structure.md.
 */

export type JobStatus = "pending" | "running" | "completed" | "failed";

export type RenderMode = "http" | "headless";

export interface CrawlScope {
  /** Maximum link depth from the seed (seed = depth 0). */
  readonly maxDepth: number;
  /** Hard cap on pages fetched for the whole job. */
  readonly maxPages: number;
  /** Only follow links whose host matches the seed's host. */
  readonly sameHostOnly: boolean;
}

export interface CrawlJobConfig {
  readonly seedUrls: readonly string[];
  readonly scope: CrawlScope;
  readonly renderMode: RenderMode;
  readonly respectRobots: boolean;
  /** Names of analyzer plugins to run against each page (see plugins/). */
  readonly plugins: readonly string[];
}

/**
 * The bounded, per-job crawl settings a worker needs to scope and limit a crawl.
 * Persisted on the Job document (M3) and read by workers.
 */
export interface JobConfig {
  readonly maxDepth: number;
  readonly maxPages: number;
  readonly sameHostOnly: boolean;
  readonly respectRobots: boolean;
  /** Upload each page's raw HTML to blob storage (M3 Step B). */
  readonly storeHtml: boolean;
  /** Analyzer plugins to run per page (M5 Step C); empty = none. */
  readonly plugins: readonly string[];
  /** Optional callback URL notified when the job reaches a terminal state (M6 B). */
  readonly webhookUrl?: string | null;
}

/**
 * The body POSTed to a job's `webhookUrl` on termination (M6 Step B). Signed with
 * `X-Crawler-Signature: sha256=HMAC(body, WEBHOOK_SECRET)` when a secret is set.
 */
export interface WebhookPayload {
  readonly event: "job.completed" | "job.cancelled";
  readonly jobId: string;
  readonly seedUrl: string;
  readonly status: string;
  readonly pagesPersisted: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** A URL discovered during a crawl. `url` is always normalized. */
export interface DiscoveredUrl {
  readonly url: string;
  readonly hash: string;
  readonly depth: number;
  readonly parentUrl: string | null;
}

/** The payload carried on the queue for one URL to crawl. `url` is normalized. */
export interface CrawlJobData {
  readonly jobId: string;
  readonly url: string;
  readonly depth: number;
  readonly parentUrl: string | null;
}

/**
 * A persisted page result (metadata only — raw HTML/screenshots live in object
 * storage, referenced by key). `url` is normalized and unique per job.
 */
export interface Page {
  readonly jobId: string;
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly depth: number;
  readonly parentUrl: string | null;
  readonly discoveredLinks: number;
  /** ISO-8601 timestamp. */
  readonly fetchedAt: string;
}
