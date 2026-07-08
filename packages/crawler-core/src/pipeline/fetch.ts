/**
 * HTTP fetch for one URL (workflow.md Phase 4.4) — built on Node's global fetch.
 * Adds the things a crawler must not go without: a descriptive User-Agent, a hard
 * timeout, and a response-size cap read off the stream so a huge file cannot
 * exhaust memory.
 *
 * The authoritative SSRF guard (ADR-0005) is applied via `safeFetch` — fetch-time
 * DNS validation, IP-pinning, and per-redirect re-check (see ./ssrfGuard).
 */
import { safeFetch } from "./ssrfGuard.js";
import type { Response } from "undici";

export interface FetchOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /**
   * Extra request headers (M10) — e.g. a session Cookie / Authorization for the
   * authenticated baseline pass of an exposure audit. Held in-flight only; never
   * persisted on the Page.
   */
  readonly requestHeaders?: Record<string, string>;
}

export interface FetchResult {
  /** URL after following redirects. */
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  /** Response headers (lowercased names) — used by analyzer plugins. */
  readonly headers: Record<string, string>;
  /** Decoded body text, capped at `maxBytes`. */
  readonly body: string;
  /** True if the body was truncated at the size cap. */
  readonly truncated: boolean;
  /** Wall-clock time from request to body read, ms (M8 Step C). */
  readonly responseTimeMs: number;
}

export const DEFAULT_USER_AGENT =
  "web-intelligence-platform-crawler/0.1 (+https://example.com/bot)";

const DEFAULTS: FetchOptions = {
  userAgent: DEFAULT_USER_AGENT,
  timeoutMs: 10_000,
  maxBytes: 5_000_000,
};

export async function fetchPage(
  url: string,
  options: Partial<FetchOptions> = {},
): Promise<FetchResult> {
  const opts = { ...DEFAULTS, ...options };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await safeFetch(url, {
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,*/*",
        ...opts.requestHeaders,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const { text, truncated } = await readCapped(res, opts.maxBytes);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      finalUrl: res.url || url,
      status: res.status,
      contentType: res.headers.get("content-type"),
      headers,
      body: text,
      truncated,
      responseTimeMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body up to `maxBytes`, cancelling the stream once the cap is hit. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (res.body === null) return { text: "", truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8").decode(merged.subarray(0, maxBytes));
  return { text, truncated };
}
