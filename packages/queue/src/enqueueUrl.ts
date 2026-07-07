import { type Queue } from "bullmq";
import { type Redis } from "ioredis";
import { urlHash, type CrawlJobData } from "@crawler/shared";

/**
 * Discovery-time, dedup-guarded enqueue (ADR-0004). Records the URL in the job's
 * `seen` set and, only if it was NOT already present, adds it to the queue — so a
 * URL enters the frontier at most once per job.
 *
 * Returns true if the URL was newly enqueued, false if it was a duplicate.
 *
 * Atomicity caveat (see docs/phase2b.md): SADD and queue.add are two ops; a crash
 * between them can lose a URL. M3's MongoDB unique index is the durable backstop.
 * The BullMQ `jobId` also guards against duplicate in-flight jobs.
 */
export async function enqueueUrl(
  queue: Queue<CrawlJobData>,
  redis: Redis,
  data: CrawlJobData,
  maxUrls?: number,
): Promise<boolean> {
  const added = await redis.sadd(`seen:${data.jobId}`, data.url);
  if (added === 0) return false; // already seen for this job

  // Enforce the page budget at ENQUEUE time (retry-safe: retries never re-enqueue).
  // Capping distinct enqueued URLs caps the pages fetched.
  if (maxUrls !== undefined) {
    const total = await redis.scard(`seen:${data.jobId}`);
    if (total > maxUrls) {
      await redis.srem(`seen:${data.jobId}`, data.url);
      return false; // over budget
    }
  }

  // Count this URL as outstanding work BEFORE it enters the queue, so completion
  // detection (M4) never sees 0 while work is still arriving (docs/phase4.md).
  await redis.incr(`job:${data.jobId}:pending`);

  await queue.add("crawl", data, {
    // BullMQ custom ids cannot contain ":" (its reserved key separator).
    jobId: `${data.jobId}.${urlHash(data.url)}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: true,
    // Keep failed jobs (they are the dead-letter queue); cap retention.
    removeOnFail: 1000,
  });
  return true;
}
