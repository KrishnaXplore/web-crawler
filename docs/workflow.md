# Distributed Crawler — Production Workflow

This document describes the full production lifecycle of a crawl job: the happy
path, the failure paths at each stage, and the cross-cutting concerns (fault
tolerance, rate limiting, retries, observability, security) that run throughout.
It is the **target design** — you build toward it across the milestones, not all
at once. Milestone mapping is at the end.

**Actors and components:** the *client* (React dashboard), the *API* (Express),
the *queue* (Redis + BullMQ), the *workers* (stateless crawler processes),
*storage* (MongoDB for metadata, MinIO for blobs), and *observability*
(Prometheus + Grafana + structured logs).

**Related design records:** see [architecture.md](architecture.md) for the HLD and
[project-structure.md](project-structure.md) for the module layout.
[ADR-0004 — frontier: per-domain scheduling](adr/0004-frontier-per-domain-scheduling.md)
governs dedup + rate limiting + scheduling as one subsystem;
[ADR-0005 — SSRF defense](adr/0005-ssrf-defense.md) governs the fetch-time
address guard referenced in Phases 1 and 4;
[ADR-0006 — modular monolith of services](adr/0006-modular-monolith-of-services.md)
explains why auth, scheduling, and notifications are packages/modules, not
separate services.

**Scheduling model — resolved.** This document assumes the **BullMQ-first**
consumption model: workers are competing consumers, and per-domain politeness is
enforced by a token check plus a delayed re-queue (Phase 4.3). The custom Lua
"next-fetchable-URL" frontier scheduler described in ADR-0004 is treated as an
**optional optimization**, adopted only if `benchmarks.md` shows the delayed-requeue
approach wastes meaningful worker time on hot-domain skew. Build the simple version
first; earn the complex one. Where a paragraph below describes the scheduler
"preferring an off-cooldown domain," that is the optimization path, not the M2/M4
default.

---

## Phase 1 — Job submission (client → API)

The user fills in a crawl job on the dashboard: seed URL(s), max depth, max
pages, rendering mode (HTTP vs headless), what to store (metadata / HTML /
screenshots), and whether to respect robots.txt. On submit, the client sends a
`POST /jobs` request carrying a JWT for authentication.

**Production considerations at this boundary:**

- *Authentication and authorization.* The request is rejected if the JWT is
  missing, expired, or lacks permission to create jobs. Role-based access
  separates admin from ordinary users.
- *Input validation.* The API validates the body against a schema (Zod) before
  anything else — a malformed seed URL, a negative depth, or a page limit above
  the allowed ceiling is rejected with a clear `400`, never enqueued.
- *SSRF pre-screen (necessary, not sufficient).* A user-supplied URL is checked
  so the crawler cannot obviously be pointed at internal targets — `localhost`,
  private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
  link-local (`169.254.0.0/16`, including the cloud metadata endpoint
  `169.254.169.254`), and unique-local IPv6 (`fc00::/7`). **This submission-time
  check is a fast early reject only.** It cannot be the authoritative guard,
  because DNS can rebind between check and fetch and because redirects can jump
  to internal targets after validation. The authoritative SSRF guard runs at
  fetch time — see Phase 4.4 and ADR-0005.
- *Idempotency.* An optional idempotency key lets a retried submission avoid
  creating a duplicate job.

**Failure path:** validation or auth failure returns an error to the client
immediately; nothing is persisted or enqueued.

---

## Phase 2 — Job acceptance and enqueue (API)

Once validated, the API does three things and then returns — it does **not**
wait for the crawl:

1. Writes a job record to MongoDB with status `pending` and the full config.
2. Normalizes the seed URL(s) and, for each, runs the discovery-time dedup guard
   (see Phase 4.2) before pushing it onto the Redis queue as a BullMQ job,
   tagged with the parent job ID and a starting depth of `0`.
3. Responds `202 Accepted` with the job ID.

