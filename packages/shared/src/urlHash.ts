import { createHash } from "node:crypto";

/**
 * Stable dedup key for a URL. Callers MUST pass an already-normalized URL
 * (see normalizeUrl) — hashing a raw URL would let trivially-different spellings
 * of the same page slip past dedup.
 *
 * SHA-1 is used purely as a fast, uniform key (not for security); collisions are
 * not a security concern here, and the durable MongoDB unique index is the final
 * backstop.
 *
 * NOTE: uses `node:crypto`, so this module is Node-only. Do not import it into
 * the browser bundle — import the pure types from ./types instead.
 */
export function urlHash(normalizedUrl: string): string {
  return createHash("sha1").update(normalizedUrl).digest("hex");
}
