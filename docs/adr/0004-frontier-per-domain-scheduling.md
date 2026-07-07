# 4. The frontier: per-domain scheduling, politeness, and dedup as one subsystem

Date: 2026-07-05

## Status

Accepted — **with one part amended (2026-07-06).**

The *dedup-at-enqueue* and *per-domain rate-limiting* decisions in this ADR stand
and are the design across the docs. The **custom Lua "next-fetchable-URL"
scheduler**, however, is **no longer the default consumption model.** The resolved
default is **BullMQ-first**: workers are competing consumers, and per-domain
politeness is enforced by a token check plus a delayed re-queue (see
[workflow.md → Phase 4.3](../workflow.md)). The Lua frontier scheduler described in
"Decision" step 4 below is retained as an **optional optimization**, to be adopted
only if `benchmarks.md` shows the delayed-requeue approach wastes meaningful worker
time on hot-domain skew.

Rationale for the amendment: hand-writing a distributed scheduler in Redis Lua is
significant complexity and a real source of subtle bugs (atomicity edge cases,
fairness, visibility timeouts we would own instead of BullMQ). The starvation
problem this ADR was written to avoid is genuine, but the *simplest* fix —
delayed re-queue — solves it acceptably for the expected scale; the scheduler is
the earned-not-assumed optimization. Build the simple version first.

Read the "Decision" section below with that in mind: steps 1–3 and 5 are the
default design; **step 4 (the scheduler loop) is the deferred optimization path**,
not day-one work.

## Context

The core of a crawler is not fetching a page — it is deciding *which URL to fetch
next*. That decision is governed by three concerns that are usually treated as
separate files but are actually one subsystem:

1. **Deduplication** — never enqueue or fetch the same URL twice.
2. **Politeness / rate limiting** — never hit a single domain faster than its
   `robots.txt` crawl-delay (or our default) allows.
3. **Scheduling** — pick the next *fetchable* URL, i.e. one that is both new and
   whose domain is not currently rate-limited.

Our first instinct was a single global BullMQ queue plus a Redis "seen?" set
(`dedup.ts`) and a per-domain `rateLimiter.ts` consulted at fetch time. That
design has a fatal coupling problem:

> With one global queue, a worker pops the next URL, discovers its domain is
> rate-limited, and must either **block** (starving the worker while other
> domains have fetchable work) or **re-enqueue** the URL (busy-looping the queue,
> burning Redis ops, and destroying FIFO fairness).

Under a real crawl the queue fills with URLs from a handful of large domains.
Workers spend their time popping URLs they are not allowed to fetch yet. Effective
throughput collapses toward the rate limit of the *slowest* hot domain, no matter
how many workers we add — which directly defeats ADR-0003 (stateless, horizontally
scalable workers).

So dedup, politeness, and scheduling cannot be three independent files. They are
one design decision.

## Decision

We model the frontier as **per-domain queues fronted by a domain-ready scheduler**,
with dedup enforced at enqueue time and politeness enforced at schedule time.

### 1. Dedup at enqueue time (not fetch time)

Before a URL enters the frontier, `dedup.ts` runs an atomic Redis check:

```
SET dedup:{jobId}:{urlHash} 1 NX
```

`NX` makes it a single atomic round-trip: if the key already existed, the URL is a
duplicate and is dropped. `urlHash` is computed from the **normalized** URL
(`packages/shared/normalize.ts`) so `http://a.com/`, `http://a.com`, and
`http://A.com/#frag` collapse to one entry. Dedup keys are namespaced per `jobId`
and given a TTL tied to the job's lifetime so completed jobs self-clean.

This guarantees a URL is enqueued at most once, so the scheduler never wastes
cycles on duplicates.

### 2. One queue *per domain*, not one global queue

The frontier is a Redis sorted set (or BullMQ queue) **per domain**:

```
frontier:{jobId}:{domain}   # ZADD score = priority (depth, then discovery order)
```

A separate Redis set tracks which domains currently have pending work:

```
domains:{jobId}   # SADD on first URL for a domain, SREM when its queue drains
```

