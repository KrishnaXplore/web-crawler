/**
 * URL canonicalization — the single source of truth for turning a raw or relative
 * URL into a stable canonical form. Its output feeds BOTH the Redis dedup key
 * (see urlHash) and the MongoDB unique index, so two URLs that address "the same
 * page" MUST normalize to an identical string. Keep this deterministic and pure.
 */

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
};

/** Tracking params dropped by default so they don't fragment the dedup key. */
const DEFAULT_STRIP_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
];

export class InvalidUrlError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid URL "${input}": ${reason}`);
    this.name = "InvalidUrlError";
  }
}

export interface NormalizeOptions {
  /** Additional query parameters to strip (case-insensitive). */
  readonly stripParams?: readonly string[];
}

/**
 * Canonicalize a URL. If `base` is provided, `input` may be relative and is
 * resolved against it (used when extracting links from a page).
 *
 * @throws {InvalidUrlError} on empty/unparseable input or a non-http(s) scheme.
 */
export function normalizeUrl(
  input: string,
  base?: string,
  options: NormalizeOptions = {},
): string {
  const raw = input.trim();
  if (raw === "") throw new InvalidUrlError(input, "empty");

  let url: URL;
  try {
    url = base !== undefined ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new InvalidUrlError(input, "unparseable");
  }

  // WHATWG URL already lowercases scheme and host, but be explicit.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(input, `unsupported scheme "${url.protocol}"`);
  }

  // The fragment is never part of server identity.
  url.hash = "";

  // Drop the default port for the scheme.
  if (url.port !== "" && DEFAULT_PORTS[url.protocol] === url.port) {
    url.port = "";
  }

  // An empty path canonicalizes to "/".
  if (url.pathname === "") url.pathname = "/";

  // Sort query params for a stable key and strip tracking params. JS sort is
  // stable, so repeated keys keep their relative order.
  const strip = new Set(
    [...DEFAULT_STRIP_PARAMS, ...(options.stripParams ?? [])].map((p) =>
      p.toLowerCase(),
    ),
  );
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !strip.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  return url.toString();
}

/**
 * The lowercased host of a URL, used for per-domain scheduling and same-host
 * scope checks. Accepts a relative URL when `base` is given.
 *
 * @throws {InvalidUrlError} on the same conditions as {@link normalizeUrl}.
 */
export function hostOf(input: string, base?: string): string {
  return new URL(normalizeUrl(input, base)).hostname;
}
