import express from "express";
import type { AppDeps } from "../app.js";
import { isMongoReady } from "@crawler/db";

export function createHealthRouter(deps: AppDeps): express.Router {
  const router = express.Router();

  // Deprecated root health check (for backwards compatibility)
  router.get("/", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    try {
      // Check Redis
      const redisPing = await deps.redis.ping();
      if (redisPing !== "PONG") throw new Error("Redis ping failed");

      // Check Mongo
      if (!isMongoReady()) {
        throw new Error("Mongo not connected");
      }

      res.json({ status: "ready" });
    } catch (err) {
      res.status(503).json({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
