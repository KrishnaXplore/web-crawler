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
  finishUrl,
  isCancelled,
  isGoalMet,
  markGoalMet,
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
  isMongoReady,
  getJob,
  getJobConfig,
  upsertPage,
  countPages,
  markJobFinished,
  recordDomainObservation,
  getRulesForDomain,
  upsertRule,
  recordRuleUsage,
  getDomainProfile,
  matchingPathHints,
  recordPathHint,
} from "@crawler/db";
import { createBlobStore } from "@crawler/storage";
import { type JobConfig, type ExtractionRule } from "@crawler/shared";
import {
  crawlUrl,
  fetchPage,
  parseRobots,
  runPlugins,
  deliverWebhook,
  SsrfError,
  mockLlmSocket,
  createGeminiLlmSocket,
  scoreLinks,
  focusLinks,
  keywordsFromIntent,
  classifyIntentTarget,
  isIntentCovered,
  normalizeAnalysis,
  findNextPageUrl,
  looksLikeBotChallenge,
  type CrawlDeps,
  type RobotsRules,
} from "@crawler/core";

const log = createLogger("worker");
const env = loadEnv();
const UA = env.CRAWL_USER_AGENT;

// Tier 4 (M15): real Gemini calls when a key is configured, otherwise the mock
// keeps working exactly as before — the platform never requires an API key.
const llmSocket = env.GEMINI_API_KEY
  ? createGeminiLlmSocket({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL })
  : mockLlmSocket;

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

    // Build deps per-job so the exposure audit's auth headers (M10) apply. When set,
    // this is the *authenticated baseline* pass; when null, the unauthenticated pass.
    const deps: CrawlDeps = {
      fetch: (url) =>
        fetchPage(url, {
          userAgent: UA,
          timeoutMs: 10_000,
          maxBytes: 3_000_000,
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

    // Hoisted for the pagination block below (M25), which sits outside the
    // persistence scope where `analysis` lives.
    let isListingResult = false;

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
      // Both rule kinds are fetched up front (M22) — the page's detail/listing
      // classification happens inside runPlugins, which picks the right one.
      let rules = null;
      let listRules = null;
      if (cfg.plugins.includes("rules")) {
        rules = await getRulesForDomain(hostname);
        listRules = await getRulesForDomain(hostname, "list");
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
                listRules: listRules ?? undefined,
              },
              intent: cfg.intent,
              llmSocket,
            })
          : null;

      // Value normalization (M24): enrich price-like extracted values with
      // numeric `_amount` + `_currency` siblings so the CSV/table are
      // spreadsheet-usable. Additive; runs after extraction, before persist.
      normalizeAnalysis(analysis);

      // Did this page read as a listing? (M25 pagination gate — computed here
      // where `analysis` is in scope.)
      {
        const pageType = (analysis?.discovery as { pageType?: string } | undefined)?.pageType;
        const recordCount =
          (analysis?.rules as { records?: unknown[] } | undefined)?.records?.length ?? 0;
        isListingResult = pageType === "listing" || recordCount > 1;
      }

      // Rule Library feedback loop (gap-analysis fix #7, architecture-v3 §2.45): a
      // freshly-generated rule (Tier 4/LLM) is saved for reuse; any time the `rules`
      // tier actually ran — existing rule or just-generated — its confidence is the
      // real signal of whether the selectors work on this page, so it's recorded as
      // a hit/miss for a future self-heal step to watch for staleness. Both are
      // best-effort — never fail the crawl over Rule Library bookkeeping.
      const rulesOut = analysis?.rules as
        | { confidence?: "high" | "low" | "none"; generatedRules?: ExtractionRule }
        | undefined;
      if (rulesOut?.generatedRules) {
        await upsertRule(rulesOut.generatedRules, { generatedBy: "llm" });
        log.info({ url: result.url, domain: hostname }, "persisted LLM-generated extraction rules");
      }
      if (rulesOut?.confidence !== undefined) {
        // Listing pages exercise the domain's LIST rule (M22) — its hit/miss
        // bookkeeping (and any self-heal) must not touch the detail rule.
        const ruleKind =
          (analysis?.discovery as { pageType?: string } | undefined)?.pageType === "listing"
            ? ("list" as const)
            : ("detail" as const);
        void recordRuleUsage(hostname, rulesOut.confidence !== "none", ruleKind).catch(
          () => undefined,
        );
      }

      // Discovery Engine Step B (M18): if this page — reached via a scored link or
      // chosen as the seed — actually produced extraction results, remember its path
      // for this intent so a later crawl on the same domain can skip straight to it.
      // Best-effort, never blocks the crawl.
      const structuredOut = analysis?.structured as { confidence?: string } | undefined;
      const extractionSucceeded =
        (structuredOut?.confidence !== undefined && structuredOut.confidence !== "none") ||
        (rulesOut?.confidence !== undefined && rulesOut.confidence !== "none");
      if (cfg.intent && extractionSucceeded) {
        const keywords = keywordsFromIntent(cfg.intent);
        void recordPathHint(hostname, keywords, new URL(result.url).pathname).catch(() => undefined);
      }

      // Focused-crawl early stop (M23): for a DETAIL intent, once a single-record
      // page covers the requested fields, the goal is met — flag the job so the
      // enqueue loop stops expanding. Gated on runtime evidence, not just the
      // intent classifier: a listing page (records[] — collection evidence)
      // never trips this, so a collection mis-labelled "detail" self-corrects the
      // moment the crawler reaches an actual listing.
      if (cfg.focusedCrawl && cfg.intent && extractionSucceeded) {
        const pageType = (analysis?.discovery as { pageType?: string } | undefined)?.pageType;
        const rulesRecords = (analysis?.rules as { records?: unknown[] } | undefined)?.records;
        const isSingleRecord = pageType !== "listing" && !(rulesRecords && rulesRecords.length > 1);
        if (classifyIntentTarget(cfg.intent) === "detail" && isSingleRecord) {
          const fields = {
            ...((structuredOut as { fields?: Record<string, unknown> } | undefined)?.fields ?? {}),
            ...((rulesOut as { fields?: Record<string, unknown> } | undefined)?.fields ?? {}),
          };
          if (isIntentCovered(fields, cfg.intent)) {
            await markGoalMet(redis, data.jobId).catch(() => undefined);
            log.info({ jobId: data.jobId, url: result.url }, "focused crawl: goal met, winding down");
          }
        }
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

      // Website Intelligence Layer (M12): remember this domain. Best-effort — a
      // profile-write failure must never fail the crawl.
      const tech =
        (analysis?.tech as { detected?: string[] } | undefined)?.detected ?? [];
      // M20: HTTP mode only — the renderer already executes JS, so it's not the one
      // that needs to escalate. Flagging this feeds needsRender, so the *next* auto
      // crawl on this domain routes to the renderer without any manual intervention.
      void recordDomainObservation(hostname, {
        tech,
        renderMode: "http",
        statusOk: (result.status ?? 0) >= 200 && (result.status ?? 0) < 400,
        httpChallengeDetected: looksLikeBotChallenge(result.html ?? "", result.links.length),
      }).catch(() => undefined);
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

    // Focused-crawl early stop (M23): the goal has already been satisfied by an
    // earlier page — don't expand further. Already-queued work still drains via
    // the normal completion accounting, same as cancel.
    const goalMet = cfg.focusedCrawl ? await isGoalMet(redis, data.jobId) : false;

    if (result.outcome === "ok" && data.depth < cfg.maxDepth && !goalMet) {
      // Discovery Engine, Stage A (M16) + Step B (M18): with an intent set, crawl the
      // links most likely to lead there first — the page budget (maxPages) is a hard
      // cap enforced at enqueue time, so *order* here determines which links actually
      // survive it, not just which get processed first. Step B: a path this domain has
      // already confirmed works for an overlapping intent outranks a plain keyword
      // guess (one extra Mongo read, best-effort — a lookup failure just means no
      // boost this time, never blocks the crawl). No intent → no scoring → original
      // DOM order, unchanged from before M16.
      let links = result.links;
      if (cfg.intent) {
        const keywords = keywordsFromIntent(cfg.intent);
        const knownGoodPaths = await getDomainProfile(hostname)
          .then((profile) =>
            profile ? matchingPathHints(profile.pathHints, keywords).map((h) => h.path) : [],
          )
          .catch(() => []);
        // Focused mode + DETAIL intent: hard-filter to links leading toward a
        // product/detail page (focusLinks). Collection intents keep breadth
        // (plain scoreLinks) — a listing crawl wants every product link, and
        // those often don't keyword-match. See docs/phase23.md.
        links =
          cfg.focusedCrawl && classifyIntentTarget(cfg.intent) === "detail"
            ? focusLinks(result.links, cfg.intent, knownGoodPaths)
            : scoreLinks(result.links, cfg.intent, knownGoodPaths);
      }
      for (const link of links) {
        await enqueueUrl(
          queue,
          redis,
          {
            jobId: data.jobId,
            url: link.url,
            depth: data.depth + 1,
            parentUrl: data.url,
          },
          cfg.maxPages,
        );
      }
    }

    // Pagination following (M25): for a COLLECTION intent on a LISTING page,
    // walk the result set by enqueuing the "next page" at the SAME depth — so a
    // deep pagination chain is bounded by maxPages, not maxDepth, and works even
    // at maxDepth 0. Detail/focused crawls want to stop, not gather breadth.
    if (result.outcome === "ok" && result.html && cfg.intent && !goalMet) {
      if (classifyIntentTarget(cfg.intent) === "collection" && isListingResult) {
        const nextUrl = findNextPageUrl(result.html, result.url);
        const sameHost =
          nextUrl !== null &&
          (!cfg.sameHostOnly || new URL(nextUrl).hostname === new URL(result.url).hostname);
        if (nextUrl && sameHost) {
          await enqueueUrl(
            queue,
            redis,
            { jobId: data.jobId, url: nextUrl, depth: data.depth, parentUrl: data.url },
            cfg.maxPages,
          );
        }
      }
    }
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

/**
 * Reference-counted completion detection (M4). The ordering-critical core lives in
 * finishUrl (packages/queue, shared with the renderer since M9); this service
 * contributes the finalize hook: persist terminal status + enqueue the webhook
 * (M6 Step B — never deliver inline, so finalization is not coupled to a third
 * party's uptime). Runs in Worker events (not the handler) so retries don't
 * double-count.
 */
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
const metricsServer = createServer(async (req, res) => {
  if (req.url === "/metrics") {
    const text = await metricsText();
    res.setHeader("Content-Type", contentType);
    res.end(text);
  } else if (req.url === "/health" || req.url === "/health/live") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  } else if (req.url === "/health/ready") {
    res.setHeader("Content-Type", "application/json");
    try {
      const ping = await redis.ping();
      if (ping !== "PONG" || !isMongoReady()) {
        throw new Error("Dependencies not ready");
      }
      res.end(JSON.stringify({ status: "ready" }));
    } catch (err) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
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
