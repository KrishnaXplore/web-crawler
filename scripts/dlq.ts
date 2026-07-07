#!/usr/bin/env node
/**
 * Inspect the dead-letter queue (M4) — URLs that failed every retry, kept in
 * BullMQ's failed set so they're visible and (later) replayable.
 *
 * Usage: pnpm exec tsx scripts/dlq.ts [--limit N]
 */
import { parseArgs } from "node:util";
import { createRedis, createCrawlQueue } from "@crawler/queue";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { limit: { type: "string", default: "20" } },
  });
  const limit = Number(values.limit);

  const redis = createRedis();
  const queue = createCrawlQueue(redis);

  const count = await queue.getFailedCount();
  const failed = await queue.getFailed(0, limit - 1);

  console.log(`dead-letter queue: ${count} failed job(s)\n`);
  for (const job of failed) {
    console.log(
      `  ${job.data.url}\n    job ${job.data.jobId.slice(0, 8)} · ` +
        `${job.attemptsMade} attempts · ${job.failedReason ?? "unknown"}`,
    );
  }

  await queue.close();
  await redis.quit();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
