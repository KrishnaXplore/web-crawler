# Architecture v2 — Production / Enterprise Target

> Status: **target architecture**. `architecture.md` is the original HLD; the engine it
> describes (M1–M5) is built and verified. This document is the next altitude: what the
> same system looks like operated as a real product — multi-tenant, deployed on an
> orchestrator, observable, and safe to run unattended. The concrete deltas from today's
> code are enumerated in [gap-analysis.md](gap-analysis.md).

---

## 1. Design goals (what changes at enterprise level)

The v1 goal — *the crawl must scale horizontally* — stands. Production adds four more:

1. **Multi-tenancy** — many users/orgs share one deployment without seeing or starving
   each other: authn/authz, quotas, per-tenant rate limits, per-tenant data isolation.
2. **Operability** — the system can be deployed, upgraded, debugged, and recovered by
   someone who didn't write it: CI/CD, IaC, dashboards, alerts, runbooks, backups.
3. **Zero-trust edge** — every request authenticated, every input validated, every
   egress constrained; secrets never in files; audit trail for every mutating action.
4. **Graceful degradation** — any dependency can fail and the system sheds load or
   pauses rather than corrupting state or falling over.

---

## 2. Topology

```
                                   ┌─────────────────────────────┐
                                   │           CDN               │
                                   │   (static dashboard build)  │
                                   └──────────────┬──────────────┘
                                                  │
   users ──HTTPS──►  ┌────────────────────────────▼─────────────────────────────┐
                     │              Ingress / API Gateway (nginx / ALB)          │
                     │   TLS termination · WAF · per-IP rate limit · routing     │
                     └───────┬──────────────────────────────────────┬───────────┘
                             │ /api/v1/*                            │ /ws (SSE/WebSocket)
                     ┌───────▼───────┐                      ┌───────▼───────┐
                     │  api ×N       │                      │ progress hub  │
                     │  (stateless)  │                      │ (SSE fan-out, │
                     │  authn/authz  │                      │  Redis pub/sub)│
                     │  quotas       │                      └───────┬───────┘
                     │  validation   │                              │
                     │  OpenAPI v1   │        Redis pub/sub (job events)
                     └───┬───────┬───┘                              │
              Mongo (jobs,│      │ outbox → enqueue                 │
              pages, users│      ▼                                  │
              audit)      │  ┌──────────────────────────────────────▼───┐
                     ┌────▼─┐│        Redis (HA: Sentinel/Cluster)       │
                     │Mongo ││  BullMQ queues (per-priority) · frontier  │
                     │RS ×3 ││  dedup sets · counters · rate-limit state │
                     └────▲─┘└──────────────┬───────────────▲───────────┘
                          │                 │ claim         │ enqueue children
                          │        ┌────────▼───────────────┴────────┐
              upsert page │        │        worker ×N (KEDA-scaled)   │
              + analysis  └────────┤  crawler-core pipeline:          │
                                   │  robots → ratelimit → ssrf →     │
                                   │  fetch → parse → plugins →       │
                                   │  extract → enqueue               │
                                   └───────┬──────────────┬───────────┘
                                           │ blobs        │ render jobs (JS pages)
                                    ┌──────▼─────┐  ┌─────▼──────────┐
                                    │ S3 / MinIO │  │ renderer ×M    │
                                    │ versioned, │  │ (Playwright    │
                                    │ lifecycle  │  │  pool, own     │
                                    │ policies   │  │  queue, heavy) │
                                    └────────────┘  └────────────────┘

   Cross-cutting:
     OpenTelemetry traces ─► collector ─► Tempo/Jaeger
     prom-client /metrics  ─► Prometheus ─► Grafana + Alertmanager (SLO alerts)
     pino structured logs  ─► stdout ─► Loki/ELK (jobId + traceId correlation)
     secrets              ─► Vault / cloud secret manager (no .env in prod)
     egress               ─► NetworkPolicy: workers may reach ONLY the internet,
                             never cluster-internal ranges (defense-in-depth for SSRF)
```

### Services (deployables)

| Service | Role | Scaling signal | New vs v1 |
|---|---|---|---|
| `web` | Static React bundle | CDN | unchanged |
| `api` | REST edge: auth, quotas, jobs, search, export | RPS / CPU | + JWT/OIDC, quotas, API versioning, idempotency |
| `progress-hub` | SSE/WebSocket fan-out of live job events | connections | **new** (replaces dashboard polling) |
| `worker` | Crawl engine | **queue depth (KEDA)** | + tracing, structured logs |
| `renderer` | Headless-browser rendering for JS-heavy pages | render-queue depth | **new**, isolated because Chromium is heavy and crashy |

