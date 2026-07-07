# Web Intelligence Platform

A **distributed web crawler and page-analysis platform**: submit a seed URL and a
scope, and a horizontally-scalable fleet of workers crawls the site politely, runs
pluggable analyzers over every page (SEO, security headers, tech fingerprint, page
metadata), stores results and raw HTML, and streams them back — with live progress,
search, export, webhooks, and Prometheus metrics throughout.

Built as a TypeScript **pnpm monorepo**: three deployable services around a core of
shared packages, backed by Redis (BullMQ), MongoDB, and MinIO.

```
 Browser (React+Vite) ──► api (Express) ──► MongoDB (jobs · pages)
                              │      └────► Redis + BullMQ (queue · dedup · counters)
                              ▼                     ▲│
                        202 Accepted                ││ claim / enqueue children
                                                    │▼
                                          worker ×N (stateless)
                              robots → rate-limit → SSRF guard → fetch
                                   → parse → analyze (plugins) → extract links
                                                    │
                                        MinIO (raw HTML blobs)   Prometheus /metrics
```

## Highlights

- **Scales horizontally** — workers are stateless ([ADR-0003](docs/adr/0003-stateless-workers.md));
  all coordination lives in Redis (queue, dedup set, atomic counters) and MongoDB.
  Add replicas, get throughput.
- **Knows when it's done** — distributed termination via a reference-counted
  `pending` counter with an enqueue-before-decrement invariant; no polling, no
  heuristics ([docs/phase4.md](docs/phase4.md)).
- **Crawls politely** — robots.txt respected (incl. crawl-delay), per-domain rate
  limiting shared across all workers via a Redis Lua gate, honest User-Agent.
- **SSRF-hardened** — a crawler is an SSRF weapon by construction, so the guard sits
  at *fetch time*: DNS-validating, IP-pinning undici agent that re-checks every
  redirect hop; submission-time checks are only UX
  ([ADR-0005](docs/adr/0005-ssrf-defense.md)). Webhook delivery goes through the
  **same guard** — one egress path, one set of rules.
- **No work silently lost** — retries with exponential backoff, dead-letter queue for
  post-mortems, graceful drain on SIGTERM, idempotent page upserts with a unique-index
  backstop ([ADR-0001](docs/adr/0001-mongodb-for-pages.md)).
- **Extensible by plugin** — analyzers are pure functions behind one interface
  ([ADR-0006](docs/adr/0006-modular-monolith-of-services.md)); a plugin that throws
  fails its own slot, never the crawl. Built-ins: `seo`, `tech`, `security`, `metadata`.
- **Observable** — shared Prometheus registry (`/metrics` on api and worker),
  outcome-labelled counters, fetch-duration histograms.

## Features

| | |
|---|---|
| Submit & scope | depth, page cap, same-host, robots on/off, store raw HTML, analyzer selection |
| Live dashboard | React SPA: submit, watch pending/persisted tick, browse results + analysis, cancel |
| Cancel | `POST /jobs/:id/cancel` — tombstone + no-op drain; partial results kept |
| Webhooks | HMAC-signed (`X-Crawler-Signature`) callback on `job.completed` / `job.cancelled`, delivered via its own BullMQ queue (retries → DLQ) |
| Search | Mongo text index over title + description, `GET /search?q=…` |
| Export | `GET /jobs/:id/export?format=json\|csv` — streamed, bounded memory |
| Blob storage | raw HTML in MinIO under content-hash keys; Mongo stores only the key |

## Quickstart

Prereqs: Node ≥ 20, pnpm, Docker.

```bash
cp .env.example .env          # defaults match the compose file
pnpm install
pnpm infra:up                 # Redis :6380 · MongoDB :27018 · MinIO :9002 (non-standard ports)

pnpm api                      # REST API on :3000
pnpm worker                   # crawl worker (+ metrics on :9464) — run as many as you like
pnpm --filter @crawler/web dev  # dashboard on :5173 (proxies /api → :3000)
```

Submit a crawl:

```bash
curl -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{
  "seedUrl": "https://quotes.toscrape.com/",
  "maxDepth": 1,
  "maxPages": 25,
  "plugins": ["seo", "tech", "security", "metadata"],
  "storeHtml": true
}'
# → 202 {"jobId": "…"}

curl localhost:3000/jobs/<id>          # status + live counts
curl localhost:3000/jobs/<id>/pages    # results with per-page analysis
curl -X POST localhost:3000/jobs/<id>/cancel
curl "localhost:3000/jobs/<id>/export?format=csv"
curl "localhost:3000/search?q=quotes"
```

Optional env: `API_KEY` (enables `X-API-Key` auth), `WEBHOOK_SECRET` (signs webhook
deliveries).

## Testing

```bash
pnpm -r test        # offline suite — no infra needed (60+ tests)
pnpm -r typecheck
```

Integration suites are opt-in so the default run works anywhere:
`RUN_REDIS_IT=1` / `RUN_MONGO_IT=1` / `RUN_MINIO_IT=1` (require `pnpm infra:up`).

## Repository layout

```
packages/
  shared/         pure domain types, URL normalization + hashing (browser-safe)
  config/         env contract — zod-validated once at boot, fail-fast
  crawler-core/   the crawl pipeline (robots, SSRF guard, fetch, parse, extract),
                  plugin host + built-in analyzers, webhook delivery
  queue/          BullMQ queues, dedup-guarded enqueue, job counters, rate limiter
  db/             Mongoose models (Job, Page), idempotent repository
  storage/        MinIO blob store (content-hash keys)
  metrics/        shared Prometheus registry — metric names defined once
services/
  api/            Express REST edge: validation, SSRF pre-screen, jobs/search/export
  worker/         stateless queue consumer wiring crawler-core to the stores
  web/            React + Vite dashboard
scripts/          CLI entry points (crawl, seed, results, html, dlq)
docs/             HLD · LLD · 8-phase workflow · ADRs 0001–0006 · per-milestone
                  phase docs · production target (architecture-v2 + gap-analysis)
```

## Design docs

The design is written down *before* the code, milestone by milestone:

- [architecture.md](docs/architecture.md) — system HLD and the scaling model
- [workflow.md](docs/workflow.md) — the 8-phase crawl lifecycle incl. failure paths
- [project-structure.md](docs/project-structure.md) — LLD, package boundaries
- [ADRs](docs/adr/) — MongoDB, BullMQ-over-Kafka, stateless workers, frontier
  scheduling, SSRF defense, modular-monolith service split
- [phase1–6](docs/) — what/why/alternatives for every milestone as built
- [architecture-v2.md](docs/architecture-v2.md) + [gap-analysis.md](docs/gap-analysis.md)
  — the production/enterprise target and the prioritized path to it

## Status

M1–M6 complete: crawl core → queue + workers → persistence + blobs → hardening
(completion detection, retries/DLQ, SSRF, rate limiting) → product surface (API,
dashboard, plugins, metrics, search, export) → cancel + webhooks + metadata plugin.
Every feature above is exercised end-to-end; the roadmap beyond lives in
[gap-analysis.md](docs/gap-analysis.md).
