import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import type { AppDeps } from "./app.js";

// Validation + health paths don't touch Redis/Mongo, so stub deps suffice.
const deps = {} as AppDeps;
const app = createApp(deps);

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
});
