import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedAddress } from "@crawler/core";

/**
 * Request vetting for the headless browser (M9, docs/phase9.md). A rendered page
 * fetches sub-resources the crawler never sees — each is an egress. Every request is
 * checked against the SAME blocked-address list as the HTTP guard (ADR-0005): literal
 * IPs directly, hostnames via DNS with ALL resolved addresses checked.
 *
 * Honest caveat (documented in phase9.md): this validates at check time and cannot pin
 * the later connection to the validated IP, so a fast-rebinding DNS attacker has a
 * TOCTOU window the undici agent doesn't. The prod mitigation is an egress network
 * policy — this is the application-layer half of defense-in-depth.
 */
export async function isRequestAllowed(rawUrl: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // Allow browser-internal schemes; block anything not http(s) otherwise.
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") {
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return !isBlockedAddress(host);

  try {
    const addrs = await dnsLookup(host, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false; // unresolvable → refuse
  }
}