Everything else stays a **package** (ADR-0006 holds): `auth`, `logger`, `config`,
`metrics`, `db`, `queue`, `storage`, `crawler-core`, `shared`.

### Stores

| Store | Production shape | v1 shape |
|---|---|---|
| MongoDB | 3-node replica set, majority writes for job state; TTL indexes for data retention; per-tenant `orgId` on every document; nightly snapshots | single container |
| Redis | Sentinel or Cluster; AOF everysec; maxmemory policy `noeviction` on queue keys | single container |
| Blob store | Real S3 (or MinIO distributed): versioning, lifecycle rules (expire raw HTML after N days), SSE encryption | single MinIO |
| Search | Mongo text index until scale demands; OpenSearch behind an ADR when p95 search > target or index > ~10 GB | Mongo text index |

---

## 3. Identity, tenancy, and quotas

**AuthN.** OIDC (Auth0/Keycloak/Cognito — pluggable) issues JWTs; `packages/auth`
verifies them (JWKS cached, `aud`/`iss` pinned). Service-to-service calls use short-lived
machine tokens. API keys remain as a *secondary* credential for CI/programmatic use,
stored hashed, scoped, and revocable.

**AuthZ.** RBAC with three roles to start: `viewer` (read jobs/results), `operator`
(submit/cancel jobs), `admin` (DLQ replay, quota management, user management). Enforced
in `api` middleware; role claims live in the JWT.

**Tenancy.** Every Job, Page, and blob key carries `orgId`. All queries are
tenant-scoped by construction (repository layer injects the filter — routes cannot
forget it). Blob keys are prefixed `org/{orgId}/html/{hash}` so bucket policies can
partition access.

**Quotas & fairness.**

| Control | Mechanism |
|---|---|
| Max concurrent jobs per org | Redis counter checked at submit |
| Max pages per job / per org per day | enqueue-time budget (extends the existing maxPages ref-count) |
| API request rate per token | sliding-window limiter in `api` (Redis) |
| Crawl fairness across tenants | per-org BullMQ **priority** + round-robin group scheduling so one org's 100k-page job can't starve another's 10-page job |

**Audit.** Every mutating call (submit, cancel, replay, quota change) writes an
append-only audit document: who, what, when, from where, request id.

---

## 4. Job lifecycle upgrades

**Submission is transactional.** v1 has a documented crash window between "create Job"
and "enqueue seed" and between SADD and queue.add. v2 closes both:

- **Outbox pattern**: the API writes Job + an `outbox` document in one Mongo
  transaction; a relay (in-process loop in `api`, idempotent) drains the outbox into
  BullMQ. A crash anywhere → the relay re-delivers; the dedup guard absorbs duplicates.
- **Fused Lua dedup+enqueue** inside `packages/queue` so SADD + add are one atomic step
  (the ADR-0004 deferred optimization, now justified).

**Idempotent submits.** `POST /v1/jobs` accepts an `Idempotency-Key` header; replays
return the original `jobId` instead of creating a duplicate job.

**New job controls.**

| Operation | Endpoint |
|---|---|
| Cancel a running job | `POST /v1/jobs/:id/cancel` — sets a Redis tombstone; workers check before processing; queued children drain as no-ops |
| Pause / resume | tombstone with `paused` state; frontier retained |
| Scheduled / recurring crawls | `POST /v1/schedules` — cron expression, stored in Mongo, fired by a leader-elected scheduler loop inside `api` (a module, not a service — ADR-0006) |
| Recrawl / change detection | jobs may reference a previous job; unchanged pages (content-hash match) short-circuit; a `changes` summary is stored |
| Webhooks | `POST /v1/webhooks` — signed (HMAC) delivery on `job.completed` / `job.failed`, with retries and a dead-letter list |

**Completion events** (already ref-counted in v1) additionally publish
`job.completed` to Redis pub/sub → progress-hub pushes to browsers, webhook dispatcher
fires, metrics record end-to-end duration.

---

## 5. Crawl engine upgrades

The pipeline order is unchanged (`robots → ratelimit → ssrf → fetch → parse → analyze →
extract → enqueue`). Production hardens each stage:

- **Politeness, complete**: robots.txt cache with TTL + `crawl-delay` honored per
  domain; sitemap.xml ingestion as an optional seed expander; conditional GETs
  (`ETag`/`If-Modified-Since`) on recrawls; global per-domain concurrency cap of 1–2
  regardless of worker count.
