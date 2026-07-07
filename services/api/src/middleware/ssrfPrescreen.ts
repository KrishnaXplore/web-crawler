import { isIP } from "node:net";
import type { Request, Response, NextFunction } from "express";
import { isBlockedAddress } from "@crawler/core";

/**
 * Fast SSRF reject at submission (Phase 1) for obviously-internal seed URLs. NOT the
 * security boundary — the authoritative guard is the worker's fetch-time SSRF check
 * (ADR-0005). This just gives the user an immediate 400 instead of a silent
 * blocked-ssrf outcome later.
 */
export function ssrfPrescreen(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const seedUrl: unknown = req.body?.seedUrl;
  if (typeof seedUrl === "string") {
    try {
      const host = new URL(seedUrl).hostname.replace(/^\[|\]$/g, "");
      if (
        host === "localhost" ||
        (isIP(host) !== 0 && isBlockedAddress(host))
      ) {
        res
          .status(400)
          .json({ error: "seed URL points to a disallowed internal address" });
        return;
      }
    } catch {
      /* URL validity was already enforced by validateBody */
    }
  }
  next();
}
