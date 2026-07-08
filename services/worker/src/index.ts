/**
 * Stateless crawl worker (M2 Step B — see docs/phase2b.md). Pulls URL jobs from the
 * BullMQ queue, crawls each (M1/A pipeline), and enqueues discovered links back —
 * deduped — with depth+1. Run as many of these as you like; they share the Redis
 * queue and coordinate through it (ADR-0003).
 */
import { createServer } from "node:http";
import { Worker, UnrecoverableError } from "bullmq";
import { loadEnv } from "@crawler/config";
import { createLogger } from "@crawler/logger";
import { metricsText, contentType, pagesTotal, fetchDuration } from "@crawler/metrics";
import {
  createRedis,
  createCrawlQueue,
  enqueueUrl,
  decrPending,
  clearJobState,
  isCancelled,
  acquireDomainSlot,
  createWebhookQueue,
  enqueueWebhook,
  CRAWL_QUEUE,
  WEBHOOK_QUEUE,
  type CrawlJobData,
  type WebhookJobData,
} from "@crawler/queue";
import {
  connectMongo,
  disconnectMongo,
  getJob,
  getJobConfig,
  upsertPage,
  countPages,
  markJobFinished,
} from "@crawler/db";
import { createBlobStore } from "@crawler/storage";
import { type JobConfig } from "@crawler/shared";
import {
  crawlUrl,
  fetchPage,
  parseRobots,
  runPlugins,
  deliverWebhook,
  SsrfError,
  type CrawlDeps,
  type RobotsRules,
} from "@crawler/core";

const log = createLogger("worker");
const env = loadEnv();
const UA = env.CRAWL_USER_AGENT;

const connection = createRedis(); // dedicated connection for the BullMQ Worker
const redis = createRedis(); // for queue add + our SADD / counters
const queue = createCrawlQueue(redis);
const webhookQueue = createWebhookQueue(redis);
const webhookConnection = createRedis(); // BullMQ Workers each need a dedicated conn

const blobStore = createBlobStore();
let bucketEnsured = false; // lazily ensure the bucket only if a job stores HTML

// Per-worker cache of job config, loaded from Mongo on first use.
const configCache = new Map<string, JobConfig | null>();
async function loadJobConfig(jobId: string): Promise<JobConfig | null> {
  if (configCache.has(jobId)) return configCache.get(jobId) ?? null;
  const cfg = await getJobConfig(jobId);
  configCache.set(jobId, cfg);
  return cfg;
}

// In-memory robots cache. Recomputable state, so worker statelessness holds
// (ADR-0003) — a fresh worker just re-fetches robots.txt as needed.
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
    rules = parseRobots("", UA);
  }
  robotsCache.set(origin, rules);
  return rules;
}

const deps: CrawlDeps = {
  fetch: (url) =>
    fetchPage(url, { userAgent: UA, timeoutMs: 10_000, maxBytes: 3_000_000 }),
  robotsFor,
};

