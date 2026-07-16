import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { normalizeUrl, type JobConfig } from "@crawler/shared";
import { enqueueUrl, markCancelled } from "@crawler/queue";
import {
  createJob,
  getJob,
  getPages,
  countPages,
  iteratePages,
  buildReport,
  markJobCancelling,
  getDomainProfile,
} from "@crawler/db";
import { validateBody } from "../middleware/validate.js";
import { ssrfPrescreen } from "../middleware/ssrfPrescreen.js";
import type { AppDeps } from "../app.js";

const createJobSchema = z.object({
  seedUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "must be http(s)"),
  maxDepth: z.number().int().min(0).max(10).default(1),
  maxPages: z.number().int().min(1).max(1000).default(50),
  sameHostOnly: z.boolean().default(true),
  respectRobots: z.boolean().default(true),
  storeHtml: z.boolean().default(false),
  plugins: z.array(z.string()).default([]),
  webhookUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
    .optional(),
  renderMode: z.enum(["http", "browser", "auto"]).default("auto"),
  // Exposure audit (M10). requestHeaders is a secret (session/token) for the
  // authenticated baseline pass; exposurePatterns are custom sensitive-data regexes.
  requestHeaders: z.record(z.string(), z.string()).optional(),
  exposurePatterns: z.array(z.string()).max(50).default([]),
  // Opt-in: store full matched values instead of redacted samples (M10).
  exposureReveal: z.boolean().default(false),
  intent: z.string().optional(),
  focusedCrawl: z.boolean().default(false),
});

