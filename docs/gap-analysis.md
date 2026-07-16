# Gap Analysis — Designed vs Built vs Production Target

> Three columns of truth: what `architecture.md` (the original HLD) promised, what the
> code actually does today, and what [architecture-v2.md](architecture-v2.md) /
> [architecture-v3.md](architecture-v3.md) target. This file is the work list.
>
> **Reconciled to reality as of M25 (2026-07-13).** The earlier revision of this file
> was frozen at "M1–M5 complete" and is why so much below flipped from ❌/⚠️ to ✅: the
> crawl platform, the renderer, and the entire Extraction & Intelligence engine
> (M11–M25) have since been built and verified live. The per-milestone record is in
> `docs/phaseN.md`.

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
| REST API: submit/status/pages/report/search/export, zod validation, SSRF pre-screen | `services/api` |
| Metrics package + `/metrics` on api & worker & renderer | `packages/metrics`, worker `:9464`, renderer `:9465` |
| Plugin host + seo/tech/security/**metadata** analyzers | `crawler-core/src/plugins`, `builtins.ts` |
| Search (Mongo text) + streamed CSV/JSON export | `search.ts`, jobs export route |
| React dashboard (two pages: Scraper + Console) | `services/web` |
| Config validation at boot | `packages/config` (zod) |
| **Structured logging (pino), `{jobId,url}` child loggers, no bare `console.*`** | `packages/logger` — closes former D2 |
| **Renderer service (browser mode, Playwright, SSRF-guarded interception)** | `services/renderer` — closes former D7 |
| **Job cancel** (Redis tombstone, queued children no-op) | `jobStore.markCancelled` + api `/jobs/:id/cancel` |
| **Webhooks on completion/failure** (HMAC-signed, retried, dead-lettered) | `crawler-core/webhook`, `queue/webhooks.ts` |
| **Liveness/readiness split** on api + worker | api `/health/live` + `/ready`; worker `/health/ready` pings Redis+Mongo |
| **Exposure audit** (passive sensitive-data detector, authorized use) | `plugins/exposure.ts` + Console tab |

### 🧠 Extraction & Intelligence engine (M11–M25 — not in the original HLD, built since)

The no-code extraction thesis (`docs/vision-no-code-extraction.md`, `architecture-v3.md`).
All verified live; details in the phase docs and `docs/scraper-edge-cases.md`.

| Capability | Evidence |
|---|---|
| Tier 1 structured data (JSON-LD → microdata → OpenGraph) | `plugins/structured.ts` (M11) |
| Tier 2 stored CSS rules + **multi-record list rules** (`records[]`) | `plugins/rules.ts` (M11/M22) |
| Tier 4 LLM rule generation (Gemini), cheapest-first, coverage-gated | `llm/socket.ts`, `plugins/registry.ts` (M15/M17/M21) |
| Intent coverage router ("found what was asked", not just "found something") | `plugins/intentCoverage.ts` (M17) |
| Page classification (listing/detail/unknown) gating the tiers | `plugins/discovery.ts` (M12/M22) |
| Rule Library w/ hit/miss feedback + **self-heal** (<30% over ≥5 uses) | `db/rules.ts` (M14/M17) |
| Domain intelligence profiles; `needsRender` drives renderMode `auto` | `db/intelligence.ts` (M12) |
| Bot-challenge detection → auto-route challenged domains to browser | `pipeline/botChallenge.ts` (M20) |
| Discovery link scoring + learned per-domain path hints | `discovery/linkScorer.ts` (M16/M18) |
| Focused-crawl mode (detail intents: head for product pages, early-stop) | `discovery/intentTargetType.ts`, `linkScorer.focusLinks` (M23) |
| Pagination following for collection intents on listing pages | `pipeline/pagination.ts` (M25) |
| Value normalization (price → `_amount`/`_currency` siblings) | `plugins/normalize.ts` (M24) |

### ⚠️ Designed in the HLD but NOT built (remaining drift)

| # | HLD promise | Current reality | Severity |
|---|---|---|---|
| D1 | `packages/auth` — JWT + RBAC | Single API-key middleware in `api` (documented interim); no `packages/auth` | High (blocks multi-user) |
| D3 | Per-user/token API rate limiting at the edge | None (per-**domain** crawl rate limiting exists; per-**caller** quota does not) | Medium |
| D5 | Prometheus + Grafana deployment, dashboards in `infra/grafana` | Endpoints exist & are scrapeable; no `infra/` dir, no `observability` compose profile, nothing scrapes them | Medium |
| D6b | a11y + screenshot plugins | metadata built; a11y/screenshot still not (both need renderer wiring, now available) | Low |
| D9 | Fused Lua dedup+enqueue (one atomic op) | `enqueueUrl` is still SADD + `queue.add` (two ops); crash window documented in phase2b.md | Low (rare, self-healing via unique index) |
| D10 | Custom frontier per-domain scheduler (ADR-0004) | Deferred by amendment — BullMQ delayed re-queue instead | Accepted (documented decision, not drift) |

Former drift now **closed**: D2 (logger), D4 (nginx + compose `app` profile — LB/ingress
still prod-only), D7 (renderer), D8 (`scripts/load-test.ts` + `benchmarks.md`),
D11 (`api-spec.yaml`), D12 (`runbook.md`), D13 (liveness/readiness).

### ❗ Divergence from a stated design line (flag, not a gap to "close")

The renderer now ships anti-bot **evasion** tooling — stealth plugin, humanized-behavior
simulation, residential-proxy rotation, WAF/CAPTCHA-block detection
(`services/renderer/src/stealth-utils.ts`, `proxy.ts`, `render.ts`). This **contradicts
the honest-identity / no-evasion line** in `CLAUDE.md` §9 and `docs/scraper-edge-cases.md`.
Recorded here for accuracy; the design decision on whether to keep it is the owner's, not
an implementation gap.

### ✅ Repo hygiene (all resolved)

| # | Item | State |
|---|---|---|
| H1 | Git history on `main` | ✅ committed (was: zero history) |
| H2 | `.gitignore` | ✅ present; ignores `node_modules/`, `dist/`, `.env*`, logs, `.DS_Store` |
| H3 | `.github/workflows/ci.yml` + `deploy.yml` | ✅ non-empty (was: decorative) |
| H4 | Dockerfiles for api/worker/web/renderer | ✅ all four present (web → nginx static) |
| H5 | Root `README.md` | ✅ present |
| H6 | `.env` ignored next to `.env.example` | ✅ `.gitignore` excludes `.env` |

---

## 2. Work list — what remains, prioritized

Ordered so each tier is releasable and nothing later blocks earlier. Per project
convention, **each item gets its `docs/phaseN.md` (what / why / alternatives) before code.**

### Tier 1 — Operate & prove (days)

1. **Observability deployment** (*closes D5*): Prometheus + Grafana in an `observability`
   compose profile; first dashboard (pages/sec, queue depth, fetch p95, DLQ size, outcome
   breakdown) version-controlled in `infra/grafana/`. Endpoints already emit; nothing scrapes them.
2. **CI teeth**: confirm `ci.yml` runs typecheck + unit tests + the integration tests behind
   `RUN_*_IT=1` (Redis/Mongo/MinIO service containers) + image build — they exist but must gate merges.
3. **Fused Lua dedup+enqueue** (*closes D9*): collapse SADD + `queue.add` into one atomic
   Lua op in `packages/queue`, closing the phase2b crash window.

### Tier 2 — Multi-user product (days–weeks)

4. **`packages/auth`** (*closes D1*): JWT verification (JWKS, `iss`/`aud` pinned) + RBAC
   (`viewer`/`operator`/`admin`); keep hashed scoped API keys for programmatic access.
   Needs a minimal user/org store in Mongo + OIDC login (Keycloak in compose for dev).
5. **Tenancy**: `orgId` on Job/Page + repository-level tenant scoping; blob keys prefixed per org.
6. **Quotas + API rate limiting** (*closes D3*): Redis sliding window per token; per-org
   concurrent-job and pages/day budgets enforced at submit/enqueue.
7. **API v1**: routes under `/v1`, cursor pagination, RFC 7807 errors, `Idempotency-Key` on submit.
8. **Audit log**: append-only Mongo collection for every mutating call.

### Tier 3 — Engine hardening (weeks)

9. **Politeness completion**: robots.txt cache TTL (crawl-delay already honored); sitemap.xml
   ingestion; conditional GET (ETag/If-Modified-Since) for recrawls; per-domain global concurrency cap.
10. **Fairness/priority scheduling**: per-org BullMQ priorities; activate the ADR-0004 frontier
    scheduler behind a flag only if benchmarks show head-of-line blocking.
11. **HA stores**: Mongo replica set + majority writes; Redis Sentinel; S3 lifecycle/versioning;
    documented backup/restore drill.
12. **Autoscaling**: KEDA on queue depth for workers (k8s/Helm), HPA for api.
13. **OpenTelemetry tracing**: span per pipeline stage, context propagated through job data; `traceId` in logs.

### Tier 4 — Product growth (when needed)

14. **progress-hub**: SSE endpoint fed by Redis pub/sub job events; dashboard drops its 1.5s polling.
15. **Schedules/recurring crawls** + **recrawl with change detection** (content-hash diff summary).
16. **a11y + screenshot plugins** (*closes D6b*): now unblocked by the renderer.
17. **Plugin SDK v1**: freeze + version `AnalyzerPlugin`, per-plugin time budgets, failure isolation;
    then add links-graph / keywords built-ins.
18. **Data retention/GDPR**: TTL + S3 lifecycle expiry for raw HTML; `DELETE /v1/jobs/:id` purge; per-org overrides.
19. **DLQ admin API/UI**: inspect + replay from the dashboard (today CLI-only via `scripts/dlq.ts`).
20. **Search upgrade path**: OpenSearch behind a new ADR only when Mongo text search misses a real target.

### Known engine limitations (functional, tracked in `docs/scraper-edge-cases.md`)

Not "gaps" against the HLD, but the real edges to close as evidence demands: JS
infinite-scroll / "Load more" pagination isn't followed; link scoring is synonym-blind
(literal substring); one rule per domain per template; intent coverage recognizes only ~7
field concepts; non-price values aren't normalized.

---

## 3. What NOT to change

Explicitly re-affirmed — these hold at production scale and churning them would be negative work:

- **Three services + packages** (ADR-0006) — `renderer` was added because its
  scaling/isolation profile genuinely differs; `progress-hub` is the only remaining split.
- **BullMQ over Kafka** (ADR-0002), **stateless workers** (ADR-0003), **Mongo for pages**
  (ADR-0001), **fetch-time SSRF guard** (ADR-0005), **ref-count completion**.
- **zod-at-the-edge validation**, **content-hash blob keys**, **dedup-guarded enqueue as the
  single shared primitive**, **wiring-vs-entrypoint split** (`app.ts`/`index.ts`).
- **Cheapest-first extraction** (never call the LLM when Tier 1/2 already covers the intent).
- **Dev proxy instead of CORS** for the dashboard — same shape in prod behind nginx.

---

## 4. Suggested immediate next step

The hygiene and single-service build gaps are closed, so the next new code is **Tier 1
item 1 (observability deployment)** — it's the cheapest way to make the platform operable
and it unblocks proving the scaling claim with the existing `load-test.ts`. Then **Tier 2
item 4 (`packages/auth`)**, which touches every service, so landing it before further Tier 2/3
features avoids retrofitting tenant/identity context later. Each gets its `docs/phaseN.md` first.
