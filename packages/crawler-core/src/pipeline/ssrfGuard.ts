import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit, Response } from "undici";

/**
 * Fetch-time SSRF defense (ADR-0005): resolve the host, reject private/link-local/
 * loopback addresses, pin the connection to the validated IP, and re-check every
 * redirect hop — all via an undici Agent whose connect.lookup validates each DNS
 * resolution. Covers the page fetch AND the robots.txt fetch.
 */

export class SsrfError extends Error {
  constructor(host: string, detail: string) {
    super(`SSRF blocked for "${host}": ${detail}`);
    this.name = "SsrfError";
  }
}

/** True if an IP literal is in a range a crawler must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true; // not a valid IP → refuse
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((o) => Number.isNaN(o))) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 255 && b === 255) return true; // broadcast
  return false;
}

function isBlockedV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true; // loopback / unspecified
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s); // IPv4-mapped
  if (mapped) return isBlockedV4(mapped[1]!);
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return true; // link-local fe80::/10
  return false;
}

/**
 * A dns.lookup-compatible function that validates (and thereby pins) every resolved
 * address. Used as undici Agent's connect.lookup, so each connection — including each
 * redirect hop — is checked.
 */
export function validatingLookup(
  hostname: string,
  options: unknown,
  callback: (err: Error | null, address?: unknown, family?: number) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    for (const a of addresses) {
      if (isBlockedAddress(a.address)) {
        callback(new SsrfError(hostname, `resolves to blocked ${a.address}`));
        return;
      }
    }
    const wantsAll =
      typeof options === "object" && options !== null && "all" in options
        ? Boolean((options as { all?: unknown }).all)
        : false;
    if (wantsAll) {
      callback(null, addresses);
    } else {
      const first = addresses[0];
      if (first === undefined) {
        callback(new SsrfError(hostname, "no addresses"));
        return;
      }
      callback(null, first.address, first.family);
    }
  });
}

const guardedAgent = new Agent({
  connect: { lookup: validatingLookup as never },
});

/** Walk an error's cause/aggregate chain looking for our SsrfError. */
function findSsrfError(err: unknown, depth = 0): SsrfError | null {
  if (err === null || err === undefined || depth > 6) return null;
  if (err instanceof SsrfError) return err;
  const e = err as { cause?: unknown; errors?: unknown };
  const fromCause = findSsrfError(e.cause, depth + 1);
  if (fromCause) return fromCause;
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const found = findSsrfError(inner, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * fetch() with the SSRF guard applied. Redirects follow through the same guarded
 * dispatcher, so every hop is re-validated. Throws SsrfError for a blocked address
 * or an unsupported scheme.
 *
 * undici wraps a connect-time lookup error in a generic `TypeError: fetch failed`,
 * so we unwrap the cause chain and re-throw the real SsrfError — letting callers
 * distinguish a permanent SSRF block from a transient network error.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfError(u.hostname, `unsupported scheme "${u.protocol}"`);
  }
  // Literal-IP hosts skip DNS, so the validating lookup never runs — check directly.
  // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]"), so strip them first.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new SsrfError(host, "blocked literal address");
  }
  try {
    return await undiciFetch(url, { ...init, dispatcher: guardedAgent });
  } catch (err) {
    const ssrf = findSsrfError(err);
    if (ssrf) throw ssrf;
    throw err;
  }
}
