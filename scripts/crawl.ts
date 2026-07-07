#!/usr/bin/env node
/**
 * Minimal BFS crawler CLI (M2 Step A — see docs/phase2.md).
 *
 * Usage:
 *   pnpm crawl <url> [--depth N] [--max-pages N] [--same-host] [--no-robots] [--delay ms]
 *
 * In-memory frontier + visited-set + robots cache. This is the throwaway
 * single-process version; M2 Step B replaces the frontier/dedup with Redis.
 */
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeUrl, InvalidUrlError } from "@crawler/shared";
import {
  crawlUrl,
  fetchPage,
  parseRobots,
  DEFAULT_USER_AGENT,
  type CrawlDeps,
  type RobotsRules,
} from "@crawler/core";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    depth: { type: "string", default: "1" },
    "max-pages": { type: "string", default: "20" },
    "same-host": { type: "boolean", default: false },
    "no-robots": { type: "boolean", default: false },
    delay: { type: "string", default: "200" },
  },
});

const seedArg = positionals[0];
if (seedArg === undefined) {
  console.error(
    "usage: pnpm crawl <url> [--depth N] [--max-pages N] [--same-host] [--no-robots] [--delay ms]",
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

const maxDepth = Number(values.depth);
const maxPages = Number(values["max-pages"]);
const sameHostOnly = values["same-host"] === true;
const respectRobots = values["no-robots"] !== true;
const delayMs = Number(values.delay);

const UA = DEFAULT_USER_AGENT;

// ── robots cache (one lookup per origin) ────────────────────────────────────
const robotsCache = new Map<string, RobotsRules>();
async function robotsFor(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules: RobotsRules;
  try {
    const res = await fetchPage(`${origin}/robots.txt`, {
      userAgent: UA,
      timeoutMs: 8000,
      maxBytes: 512_000,
    });
    rules =
      res.status >= 200 && res.status < 300
        ? parseRobots(res.body, UA)
        : parseRobots("", UA);
  } catch {
    rules = parseRobots("", UA); // unreachable robots → allow all
  }
  robotsCache.set(origin, rules);
  return rules;
}

const deps: CrawlDeps = {
  fetch: (url) => fetchPage(url, { userAgent: UA, timeoutMs: 10_000, maxBytes: 3_000_000 }),
  robotsFor,
};

// ── BFS ─────────────────────────────────────────────────────────────────────
interface Item {
  readonly url: string;
  readonly depth: number;
}

async function main(): Promise<void> {
  const visited = new Set<string>([seed]);
  const frontier: Item[] = [{ url: seed, depth: 0 }];
  let crawled = 0;
  const counts = { ok: 0, "skipped-robots": 0, "blocked-ssrf": 0, error: 0 };

  console.log(
    `crawling ${seed}  (depth<=${maxDepth}, max ${maxPages} pages, ` +
      `${sameHostOnly ? "same-host" : "any-host"}, robots ${respectRobots ? "on" : "off"})\n`,
  );

  const startedAt = Date.now();

  while (frontier.length > 0 && crawled < maxPages) {
    const item = frontier.shift()!;
    const result = await crawlUrl(item.url, deps, { sameHostOnly, respectRobots });
    crawled++;
    counts[result.outcome]++;

    const tag =
      result.outcome === "ok"
        ? String(result.status)
        : result.outcome === "skipped-robots"
          ? "robots"
          : result.outcome === "blocked-ssrf"
            ? "ssrf"
            : "ERR";
    const title = result.title ? `  “${result.title}”` : "";
    console.log(
      `[d${item.depth}] ${tag.padStart(6)}  ${item.url}  (${result.links.length} links)${title}`,
    );
    if (result.outcome === "error") console.log(`         ${result.error}`);

    if (item.depth < maxDepth) {
      for (const link of result.links) {
        if (visited.has(link)) continue;
        visited.add(link);
        frontier.push({ url: link, depth: item.depth + 1 });
      }
    }

    // Politeness: max of the flag and any robots crawl-delay for this origin.
    if (frontier.length > 0 && crawled < maxPages) {
      const rd = robotsCache.get(new URL(item.url).origin)?.crawlDelay ?? 0;
      await sleep(Math.max(delayMs, rd * 1000));
    }
  }

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\ndone: ${crawled} crawled in ${secs}s  ` +
      `(ok ${counts.ok}, robots ${counts["skipped-robots"]}, error ${counts.error}, ` +
      `discovered ${visited.size})`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
