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

/**
 * Cancellation tombstone (M6 Step A — see docs/phase6.md). Cancel sets a flag; every
 * worker checks it before processing a URL, so queued work drains as no-ops through
 * the normal completion accounting. O(1) per URL and race-free: a URL is either
 * processed before the flag lands (fine) or no-ops after it. The TTL is a safety net
 * well above any job's lifetime — normal cleanup is clearJobState at finalization.
 */
const CANCEL_TTL_SECONDS = 7 * 24 * 3600;

export async function markCancelled(redis: Redis, jobId: string): Promise<void> {
  await redis.set(`job:${jobId}:cancelled`, "1", "EX", CANCEL_TTL_SECONDS);
}

export async function isCancelled(redis: Redis, jobId: string): Promise<boolean> {
  return (await redis.exists(`job:${jobId}:cancelled`)) === 1;
}

/**
 * Focused-crawl goal-met flag (M23). For a *detail* intent, once a single-record
 * page covers the requested fields there's nothing more to find — this flag tells
 * the enqueue loop to stop expanding. Same tombstone mechanics as cancel: O(1),
 * race-tolerant (already-queued work still drains), cleared at finalization.
 * Deliberately NOT set for collection intents — those want breadth, bounded by
 * the page budget, not an early stop.
 */
export async function markGoalMet(redis: Redis, jobId: string): Promise<void> {
  await redis.set(`job:${jobId}:goalmet`, "1", "EX", CANCEL_TTL_SECONDS);
}

export async function isGoalMet(redis: Redis, jobId: string): Promise<boolean> {
  return (await redis.exists(`job:${jobId}:goalmet`)) === 1;
}

/** Remove a job's transient Redis state once it has completed. */
export async function clearJobState(redis: Redis, jobId: string): Promise<void> {
  await redis.del(
    `job:${jobId}:pending`,
    `job:${jobId}:pages`,
    `job:${jobId}:cancelled`,
    `job:${jobId}:goalmet`,
    `seen:${jobId}`,
  );
}
