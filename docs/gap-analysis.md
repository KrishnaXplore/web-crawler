# Gap Analysis — Designed vs Built vs Production Target

> Three columns of truth: what `architecture.md` (the original HLD) promised, what the
> code actually does today (M1–M5 complete, verified end-to-end 2026-07-07), and what
> [architecture-v2.md](architecture-v2.md) targets. This file is the work list.

---

## 1. Scorecard: original design vs current code

### ✅ Built as designed (verified working)

| Area | Evidence |
|---|---|
| Stateless workers, horizontal scaling (ADR-0003) | `services/worker` holds no state; N replicas safe |
| BullMQ queue + Redis dedup (ADR-0002) | `packages/queue` SADD-guarded `enqueueUrl` |
| Pipeline: robots → ratelimit → ssrf → fetch → parse → analyze → extract | `packages/crawler-core/src/pipeline` |
| SSRF fetch-time guard, IP-pinned, per-hop (ADR-0005) | `ssrfGuard.ts` — undici connect hook |
| Per-domain rate limiting | `rateLimit.ts` Redis Lua interval gate |
| Completion detection (ref-count, enqueue-before-decrement) | Redis `pending` counter, decrement in Worker events |
| Retries + backoff + DLQ, graceful shutdown | BullMQ retries, `scripts/dlq.ts`, SIGTERM drain |
| Mongo persistence, `(jobId,url)` unique dedup backstop (ADR-0001) | `packages/db` |
| Blob storage, content-hash keys | `packages/storage` + MinIO |
| REST API: submit/status/pages/search/export, zod validation, SSRF pre-screen | `services/api` |
| Metrics package + `/metrics` on api & worker | `packages/metrics`, worker `:9464` |
| Plugin host + seo/tech/security analyzers | `crawler-core/src/plugins` |
| Search (Mongo text) + streamed CSV/JSON export | `search.ts`, jobs export route |
| React dashboard (submit, live view, results, export) | `services/web` |
| Config validation at boot | `packages/config` (zod) |

### ⚠️ Designed in the HLD but NOT built (drift)

