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
        const config: JobConfig = {
          maxDepth: body.maxDepth,
          maxPages: body.maxPages,
          sameHostOnly: body.sameHostOnly,
          respectRobots: body.respectRobots,
          storeHtml: body.storeHtml,
          plugins: body.plugins,
          webhookUrl: body.webhookUrl ?? null,
        };
        const jobId = randomUUID();
        await createJob({ jobId, seedUrl: seed, ...config });
        await enqueueUrl(
          deps.queue,
          deps.redis,
          { jobId, url: seed, depth: 0, parentUrl: null },
          config.maxPages,
        );
        res.status(202).json({ jobId, seedUrl: seed, config });
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
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${jobId}.csv"`,
        );
        res.write("url,finalUrl,status,depth,discoveredLinks,title\n");
        for await (const p of iteratePages(jobId)) {
          res.write(
            [
              csv(p.url),
              csv(p.finalUrl),
              p.status ?? "",
              p.depth,
              p.discoveredLinks,
              csv(p.title),
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
