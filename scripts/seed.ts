#!/usr/bin/env node
/**
 * Seed a crawl job (M2 Step B — see docs/phase2b.md): write its config to Redis and
 * enqueue the seed URL. A running `worker` then drains it.
 *
 * Usage:
 *   pnpm seed <url> [--depth N] [--max-pages N] [--same-host] [--no-robots]
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { normalizeUrl, InvalidUrlError, type JobConfig } from "@crawler/shared";
import { createRedis, createCrawlQueue, enqueueUrl } from "@crawler/queue";
import { connectMongo, disconnectMongo, createJob } from "@crawler/db";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      depth: { type: "string", default: "1" },
      "max-pages": { type: "string", default: "50" },
      "same-host": { type: "boolean", default: false },
      "no-robots": { type: "boolean", default: false },
      "store-html": { type: "boolean", default: false },
      plugins: { type: "string", default: "" },
    },
  });

  const seedArg = positionals[0];
  if (seedArg === undefined) {
    console.error(
      "usage: pnpm seed <url> [--depth N] [--max-pages N] [--same-host] [--no-robots]",
    );
    process.exit(1);
  }

  let seed: string;
  try {
    seed = normalizeUrl(seedArg);
  } catch (err) {
    console.error(
      err instanceof InvalidUrlError ? err.message : `bad url: ${seedArg}`,
    );
    process.exit(1);
  }

  const config: JobConfig = {
    maxDepth: Number(values.depth),
    maxPages: Number(values["max-pages"]),
    sameHostOnly: values["same-host"] === true,
    respectRobots: values["no-robots"] !== true,
    storeHtml: values["store-html"] === true,
    plugins: values.plugins ? values.plugins.split(",").map((p) => p.trim()) : [],
  };
  const jobId = randomUUID();

  await connectMongo();
  await createJob({ jobId, seedUrl: seed, ...config });

  const redis = createRedis();
  const queue = createCrawlQueue(redis);
  await enqueueUrl(
    queue,
    redis,
    { jobId, url: seed, depth: 0, parentUrl: null },
    config.maxPages,
  );

  console.log(`seeded job ${jobId}`);
  console.log(`  seed:   ${seed}`);
  console.log(`  config: ${JSON.stringify(config)}`);
  console.log(`\nstart a worker to process it:  pnpm worker`);
  console.log(`see results:                   pnpm exec tsx scripts/results.ts ${jobId}`);

  await queue.close();
  await redis.quit();
  await disconnectMongo();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
