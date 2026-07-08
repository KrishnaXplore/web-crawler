import { Queue } from "bullmq";
import { type Redis } from "ioredis";
import { type CrawlJobData } from "@crawler/shared";
import { CRAWL_QUEUE, RENDER_QUEUE } from "./jobTypes.js";

/** Create the crawl Queue bound to an existing Redis connection. */
export function createCrawlQueue(connection: Redis): Queue<CrawlJobData> {
  return new Queue<CrawlJobData>(CRAWL_QUEUE, { connection });
}

/** Create the render Queue (M9) — same job contract, browser-rendered consumer. */
export function createRenderQueue(connection: Redis): Queue<CrawlJobData> {
  return new Queue<CrawlJobData>(RENDER_QUEUE, { connection });
}
