# 2. BullMQ + Redis over Kafka for the work queue

Date: 2026-07-05

## Status

Accepted

## Context

The crawler is a work-queue system: URLs are produced (seed enqueue in the API,
child-link enqueue in the worker) and consumed by a pool of stateless workers that
must scale horizontally. The queue is the spine of the design — everything about
throughput and fault tolerance runs through it. Its required properties:

- **Competing consumers** — a URL is delivered to exactly one worker; adding
  workers increases throughput.
- **At-least-once delivery with lock/lease recovery** — if a worker dies
  mid-URL, the job returns to the queue and another worker picks it up (this is the
  mechanism behind [ADR-0003](0003-stateless-workers.md)'s "kill a worker and
  nothing is lost").
- **Per-job retries with exponential backoff and a dead-letter path** for URLs
  that fail every attempt.
- **Delayed / scheduled jobs** — the delayed re-queue that enforces per-domain
  politeness (workflow.md Phase 4.3) and recurring/cron crawls need native delay
  support.
- **Shared infrastructure with the rest of the system** — we already need Redis
  for dedup, the per-domain frontier, rate-limit token buckets, and the atomic job
  counters. A queue that lives in the *same* Redis keeps coordination and work in
  one place.

We are a single team at portfolio-to-moderate scale (thousands–millions of URLs
per crawl), not a firehose of millions of events per second across many teams.

## Decision

Use **BullMQ on Redis** as the queue.

- **Competing-consumers + lock lease** are first-class in BullMQ: `lockDuration`,
  lock renewal while processing, and a stalled-job checker that returns crashed
  jobs to the waiting state. This gives us the fault-tolerance story directly.
- **Retries + backoff + dead-letter** are built in (`attempts`, `backoff`, the
  failed set), so the retry machinery in workflow.md is configuration, not code we
  write.
- **Delayed jobs** are native — the same primitive powers per-domain politeness
  re-queues and the recurring-crawl scheduler module.
- **One Redis** already backs dedup, frontier, rate limiting, and counters
  (ADR-0004). Putting the queue there too means the enqueue primitive can fuse the
  dedup check and the queue add into a single atomic Lua operation
  (`packages/queue/enqueueUrl.ts`) — impossible if the dedup set and the queue
  lived in different systems.

## Consequences

### Positive

- Fault tolerance, retries, DLQ, and delayed jobs come from the library, not from
  us.
- Atomic **dedup-fused-with-enqueue** because both live in the same Redis.
- One fewer piece of heavy infrastructure to run, secure, and monitor.
- Excellent TypeScript ergonomics and a small operational surface — fits the
  single-team, modular-monolith posture (ADR-0006).

### Negative / tradeoffs

- **Redis is memory-bound**, so the frontier must be bounded (backpressure via
  high/low watermarks, workflow.md Phase 3) or a huge crawl could exhaust memory.
  Kafka's disk-backed log would not have this ceiling.
- **No long-term event retention / replay** the way Kafka offers. We do not need an
  immutable event log — completed work is a Mongo record, not a replayable stream —
  but if that requirement appeared, this decision would be revisited.
- **Throughput ceiling** far below Kafka's. Acceptable: the real ceiling on a
  crawl is per-domain politeness, not queue bandwidth (ADR-0004).
- Redis becomes a critical single dependency for both work and coordination;
  mitigated with managed Redis / replication in production.

## Alternatives considered

- **Apache Kafka** — the right tool for high-throughput, multi-team, replayable
  event streaming. Rejected here: it is operationally heavy (brokers, ZooKeeper/
  KRaft, partition management), it is a *log* rather than a work queue (competing
  consumers, per-message retries, and delayed messages are awkward or bolt-on),
  and — decisively — it cannot share Redis with the dedup/frontier/counter state,
  so we would lose the atomic dedup-fused-enqueue. Partitioning-by-domain would
  solve politeness but at a cost far exceeding the problem's scale. This ADR does
  not reopen if a genuine streaming/replay need emerges later.
- **RabbitMQ / SQS** — competent queues, but each is another external system that
  does *not* co-locate with the Redis coordination state; same "can't fuse dedup
  and enqueue" objection, with less TypeScript-native ergonomics than BullMQ.
- **A hand-rolled Redis list queue** — rejected: we would reimplement lock leases,
  stalled-job recovery, retries, and delays that BullMQ already provides correctly.
