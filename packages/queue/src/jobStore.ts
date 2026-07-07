import { type Redis } from "ioredis";

/**
 * Hot per-job counters in Redis. The durable job record (config + status) lives in
 * MongoDB from M3 (see @crawler/db); Redis keeps only fast coordination state.
 */

/** Atomically increment and return the job's fetched-page count (bounds maxPages). */
export function incrPages(redis: Redis, jobId: string): Promise<number> {
  return redis.incr(`job:${jobId}:pages`);
}

/**
 * Outstanding-work counter for completion detection (M4). Incremented when a URL is
 * enqueued, decremented when it terminally finishes; the crawl is done at 0. The
 * ordering invariant (children incremented before parent decremented) is what makes
 * 0 mean "truly done" — see docs/phase4.md.
 */
export function incrPending(redis: Redis, jobId: string): Promise<number> {
  return redis.incr(`job:${jobId}:pending`);
}

export function decrPending(redis: Redis, jobId: string): Promise<number> {
  return redis.decr(`job:${jobId}:pending`);
}

/** Remove a job's transient Redis state once it has completed. */
export async function clearJobState(redis: Redis, jobId: string): Promise<void> {
  await redis.del(
    `job:${jobId}:pending`,
    `job:${jobId}:pages`,
    `seen:${jobId}`,
  );
}
