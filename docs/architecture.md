# Architecture (High-Level Design)

This is the system overview: what the pieces are, how a crawl flows through them,
why the boundaries fall where they do, and how the design scales and stays
correct under failure. It is the **HLD** — the module-level detail lives in
[project-structure.md](project-structure.md) (LLD), the runtime lifecycle in
[workflow.md](workflow.md), and each load-bearing decision in an
[ADR](adr/).

---

## 1. What it is

A **distributed web-intelligence platform**: users submit a seed URL and a scope
(depth, page cap, render mode, which analyzers to run); the system crawls the
site politely, extracts links to spread the crawl, runs pluggable analyzers over
each page, stores metadata and blobs, and streams the results back — with live
progress and full observability throughout.

The design goal that shapes everything: **the crawl must scale horizontally**.
Adding worker replicas increases throughput; no worker holds state another needs.
Every other decision (external queue, stateless workers, shared-correctness
packages, per-domain scheduling) follows from that goal.

---

## 2. Components at a glance

```
                        ┌───────────────┐
                        │   Browser     │
                        │ (React + Vite)│
                        └───────┬───────┘
                                │  HTTPS
                        ┌───────▼───────┐
                        │  nginx / LB   │
                        └───────┬───────┘
                                │
                        ┌───────▼───────────────────────┐
                        │        api  (Express)          │
                        │  auth · validate · SSRF pre-   │
                        │  screen · jobs · search ·      │
                        │  export · /metrics · /health   │
                        └───┬───────────────────┬────────┘
                writes job  │                   │ enqueue seed (dedup-guarded)
                            ▼                   ▼
                    ┌──────────────┐    ┌───────────────────┐
                    │   MongoDB    │    │  Redis + BullMQ    │
                    │ jobs · pages │    │  queue · frontier  │
                    │ (unique idx) │    │  dedup · counters  │
                    └──────▲───────┘    └─────┬────────▲─────┘
                  upsert   │                  │ claim  │ enqueue children
                  page     │                  ▼        │ (depth+1)
                    ┌───────┴──────────────────────────┴──────────┐
                    │        worker  ×N   (stateless)              │
                    │  ┌────────────────────────────────────────┐ │
                    │  │  crawler-core (library)                 │ │
                    │  │  pipeline: robots→ratelimit→ssrf→fetch  │ │
                    │  │           →parse→analyze→extract        │ │
                    │  │  frontier: schedule · ratelimit ·       │ │
                    │  │            counters · completion        │ │
                    │  │  plugins host → [metadata][seo][sec]... │ │
                    │  └────────────────────────────────────────┘ │
                    └───────────────┬──────────────────────────────┘
                          blobs     │
                          (HTML,    ▼
                          shots)  ┌──────────┐
                                  │  MinIO   │
                                  │  (S3)    │
                                  └──────────┘

   Observability (scrapes /metrics on api + worker):
        Prometheus ──► Grafana         structured logs (pino, jobId+url)
```

**Three deployable services** ([ADR-0006](adr/0006-modular-monolith-of-services.md)):

| Service | Responsibility | Scales on |
|---|---|---|
| `web` | React dashboard: submit jobs, watch live progress, search, export | static / CDN |
| `api` | REST edge: auth, validation, SSRF pre-screen, job CRUD, search, export, health/metrics | request volume |
| `worker` | The crawl engine: claims URLs, runs the pipeline + plugins, persists results, spreads the crawl | **crawl throughput** |

Everything else the design needs is a **package** (imported) or a **module**
(in-process), not a service — auth, scheduler, and notifications included. See
ADR-0006 for why.

**Backing stores:**

- **MongoDB** — job records and page metadata; the `Page.url` unique index is the
  durable dedup backstop ([ADR-0001](adr/0001-mongodb-for-pages.md)).
- **Redis + BullMQ** — the work queue, the per-domain frontier, the dedup set, and
  the atomic job counters ([ADR-0002](adr/0002-bullmq-over-kafka.md),
  [ADR-0004](adr/0004-frontier-per-domain-scheduling.md)).
- **MinIO (S3-compatible)** — large blobs (raw HTML, screenshots) keyed by content
  hash; Mongo stores only the object key.

---

## 3. How a crawl flows

The full lifecycle with failure paths is in [workflow.md](workflow.md); here is the
shape of it.

