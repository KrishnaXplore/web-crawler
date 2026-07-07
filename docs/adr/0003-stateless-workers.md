# 3. Stateless workers

Date: 2026-07-05

## Status

Accepted

## Context

The headline requirement of the whole system is that **the crawl scales
horizontally**: adding worker replicas increases throughput, and losing a worker
loses no work. Whether that is achievable is decided entirely by *where crawl state
lives.*

A crawl has real state: which URLs have been seen (dedup), which URLs remain to
fetch (the frontier), how many are in-flight/done/failed (counters for completion
detection), and how recently each domain was hit (rate-limit tokens). If any of
that state lives **inside a worker process**, then:

- workers are not interchangeable (a URL can only be processed by the worker that
  holds the relevant state),
- a worker crash loses the state it held (the frontier it owned, the dedup set it
  accumulated), and
- scaling out requires partitioning and rebalancing that state across workers — a
  hard distributed-systems problem we would be signing up to solve.

That is the opposite of the goal. So the question is not "should workers be
stateless?" but "where does the shared state live instead?"

## Decision

**Workers hold no state that another worker needs.** A worker is a pure function of
the URL job it claims plus the shared stores:

- **Coordination state lives in Redis** — the queue, the dedup set, the per-domain
  frontier, rate-limit token buckets, and the atomic job counters
  ([ADR-0002](0002-bullmq-over-kafka.md), [ADR-0004](0004-frontier-per-domain-scheduling.md)).
- **Durable results live in MongoDB / MinIO** — page documents and blobs
  ([ADR-0001](0001-mongodb-for-pages.md)).
- **A worker's only in-process state is the URL it is currently crawling**, held
  for the duration of one pipeline run and nothing longer.

Consequences of statelessness that we adopt as design rules:

- **Any worker can process any URL.** The queue hands work to whichever worker is
  free; there is no affinity.
- **Crash recovery is automatic.** A dead worker's lock expires and the URL returns
  to the queue (BullMQ stalled-job recovery); no state reconstruction is needed
  because the worker held none.
- **Graceful shutdown** on `SIGTERM`: stop pulling new jobs, finish the current
  URL, release the lock, exit — so a deploy or scale-down never drops in-flight
  work.
- **Scaling is `replicas: N`.** No rebalancing, no sticky routing, no coordinator.

## Consequences

### Positive

- **Horizontal scaling is trivial** — the core project thesis, demonstrated by
  `scripts/load-test.ts` scaling throughput with worker count across a
  multi-domain seed set.
- **Fault tolerance is free** — every worker is disposable; crashes and deploys are
  non-events.
- Workers can run anywhere (autoscaled pods, spot instances) because losing one
  costs at most one in-flight URL, which the queue recovers.
- Simple deploys (rolling restart) with no coordinated state handoff.

### Negative / tradeoffs

- **Every coordination decision is a network round-trip to Redis** (dedup check,
  token acquire, counter update, next job). This is the price of not holding state
  locally; we pay it deliberately and keep those operations atomic and cheap
  (single Lua ops), because the alternative — local state — forfeits the scaling
  goal.
- **Redis is now load-bearing for correctness**, not just speed. Its availability
  and the atomicity of its operations are the system's backbone. Mitigated with
  managed/replicated Redis and by keeping coordination ops small.
- **No in-worker caching of cross-URL state** (e.g. a shared robots cache) beyond
  what is safe to recompute or store in Redis. Per-origin robots.txt is cached in
  Redis with a TTL, not in worker memory, so all workers share it.

## Alternatives considered

- **Stateful/sharded workers** (each owns a slice of the URL space, e.g. by domain
  hash) — would reduce Redis chatter and localize per-domain politeness, but
  reintroduces partitioning, rebalancing on scale events, and state loss on crash.
  Rejected: it trades the entire simplicity-and-resilience win for a throughput
  optimization we do not need at this scale.
- **A single coordinator process** dispatching to dumb workers — rejected: the
  coordinator becomes a bottleneck and a single point of failure, and we already
  get dispatch from the queue for free.
- **In-memory frontier per worker** — rejected explicitly: a worker restart would
  lose its frontier and dedup state, violating the "nothing is lost" guarantee.
