import { createHmac } from "node:crypto";
import type { WebhookPayload } from "@crawler/shared";
import { safeFetch } from "../pipeline/ssrfGuard.js";

/**
 * Webhook delivery (M6 Step B — see docs/phase6.md). A webhook URL is a
 * user-supplied URL the server fetches — exactly the SSRF threat ADR-0005 exists
 * for — so delivery goes through the SAME safeFetch guard as the crawler, with
 * redirects refused outright. Two egress paths with different rules is how SSRF
 * holes happen.
 *
 * The body is HMAC-signed (GitHub/Stripe-style) when a secret is configured, so
 * receivers can verify origin: `X-Crawler-Signature: sha256=<hex>` over the exact
 * raw body.
 */

export const SIGNATURE_HEADER = "x-crawler-signature";

export function signWebhookBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export interface WebhookRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** Build the exact request body + headers (pure — unit-testable without I/O). */
export function buildWebhookRequest(
  payload: WebhookPayload,
  secret?: string,
): WebhookRequest {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "web-intelligence-platform-webhook/0.1",
  };
  if (secret !== undefined && secret !== "") {
    headers[SIGNATURE_HEADER] = signWebhookBody(body, secret);
  }
  return { body, headers };
}

/** POST the signed payload. Non-2xx throws so BullMQ retries with backoff. */
export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string,
): Promise<void> {
  const { body, headers } = buildWebhookRequest(payload, secret);
  const res = await safeFetch(url, {
    method: "POST",
    body,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  // Drain the body so the socket is released.
  await res.arrayBuffer().catch(() => undefined);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`webhook receiver responded ${res.status}`);
  }
}
