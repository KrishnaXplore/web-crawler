#!/usr/bin/env node
/**
 * Fetch a stored page's raw HTML back from MinIO (M3 Step B) — proof of the
 * metadata/blob split: Mongo holds the key, MinIO holds the bytes.
 *
 * Usage: pnpm exec tsx scripts/html.ts <jobId> <url> [--full]
 */
import { parseArgs } from "node:util";
import { normalizeUrl } from "@crawler/shared";
import { connectMongo, disconnectMongo, getPageHtmlKey } from "@crawler/db";
import { createBlobStore } from "@crawler/storage";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { full: { type: "boolean", default: false } },
  });

  const [jobId, rawUrl] = positionals;
  if (jobId === undefined || rawUrl === undefined) {
    console.error("usage: pnpm exec tsx scripts/html.ts <jobId> <url> [--full]");
    process.exit(1);
  }
  const url = normalizeUrl(rawUrl);

  await connectMongo();
  const key = await getPageHtmlKey(jobId, url);
  await disconnectMongo();

  if (key === null) {
    console.error(`no stored HTML for ${url} (was the job seeded with --store-html?)`);
    process.exit(1);
  }

  const bytes = await createBlobStore().getBlob(key);
  console.log(`page:  ${url}`);
  console.log(`key:   ${key}   (Mongo → MinIO)`);
  console.log(`bytes: ${bytes.length}\n`);
  const text = bytes.toString("utf-8");
  console.log(values.full === true ? text : text.slice(0, 400) + "\n…(truncated; --full for all)");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