| # | HLD promise | Current reality | Severity |
|---|---|---|---|
| D1 | `packages/auth` — JWT + RBAC | Single API-key middleware in `api` (documented interim) | High (blocks multi-user) |
| D2 | `packages/logger` — pino, structured, jobId+url on every line, "no bare console.log" | Package doesn't exist; **38 `console.*` calls** across services/scripts | High (blocks operability) |
| D3 | Per-user API rate limiting at the edge | None | Medium |
| D4 | nginx / LB in front of api + web | None (dev proxy only) | Medium (prod-only) |
| D5 | Prometheus + Grafana deployment, dashboards in `infra/grafana` | Endpoints exist; nothing scrapes them; no `infra/` dir | Medium |
| D6 | Plugins: metadata, a11y, screenshot (HLD diagram) | Only seo/tech/security | Low (a11y/screenshot need a renderer) |
| D7 | Render mode (headless browser) in job scope | Not built | Low (deliberate deferral) |
| D8 | `scripts/load-test.ts` + `docs/benchmarks.md` with multi-domain scaling results | Neither exists (benchmarks.md is 0 bytes) | Medium (the HLD's scaling claim is unproven) |
| D9 | Fused Lua dedup+enqueue (one atomic op) | SADD + queue.add are two ops; crash window documented in phase2b.md | Low (rare, self-healing via unique index) |
| D10 | Custom frontier per-domain scheduler (ADR-0004) | Deferred by amendment — BullMQ delayed re-queue instead | Accepted (documented decision, not drift) |
| D11 | `docs/api-spec.yaml` (OpenAPI) | Empty file | Medium |
| D12 | `docs/runbook.md` | Empty file | Medium |
| D13 | Readiness vs liveness split | Single `/health` liveness only | Low |

### ❌ Repo hygiene (not architecture, but blocks everything)

| # | Item | State |
|---|---|---|
| H1 | **No commits** — `main` has zero history | everything untracked |
| H2 | `.gitignore` is **empty (0 bytes)** — `node_modules/`, `.env`, `dist/` would be committed | must precede H1 |
| H3 | `.github/workflows/ci.yml` and `deploy.yml` are **empty files** | CI/CD is decorative |
| H4 | No Dockerfiles for api/worker/web (compose covers infra only) | services can't be shipped |
| H5 | No README at repo root | project has no front door |
| H6 | `.env` is untracked but sitting next to `.env.example` — ensure it's ignored before the first commit | see H2 |

---

## 2. Work list — changes & additions, prioritized

Ordered so each tier is releasable and nothing later blocks earlier.

### Tier 0 — Repo hygiene (hours, do first)

1. **Write `.gitignore`** (`node_modules/`, `dist/`, `.env`, `*.log`, coverage, `.DS_Store`).
2. **First commit** on `main`; commit granularity going forward per milestone/step.
3. **README.md** — what it is, architecture sketch, quickstart (`infra:up → api → worker → web dev`), example curl, links into `docs/`.
4. **Fill `docs/api-spec.yaml`** — generate OpenAPI from the existing zod schemas (`zod-to-openapi`) so it can't drift from the code.
5. **Fill `docs/runbook.md`** — start/stop, ports, common failures (Redis down, Mongo down, stuck job, DLQ inspect/replay), the gotchas already learned (BullMQ jobId `:`→`.`, CJS imports, run scripts from repo root).

### Tier 1 — Ship & operate (days)

6. **`packages/logger`** (pino): JSON logs, child loggers carrying `{jobId, url}`, redaction paths for secrets. Replace all 38 `console.*` call sites; add an ESLint `no-console` rule to hold the line. *(Closes D2.)*
7. **Dockerfiles** for api/worker (multi-stage, non-root, distroless) + web (build → nginx static). Extend `docker-compose.yml` with an `app` profile so `docker compose --profile app up` runs the whole product. *(Closes H4, D4 partially.)*
8. **Real CI** (`ci.yml`): pnpm install → typecheck → unit tests → **integration tests with Redis/Mongo/MinIO service containers** (`RUN_*_IT=1` — they exist, they just never run in CI) → build images. *(Closes H3.)*
9. **Liveness/readiness split**: `/health/live` (process up) vs `/health/ready` (Redis+Mongo ping) on api and worker metrics server. *(Closes D13.)*
10. **Prometheus + Grafana in compose** (`observability` profile) + first dashboard (pages/sec, queue depth, fetch p95, DLQ size, outcome breakdown) version-controlled in `infra/grafana/`. *(Closes D5.)*
11. **`scripts/load-test.ts` + `docs/benchmarks.md`**: multi-domain seed set, 1 vs 4 vs 8 workers, plot throughput — proves the HLD's scaling section. *(Closes D8.)*

### Tier 2 — Multi-user product (days–weeks)

12. **`packages/auth`**: JWT verification (JWKS, `iss`/`aud` pinned) + RBAC middleware (`viewer`/`operator`/`admin`); keep hashed scoped API keys for programmatic access. Needs a minimal user/org store in Mongo + login via an OIDC provider (Keycloak in compose for dev). *(Closes D1.)*
13. **Tenancy**: `orgId` on Job/Page + repository-level tenant scoping; blob keys prefixed per org.
14. **Quotas + API rate limiting**: Redis sliding window per token; per-org concurrent-job and pages/day budgets enforced at submit/enqueue. *(Closes D3.)*
15. **API v1**: move routes under `/v1`, cursor pagination on list endpoints, RFC 7807 errors, `Idempotency-Key` on job submit.
16. **Job cancel/pause** (`POST /v1/jobs/:id/cancel`): Redis tombstone checked by workers; queued children no-op.
17. **Audit log**: append-only Mongo collection for every mutating call.

### Tier 3 — Engine hardening (weeks)

18. **Outbox pattern** for job-create + seed-enqueue atomicity; **fused Lua dedup+enqueue** in `packages/queue`. *(Closes D9 and the phase2b crash window.)*
19. **Politeness completion**: robots.txt cache w/ TTL + crawl-delay honored; sitemap.xml ingestion; conditional GET (ETag/If-Modified-Since) for recrawls; per-domain global concurrency cap.
20. **Fairness/priority scheduling**: per-org BullMQ priorities so tenants can't starve each other; activate the ADR-0004 frontier scheduler behind a flag only if benchmarks (item 11) show head-of-line blocking.
21. **HA stores**: Mongo replica set + majority writes for job state; Redis Sentinel; S3 lifecycle/versioning; documented backup/restore drill.
22. **Autoscaling**: KEDA on queue depth for workers (k8s/Helm chart), HPA for api.
23. **OpenTelemetry tracing**: span per pipeline stage, context propagated through job data; correlate `traceId` in logs.

### Tier 4 — Product growth (when needed)

24. **progress-hub**: SSE endpoint fed by Redis pub/sub job events; dashboard drops polling.
25. **Webhooks** on job completion/failure (HMAC-signed, retried, dead-lettered).
26. **Schedules/recurring crawls** + **recrawl with change detection** (content-hash diff summary).
27. **Renderer service** (Playwright pool, own queue, SSRF-guarded request interception) → unlocks **a11y** and **screenshot** plugins. *(Closes D6, D7.)*
28. **Plugin SDK v1**: freeze + version the `AnalyzerPlugin` interface, per-plugin time budgets, failure isolation; then add **metadata**, **links-graph**, **keywords** built-ins.
29. **Data retention/GDPR**: TTL + S3 lifecycle expiry for raw HTML, `DELETE /v1/jobs/:id` purge, per-org retention overrides.
30. **DLQ admin API/UI**: inspect + replay from the dashboard (today it's CLI-only via `scripts/dlq.ts`).
31. **Search upgrade path**: OpenSearch behind a new ADR only when Mongo text search misses a real target.

---

## 3. What NOT to change

Explicitly re-affirmed after review — these hold at production scale and churning them
would be negative work:

- **Three services + packages** (ADR-0006) — v2 adds `progress-hub`/`renderer` only
  because their scaling/isolation profiles genuinely differ.
- **BullMQ over Kafka** (ADR-0002), **stateless workers** (ADR-0003), **Mongo for
  pages** (ADR-0001), **fetch-time SSRF guard** (ADR-0005), **ref-count completion**.
- **zod-at-the-edge validation**, **content-hash blob keys**, **dedup-guarded enqueue
  as the single shared primitive**, **wiring-vs-entrypoint split** (`app.ts`/`index.ts`).
- **Dev proxy instead of CORS** for the dashboard — same shape in prod behind nginx.

---

## 4. Suggested immediate next step

Tier 0 in one sitting (gitignore → first commit → README → api-spec → runbook), then
Tier 1 item 6 (`packages/logger`) as the first new code — it touches every service,
so landing it before Tier 2/3 features avoids retrofitting log context later.
Per project convention, each tier item gets its `docs/phaseN.md` before implementation.