```
submit ─► api validates (auth, zod, SSRF pre-screen) ─► writes Job(pending) to Mongo
       └► dedup-guarded enqueue of seed URL(s) to Redis ─► 202 Accepted (job id)

                        ┌─────────────────────────────────────────────┐
                        │  worker claims a URL job (BullMQ lock/lease)  │
                        └───────────────────────┬─────────────────────┘
                                                ▼
   robots.txt gate ─► per-domain rate limit ─► FETCH (SSRF guard: resolve+pin+per-hop)
        │ (skip)            │ (no token:                    │ (timeout/5xx:
        ▼                   ▼  requeue w/ delay)            ▼  retry → DLQ)
    done-skip           back to queue                  parse ─► run plugins ─► extract links
                                                            │                       │
                                          upsert Page + blobs (Mongo + MinIO)       ▼
                                                            │        dedup + scope check each link
                                                            │                       │
                                                            └──── enqueue new links (depth+1) ◄┘
                                                                        │
                                                    (loop until frontier + in-flight = 0)
                                                                        ▼
                                                        completion.ts marks Job(completed)
```

Three things in that loop are the hard parts, and each has an ADR or a workflow
section behind it:

1. **Politeness without starvation** — per-domain scheduling so a rate-limited
   domain never blocks a worker that could fetch a different one
   ([ADR-0004](adr/0004-frontier-per-domain-scheduling.md)).
2. **SSRF safety** — the fetch-time, IP-pinned, per-redirect guard, because a
   crawler is an SSRF weapon if the guard is only at submission
   ([ADR-0005](adr/0005-ssrf-defense.md)).
3. **Knowing when it's done** — distributed-termination detection via atomic
   counters, with the enqueue-before-decrement ordering invariant
   ([workflow.md §6](workflow.md)).

---

## 4. The scaling model

```
   1 worker            4 workers                 12 workers
   ▲ throughput        ▲                         ▲
   │   ▁               │   ▁▁▁▁                   │   ▁▁▁▁▁▁▁▁▁▁▁▁
   └──────►            └──────►                   └──────►
   (bounded by a single       (throughput rises with replicas —
    domain's crawl-delay)      until domain-mix politeness caps it)
```

- **Workers are stateless** ([ADR-0003](adr/0003-stateless-workers.md)). Any worker
  can process any URL; state lives in Redis (frontier, counters, dedup, rate-limit
  tokens) and Mongo (results). So throughput scales by adding replicas.
- **The queue absorbs bursts.** The API returns in milliseconds; crawl work is
  drained asynchronously by however many workers exist. A bounded frontier applies
  backpressure so Redis memory stays bounded.
- **The ceiling is politeness, not architecture.** A crawl dominated by one domain
  is correctly throttled by that domain's crawl-delay — no number of workers
  helps, and that is the *right* behavior. This is why the load test
  (`scripts/load-test.ts`, results in `docs/benchmarks.md`) uses a **multi-domain**
  seed set to demonstrate real scaling.

---

## 5. Fault tolerance

The system assumes any component can die at any time.

| Failure | What happens | Mechanism |
|---|---|---|
| Worker crashes mid-URL | Its lock expires; the job returns to the queue; another worker picks it up | BullMQ stalled-job / lock lease (Phase 3) |
| Worker gets SIGTERM (deploy) | Stops pulling new jobs, finishes the current URL, releases the lock, exits | `shutdown.ts` graceful drain |
| Fetch times out / 5xx | Retried with exponential backoff; survives all attempts → dead-letter queue | BullMQ retries + `deadletter.ts` |
| API dies between DB write and enqueue | Job never left `pending` orphaned: replay-safe enqueue + dedup, or transactional outbox | Phase 2 |
| Duplicate URL across workers (race) | Fast Redis dedup catches most; `Page.url` unique index catches the rest | ADR-0004, ADR-0001 |
| Redis/Mongo restart | Connections retry with backoff; workers idle until stores return | connection layers in `packages/*` |

The invariant: **no acknowledged work is silently lost.** A URL is either
completed, retrying, dead-lettered (and inspectable), or still in the frontier —
never dropped.

---

## 6. Correctness boundaries (why the packages exist)

Some guarantees must hold identically in more than one service, so they are owned
**once** in a package and imported — they cannot drift:

- **`packages/db`** — the `Page` schema and its unique index. The `api` reads jobs,
  the `worker` upserts pages; both see the *same* index definition, so the durable
  dedup guard is one source of truth.
- **`packages/queue`** — the dedup-guarded enqueue primitive. Seed enqueue (api,
  Phase 2) and child enqueue (worker, Phase 6) call the *same* atomic operation
  (dedup-check + queue-add fused in one Lua script), so a crash can neither lose
  nor duplicate a URL.
- **`packages/auth`, `config`, `logger`, `metrics`, `storage`** — shared edge
  behavior (token verification, env validation, log shape, metric names, blob
  access) defined once.
