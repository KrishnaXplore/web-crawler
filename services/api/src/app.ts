import express from "express";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { CrawlJobData } from "@crawler/shared";
import { apiKeyAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { metricsMiddleware } from "./middleware/metrics.js";
import { healthRouter } from "./routes/health.js";
import { metricsRouter } from "./routes/metrics.js";
import { searchRouter } from "./routes/search.js";
import { createJobsRouter } from "./routes/jobs.js";

export interface AppDeps {
  readonly redis: Redis;
  readonly queue: Queue<CrawlJobData>;
  /** The render queue (M9) — seeds of renderMode:"browser" jobs go here instead. */
  readonly renderQueue: Queue<CrawlJobData>;
}

/**
 * Assemble the Express app from its dependencies (no `listen` — index.ts binds the
 * port). Importable and testable without a running server. Stateless (ADR-0003): it
 * holds only connections, so it scales behind a load balancer.
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  app.use("/health", healthRouter);
  app.use("/metrics", metricsRouter);
  app.use("/jobs", apiKeyAuth, createJobsRouter(deps));
  app.use("/search", apiKeyAuth, searchRouter);

  app.use(errorHandler);
  return app;
}
