import type { Request, Response, NextFunction } from "express";
import { createLogger } from "@crawler/logger";

const log = createLogger("api");

/** Single funnel for all errors, so route handlers never hand-roll a 500. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)), path: req.path },
    "unhandled route error",
  );
  res.status(500).json({ error: "internal error" });
}