- **`packages/crawler-core`** — the crawl domain logic (pipeline + frontier +
  plugin host), testable without booting BullMQ; the `worker` service is thin glue
  around it.

This is the concrete meaning of "services never import each other" (ADR-0003):
anything two services must agree on is a package, not a copy.

---

## 7. Extensibility: the plugin model

Analysis is not baked into the pipeline. `parse.ts` produces a normalized DOM +
page metadata; the **plugin host** (`crawler-core/src/plugins`) runs each enabled
`AnalyzerPlugin` against it and collects analysis documents.

```
   page DOM + metadata
          │
          ▼
   ┌─────────────┐   for each plugin enabled in the job config:
   │ plugin host │──►[ metadata ][ seo ][ security ][ tech-detector ][ a11y ][ screenshot ]
   └─────────────┘        │        │        │             │            │          │
          │               └────────┴────────┴─────────────┴────────────┴──────────┘
          ▼                                    analysis docs
   persist (Mongo metadata + MinIO blobs)
```

Adding a capability is "write a plugin," not "edit the pipeline." The plugins are
independently testable and selected per job. The public plugin **SDK** is
deferred until the internal interface stabilizes (ADR-0006) — the interface earns
a versioned contract only once it stops changing.

---

## 8. Security posture

- **Edge:** JWT + RBAC (`packages/auth`), zod validation, per-user API rate
  limiting — all in `api` middleware (Phase 1).
- **SSRF (the crawler-specific threat):** authoritative guard at *fetch* time —
  resolve the host now, pin the connection to the validated IP, re-check every
  redirect hop, reject private/link-local/loopback and the cloud metadata endpoint.
  The submission-time check is a fast pre-screen, not the boundary
  ([ADR-0005](adr/0005-ssrf-defense.md)). An egress network policy is recommended
  defense-in-depth.
- **Politeness / abuse:** per-domain rate limiting protects target sites; honest
  User-Agent; robots.txt respected by default.
- **Secrets:** environment variables only, validated once at boot by
  `packages/config`; the app refuses to start on a missing/invalid var.

---

## 9. Observability

Not a phase — it runs continuously alongside the crawl.

- **Metrics** (`prom-client` via `packages/metrics`): pages/sec, fetch latency,
  queue depth, active workers, success rate, retry count, DLQ size. Prometheus
  scrapes `/metrics` on api + worker; Grafana dashboards are version-controlled in
  `infra/grafana`.
- **Logs** (`pino` via `packages/logger`): structured, every line carries `jobId`
  and `url` so one crawl is traceable across workers. No bare `console.log`.
- **Health:** `/health` liveness + readiness on every service so the orchestrator
  knows whether to route traffic or restart.
- **Progress:** the dashboard renders from the *same* atomic counters that drive
  completion detection — one source of truth for "how far along is this crawl."

---

## 10. Key decisions (ADR index)

| ADR | Decision |
|---|---|
| [0001](adr/0001-mongodb-for-pages.md) | MongoDB for page storage |
| [0002](adr/0002-bullmq-over-kafka.md) | BullMQ + Redis over Kafka for the queue |
| [0003](adr/0003-stateless-workers.md) | Stateless workers (the scaling thesis) |
| [0004](adr/0004-frontier-per-domain-scheduling.md) | Frontier: dedup + rate-limit + scheduling as one subsystem |
| [0005](adr/0005-ssrf-defense.md) | SSRF defense: fetch-time, IP-pinned, per-redirect |
| [0006](adr/0006-modular-monolith-of-services.md) | Three services, not microservice sprawl |

**One decision still open** (resolve before M2): whether the worker consumes via
BullMQ's competing-consumers model or drives the custom frontier scheduler
(ADR-0004). The choice determines whether the rate limiter is a gate the scheduler
consults or a re-queue valve the pipeline trips. See
[project-structure.md → Open architectural decision](project-structure.md).

---

## 11. Milestone view

```
 M1 ─ single-URL crawl (fetch·parse·extract·normalize·robots)   ── DONE
 M2 ─ queue + stateless worker loop + discovery-time dedup       ── the spine
 M3 ─ MongoDB persistence + indexes + blob storage
 M4 ─ hardening: per-domain rate limit, SSRF guard, retries+DLQ,
      graceful shutdown, completion detection
 M5 ─ dashboard, auth, plugins, metrics/monitoring, search, export
```

The bones (stateless workers, external queue, metadata/blob split, shared
packages) are in place from M2 onward; everything after is hardening the happy
path against the failure paths.
