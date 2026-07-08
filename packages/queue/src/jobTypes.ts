import type { CrawlJobData, JobConfig } from "@crawler/shared";

/** The BullMQ queue plain-HTTP crawl work flows through. */
export const CRAWL_QUEUE = "crawl";

/**
 * The queue for browser-rendered work (M9). Same CrawlJobData contract and the same
 * Redis coordination state (dedup/pending/cancel), so completion detection and
 * cancel work identically — only the consumer fleet differs.
 */
export const RENDER_QUEUE = "render";

export type { CrawlJobData, JobConfig };
