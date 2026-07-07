import type { CrawlJobData, JobConfig } from "@crawler/shared";

/** The single BullMQ queue all crawl work flows through. */
export const CRAWL_QUEUE = "crawl";

export type { CrawlJobData, JobConfig };
