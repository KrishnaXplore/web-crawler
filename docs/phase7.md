# Phase 7 (Milestone M7) — Prove It & Ship It

> Milestone **M7** — no new crawl features. This milestone converts claims into
> evidence and code into shippable artifacts: the four highest-signal items from
> [gap-analysis.md](gap-analysis.md) Tiers 0–1. CI/CD is deliberately **out of scope**
> (deferred by decision, not oversight).

- **Step A — LICENSE**: MIT at the repo root.
- **Step B — `packages/logger`**: pino structured logging; retire `console.*` from services.
- **Step C — Dockerfiles + compose app profile**: the services become shippable images.
- **Step D — Load test + benchmarks**: prove the horizontal-scaling thesis with numbers.

---

## Step A — LICENSE (MIT)

The repo is public with no license — legally "all rights reserved", so nobody may
use, copy, or learn from it. MIT is the obvious choice for a portfolio project:
maximally permissive, universally understood, zero friction for a reviewer.

| Decision | Alternative | Why |
|---|---|---|
| MIT | Apache-2.0 | Apache adds a patent grant + NOTICE mechanics that buy nothing for a portfolio repo; MIT is shorter and just as recognized. |

## Step B — `packages/logger` (pino)

The HLD (§9) promised structured logs with `jobId`+`url` on every line; the code has
38 bare `console.*` calls. In production, logs are *data* — they get shipped,
filtered by job, correlated across N workers. `console.log` strings can't do that.

**Design.** A thin package: `createLogger(name)` returns a pino instance —
JSON to stdout, level from `LOG_LEVEL` (default `info`), secrets redacted by path.
Services bind context once (`log.child({ jobId })`) so every subsequent line carries
it. The **api** and **worker** migrate; **scripts keep `console`** — they are CLIs
whose stdout *is* the user interface, not log streams.

| Decision | Alternative | Why |
|---|---|---|
| pino | winston | pino is the Node-standard structured logger: faster, JSON-first, tiny API; the HLD names it. |
| JSON to stdout only | file transports, log rotation | Twelve-factor: the process writes to stdout; shipping/rotation is the platform's job (Docker/k8s), not the app's. |
| Scripts keep console | migrate everything | A CLI's printed table is product output, not telemetry. Blanket rules that ignore intent produce worse tools. |

## Step C — Dockerfiles + compose `app` profile

Three services exist but nothing can ship them: no images, and compose only runs the
backing stores. After this step `docker compose --profile app up` runs the **entire
product** — infra + api + worker + dashboard — from a clean checkout.

**Design.**
- **api / worker**: one multi-stage Dockerfile each — `pnpm install` against the
  workspace, `pnpm -r build`, then a slim runtime layer running compiled JS
  (`node dist/index.js`) as a **non-root user**. No tsx/TypeScript in the runtime
  image.
- **web**: build stage runs `vite build`; runtime is **nginx** serving the static
  bundle and proxying `/api/*` → the api container — the exact same shape as the dev
  proxy and the production topology in [architecture-v2.md](architecture-v2.md), so
  no CORS anywhere.
- **compose**: services join under a `--profile app` flag so plain
  `docker compose up` still starts infra only (the local-dev workflow is unchanged).
  In-network env overrides point at service names (`redis:6379`, `mongo:27017`,
  `minio:9000`).
- `.dockerignore` excludes `node_modules`, `dist`, `.env`, `.git` — builds are
  reproducible from source, local state can't leak into images.

| Decision | Alternative | Why |
|---|---|---|
| Compiled JS in runtime image | run tsx in container | Runtime images shouldn't carry a TS toolchain; smaller, faster boot, matches how the code actually deploys. |
| nginx for web + `/api` proxy | serve static from Express / enable CORS | Matches the documented production topology; keeps the API's origin posture intact. |
| Compose profile | separate compose file | One file, one network, no drift between dev-infra and full-app definitions. |

## Step D — Load test + `docs/benchmarks.md`

The README's headline claim — *"adding worker replicas increases throughput"* — is
unproven. The HLD explicitly calls for a **multi-domain** load test because a
single-domain crawl is (correctly) politeness-capped: per-domain rate limiting means
one domain can never demonstrate scaling, no matter how many workers exist.

**Design.** `scripts/load-test.ts` submits a fixed multi-domain seed set (the
`*.toscrape.com` scraping sandboxes — sites built for exactly this — plus a page-cap
per job), waits for completion via the jobs API, and reports wall-clock time and
pages/sec. The operator runs it twice: once with **1 worker**, once with **4
workers** (same seed set, cleaned state between runs). `docs/benchmarks.md` records
machine, method, numbers, and the honest caveats (residential network, small-N, the
politeness ceiling).

| Decision | Alternative | Why |
|---|---|---|
| Crawl real public sandbox sites | local mock HTTP server | The SSRF guard blocks loopback/private targets **by design** — a local target would mean weakening the guard for tests, exactly backwards. toscrape.com exists to be scraped. |
| Script measures via the public API | instrument worker internals | The benchmark should exercise the system the way users do; jobs API counts are the same counters completion detection uses. |
| Modest page caps (hundreds) | crawl thousands | Enough pages for a stable rate without hammering a free community sandbox. |

## What's verified / exit criteria

- **A**: LICENSE renders on the GitHub repo page.
- **B**: `pnpm -r build && pnpm -r test` green; zero `console.*` left in
  `services/api` + `services/worker`; worker logs are JSON lines carrying `jobId`.
- **C**: all three images build; `docker compose --profile app up` serves the
  dashboard on nginx, which proxies to the api, which enqueues to the shared Redis;
  a crawl submitted through the containerized stack completes.
- **D**: `benchmarks.md` contains real measured numbers for 1 vs 4 workers on the
  same seed set, showing a clear (if sub-linear) throughput increase.
