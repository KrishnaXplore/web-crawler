import { Queue } from "bullmq";
import { type Redis } from "ioredis";
import type { WebhookPayload } from "@crawler/shared";

/**
 * Webhook delivery queue (M6 Step B — see docs/phase6.md). Delivery is a BullMQ job
 * so it inherits the engine's existing failure model — exponential backoff, capped
 * attempts, dead-letter on exhaustion — instead of a hand-rolled retry loop in the
 * completion path.
 */
export const WEBHOOK_QUEUE = "webhooks";

export interface WebhookJobData {
  readonly url: string;
  readonly payload: WebhookPayload;
}

export function createWebhookQueue(connection: Redis): Queue<WebhookJobData> {
  return new Queue<WebhookJobData>(WEBHOOK_QUEUE, { connection });
}

export async function enqueueWebhook(
  queue: Queue<WebhookJobData>,
  data: WebhookJobData,
): Promise<void> {
  await queue.add("deliver", data, {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    // Failed deliveries are the webhook DLQ (same convention as the crawl queue).
    removeOnFail: 1000,
  });
}
