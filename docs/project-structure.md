# Project Structure

The production layout for the distributed crawler / web-intelligence platform. It
is a **pnpm/Turbo monorepo**: shared code lives in `packages/`, deployable
services in `services/`, pluggable analyzers in `plugins/`, operational config in
`infra/`, and design docs in `docs/`. Every service extends one base TypeScript
config and imports shared types/env/db/queue from `packages/` — there is one
source of truth for each concern.

This structure maps directly onto [the workflow](workflow.md) and the ADRs; file
annotations below cite the phase or ADR that motivates them.

## What this revision merges

This layout merges the **depth and correctness placement** of the earlier
`crawler-platform` tree with the **extensibility and domain-separation** ideas
from the broader `distributed-web-intelligence-platform` proposal — while
explicitly *not* adopting its microservice sprawl (see
[ADR-0006](adr/0006-modular-monolith-of-services.md)). Concretely:

- **`plugins/` (adopted).** Analyzers (metadata, screenshot, SEO, security,
  tech-detect, accessibility) become isolated, independently testable plugins
  behind a stable interface, instead of a bloated `parse.ts`. This is the feature
  that turns "a crawler" into "a web-intelligence platform." The plugin **SDK** is
  deferred until the internal interface stabilizes (premature-abstraction guard).
- **`packages/crawler-core` (adopted, relocated).** The crawl domain logic
  (pipeline, frontier, extractors) is a *library* the worker imports — so it lives
  under `packages/`, not as a third top-level home for crawl code. This resolves
  the ambiguity of a top-level `crawler/` sibling.
- **`packages/storage` / `logger` / `metrics` (adopted).** Shared operational
  concerns owned once, consistent with the shared-correctness principle.
- **Auth folded into `api` (not a separate service).** Per ADR-0006, auth is
  middleware + a package, not a network hop, until there is a scaling reason.
- **`scheduler` starts as a module inside the worker** (BullMQ repeatable jobs),
  promotable to its own service later — recorded as a decision, not built as an
  app on day one.
- **Deferred behind ADRs:** Elasticsearch (Mongo text search first),
  notification-service (future queue consumer), custom-plugin-SDK, and full
  Kubernetes/Helm. Each is a documented "not yet," so the ambition is *staged*,
  not missing.

