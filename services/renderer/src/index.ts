/**
 * Renderer service (M9 — docs/phase9.md). A second stateless queue consumer, like the
 * worker, but each URL is executed in headless Chromium so JavaScript-rendered pages
 * and screenshots are captured. Routed to only for jobs with renderMode:"browser".
 * Shares all Redis coordination state with the worker, so completion/cancel/webhooks
 * work identically (finishUrl in @crawler/queue owns that contract).
 */
import { createServer } from "node:http";
import { Worker } from "bullmq";
import { chromium, type Browser } from "playwright";
import { loadEnv } from "@crawler/config";
import { createLogger } from "@crawler/logger";
import { metricsText, contentType, pagesTotal, fetchDuration } from "@crawler/metrics";
import {
  createRedis,
  createRenderQueue,
  createWebhookQueue,
  enqueueUrl,
  enqueueWebhook,
  finishUrl,
  isCancelled,
  acquireDomainSlot,
  RENDER_QUEUE,
  type CrawlJobData,
} from "@crawler/queue";
import {
  connectMongo,
  disconnectMongo,
  getJob,
  getJobConfig,
  upsertPage,
  countPages,
  markJobFinished,
  recordDomainObservation,
  getRulesForDomain,
  upsertRule,
} from "@crawler/db";
import { createBlobStore } from "@crawler/storage";
import { type JobConfig } from "@crawler/shared";
import {
  crawlUrl,
  fetchPage,
  parseRobots,
  runPlugins,
  type CrawlDeps,
  type RobotsRules,
} from "@crawler/core";
import { renderPage } from "./render.js";

const log = createLogger("renderer");
const env = loadEnv();
const UA = env.CRAWL_USER_AGENT;

const redis = createRedis();
const renderQueue = createRenderQueue(redis);
const webhookQueue = createWebhookQueue(redis);

const blobStore = createBlobStore();
let bucketEnsured = false;

let browser: Browser;

const configCache = new Map<string, JobConfig | null>();
async function loadJobConfig(jobId: string): Promise<JobConfig | null> {
  if (configCache.has(jobId)) return configCache.get(jobId) ?? null;
  const cfg = await getJobConfig(jobId);
  configCache.set(jobId, cfg);
  return cfg;
}

// Robots is fetched over plain HTTP (no need to render robots.txt) — same as worker.
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

// Construct the Worker BEFORE any top-level await (matching the worker service), so
// its autorun run-loop / blocking connection starts immediately. The browser is
// launched below; the handler awaits `browserReady` before using it, so there is no
// undefined-browser race.
let markBrowserReady: () => void;
const browserReady = new Promise<void>((resolve) => (markBrowserReady = resolve));