- **Frontier scheduling** (ADR-0004, now activated at scale): when a queue is dominated
  by one slow domain, per-domain sub-queues with a Lua "next eligible domain" scheduler
  stop head-of-line blocking. This stays behind a feature flag until benchmarks show
  BullMQ-only ordering is the bottleneck.
- **Rendering tier**: pages that need JavaScript (detected by heuristic or requested via
  `renderMode: "browser"` in job config) are re-enqueued to the renderer service's own
  queue. Renderer = Playwright pool with hard memory/CPU limits, per-page timeout,
  and the **same SSRF guard** applied to every request the browser makes (route
  interception). Screenshots become a blob type next to HTML.
- **Content dedup**: content-hash already dedups blob storage; add simhash/shingling to
  mark near-duplicate pages so analyzers and search can skip boilerplate mirrors.
- **Egress control**: all worker/renderer traffic exits through a NetworkPolicy (and
  optionally a proxy pool for IP rotation / geo-distribution). The SSRF guard remains
  the application-level boundary; the network layer is defense-in-depth as ADR-0005
  already recommends.

### Plugin platform

The host exists; production grows it into a platform:

- Built-ins to add: **metadata** (canonical URL, og:/twitter: cards, hreflang),
  **a11y** (axe-core against rendered DOM — requires renderer), **screenshot**
  (renderer), **links-graph** (export adjacency for PageRank-style analysis),
  **keywords** (term extraction for better search).
- **Plugin SDK v1**: freeze the `AnalyzerPlugin` interface, version it
  (`apiVersion: 1`), and document a contract: pure function over `(dom, headers,
  meta)`, time-budgeted (host kills a plugin exceeding its per-page budget), failures
  isolated (one plugin failing marks its slot `error`, never fails the page).

---

## 6. API surface (v1, versioned)

All routes move under `/v1`; OpenAPI spec (`docs/api-spec.yaml`) is generated from the
zod schemas (single source of truth) and served at `/v1/openapi.json`.

```
POST   /v1/jobs                     submit (Idempotency-Key honored)
GET    /v1/jobs?cursor=…            list (tenant-scoped, cursor pagination)
GET    /v1/jobs/:id                 status + counts
POST   /v1/jobs/:id/cancel          cancel
GET    /v1/jobs/:id/pages?cursor=…  results (cursor pagination, filterable)
GET    /v1/jobs/:id/export          streamed json|csv|ndjson
GET    /v1/search?q=…               tenant-scoped text search
GET    /v1/jobs/:id/events          SSE live progress (via progress-hub)
POST   /v1/schedules                recurring crawls
POST   /v1/webhooks                 completion callbacks
GET    /v1/admin/dlq                inspect dead letters (admin)
POST   /v1/admin/dlq/:id/replay     replay a dead letter (admin)
GET    /health/live | /health/ready liveness vs readiness (ready = Redis+Mongo ping)
GET    /metrics                     Prometheus
```

Pagination is **cursor-based** (`_id`-anchored), not offset — offset pagination on a
million-page job re-scans; cursors don't. Error bodies follow RFC 7807
(`application/problem+json`).

---

## 7. Observability & SLOs

Three signals, correlated by `traceId` + `jobId`:

- **Traces** — OpenTelemetry SDK in api/worker/renderer; one trace per URL-crawl
  (span per pipeline stage), one per API request. Queue hop propagates context via job
  data. Exported to Tempo/Jaeger.
- **Metrics** — existing `packages/metrics` registry, extended: queue depth per
  priority, frontier size, per-domain throttle waits, render pool saturation, webhook
  delivery failures, DLQ size. Grafana dashboards are **version-controlled** in
  `infra/grafana/` (as the v1 HLD already promised).
- **Logs** — `packages/logger` (pino): JSON to stdout, every line carries
  `{ orgId, jobId, url, traceId }`. Zero bare `console.*` (lint-enforced).

**SLOs (initial):**

| SLO | Target | Alert |
|---|---|---|
| API availability | 99.9 % monthly | burn-rate alerts (fast+slow window) |
| p95 `POST /jobs` latency | < 150 ms | page |
| Job completion (no stuck jobs) | pending>0 with 0 in-flight for >10 min = stuck | page |
| DLQ growth | < 1 % of pages/day | ticket |
| Worker crash-loop | restarts > 3/10 min | page |

Runbook entries (`docs/runbook.md`) exist for every alert — an alert without a runbook
entry fails CI review.

---

## 8. Deployment & operations