The asynchronous hand-off is the core production move: the HTTP request returns
in milliseconds while the crawl happens in the background. The client then polls
(or subscribes to) job status using that ID.

**Production considerations:**

- *Transactional intent.* The DB write and the enqueue should not diverge — if
  the process dies between them, you want either both or neither. The robust
  pattern is a transactional outbox (write the job and an "enqueue" intent in
  one DB transaction; a relay publishes to the queue). The acceptable minimum
  for this project is an enqueue that is **safe to replay** because the
  discovery-time dedup (4.2) and the durable unique index (Phase 5) catch
  repeats. Choose one and state it; do not leave the gap unaddressed.
- *Enqueue-level dedup.* The normalized seed URL is hashed; the dedup guard
  (4.2) ensures the same URL is queued at most once per job.

**Failure path:** if the enqueue fails, the job is marked `failed` (or retried by
the relay) rather than left `pending` forever.

---

## Phase 3 — A worker claims the work (queue → worker)

Idle workers block on the queue waiting for jobs. When a URL job is available,
exactly one worker claims it — BullMQ's competing-consumers semantics guarantee
a job is delivered to a single worker via a lock.

**Production considerations:**

- *Lease / visibility.* The claimed job is locked for a `lockDuration`. The
  worker renews the lock while processing. If the worker dies, the lock expires,
  the stalled-job checker returns the job to the waiting state, and another
  worker picks it up. This is the mechanism behind "kill a worker and nothing is
  lost."
- *Concurrency control.* Each worker processes a bounded number of jobs
  concurrently (`concurrency` setting), sized to the CPU/RAM budget — much higher
  for lightweight Cheerio fetches, much lower for headless-browser jobs.
- *Backpressure.* The frontier is bounded. When the queue depth crosses a high
  watermark, discovery pauses (newly found links are held / dropped per scope
  rules) until workers drain it below a low watermark, so Redis memory stays
  bounded. Prefer a concrete bounded-queue mechanism over an unspecified "cap
  enqueue rate."

---

## Phase 4 — The per-URL crawl pipeline (worker)

This is the heart of the system. For each claimed URL the worker runs an ordered
pipeline, and each stage can short-circuit the rest.

### 4.1 — robots.txt gate

Fetch and cache the origin's `robots.txt` (per-origin, with a TTL). If the URL is
disallowed for our user-agent, the job ends here as `skipped-robots` — not a
failure, an expected outcome. Two notes:

- The `robots.txt` fetch is itself an attacker-influenced request to a
  user-supplied origin, so it goes through the **same fetch-time SSRF guard** as
  4.4.
- Parse `Crawl-delay` from `robots.txt` and feed it into the per-domain rate
  limiter (4.3) as that domain's delay, falling back to the configured default
  when absent. Robots crawl-delay is an input to rate limiting, not a separate
  concern.

### 4.2 — Deduplication (at discovery time, two layers)

**Dedup happens when a URL is discovered/enqueued, not inside the fetch of the
URL itself.** This matches ADR-0004 and avoids the trap where a transient fetch
failure permanently marks a URL as "seen" and it is never actually crawled.

- *Fast layer (at enqueue).* Normalize the URL to canonical form, hash it, and
  run an atomic `SET dedup:{jobId}:{urlHash} 1 NX` in Redis (or a Bloom filter at
  scale). If the key already existed, the URL is a duplicate and is dropped
  before it ever enters the queue.
- *Durable layer (at persist).* A unique index on the normalized URL in MongoDB
  (Phase 5) is the source of truth. It catches races between workers that the
  Redis check might miss and makes the write idempotent.

Because dedup runs at discovery, the per-URL pipeline does **not** re-check-and-add
the URL it is currently processing — so BullMQ retries of a failed fetch re-run
cleanly instead of self-deduping.

### 4.3 — Per-domain rate limiting

