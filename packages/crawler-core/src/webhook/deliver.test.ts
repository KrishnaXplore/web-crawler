import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import type { WebhookPayload } from "@crawler/shared";
import {
  buildWebhookRequest,
  signWebhookBody,
  SIGNATURE_HEADER,
} from "./deliver.js";

const payload: WebhookPayload = {
  event: "job.completed",
  jobId: "j1",
  seedUrl: "https://example.com/",
  status: "completed",
  pagesPersisted: 12,
  startedAt: "2026-07-08T00:00:00.000Z",
  finishedAt: "2026-07-08T00:01:00.000Z",
};

describe("webhook request (M6 Step B)", () => {
  it("body round-trips the payload exactly", () => {
    const { body } = buildWebhookRequest(payload);
    expect(JSON.parse(body)).toEqual(payload);
  });

  it("is unsigned when no secret is configured", () => {
    const { headers } = buildWebhookRequest(payload);
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("signature verifies against the exact raw body (receiver-side check)", () => {
    const secret = "test-secret";
    const { body, headers } = buildWebhookRequest(payload, secret);
    const expected =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(headers[SIGNATURE_HEADER]).toBe(expected);
  });

  it("different secrets produce different signatures", () => {
    expect(signWebhookBody("x", "a")).not.toBe(signWebhookBody("x", "b"));
  });
});
