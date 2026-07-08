#!/usr/bin/env node
/**
 * Multi-domain load test (M7 Step D — see docs/phase7.md). Submits a fixed seed set
 * through the public API, waits for every job to reach a terminal state, and reports
 * wall-clock throughput. Run it against 1 worker, then N workers, to measure how
 * throughput scales with replicas (results in docs/benchmarks.md).
 *
 * The seed set is multi-domain on purpose: per-domain politeness caps a single
 * domain's rate, so only a domain MIX can demonstrate horizontal scaling (HLD §4).
 * The *.toscrape.com sites are public sandboxes built for scraping practice.
 *
 * Usage:
 *   pnpm exec tsx scripts/load-test.ts [--api http://localhost:3000] [--max-pages 200]
 */
import { parseArgs } from "node:util";

const SEEDS = [
  "https://books.toscrape.com/",
  "https://quotes.toscrape.com/",
];

interface JobStatus {
  status: string;
  pagesPersisted: number;
  pending: number;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      api: { type: "string", default: "http://localhost:3000" },
      "max-pages": { type: "string", default: "200" },
      depth: { type: "string", default: "3" },
    },
  });
  const api = values.api!;
  const maxPages = Number(values["max-pages"]);
  const maxDepth = Number(values.depth);

  console.log(`load test → ${api}`);
  console.log(`  seeds: ${SEEDS.join(", ")}`);
  console.log(`  per-job cap: ${maxPages} pages, depth ${maxDepth}\n`);

  const t0 = Date.now();
  const jobIds: string[] = [];
  for (const seedUrl of SEEDS) {
    const res = await fetch(`${api}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seedUrl,
        maxDepth,
        maxPages,
        sameHostOnly: true,
        respectRobots: true,
        storeHtml: false,
        plugins: [],
      }),
    });
    if (res.status !== 202) {
      throw new Error(`submit failed (${res.status}): ${await res.text()}`);
    }
    const { jobId } = (await res.json()) as { jobId: string };
    jobIds.push(jobId);
    console.log(`  submitted ${jobId.slice(0, 8)}  ${seedUrl}`);
  }

  const TERMINAL = new Set(["completed", "cancelled", "failed"]);
  let statuses: JobStatus[] = [];
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    statuses = await Promise.all(
      jobIds.map(async (id) => {
        const r = await fetch(`${api}/jobs/${id}`);
        return (await r.json()) as JobStatus;
      }),
    );
    const pages = statuses.reduce((n, s) => n + s.pagesPersisted, 0);
    const pending = statuses.reduce((n, s) => n + s.pending, 0);
    const secs = (Date.now() - t0) / 1000;
    process.stdout.write(
      `\r  ${secs.toFixed(0).padStart(4)}s  pages=${String(pages).padStart(4)}` +
        `  pending=${String(pending).padStart(4)}  (${(pages / secs).toFixed(1)} pages/s)   `,
    );
    if (statuses.every((s) => TERMINAL.has(s.status))) break;
  }

  const secs = (Date.now() - t0) / 1000;
  const pages = statuses.reduce((n, s) => n + s.pagesPersisted, 0);
  console.log(`\n\nRESULT  ${pages} pages in ${secs.toFixed(1)}s  →  ${(pages / secs).toFixed(2)} pages/sec`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