Before fetching, the worker acquires a token from a **per-domain** token bucket
held in Redis (rate = robots `Crawl-delay` for that domain, else the configured
default). The limit is per *domain*, shared across all workers, not per worker —
this is what keeps many workers from collectively hammering one host. If no token
is available, the job is re-queued with a short, jittered delay rather than
fetched immediately.

Guard against unbounded bouncing: cap the number of in-flight/queued URLs per
domain (or a max re-queue count) so a saturated hot domain cannot spin a URL
forever or stall completion detection.

*Optimization path (deferred, ADR-0004).* If benchmarks show workers burning
cycles popping-and-requeuing URLs from a rate-limited hot domain, replace the
delayed re-queue with the custom frontier scheduler that atomically picks a domain
that is both non-empty *and* off cooldown, so a worker is never handed a URL it
cannot fetch yet. Do not build this until the numbers justify the added Lua
complexity.

### 4.4 — Fetch (authoritative SSRF guard lives here)

Issue the HTTP request with a descriptive User-Agent, a hard timeout, a
response-size cap (so a giant file cannot exhaust memory), and content-type
inspection. Non-HTML content is recorded as metadata but not parsed for links.

The **fetch-time SSRF guard is authoritative** (ADR-0005):

- Resolve the host and reject any answer in a private / link-local / loopback /
  unique-local range — evaluated **now**, at fetch time, not at submission.
- **Pin the connection to the exact resolved IP** so the address you validated is
  the address you connect to (defeats DNS rebinding / TOCTOU).
- **Do not delegate redirects to the HTTP client.** Follow redirects manually and
  re-run the full SSRF guard on **every hop**; record the final URL. A public
  seed that `302`s to `169.254.169.254` must be rejected at the hop.
- On `429` or a `Retry-After` header, back off and re-queue.

### 4.5 — Parse and extract

Load the HTML (Cheerio for server-rendered, or a headless browser for JS-heavy
jobs per the job config) into a normalized DOM + metadata, and pull every link.
Resolve relatives against the page URL (honoring any `<base>` tag), normalize each
link, drop off-domain and asset links per the job's scope rules, and dedupe within
the page. Surviving links are candidates for Phase 6 (where discovery-time dedup
and limit checks decide what is actually enqueued).

### 4.6 — Analyze (plugins)

The normalized DOM + metadata from 4.5 is handed to the **plugin host**
(`crawler-core/src/plugins`), which runs each analyzer enabled in the job config —
metadata, SEO, security headers, technology fingerprint, accessibility, screenshot
— and collects their analysis documents. Analysis is *not* baked into the pipeline:
adding a capability is "write a plugin," not "edit `parse.ts`" (ADR-0006). A
plugin that throws is isolated — it fails its own analysis without failing the
crawl of the page. Screenshot/large outputs go to blob storage (Phase 5), not the
page document.

**Failure path:** a timeout, DNS error, or 5xx in the fetch (4.4) does not crash
the worker. The job is recorded as failed and handed to the retry machinery
(cross-cutting, below). A failing *plugin* (4.6) degrades gracefully: the page is
still persisted with whatever analyses succeeded.

---

## Phase 5 — Persistence (worker → storage)

The worker writes results using a metadata/blob split:

- *MongoDB* stores the page document: normalized URL, final URL, title,
  description, HTTP status, content type, depth, parent URL, discovered-link
  count, the analysis documents from the plugins (4.6), and timestamp. The
  normalized URL carries a **unique index** (the durable dedup guard from 4.2).
- *MinIO* stores large blobs — raw HTML and screenshots — keyed by content hash.
  MongoDB holds only the object key, never the blob itself. This mirrors how
  production systems separate metadata from file contents and keeps the database
  small and fast; identical content across URLs naturally shares one blob.

**Production considerations:** writes are idempotent — re-processing the same URL
(after a retry) upserts rather than duplicates, protected by the unique index. If
the unique-index write conflicts (a concurrent worker won the race), treat it as a
successful dedup, not an error.

---

## Phase 6 — Loop, limit enforcement, and completion