- **Packaging**: one multi-stage Dockerfile per service (distroless runtime, non-root
  UID, pinned base digests). Images scanned (Trivy) + SBOM (Syft) in CI.
- **Orchestration**: Kubernetes via Helm chart (or ECS — chart structure keeps the
  choice swappable). Workers scale on **queue depth via KEDA**; api on RPS/CPU HPA;
  renderer on its queue. PodDisruptionBudgets + the existing graceful-drain shutdown
  give zero-loss deploys.
- **CI** (`.github/workflows/ci.yml`): typecheck → unit tests → integration tests
  against ephemeral Redis/Mongo/MinIO service containers (the `RUN_*_IT` suites run
  **on every PR**, not just locally) → build images → scan → push on main.
- **CD** (`deploy.yml`): staging auto-deploy → smoke test (submit a canary crawl, assert
  completion) → manual gate → production, blue/green.
- **Config & secrets**: `packages/config` zod validation stays the boot gate; values
  come from the orchestrator's secret store (Vault agent / cloud SM), never `.env`
  files in production.
- **Backups/DR**: Mongo nightly snapshot + oplog PITR; Redis AOF (queue state is
  reconstructible — losing it loses in-flight frontier, jobs restartable via replay);
  S3 versioning. Restore procedure rehearsed and documented in the runbook.
- **Data retention**: TTL index on raw-HTML references + S3 lifecycle expiry
  (default 30 days); page metadata retained; per-org overrides. Deletion API for
  GDPR-style erasure (`DELETE /v1/jobs/:id` purges Mongo docs + blobs).

---

## 9. Security posture (v2)

| Layer | Control |
|---|---|
| Edge | TLS everywhere, WAF, per-IP + per-token rate limits, strict CORS (prod serves same-origin, so CORS stays off), security headers |
| AuthN/Z | OIDC JWT + RBAC (§3); hashed scoped API keys; audit log |
| Input | zod at every boundary (unchanged); body-size caps; export row caps per plan |
| SSRF | fetch-time IP-pinned guard (unchanged, ADR-0005) **plus** egress NetworkPolicy **plus** renderer request interception |
| Supply chain | lockfile-only installs, dependabot/renovate, image scan + SBOM, pinned action digests in CI |
| Secrets | secret manager, short-lived DB creds where supported, no secrets in images or logs (pino redaction paths) |
| Isolation | workers/renderer run non-root, read-only rootfs, seccomp default; renderer additionally sandboxed (Chromium in its own pod with no cluster credentials) |

---

## 10. What deliberately stays the same

These v1 decisions survive contact with production and are **not** revisited:

- **Three-ish services, packages for everything else** (ADR-0006). v2 adds only
  `progress-hub` and `renderer`, both forced by genuinely different scaling/isolation
  profiles — the ADR's own test.
- **BullMQ + Redis over Kafka** (ADR-0002). Queue depth at this workload doesn't
  justify Kafka's operational cost; revisit only if multi-region or replay-log
  requirements appear.
- **Stateless workers** (ADR-0003) — the scaling thesis, unchanged.
- **MongoDB for pages** (ADR-0001) — document shape fits; replica set is an
  operational upgrade, not a schema one.
- **SSRF defense at fetch time** (ADR-0005) — extended with network policy, never
  replaced by it.
- **Completion via ref-counting** — proven in M4; v2 only adds event publication.

---

## 11. Phasing (suggested)

| Phase | Theme | Contents |
|---|---|---|
| **P1 — Ship it honestly** | repo + delivery | .gitignore, first commit, Dockerfiles, real CI (typecheck/unit/integration in containers), CD to a staging compose/k8s, README |
| **P2 — Operate it** | observability + ops | `packages/logger` (pino), OTel traces, Grafana dashboards + alerts, runbook, liveness/readiness split, load test + benchmarks.md |
| **P3 — Open it up** | multi-tenant product | `packages/auth` (OIDC JWT + RBAC), orgId tenancy, quotas, audit log, API v1 + OpenAPI, cursor pagination, idempotency, cancel/pause |
| **P4 — Harden the engine** | correctness + scale | outbox, fused Lua enqueue, robots cache/sitemaps/conditional GET, priority + fairness scheduling, KEDA autoscaling, Redis/Mongo HA |
| **P5 — Grow the product** | features | progress-hub (SSE), webhooks, schedules/recrawl + change detection, renderer service + a11y/screenshot plugins, plugin SDK v1, retention/GDPR delete |

Each phase is releasable on its own; nothing in a later phase blocks an earlier one.
