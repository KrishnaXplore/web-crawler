# Phase 5 (Milestone M5) — The Product Surface

> **Naming note.** Milestone **M5** — the product/UI layer over the finished engine
> (M1–M4). Implements workflow Phases 1, 7, 8.

M5 is the largest milestone by volume but the least conceptually hard: it wraps the
distributed engine in the things a *user* touches. Built in steps:

- **Step A (this doc, now): REST API** — Express. Submit jobs, query status/results,
  health. The HTTP version of `seed.ts` + `results.ts`, with auth, validation, and an
  SSRF pre-screen.
- **Step B: Metrics** — `prom-client` `/metrics` on api + worker.
- **Step C: Analyzer plugins** — the plugin host + SEO/security/tech-detect analyzers,
  stored per page.
- **Step D: Dashboard** — React + Vite UI over the API.
- **Step E: Search + Export** — Mongo text search; streamed JSON/CSV export.

---

## Step A — REST API

| Endpoint | Purpose |
|---|---|
| `POST /jobs` | Submit a crawl (validated), create the Job, enqueue the seed → `202 {jobId}` |
| `GET /jobs/:id` | Job status + live counts (persisted pages, discovered, pending) |
| `GET /jobs/:id/pages` | The job's persisted page results (paginated) |
| `GET /health` | Liveness for load balancers |

The API is **stateless** (ADR-0003): it holds only connections (Redis, Mongo), so it
scales behind a load balancer like the workers do. It reuses the exact same
`createJob` + dedup-guarded `enqueueUrl` the CLI used — one code path, two front ends.

### Design decisions

**Framework — Express.** The design specifies it; it's the boring, ubiquitous choice,
and the route/middleware model maps cleanly onto the project structure
(`routes/`, `middleware/`).

**`app.ts` vs `index.ts`.** `app.ts` builds the Express app and takes its
dependencies (Redis queue, etc.) as arguments — so it's importable and testable
without binding a port. `index.ts` wires real connections and calls `listen`. This is
the same wiring-vs-entrypoint split the worker uses.

**Validation — zod at the edge.** Every request body is parsed against a zod schema
before anything touches the DB or queue: a bad seed URL, negative depth, or a page
cap over the ceiling is a clean `400`, never enqueued (workflow Phase 1).

**Auth — API key now, JWT-shaped later.**

| Choice | Why |
|---|---|
| **API key** (`X-API-Key` vs `API_KEY`) | Honest for a single-tenant service: it authenticates callers without pretending to have a user store / login / token issuance we haven't built. Enabled only if `API_KEY` is set, so local dev stays frictionless. |
| ~~Full JWT + RBAC~~ | The design's target, but issuing JWTs needs a user store + login flow that's explicitly deferred (ADR-0006, "auth issuance"). Verifying tokens without an issuer is half a system; an API key is the honest interim. The middleware is a single swap point when issuance lands. |

**SSRF pre-screen (Phase 1).** A *fast reject* at submission for obviously-internal
seed URLs (literal private/loopback IPs, `localhost`). It is explicitly **not** the
security boundary — the authoritative guard is the worker's fetch-time SSRF check
(ADR-0005). It just gives the user an immediate `400` instead of a silent
`blocked-ssrf` later.

**Errors funnel through one handler.** All routes delegate to a single
`errorHandler` middleware so error shape is consistent and no route hand-rolls its
own `500`.

### What's tested

- **`app.ts`** via `supertest` (no real port, no infra needed for the validation
  paths): `POST /jobs` rejects bad input `400`; `GET /health` returns `200`. Routes
  that hit Redis/Mongo are exercised in the end-to-end demo.
- **End-to-end** — `POST /jobs` with curl, run a worker, `GET /jobs/:id` shows it
  progress to `completed`, `GET /jobs/:id/pages` returns the results.

### Exit criteria for Step A

- `pnpm api` serves the endpoints; `POST /jobs` enqueues a crawl a worker then drains.
- Bad input is rejected `400`; internal seed URLs are pre-screened.
- `GET /jobs/:id` reflects live status → `completed`; `GET /jobs/:id/pages` lists pages.
- Offline suite green.