const worker = new Worker<CrawlJobData>(
  CRAWL_QUEUE,
  async (job) => {
    const data = job.data;

    // Cancelled job (M6 Step A): drain as a no-op. Returning normally still flows
    // through the completed event → pending decrement, so completion accounting
    // (and therefore termination) is unchanged.
    if (await isCancelled(redis, data.jobId)) {
      pagesTotal.inc({ outcome: "cancelled" });
      return;
    }

    const cfg = await loadJobConfig(data.jobId);
    if (cfg === null) {
      log.warn({ jobId: data.jobId, url: data.url }, "no config found; dropping url");
      return;
    }

    // Per-domain rate limiting (ADR-0004), shared across workers via Redis. The
    // interval is the robots Crawl-delay (when respected) or the configured default.
    const { origin, hostname } = new URL(data.url);
    let intervalMs = env.CRAWL_DELAY_MS;
    if (cfg.respectRobots) {
      const rules = await robotsFor(origin);
      intervalMs = Math.max((rules.crawlDelay ?? 0) * 1000, env.CRAWL_DELAY_MS);
    }
    let waitMs = await acquireDomainSlot(redis, hostname, intervalMs);
    while (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
      waitMs = await acquireDomainSlot(redis, hostname, intervalMs);
    }

    const endTimer = fetchDuration.startTimer();
    const result = await crawlUrl(data.url, deps, {
      sameHostOnly: cfg.sameHostOnly,
      respectRobots: cfg.respectRobots,
    });
    endTimer();
    pagesTotal.inc({ outcome: result.outcome });

    // Persist page metadata (workflow Phase 5). Idempotent on (jobId, url).
    if (result.outcome === "ok") {
      // Metadata/blob split: bytes → MinIO (opt-in), only the key → Mongo.
      let htmlKey: string | null = null;
      let htmlBytes: number | null = null;
      if (cfg.storeHtml && result.html !== null) {
        if (!bucketEnsured) {
          await blobStore.ensureBucket();
          bucketEnsured = true;
        }
        const put = await blobStore.putBlob(
          result.html,
          result.contentType ?? "text/html",
        );
        htmlKey = put.key;
        htmlBytes = put.bytes;
      }

      // Analyzer plugins (M5 Step C): run the enabled ones over the page.
      const analysis =
        result.html !== null
          ? runPlugins(cfg.plugins, {
              url: result.url,
              html: result.html,
              headers: result.headers,
              status: result.status ?? 0,
            })
          : null;

      await upsertPage({
        jobId: data.jobId,
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        contentType: result.contentType,
        title: result.title,
        description: result.description,
        depth: data.depth,
        parentUrl: data.parentUrl,
        discoveredLinks: result.links.length,
        internalLinks: result.internalLinks,
        externalLinks: result.externalLinks,
        responseTimeMs: result.responseTimeMs,
        htmlKey,
        htmlBytes,
        analysis,
      });
    }

    log.info(
      {
        jobId: data.jobId,
        url: data.url,
        depth: data.depth,
        outcome: result.outcome,
        status: result.status,
        links: result.links.length,
        title: result.title,
      },
      "crawled",
    );

    // A crawl error throws → BullMQ retries with backoff, then dead-letters.
    // (robots-skip / over-budget return normally and are not retried.)
    if (result.outcome === "error") {
      throw new Error(result.error ?? "crawl failed");
    }

    if (result.outcome === "ok" && data.depth < cfg.maxDepth) {
      for (const link of result.links) {
        await enqueueUrl(
          queue,
          redis,
          {
            jobId: data.jobId,
            url: link,
            depth: data.depth + 1,
            parentUrl: data.url,
          },
          cfg.maxPages,
        );
      }
    }
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

/**
 * Reference-counted completion detection (M4). Decrement the job's outstanding-work
 * count on each terminal outcome; when it hits exactly 0 the crawl is done. Runs in
 * Worker events (not the job handler) so retries don't double-count.
 */
async function finishJob(jobId: string): Promise<void> {
  const remaining = await decrPending(redis, jobId);
  if (remaining === 0) {
    // Finalize to cancelled if the tombstone is set, else completed (M6 Step A) —
    // same termination path, one branch. Read the flag BEFORE clearJobState wipes it.
    const cancelled = await isCancelled(redis, jobId);
    await markJobFinished(jobId, cancelled ? "cancelled" : "completed");
    await clearJobState(redis, jobId);
    log.info({ jobId, final: cancelled ? "cancelled" : "completed" }, "job finished");

    // Webhook (M6 Step B): enqueue the delivery — never deliver inline, so job
    // finalization is not coupled to a third party's uptime.
    const job = await getJob(jobId);
    if (job !== null && job.webhookUrl !== null) {
      await enqueueWebhook(webhookQueue, {
        url: job.webhookUrl,
        payload: {
          event: cancelled ? "job.cancelled" : "job.completed",
          jobId,
          seedUrl: job.seedUrl,
          status: cancelled ? "cancelled" : "completed",
          pagesPersisted: await countPages(jobId),
          startedAt: job.createdAt,
          finishedAt: new Date().toISOString(),
        },
      });
    }
  }
}

/**
 * Webhook delivery consumer (M6 Step B). A module in this process, not a service
 * (ADR-0006). Failures throw → BullMQ retries with backoff → dead-letter, except an
 * SSRF block, which is terminal by design (never retried).
 */
const webhookWorker = new Worker<WebhookJobData>(
  WEBHOOK_QUEUE,
  async (job) => {
    try {
      await deliverWebhook(job.data.url, job.data.payload, env.WEBHOOK_SECRET);
      log.info(
        { jobId: job.data.payload.jobId, event: job.data.payload.event, url: job.data.url },
        "webhook delivered",
      );
    } catch (err) {
      if (err instanceof SsrfError) throw new UnrecoverableError(err.message);
      throw err;
    }
  },
  { connection: webhookConnection, concurrency: 2 },
);

webhookWorker.on("failed", (job, err) => {
  if (!job) return;
  log.error(
    {
      jobId: job.data.payload.jobId,
      url: job.data.url,
      attempt: job.attemptsMade,
      attempts: job.opts.attempts ?? 1,
      err,
    },
    "webhook delivery failed",
  );
});

await connectMongo();

// A worker has no HTTP surface of its own, so a tiny server exposes metrics/health
// for Prometheus to scrape (workflow Phase 7).
const metricsServer = createServer((req, res) => {
  if (req.url === "/metrics") {
    void metricsText().then((text) => {
      res.setHeader("Content-Type", contentType);
      res.end(text);
    });
  } else if (req.url === "/health") {
    res.end("ok");
  } else {
    res.statusCode = 404;
    res.end();
  }
});
metricsServer.listen(env.WORKER_METRICS_PORT, () =>
  log.info({ port: env.WORKER_METRICS_PORT }, "worker metrics listening"),
);

worker.on("ready", () =>
  log.info({ concurrency: env.WORKER_CONCURRENCY }, "worker ready — waiting for jobs"),
);

worker.on("completed", (job) => {
  void finishJob(job.data.jobId);
});

worker.on("failed", (job, err) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= attempts) {
    // Terminal failure → dead-lettered (kept in BullMQ's failed set) and counted
    // as finished so it never wedges completion.
    log.error({ jobId: job.data.jobId, url: job.data.url, err }, "dead-lettered");
    void finishJob(job.data.jobId);
  }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down — finishing in-flight URLs");
  metricsServer.close();
  await worker.close(); // waits for active jobs to finish, releases locks
  await webhookWorker.close();
  await queue.close();
  await webhookQueue.close();
  await redis.quit();
  await connection.quit();
  await webhookConnection.quit();
  await disconnectMongo();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
