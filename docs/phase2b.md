# Phase 2 Step B (Milestone M2) — Distributed: Queue + Worker + Dedup

> **Naming note.** "Phase 2" = milestone **M2**. Step A ([phase2.md](phase2.md))
> built a single-process crawler. Step B makes it **distributed**. Not related to
> workflow.md's numbered phases.

Step A's CLI held the frontier and the visited-set **in memory** — kill it and the
crawl is gone, and it can't scale past one process. Step B moves that coordination
state into **Redis** and turns crawling into **stateless workers pulling from a
BullMQ queue**. This is where the design's actual thesis — *add workers, get more
throughput; lose a worker, lose nothing* (ADR-0003) — starts to be real.

---

## What Step B delivers

| Piece | Where | Responsibility |
|---|---|---|
| Redis | `docker-compose.yml` | The shared store: queue, dedup set, job config, counters. |
| `@crawler/config` | `packages/config` | Parse + validate env (Redis URL, concurrency, UA) once, via zod. |
| `@crawler/queue` | `packages/queue` | The BullMQ connection, the job-payload contract, and the **dedup-guarded enqueue primitive** shared by seeder and worker. |
| `worker` | `services/worker` | The stateless consumer: claim a URL → crawl → enqueue children (deduped) → repeat. Run N of them. |
| `scripts/seed.ts` | root | Kick off a job: write its config to Redis and enqueue the seed URL. |

**Deferred (later milestones):** MongoDB persistence + the durable unique index
(M3); per-domain rate limiting, retries/DLQ, graceful shutdown, and true
completion detection (M4); SSRF guard (M4). Step B stores job config/counters in
Redis as an interim home until Mongo arrives.

---

## How it runs

```
scripts/seed.ts ──► SADD seen:{job}  +  queue.add       (dedup-guarded enqueue)
                          │
                    ┌─────▼──────────── Redis (BullMQ "crawl" queue) ───────────┐
                    │  competing consumers                                       │
   worker #1 ◄──────┤  each pulls a URL job, locks it (lease)                    ├──► worker #2, #3 …
        │           └────────────────────────────────────────────────────────────┘
        ▼
   crawlUrl (M1/A: robots → fetch → parse → extract)
        │
        └─► for each discovered link: enqueueUrl() → SADD seen? new? → queue.add (depth+1)
```

The loop is the same crawl logic from Step A — but the frontier is now the Redis
queue and dedup is a Redis set, so **any number of workers** share one crawl, and a
crashed worker's in-flight URL is redelivered by BullMQ's lock expiry.

---

## Design decisions

### Scheduling model — BullMQ-first competing consumers (ADR-0004, amended)

**Chosen:** plain BullMQ competing consumers. The broker hands each free worker the
next URL; there is **no custom scheduler**.

**Why:** this is the resolved default from the ADR-0004 amendment — build the simple
version first. The custom Lua "next-fetchable-URL" frontier scheduler is a deferred
optimization we adopt only if benchmarks show hot-domain skew wastes worker time.
Per-domain politeness in this model is a token-check + delayed re-queue, which lands
with rate limiting in **M4**; Step B keeps politeness minimal (bounded concurrency +
a small delay).

| Alternative | Why not now |
|---|---|
| **Custom Lua frontier scheduler** | The ADR-0004 optimization. Real complexity (atomicity, fairness, visibility timeouts we'd own). Deferred until numbers justify it. |

### Dedup — a Redis set (`SADD`), guarding the enqueue

**Chosen:** `enqueueUrl()` does `SADD seen:{jobId} <normalizedUrl>` first; only if the
member is **new** (SADD returns 1) does it `queue.add`. Dedup happens at
**discovery/enqueue** time (ADR-0004), so a URL enters the queue at most once.

**Why `SADD`:** it's a single atomic op that both records "seen" and tells us whether
it was new — exactly the primitive we need, and exact (no false positives). Fusing it
with the enqueue keeps dedup owned in one place (`packages/queue`), shared by the
seeder and the worker.

**Honest atomicity caveat.** `SADD` then `queue.add` are two operations. If a worker
crashes *between* them, the URL is marked seen but never enqueued — a lost page. At
M2 we accept this narrow window; **M3's MongoDB unique index is the durable backstop**
and completion/DLQ tooling (M4) surfaces gaps. A fully-atomic single-op version
(Lua bundling dedup + push) is the same tradeoff ADR-0004 discusses; not worth the
hand-rolled queue at this step.

| Alternative | Why not |
|---|---|
| **BullMQ `jobId` dedup only** | BullMQ refuses a duplicate `jobId` *while the job exists*, but once it completes and is removed, the same URL could re-enter. We need "seen for the job's lifetime," which the set gives. (We *also* set `jobId` for in-flight safety.) |
| **Bloom filter** | Memory-efficient at massive scale, but probabilistic (false positives skip real pages). Overkill now; a scale-time swap. |
| **Dedup at fetch time** | The M1-era mistake: a transient fetch failure would permanently mark a URL seen. Rejected in ADR-0004. |

### Redis client — ioredis

**Chosen:** ioredis (required by BullMQ).

**Why:** BullMQ is built on ioredis and needs its connection semantics
(`maxRetriesPerRequest: null` for blocking ops). No real choice here, and it's a
capable client for our own `SADD`/counter ops too.

### Interim state home — Redis (job config + counters), not Mongo yet

**Chosen:** store each job's config (`maxDepth`, `maxPages`, `sameHostOnly`,
`respectRobots`) and a `pages` counter in Redis for now.

**Why:** M3 owns MongoDB. Blocking Step B on Mongo would mean standing up two
datastores at once. Redis already holds the queue and dedup, so parking job config +
counters there keeps Step B to a single new dependency. When M3 lands, the job record
moves to Mongo (the queue/dedup stay in Redis).

### Running multiple workers

`worker` is a plain Node process. "Scale out" = run it more than once
(`concurrency` within a process for I/O parallelism, and/or multiple processes /
`docker compose up --scale`). Because workers are stateless, N of them just share the
Redis queue — no coordination, no config change. This is the ADR-0003 payoff made
tangible.

---

## What's tested

- **`enqueueUrl`** — unit-tested against a real Redis (via the compose service):
  first enqueue returns `true` and adds a job; the duplicate returns `false` and adds
  nothing. (Guarded to skip if Redis isn't reachable, so the pure suite still runs
  offline.)
- **The worker loop** — validated **end-to-end**: `docker compose up redis`, run a
  worker, `pnpm seed <url>`, watch it drain the queue and spread the crawl, then
  confirm the same URL is never processed twice.

## Exit criteria for Step B

- `docker compose up -d redis` brings Redis up.
- `pnpm seed <url> …` enqueues a job and prints its id.
- One or more `worker` processes drain the queue, crawl breadth-first within
  depth/page bounds, and **dedup holds** (no URL processed twice).
- Killing a worker mid-crawl loses no URLs (BullMQ redelivers) — the fault-tolerance
  demo.

Then **M3** (`phase3.md`): persist pages to MongoDB + the durable unique index, and
move job records off Redis.