### 3. Politeness at schedule time via a per-domain "next-fetch" gate

`rateLimiter.ts` holds, per domain, the earliest timestamp at which that domain
may be fetched again:

```
nextfetch:{domain}   # unix-ms; updated to now + crawlDelay after each fetch
```

`crawlDelay` comes from `robots.ts` (parsed `Crawl-delay`) and falls back to a
configured default (`packages/config`).

### 4. The scheduler loop

A worker asking for its next URL runs this logic (implemented as a single Lua
script so it is atomic under concurrency):

```
1. From domains:{jobId}, find a domain D whose nextfetch:{D} <= now
   AND whose frontier:{jobId}:{D} is non-empty.
2. Pop the highest-priority URL from frontier:{jobId}:{D}.
3. Set nextfetch:{D} = now + crawlDelay(D).      # reserve the slot
4. If frontier:{jobId}:{D} is now empty, SREM D from domains:{jobId}.
5. Return the URL (or "no fetchable work right now" -> worker backs off).
```

Because steps 1–4 are atomic, two workers can never both grab the same domain's
slot, and a rate-limited domain is simply skipped rather than blocking the worker.
If no domain is currently fetchable, the worker sleeps for a short, jittered
interval and retries — it does not busy-loop the queue.

### 5. Discovery feeds back through dedup

When a fetched page yields links (`extractLinks.ts`), each link is normalized,
scope-checked against the `Job` (same-domain flag, max depth, max pages), passed
through dedup (step 1), and, if new, `ZADD`ed to its domain's frontier with
`domains:{jobId}` updated. This is the loop that grows the crawl.

## Consequences

### Positive

- **Throughput scales with worker count** (the ADR-0003 thesis holds), because a
  worker is never blocked by an unrelated domain's rate limit — it just schedules
  a different domain.
- **Politeness is guaranteed**, not best-effort: the `nextfetch` reservation is
  atomic, so no burst of workers can exceed a domain's crawl-delay.
- **Dedup is cheap and correct** — one atomic `SET NX` per candidate URL, keyed on
  the normalized form.
- Dedup + rate limit + scheduling now have an explicit, testable contract instead
  of three files with an implied relationship.

### Negative / tradeoffs

- **More Redis state and more Lua.** The scheduler is a Lua script, which is harder
  to read and debug than a plain BullMQ `queue.add`/`process`. We accept this: the
  atomicity is non-negotiable and Lua is the standard way to get it in Redis.
- **Domain skew.** A crawl dominated by one domain is fundamentally throttled by
  that domain's crawl-delay, and no amount of workers helps — this is *correct*
  behavior, but it means throughput is domain-mix-dependent. The load test
  (`scripts/`) should crawl a multi-domain seed set to demonstrate scaling.
- **Fairness across domains** is currently "any fetchable domain." If one domain
  should not starve others, we may later add round-robin or weighted selection in
  step 1. Deferred until we observe it.
- **"No fetchable work" is ambiguous** between "job done" and "everything is
  rate-limited right now." The worker distinguishes these by checking whether
  `domains:{jobId}` is empty (done) vs. non-empty but all gated (back off).

### Failure handling

- A URL reserved in step 3 but never completed (worker crash) is recovered by
  BullMQ's stalled-job mechanism / a visibility timeout: the reservation does not
  remove the URL from a "processing" set until the fetch is acknowledged, so
  crashed work is re-scheduled. Poison URLs that repeatedly crash a worker exhaust
  their retry budget and move to a dead-letter set (see runbook).

## Alternatives considered

- **Single global queue + fetch-time rate check** — rejected: starves or
  busy-loops as described in Context.
- **Kafka partitioned by domain** — a domain-per-partition scheme also solves the
  coupling, but pulls in Kafka's operational weight for a workload BullMQ/Redis
  handles well at our scale. See ADR-0002 (BullMQ over Kafka); this ADR does not
  reopen it.
- **In-memory frontier per worker** — rejected: violates ADR-0003 (stateless
  workers); a worker restart would lose its frontier and dedup state.
```