```
web-intelligence-platform/
├── .github/
│   └── workflows/
│       ├── ci.yml                  # test + lint + typecheck + build on every push
│       └── deploy.yml              # build images, push to registry, deploy
├── .husky/                         # git hooks — lint/test before commit
├── package.json                    # workspace root (scripts, devDeps)
├── pnpm-workspace.yaml             # globs: packages/*, services/*, plugins/*
├── turbo.json                      # task pipeline + caching (build/test/lint)
├── tsconfig.base.json              # shared TS config; every package extends it
├── .eslintrc.cjs
├── .prettierrc
├── .editorconfig
├── .gitignore
├── .dockerignore
├── .env.example                    # documents EVERY required env var (see packages/config)
├── docker-compose.yml              # local dev: api, worker, web, redis, mongo, minio, prom, grafana
├── docker-compose.prod.yml         # production overrides (replicas, resource limits, secrets)
├── README.md
├── CONTRIBUTING.md                 # incl. test convention: unit colocated, integration in test/
├── LICENSE
│
├── docs/
│   ├── architecture.md             # HLD: diagrams + system overview
│   ├── workflow.md                 # end-to-end job lifecycle, phases + failure paths
│   ├── project-structure.md        # THIS FILE (LLD: module layout)
│   ├── api-spec.yaml               # OpenAPI/Swagger spec
│   ├── runbook.md                  # stuck jobs, DLQ drain, hot domain
│   ├── benchmarks.md               # load-test results: throughput vs worker count
│   └── adr/
│       ├── 0001-mongodb-for-pages.md
│       ├── 0002-bullmq-over-kafka.md
│       ├── 0003-stateless-workers.md
│       ├── 0004-frontier-per-domain-scheduling.md   # dedup + rate limit + scheduling as one subsystem
│       ├── 0005-ssrf-defense.md                      # fetch-time, IP-pinned, per-redirect
│       └── 0006-modular-monolith-of-services.md      # right number of services, not microservice sprawl
│
├── packages/
│   ├── shared/                     # pure types + url utils (browser-safe, no I/O)
│   │   ├── src/
│   │   │   ├── types.ts            # Job, Page, DiscoveredUrl, JobStatus, enums
│   │   │   ├── normalize.ts        # URL canonicalization (M1) — feeds dedup + unique index
│   │   │   ├── normalize.test.ts
│   │   │   ├── urlHash.ts          # stable hash of normalized URL (dedup keys) — Node-only entry
│   │   │   └── index.ts            # type-only exports safe for the web bundle
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── config/                     # env parsing + validation, ONCE, via zod
│   │   ├── src/
│   │   │   ├── env.ts              # parse + validate process.env; throws on boot if invalid
│   │   │   ├── schema.ts           # the zod schema (mirrors .env.example)
│   │   │   ├── env.test.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── db/                         # Mongoose schemas, indexes, migrations, connection (owned once)
│   │   ├── src/
│   │   │   ├── connect.ts          # mongo connection + pooling (imported by api + worker)
│   │   │   ├── models/             # Job, Page, DiscoveredUrl schemas + indexes (Page.url UNIQUE)
│   │   │   ├── migrations/         # versioned index/schema changes
│   │   │   └── index.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── queue/                      # Redis/BullMQ contract + dedup-guarded enqueue
│   │   ├── src/
│   │   │   ├── connection.ts       # Redis connection opts + queue name(s)
│   │   │   ├── jobTypes.ts         # CrawlJobData payload shape (the shared contract)
│   │   │   ├── enqueueUrl.ts       # THE primitive: dedup + queue add in ONE Lua op (see note below)
│   │   │   ├── enqueueUrl.test.ts
│   │   │   └── index.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── auth/                       # JWT verify + RBAC helpers (a LIBRARY, not a service — ADR-0006)
│   │   ├── src/
│   │   │   ├── verify.ts           # token verification
│   │   │   ├── rbac.ts             # role checks
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── storage/                    # MinIO/S3 blob client — put/get by content hash (Phase 5)
│   │   ├── src/
│   │   │   ├── blobStore.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── logger/                     # pino factory (jobId + url binding) — shared by all services
│   │   ├── src/index.ts
│   │   └── package.json
│   │
│   ├── metrics/                    # prom-client registry + shared counters/histograms
│   │   ├── src/index.ts
│   │   └── package.json
│   │
│   └── crawler-core/               # THE crawl domain logic (library the worker imports)
│       ├── src/
│       │   ├── pipeline/           # ordered per-URL steps (Phase 4) — thin, call into frontier
│       │   │   ├── crawlUrl.ts     # orchestrator: robots→ratelimit→ssrf→fetch→parse→analyze→extract
│       │   │   ├── robots.ts       # 4.1 — fetch/cache robots.txt, parse Crawl-delay (via ssrfGuard)
│       │   │   ├── ssrfGuard.ts    # 4.4 — fetch-time resolve + IP-pin + per-redirect (ADR-0005)
│       │   │   ├── fetch.ts        # 4.4 — HTTP fetch: timeout, size cap, manual redirects
│       │   │   ├── parse.ts        # 4.5 — cheerio / headless → normalized DOM handed to plugins
│       │   │   └── extractLinks.ts # 4.5 — resolve, normalize, scope-filter links (M1)
│       │   ├── frontier/           # scheduling subsystem — ratelimit + schedule + counters (ADR-0004)
│       │   │   ├── scheduler.ts    # atomic "next fetchable URL" (Lua) — domain-ready selection
│       │   │   ├── rateLimiter.ts  # 4.3 — per-domain token bucket in Redis
│       │   │   ├── enqueue.ts      # Phase 6 — limit + depth+1 check, calls packages/queue enqueueUrl
│       │   │   └── counters.ts     # atomic job counters (discovered/in-flight/done/failed/delayed)
│       │   ├── plugins/            # plugin HOST: registry + typed AnalyzerPlugin interface
│       │   │   ├── registry.ts     # loads enabled plugins per job config
│       │   │   └── types.ts        # AnalyzerPlugin contract (input: DOM+meta, output: analysis doc)
│       │   ├── completion.ts       # Phase 6 — distributed-termination (reads frontier/counters)
│       │   └── index.ts
│       ├── test/
│       ├── tsconfig.json
│       └── package.json
│
├── plugins/                        # pluggable analyzers — each isolated + independently testable
│   ├── metadata/                   # title, description, canonical, open-graph
│   ├── screenshot/                 # headless capture → packages/storage blob
│   ├── seo/                        # headings, alt-text, sitemap/robots signals
│   ├── security/                   # security headers, mixed content, TLS notes
│   ├── tech-detector/              # framework/CDN/analytics fingerprinting
│   ├── accessibility/              # a11y checks (axe-core rules)
│   └── README.md                   # how to write a plugin (custom-plugin SDK deferred — ADR-0006)
│
├── services/
│   ├── worker/                     # the crawler engine — the horizontally scalable part
│   │   ├── src/
│   │   │   ├── storage/            # Phase 5 wiring — imports packages/db + packages/storage
│   │   │   │   └── pages.ts        # upsert Page via packages/db model (unique index = dedup guard)
│   │   │   ├── scheduler/          # recurring/cron crawls as BullMQ repeatable jobs (NOT a service — ADR-0006)
│   │   │   │   └── recurring.ts
│   │   │   ├── deadletter.ts       # cross-cutting — DLQ for exhausted retries
│   │   │   ├── health.ts           # liveness/readiness signal
│   │   │   ├── shutdown.ts         # SIGTERM: stop pulling, finish current URL, release lock
│   │   │   └── index.ts            # M2 — BullMQ plumbing: pull job → crawler-core, update counters, DLQ
│   │   ├── test/                   # integration tests (real Redis + Mongo + MinIO via testcontainers)
│   │   ├── Dockerfile              # multi-stage; installs a headless browser only if needed
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── api/                        # M2/M3 — Express REST API (stateless, load-balanced)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── jobs.ts         # POST /jobs, GET /jobs/:id, GET /jobs/:id/results
│   │   │   │   ├── jobs.test.ts
│   │   │   │   ├── search.ts       # query results — Mongo text search (ES deferred — ADR-0006)
│   │   │   │   ├── export.ts       # Phase 8 — streamed JSON/CSV export
│   │   │   │   ├── health.ts       # /health for load balancers
│   │   │   │   └── metrics.ts      # /metrics for Prometheus
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts         # uses packages/auth (verify + RBAC) — Phase 1
│   │   │   │   ├── validate.ts     # zod request validation (Phase 1)
│   │   │   │   ├── ssrfPrescreen.ts# Phase 1 — fast reject; NOT the boundary (see crawler-core/ssrfGuard)
│   │   │   │   ├── idempotency.ts  # Phase 1 — optional idempotency key
│   │   │   │   ├── errorHandler.ts # one place all errors funnel through
│   │   │   │   └── rateLimit.ts    # protect the API itself (per-user)
│   │   │   ├── jobService.ts       # Phase 2 — write Job (packages/db) + seed enqueue (packages/queue)
│   │   │   ├── app.ts              # express app assembly (testable, no listen)
│   │   │   └── index.ts            # binds port, starts server
│   │   ├── test/
│   │   ├── Dockerfile
│   │   ├── tsconfig.json
│   │   └── package.json
│   │                               # NOTE: no db/ or auth/ folder — both come from packages/
│   │
│   └── web/                        # M5 — React + Vite dashboard
│       ├── src/
│       │   ├── components/
│       │   ├── pages/              # submit job, job list, job detail (live progress), search
│       │   ├── hooks/              # useJob polling / websocket subscription
│       │   ├── api/                # typed client (type-only imports from packages/shared)
│       │   └── main.tsx
│       ├── test/
│       ├── nginx.conf
│       ├── Dockerfile
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
│
├── infra/                          # M5 — operational config, not app code
│   ├── prometheus/
│   │   └── prometheus.yml          # scrape targets (api, worker)
│   ├── grafana/
│   │   ├── dashboards/             # dashboard JSON, version-controlled
│   │   └── provisioning/           # auto-load dashboards + datasource on startup
│   ├── nginx/
│   │   └── nginx.conf              # reverse proxy / gateway (api + web)
│   └── k8s/                        # prod manifests OR a Helm chart — pick one (Helm deferred — ADR-0006)
│
└── scripts/
    ├── seed.ts                     # kick off a crawl from CLI
    ├── load-test.ts                # multi-domain load test — proves throughput scales with workers
    ├── setup.sh                    # one-command local bootstrap
    └── smoke-test.sh               # sanity-check a running deployment
```

