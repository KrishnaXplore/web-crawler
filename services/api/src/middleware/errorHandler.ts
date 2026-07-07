import type { Request, Response, NextFunction } from "express";

/** Single funnel for all errors, so route handlers never hand-roll a 500. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("api error:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "internal error" });
}