Newly discovered links from 4.5 that pass the discovery-time dedup (4.2) and the
limit checks below are enqueued back onto the queue with `depth + 1`, tagged to
the same parent job. This feedback is what makes the crawl spread. Each new URL
re-enters at Phase 3.

**Limit enforcement.** Before enqueuing, the worker checks the job's counters
(held in Redis): if `depth + 1` would exceed max depth, or the job's page count
has reached max pages, the link is dropped. This bounds the crawl.

**Completion detection — the genuinely hard part.** Knowing a distributed crawl is
*done* is a distributed-termination problem. The job is complete when, for that
job ID, there are **no waiting jobs, no active (in-flight) jobs, and no
delayed/retrying jobs**. Track live counters (discovered, completed, failed,
in-flight, delayed) atomically in Redis.

The ordering invariant that makes "zero" actually mean zero:

> A worker **enqueues all discovered children (incrementing pending) BEFORE it
> decrements its own in-flight count**, and the transition is atomic (a Lua
> script). If a worker decremented first, there would be a window where
> in-flight = 0 and pending = 0 while children are about to appear — and the job
> would be falsely marked complete.

When in-flight, pending, and delayed all reach zero, mark the job `completed` in
MongoDB and stop. Getting the ordering wrong gives you jobs stuck at 99% or marked
done while URLs are still in flight.

---

## Phase 7 — Live monitoring and progress (throughout)

Observability is not a phase — it runs continuously alongside Phases 3–6.

- *Metrics.* Workers expose Prometheus counters and histograms via `prom-client`
  — pages/sec, fetch latency, queue depth, active workers, success rate, retry
  count, dead-letter count. Prometheus scrapes these; Grafana visualizes them.
- *Structured logging.* Every log line (Pino) carries the job ID and URL so a
  single crawl can be traced across workers. No bare `console.log`.
- *Health checks.* Each service exposes `/health` (liveness) and readiness
  signals so an orchestrator knows whether to route traffic or restart it.
- *Live progress to the client.* The dashboard polls `GET /jobs/:id` (or
  subscribes over WebSocket) and renders progress from the **same counters** that
  drive completion detection.

---

## Phase 8 — Export (client)

On completion the user exports collected results as JSON or CSV (Parquet later).
For large result sets the export **streams** from MongoDB rather than loading
everything into memory, and may be generated as a background job itself with a
download link when ready.

---

## Cross-cutting: retries and the dead-letter queue

Every failed fetch is retried by BullMQ with exponential backoff (e.g. 3 attempts
at increasing delays). A failure that survives all attempts is moved to a
**dead-letter queue** rather than discarded, so failed URLs are inspectable and
re-runnable. Retry recovery rate (how many initially failing URLs eventually
succeed) is a metric worth surfacing. Because dedup is at discovery (4.2), a
retry re-runs the fetch cleanly rather than being skipped as "already seen."

## Cross-cutting: fault tolerance

Workers are stateless and hold nothing another worker needs, so any worker can die
at any time. In-flight jobs return to the queue via lock expiry (Phase 3). On
deploy or shutdown, workers trap `SIGTERM`, stop pulling new jobs, finish the
current URL, release locks, and exit — graceful shutdown, so a restart never drops
work mid-flight.

## Cross-cutting: security

- *Auth & validation* at the edge (Phase 1): JWT + RBAC, Zod schema validation.
- *SSRF* enforced authoritatively at fetch time (4.4, ADR-0005): fetch-time
  resolution, IP-pinned connections, per-redirect re-validation — plus the
  submission-time pre-screen as a fast reject.
- *Rate limiting* protects both target sites (per-domain, 4.3) and the API itself
  (per-user request limits).
- *Secrets* are validated once via `packages/config` and never live in code. Env
  vars are the M-level minimum; a real deployment injects them from a secrets
  manager (Vault / cloud Secrets Manager / sealed-secrets), not a committed
  `.env`. See "Not-yet-production gaps."