## Why it's laid out this way

- **`packages/` vs `services/` vs `plugins/`.** `packages/` are libraries (no
  `main()`, no ports) that services import; `services/` are the three deployables
  (worker, api, web); `plugins/` are hot-swappable analyzers loaded at runtime per
  job config. Anything two services must agree on lives in a package, so the
  "services never import each other" rule (ADR-0003) holds without duplication.

- **`crawler-core` is a package, not a third home for crawl code.** The pipeline,
  frontier, and plugin host are domain logic the worker *imports*. Keeping them in
  `packages/crawler-core` means the crawl engine is unit-testable without booting
  BullMQ, and the worker service is thin glue.

- **`plugins/` is the extensibility story.** `parse.ts` produces a normalized
  DOM + metadata; the plugin host (`crawler-core/src/plugins`) runs each enabled
  `AnalyzerPlugin` against it and collects analysis docs. Adding SEO/security/a11y
  analysis is "write a plugin," not "edit the pipeline." The public **SDK** is
  deferred until the interface stops changing (ADR-0006).

- **Auth is a package, not a service (ADR-0006).** `packages/auth` gives `api` JWT
  verification + RBAC as a library call, no extra deployable, no network hop. It is
  promoted to a service only when a concrete scaling reason appears.

- **`scheduler` is a worker module, not a service (ADR-0006).** Recurring crawls
  are BullMQ repeatable jobs inside the worker. Same code, one fewer deployable.

