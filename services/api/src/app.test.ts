import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import type { AppDeps } from "./app.js";
import { getJob, buildReport, markJobCancelling } from "@crawler/db";

// The cancel route reads the job from Mongo — mock the db module so its
// state-machine semantics (404/409/202) are testable offline like the
// validation paths.
vi.mock("@crawler/db", () => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  getPages: vi.fn(),
  countPages: vi.fn(),
  iteratePages: vi.fn(),
  searchPages: vi.fn(),
  buildReport: vi.fn(),
  markJobCancelling: vi.fn(),
}));

// Validation + health paths don't touch Redis/Mongo; cancel needs only redis.set
// (the tombstone), so a stub suffices.
const redisSet = vi.fn();
const deps = { redis: { set: redisSet } } as unknown as AppDeps;
const app = createApp(deps);

const job = (status: string) => ({
  jobId: "j1",
  seedUrl: "https://example.com/",
  status,
  maxDepth: 1,
  maxPages: 10,
  sameHostOnly: true,
  respectRobots: true,
  storeHtml: false,
  webhookUrl: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("api", () => {
  it("GET /health → 200 ok", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("POST /jobs rejects an invalid seed URL → 400", async () => {
    const r = await request(app).post("/jobs").send({ seedUrl: "not a url" });
    expect(r.status).toBe(400);
  });

  it("POST /jobs pre-screens an internal seed URL → 400", async () => {
    const r = await request(app)
      .post("/jobs")
      .send({ seedUrl: "http://127.0.0.1/admin" });
    expect(r.status).toBe(400);
  });

  it("POST /jobs pre-screens localhost → 400", async () => {
    const r = await request(app)
      .post("/jobs")
      .send({ seedUrl: "http://localhost:9002/" });
    expect(r.status).toBe(400);
  });

  it("POST /jobs rejects a non-http(s) webhook URL → 400", async () => {
    const r = await request(app)
      .post("/jobs")
      .send({ seedUrl: "https://example.com/", webhookUrl: "ftp://x/hook" });
    expect(r.status).toBe(400);
  });

  it("POST /jobs pre-screens an internal webhook URL → 400", async () => {
    const r = await request(app)
      .post("/jobs")
      .send({ seedUrl: "https://example.com/", webhookUrl: "http://127.0.0.1/hook" });
    expect(r.status).toBe(400);
  });
});

describe("cancel (M6 Step A)", () => {
  it("unknown job → 404", async () => {
    vi.mocked(getJob).mockResolvedValue(null);
    const r = await request(app).post("/jobs/nope/cancel");
    expect(r.status).toBe(404);
  });

  it("running job → 202 cancelling; tombstone set + status flipped", async () => {
    vi.mocked(getJob).mockResolvedValue(job("running"));
    const r = await request(app).post("/jobs/j1/cancel");
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ jobId: "j1", status: "cancelling" });
    expect(redisSet).toHaveBeenCalledOnce();
    expect(vi.mocked(markJobCancelling)).toHaveBeenCalledWith("j1");
  });

  it("repeat cancel while cancelling → 202 (idempotent)", async () => {
    vi.mocked(getJob).mockResolvedValue(job("cancelling"));
    const r = await request(app).post("/jobs/j1/cancel");
    expect(r.status).toBe(202);
  });

  it.each(["completed", "cancelled", "failed"])(
    "terminal state %s → 409",
    async (status) => {
      vi.mocked(getJob).mockResolvedValue(job(status));
      const r = await request(app).post("/jobs/j1/cancel");
      expect(r.status).toBe(409);
      expect(redisSet).not.toHaveBeenCalled();
    },
  );
});

describe("report (M8 Step A)", () => {
  it("unknown job → 404", async () => {
    vi.mocked(buildReport).mockResolvedValue(null);
    const r = await request(app).get("/jobs/nope/report");
    expect(r.status).toBe(404);
  });

  it("returns the health report for a job", async () => {
    vi.mocked(buildReport).mockResolvedValue({
      pagesCrawled: 9,
      statusBreakdown: { "2xx": 9, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
      brokenPages: 0,
      totalDiscoveredLinks: 62,
      avgLinksPerPage: 6.9,
      pagesMissingH1: 2,
      pagesMissingMetaDescription: 2,
      imagesMissingAlt: 4,
      technology: ["jQuery"],
      securityScore: "3/5",
      mostLinkedPage: { url: "https://site/support", inLinks: 5 },
      crawlDurationMs: 2400,
      robotsRespected: true,
    });
    const r = await request(app).get("/jobs/j1/report");
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe("j1");
    expect(r.body.report.pagesCrawled).toBe(9);
    expect(r.body.report.mostLinkedPage.url).toBe("https://site/support");
  });
});
