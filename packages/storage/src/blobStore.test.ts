import { describe, it, expect, beforeAll } from "vitest";
import { createBlobStore, type BlobStore } from "./blobStore.js";

// Integration test against a real MinIO. Opt in with RUN_MINIO_IT=1 (after
// `docker compose up -d minio`); skipped by default so the offline suite passes.
const RUN_IT = process.env.RUN_MINIO_IT === "1";

describe.skipIf(!RUN_IT)("blob store (integration)", () => {
  let store: BlobStore;

  beforeAll(async () => {
    store = createBlobStore();
    await store.ensureBucket();
  });

  it("stores by content hash, dedupes identical content, and round-trips", async () => {
    const html = `<html><body>hello ${Date.now()}</body></html>`;

    const a = await store.putBlob(html, "text/html");
    const b = await store.putBlob(html, "text/html"); // same bytes
    expect(b.key).toBe(a.key); // content-hash → identical key
    expect(a.key).toMatch(/^html\/[0-9a-f]{64}$/);

    const different = await store.putBlob(html + "x", "text/html");
    expect(different.key).not.toBe(a.key);

    const fetched = await store.getBlob(a.key);
    expect(fetched.toString("utf-8")).toBe(html);
  });
});
