import type { Request, Response, NextFunction } from "express";
import { httpRequests } from "@crawler/metrics";

/** Count each response, collapsing UUIDs in the path to keep label cardinality low. */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.on("finish", () => {
    const route = req.path.replace(/[0-9a-f-]{36}/g, ":id");
    httpRequests.inc({
      method: req.method,
      route,
      status: res.statusCode,
    });
  });
  next();
}
