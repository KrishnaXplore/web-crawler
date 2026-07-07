#!/usr/bin/env node
/**
 * Read a crawl job's persisted pages back out of MongoDB (M3) — proof the crawl
 * results survived the process that produced them.
 *
 * Usage: pnpm results <jobId> [--limit N]
 */
import { parseArgs } from "node:util";
import {
  connectMongo,
  disconnectMongo,
  getPages,
  countPages,
} from "@crawler/db";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { limit: { type: "string", default: "50" } },
  });

  const jobId = positionals[0];
  if (jobId === undefined) {
    console.error("usage: pnpm results <jobId> [--limit N]");
    process.exit(1);
  }

  await connectMongo();
  const total = await countPages(jobId);
  const pages = await getPages(jobId, Number(values.limit));

  console.log(`job ${jobId}: ${total} page(s) persisted\n`);
  for (const p of pages) {
    const title = p.title ? `  “${p.title}”` : "";
    console.log(
      `  d${p.depth} ${String(p.status ?? "-").padStart(3)}  ` +
        `${p.url}  (${p.discoveredLinks} links)${title}`,
    );
  }

  await disconnectMongo();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
