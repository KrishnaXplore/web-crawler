import { isIP } from "node:net";
import type { Request, Response, NextFunction } from "express";
import { isBlockedAddress } from "@crawler/core";

function isInternal(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || (isIP(host) !== 0 && isBlockedAddress(host));
  } catch {
    return false; // URL validity was already enforced by validateBody
  }
}

/**
 * Fast SSRF reject at submission (Phase 1) for obviously-internal URLs — the seed
 * and, since M6 B, the webhook callback (both are URLs the system will fetch). NOT
 * the security boundary — the authoritative guard is the fetch-time SSRF check
 * (ADR-0005), which webhook delivery also goes through. This just gives the user an
 * immediate 400 instead of a silent blocked-ssrf outcome later.
 */
export function ssrfPrescreen(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  for (const field of ["seedUrl", "webhookUrl"] as const) {
    const value: unknown = req.body?.[field];
    if (typeof value === "string" && isInternal(value)) {
      res
        .status(400)
        .json({ error: `${field} points to a disallowed internal address` });
      return;
    }
  }
  next();
}