const connection = createRedis();
const worker = new Worker<CrawlJobData>(
  RENDER_QUEUE,
  async (job) => {
    const data = job.data;
    await browserReady;

    if (await isCancelled(redis, data.jobId)) {
      pagesTotal.inc({ outcome: "cancelled" });
      return;
    }
    const cfg = await loadJobConfig(data.jobId);
    if (cfg === null) {
      log.warn({ jobId: data.jobId, url: data.url }, "no config found; dropping url");
      return;
    }

    // Per-domain rate limiting (shared with the worker via the same Redis keys).
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

    const deps: CrawlDeps = {
      fetch: (url) =>
        renderPage(url, browser, {
          userAgent: UA,
          timeoutMs: env.RENDER_TIMEOUT_MS,
          requestHeaders: cfg.requestHeaders ?? undefined,
        }),
      robotsFor,
    };

    const endTimer = fetchDuration.startTimer();
    const result = await crawlUrl(data.url, deps, {
      sameHostOnly: cfg.sameHostOnly,
      respectRobots: cfg.respectRobots,
    });
    endTimer();
    pagesTotal.inc({ outcome: result.outcome });

    if (result.outcome === "ok") {
      if (!bucketEnsured) {
        await blobStore.ensureBucket();
        bucketEnsured = true;
      }

      let htmlKey: string | null = null;
      let htmlBytes: number | null = null;
      if (cfg.storeHtml && result.html !== null) {
        const put = await blobStore.putBlob(result.html, result.contentType ?? "text/html");
        htmlKey = put.key;
        htmlBytes = put.bytes;
      }

      // cheerio plugins over the rendered DOM.
      let rules = null;
      if (cfg.plugins.includes("rules")) {
        const hostname = new URL(result.url).hostname;
        rules = await getRulesForDomain(hostname);
      }

      const analysis =
        result.html !== null
          ? await runPlugins(cfg.plugins, {
              url: result.url,
              html: result.html,
              headers: result.headers,
              status: result.status ?? 0,
              authenticated: cfg.requestHeaders != null,
              options: {
                exposure: {
                  patterns: cfg.exposurePatterns ?? [],
                  reveal: cfg.exposureReveal ?? false,
                },
                rules: rules ?? undefined,
              },
              intent: cfg.intent,
            })
          : null;

      if (analysis?.rules && (analysis.rules as any).generatedRules) {
        await upsertRule((analysis.rules as any).generatedRules);
        log.info({ url: result.url }, "Persisted LLM-generated extraction rules");
      }

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

      // Website Intelligence Layer (M12): record browser-render observation. This is
      // what makes `needsRender` true for the domain. Best-effort.
      const tech =
        (analysis?.tech as { detected?: string[] } | undefined)?.detected ?? [];
      void recordDomainObservation(hostname, {
        tech,
        renderMode: "browser",
        statusOk: (result.status ?? 0) >= 200 && (result.status ?? 0) < 400,
      }).catch(() => undefined);
    }

    log.info(
      { jobId: data.jobId, url: data.url, depth: data.depth, outcome: result.outcome,
        status: result.status, links: result.links.length },
      "rendered",
    );

    if (result.outcome === "error") throw new Error(result.error ?? "render failed");

    if (result.outcome === "ok" && data.depth < cfg.maxDepth) {
      for (const link of result.links) {
        await enqueueUrl(
          renderQueue,
          redis,
          { jobId: data.jobId, url: link, depth: data.depth + 1, parentUrl: data.url },
          cfg.maxPages,
        );
      }
    }
  },
  { connection, concurrency: env.RENDER_CONCURRENCY },
);

async function finishJob(jobId: string): Promise<void> {
  await finishUrl(redis, jobId, async (cancelled) => {
    await markJobFinished(jobId, cancelled ? "cancelled" : "completed");
    log.info({ jobId, final: cancelled ? "cancelled" : "completed" }, "job finished");
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
  });
}

worker.on("completed", (job) => void finishJob(job.data.jobId));
worker.on("failed", (job, err) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= attempts) {
    log.error({ jobId: job.data.jobId, url: job.data.url, err }, "dead-lettered");
    void finishJob(job.data.jobId);
  }
});

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
metricsServer.on("error", (err) =>
  log.error({ err }, "metrics server error (does not stop the worker)"),
);
metricsServer.listen(env.RENDERER_METRICS_PORT, () =>
  log.info({ port: env.RENDERER_METRICS_PORT }, "renderer metrics listening"),
);

worker.on("error", (err) => log.error({ err }, "worker error"));
worker.on("ready", () =>
  log.info({ concurrency: env.RENDER_CONCURRENCY }, "renderer ready — waiting for jobs"),
);

// Launch the browser and connect Mongo AFTER the Worker is already running. The
// handler blocks on `browserReady` until this resolves, so a job claimed during
// startup simply waits a beat rather than racing an undefined browser.
browser = await chromium.launch({ args: ["--no-sandbox"] });
await connectMongo();
markBrowserReady!();
log.info("browser launched, mongo connected — renders can proceed");

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down — finishing in-flight renders");
  metricsServer.close();
  await worker.close();
  await browser.close().catch(() => undefined);
  await renderQueue.close();
  await webhookQueue.close();
  await redis.quit();
  await connection.quit();
  await disconnectMongo();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