- *Token issuance is out of scope here.* `packages/auth` *verifies* JWTs; issuing
  them (login, user store, rotation) is a separate concern deferred with the rest
  of auth (ADR-0006).
- The crawler *identifies itself honestly* via User-Agent and honors `robots.txt`
  by default.

## Cross-cutting: data lifecycle

Crawled data grows without bound unless managed. A page store and a blob store
both need a retention story: a TTL or per-job expiry on page documents, and a
lifecycle policy + garbage collection on MinIO blobs (orphaned when their page is
deleted). Mongo needs a backup/restore plan (and point-in-time recovery for real
production) and an index-build strategy that does not lock the collection at scale.
None of this is optional once a crawl has run more than once.

## Cross-cutting: multi-tenancy and fairness

With one shared queue, a single enormous crawl job starves every other job behind
it. Production needs per-job or per-user **fair scheduling** (weighted or
round-robin consumption across active jobs) and **quotas** (max concurrent
jobs/pages per user), so one tenant cannot monopolize the workers. Track this as a
real requirement, not an afterthought — it changes how the queue is partitioned.

## Cross-cutting: schema evolution

`CrawlJobData` (the queue payload) and the `Page` document will change over time.
In-flight jobs enqueued before a deploy must still be processible after it: version
the payload, keep consumers backward-compatible for one version, and migrate page
documents with the versioned migrations in `packages/db`.

---

## Not-yet-production gaps

This document is the target *design*; several things stand between it and a system
you would page someone about. They are called out honestly rather than implied by a
folder name:

- **Distributed tracing.** Metrics + logs exist; there is no OpenTelemetry tracing
  across api → queue → worker → plugins. In a multi-hop system, tracing is how you
  debug a slow or stuck crawl — treat it as table stakes, not a nice-to-have.
- **Secrets management.** As above: env vars are a placeholder for a real secrets
  backend.
- **Auth issuance.** Verification without an issuer/user store is half a system.
- **DLQ operations.** A dead-letter queue with no inspect/replay tooling is a
  graveyard; it needs an admin surface.
- **Autoscaling policy.** "Workers scale horizontally" needs a concrete signal
  (queue-depth-driven HPA) and load-shedding, or it is only a claim.
- **Legal / privacy.** Storing third-party content raises ToS, copyright, and
  PII/GDPR obligations for what is persisted and for how long.
- **Supply chain.** Dependency pinning, SBOM, and a CI security scan are missing.

The discipline: build the happy path and the failure paths first (M1–M4), and let
each gap above become a dated decision (an ADR or a `benchmarks.md`/`runbook.md`
entry) rather than a silent omission. "Production-level" is earned by running code
with numbers behind it, not by the shape of the tree.

---

## Milestone mapping

- **M1 (done):** the core of Phase 4 — fetch, parse, extract, normalize, robots.
- **M2:** Phases 3 and 6 — the queue, the worker loop, discovery-time Redis dedup
  (4.2).
- **M3:** Phase 5 — MongoDB persistence and indexes.
- **M4:** scale-out and hardening — per-domain rate limiting (4.3), fetch-time
  SSRF guard (4.4/ADR-0005), retries + DLQ, graceful shutdown, completion
  detection, data-lifecycle basics.
- **M5:** Phases 1, 4.6, 7, 8 — the dashboard, auth, analyzer plugins, metrics,
  monitoring, export.
- **Post-M5 (ADR-gated):** the not-yet-production gaps — tracing, secrets manager,
  auth issuance, DLQ ops, autoscaling, multi-tenancy/fairness — each promoted from
  the list above only when a concrete need names it.

The bones (stateless workers, external queue, metadata/blob split) are in place
from M2 onward; everything after that is hardening the happy path against the
failure paths. The BullMQ-first scheduling model is the M2 default; the ADR-0004
frontier scheduler is a post-benchmark optimization, not a milestone.