- **Shared correctness lives in `packages/db` and `packages/queue`.** The `Page`
  unique index and the atomic dedup-guarded enqueue are correctness contracts both
  services depend on; owning each once means the guarantee cannot drift.

- **`enqueueUrl` is ONE atomic operation.** Dedup-check and queue-add run together
  in a single Lua script so a crash between them can neither lose a URL (SET NX
  without the add) nor duplicate work. The durable `Page.url` unique index is the
  backstop. This is the fix for the "atomic across two Redis ops" gap.

- **SSRF appears in two places, deliberately.** `api/middleware/ssrfPrescreen.ts`
  is the fast submission-time reject; `crawler-core/pipeline/ssrfGuard.ts` is the
  authoritative fetch-time guard (ADR-0005).

- **`packages/shared` stays browser-safe.** `web` imports it type-only; the
  Node-only `urlHash` (`node:crypto`) must not be dragged into the Vite bundle.

- **One search backend now, Elasticsearch later.** `api/routes/search.ts` uses
  Mongo text search; ES is deferred behind an ADR until there is a proven
  search-scale need (ADR-0006).

- **`scripts/load-test.ts` + `docs/benchmarks.md` prove the thesis.** Throughput
  scaling with worker count across a multi-domain seed set is the ADR-0004 payoff.

## Open architectural decision (resolve before M2)

The worker still straddles **two consumption models** and they are an either/or:

- `services/worker/src/index.ts` as *"BullMQ plumbing: pull job → crawler-core"* —
  BullMQ's competing-consumers model, where the broker chooses the next job and
  per-domain politeness is a token-check + delayed re-queue *inside* the pipeline
  (Phase 4.3).
- `crawler-core/src/frontier/scheduler.ts` as *"atomic next-fetchable-URL (Lua)"* —
  the custom-frontier model (ADR-0004), where the scheduler chooses the next URL by
  picking an off-cooldown domain and BullMQ is demoted to durable storage / retry
  bookkeeping.

You cannot fully use both. **Pin this down in ADR-0004** before writing M2 code;
the `index.ts` / `scheduler.ts` split follows from the decision.

## Build-order caveat

This is the **destination**, not a day-one checklist. You are at M1 with a working
single-URL crawler. Create packages/plugins as their milestone arrives:
`packages/queue` + `crawler-core/frontier` + `crawler-core/pipeline` at M2,
`packages/db` + `packages/storage` + `storage/` at M3, the hardening files
(`deadletter`, `completion`, `shutdown`, `rateLimiter`, `ssrfGuard`) at M4, and
`services/web` + `plugins/*` + `infra/` + `packages/metrics` at M5. Deferred pieces
(Elasticsearch, notification-service, custom-plugin SDK, Helm) stay as ADR-recorded
"not yet"s. The shared-package split is the one thing worth designing in from the
first line of M2 code, because retrofitting it later is the painful path.