export function createJobsRouter(deps: AppDeps): express.Router {
  const router = express.Router();

  // POST /jobs — submit a crawl.
  router.post(
    "/",
    validateBody(createJobSchema),
    ssrfPrescreen,
    async (req, res, next) => {
      try {
        const body = req.body as z.infer<typeof createJobSchema>;
        const seed = normalizeUrl(body.seedUrl);
        let finalRenderMode = body.renderMode;
        if (finalRenderMode === "auto") {
          const profile = await getDomainProfile(new URL(seed).hostname);
          finalRenderMode = profile?.needsRender ? "browser" : "http";
        }

        const config: JobConfig = {
          maxDepth: body.maxDepth,
          maxPages: body.maxPages,
          sameHostOnly: body.sameHostOnly,
          respectRobots: body.respectRobots,
          storeHtml: body.storeHtml,
          plugins: body.plugins,
          webhookUrl: body.webhookUrl ?? null,
          renderMode: finalRenderMode as "http" | "browser",
          requestHeaders: body.requestHeaders ?? null,
          exposurePatterns: body.exposurePatterns,
          exposureReveal: body.exposureReveal,
          intent: body.intent,
          focusedCrawl: body.focusedCrawl,
        };
        const jobId = randomUUID();
        await createJob({ jobId, seedUrl: seed, ...config });
        // Route the seed to the render queue for browser-mode jobs (M9); the renderer
        // then spreads children onto its own queue. Same enqueueUrl dedup primitive.
        const targetQueue =
          finalRenderMode === "browser" ? deps.renderQueue : deps.queue;
        await enqueueUrl(
          targetQueue,
          deps.redis,
          { jobId, url: seed, depth: 0, parentUrl: null },
          config.maxPages,
        );
        // Never echo the secret auth headers back in the response.
        const { requestHeaders: _redacted, ...safeConfig } = config;
        res.status(202).json({
          jobId,
          seedUrl: seed,
          config: { ...safeConfig, authenticated: config.requestHeaders != null },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /jobs/:id/cancel — stop a crawl mid-flight (M6 Step A, docs/phase6.md).
  // Sets the Redis tombstone (workers no-op) + flips status to `cancelling`; the
  // worker completion path lands the terminal `cancelled`. Idempotent while the
  // job is live; a job already in a terminal state is a 409.
  router.post("/:id/cancel", async (req, res, next) => {
    try {
      const job = await getJob(req.params.id);
      if (job === null) {
        res.status(404).json({ error: "job not found" });
        return;
      }
      if (["completed", "cancelled", "failed"].includes(job.status)) {
        res.status(409).json({ error: `job already ${job.status}` });
        return;
      }
      await markCancelled(deps.redis, job.jobId);
      await markJobCancelling(job.jobId);
      res.status(202).json({ jobId: job.jobId, status: "cancelling" });
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:id — status + live counts.
  router.get("/:id", async (req, res, next) => {
    try {
      const job = await getJob(req.params.id);
      if (job === null) {
        res.status(404).json({ error: "job not found" });
        return;
      }
      const pagesPersisted = await countPages(job.jobId);
      const pendingRaw = await deps.redis.get(`job:${job.jobId}:pending`);
      res.json({
        ...job,
        pagesPersisted,
        pending: pendingRaw === null ? 0 : Number(pendingRaw),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:id/report — Website Health Report (M8 Step A). Aggregates the job's
  // persisted pages into an actionable summary. Works on completed and cancelled
  // (partial) jobs alike.
  router.get("/:id/report", async (req, res, next) => {
    try {
      const report = await buildReport(req.params.id);
      if (report === null) {
        res.status(404).json({ error: "job not found" });
        return;
      }
      res.json({ jobId: req.params.id, report });
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:id/pages — persisted results.
  router.get("/:id/pages", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const pages = await getPages(req.params.id, limit);
      res.json({ jobId: req.params.id, count: pages.length, pages });
    } catch (err) {
      next(err);
    }
  });

  // GET /jobs/:id/export?format=json|csv — streamed (bounded memory).
  router.get("/:id/export", async (req, res, next) => {
    const jobId = req.params.id;
    try {
      if (req.query.format === "csv") {
        // Buffered, not streamed (unlike JSON below): the extracted fields need to
        // become real named columns — "name", "price", "brand" — not crawl-mechanics
        // columns with the actual scraped data buried in one JSON-text cell. That
        // needs the full set of field names before the header row can be written,
        // which means seeing every page first. A job caps at 1000 pages (validated
        // at creation), so buffering here is trivial memory, not a real concern.
        // Only pages that actually produced data become rows — menus, footers
        // and 404s crawled along the way would otherwise pad the spreadsheet
        // with empty rows. A listing page contributes one row PER RECORD (M22).
        // The JSON export still carries every crawled page.
        const rows: { url: string; extracted: Record<string, unknown> }[] = [];
        const fieldColumns = new Set<string>();
        for await (const p of iteratePages(jobId)) {
          for (const extracted of extractedRowsFor(p.analysis)) {
            for (const key of Object.keys(extracted)) fieldColumns.add(key);
            rows.push({ url: p.url, extracted });
          }
        }
        // `url` (the source page) is the only fixed column, so an extracted
        // field of that name is folded out to avoid a duplicate header. An
        // extracted `title` is a REAL data column — on a listing page every
        // record has its own title and the page's <title> is the wrong value
        // for all of them (M22 verification caught exactly this: 20 books per
        // page, all showing the page title instead of each book's).
        const columns = [...fieldColumns].filter((c) => c.toLowerCase() !== "url");

        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${jobId}.csv"`,
        );
        res.write(["url", ...columns].map((h) => csv(h)).join(",") + "\n");
        for (const r of rows) {
          res.write(
            [
              csv(r.url),
              ...columns.map((c) => csv(stringifyCell(r.extracted[c]))),
            ].join(",") + "\n",
          );
        }
      } else {
        res.setHeader("Content-Type", "application/json");
        res.write("[");
        let first = true;
        for await (const p of iteratePages(jobId)) {
          res.write((first ? "" : ",") + JSON.stringify(p));
          first = false;
        }
        res.write("]");
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Minimal CSV field escaping. */
function csv(value: string | null): string {
  const s = value ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A single extracted field's value, safe to drop into one CSV cell. */
function stringifyCell(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The scraped rows a page contributes to the CSV. A listing page extracted via
 * a list rule (M22) carries `records: [...]` — one row per repeating item. A
 * detail page contributes at most one row: `structured` (Tier 1) and `rules`
 * (Tier 2/4) fields merged rather than picked, since M17's coverage-aware
 * routing means both can legitimately contribute complementary fields to the
 * same page (Tier 1 finds name/description, Tier 4 fills in price/brand that
 * Tier 1 was missing). `rules` wins on a key collision — it's the more
 * specifically-requested tier. A page with nothing extracted contributes no
 * rows.
 */
function extractedRowsFor(
  analysis: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] {
  const structured = analysis?.structured as
    | { fields?: Record<string, unknown>; confidence?: string }
    | undefined;
  const rules = analysis?.rules as
    | {
        fields?: Record<string, unknown>;
        confidence?: string;
        records?: Record<string, unknown>[];
      }
    | undefined;

  if (rules?.confidence && rules.confidence !== "none" && rules.records?.length) {
    return rules.records;
  }

  const merged: Record<string, unknown> = {};
  if (structured?.confidence && structured.confidence !== "none" && structured.fields) {
    Object.assign(merged, structured.fields);
  }
  if (rules?.confidence && rules.confidence !== "none" && rules.fields) {
    Object.assign(merged, rules.fields);
  }
  return Object.keys(merged).length > 0 ? [merged] : [];
}
