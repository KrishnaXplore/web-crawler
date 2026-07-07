import type { Request, Response, NextFunction } from "express";
import { loadEnv } from "@crawler/config";

/**
 * API-key auth (Phase 1). Enabled only when API_KEY is configured — local dev stays
 * frictionless. This is the honest interim for a single-tenant service; JWT + RBAC is
 * the design target once token issuance (a user store + login) exists (ADR-0006).
 */
export function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { API_KEY } = loadEnv();
  if (API_KEY === undefined) {
    next();
    return;
  }
  if (req.header("x-api-key") === API_KEY) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}
