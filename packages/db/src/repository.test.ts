import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectMongo, disconnectMongo } from "./connect.js";
import { upsertPage, countPages, type PageInput } from "./repository.js";
import { PageModel } from "./models/page.js";

// Integration test against a real Mongo. Opt in with RUN_MONGO_IT=1 (after
// `docker compose up -d mongo`); skipped by default so the offline suite passes.
const RUN_IT = process.env.RUN_MONGO_IT === "1";

describe.skipIf(!RUN_IT)("page persistence (integration)", () => {
  const jobId = `test-${Date.now()}`;

  beforeAll(async () => {
    await connectMongo();
    await PageModel.syncIndexes(); // ensure the unique index exists
  });

  afterAll(async () => {
    await PageModel.deleteMany({ jobId });
    await disconnectMongo();
  });

  function page(url: string): PageInput {
    return {
      jobId,
      url,
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      title: "t",
      description: null,
      depth: 0,
      parentUrl: null,
      discoveredLinks: 3,
    };
  }

  it("upserts the same (jobId,url) to a single row, and distinct urls to separate rows", async () => {
    await upsertPage(page("http://a.com/x"));
    await upsertPage(page("http://a.com/x")); // same key → update, not insert
    expect(await countPages(jobId)).toBe(1);

    await upsertPage(page("http://a.com/y"));
    expect(await countPages(jobId)).toBe(2);
  });
});
