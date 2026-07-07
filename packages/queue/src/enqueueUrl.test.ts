import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { urlHash, type CrawlJobData } from "@crawler/shared";
import { enqueueUrl } from "./enqueueUrl.js";
import { CRAWL_QUEUE } from "./jobTypes.js";

// Integration test against a real Redis. Opt in with RUN_REDIS_IT=1 (after
// `docker compose up -d redis`); skipped by default so the offline suite passes.
const RUN_IT = process.env.RUN_REDIS_IT === "1";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe.skipIf(!RUN_IT)("enqueueUrl (integration)", () => {
  let redis: Redis;
  let queue: Queue<CrawlJobData>;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    redis.on("error", () => undefined); // avoid unhandled 'error' events
    queue = new Queue<CrawlJobData>(CRAWL_QUEUE, { connection: redis });
  });

  afterAll(async () => {
    if (queue) await queue.close();
    if (redis) await redis.quit();
  });

  it("enqueues a new URL once and dedupes the second attempt", async () => {
    const jobId = `test-${Date.now()}`;
    const data: CrawlJobData = {
      jobId,
      url: "http://a.com/x",
      depth: 0,
      parentUrl: null,
    };

    const first = await enqueueUrl(queue, redis, data);
    const second = await enqueueUrl(queue, redis, data);

    expect(first).toBe(true); // new
    expect(second).toBe(false); // duplicate

    const seen = await redis.scard(`seen:${jobId}`);
    expect(seen).toBe(1);

    // cleanup
    await redis.del(`seen:${jobId}`);
    await queue.remove(`${jobId}.${urlHash(data.url)}`).catch(() => undefined);
  });
});
