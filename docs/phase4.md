# Phase 4 Step A (Milestone M4) — Operational Correctness

> **Naming note.** Milestone **M4**, the hardening milestone. Step A is operational
> correctness; Step B ([phase4b.md](phase4b.md)) is safety (SSRF guard + per-domain
> rate limiting).

Through M3 a crawl *ran and persisted*, but it never *finished* — `Job.status`
stayed `pending` forever, and a URL that failed just… failed. Step A closes those
gaps:

1. **Completion detection** — know when a distributed crawl is done, and flip
   `Job.status` to `completed`.
2. **Retries + dead-letter queue** — a failing URL is retried with backoff, and if it
   never succeeds it lands in an inspectable DLQ instead of vanishing.
3. **Graceful shutdown** — a worker told to stop finishes its in-flight URL and
   releases its lock, so a deploy/scale-down drops nothing.

---

## Design decisions

### Completion detection — reference-counted termination

Knowing a *distributed* crawl is done is the genuinely hard part (workflow Phase 6):
there's no single loop to watch, just work spread across workers. We use a
**per-job outstanding-work counter** in Redis — classic reference counting:

- `job:{jobId}:pending` — incremented every time a URL is **enqueued** (inside the
  dedup-guarded `enqueueUrl`, so it counts each URL exactly once), and decremented
  every time a URL is **finished** (terminally — completed or permanently failed).
- The crawl is done when `pending` hits **0**.

**The ordering invariant that makes zero mean zero** (workflow Phase 6): a worker
enqueues all of a page's children (each `INCR pending`) *before* its own job is
marked terminal (`DECR pending`). Because children increment before the parent
decrements, the counter can never hit 0 while more work is coming. Both operations
are atomic Redis ops, so concurrent workers stay consistent.

**Why not "ask BullMQ if the queue is empty?"** BullMQ's queue is shared across all
jobs and isn't indexed by our `jobId`, and "empty right now" races with a worker
about to enqueue children. A per-job counter with the ordering invariant is the
correct, race-free signal.

**Accounting lives in worker events, not the processor.** We `DECR` in the Worker's
`completed` and terminal-`failed` events — *not* inside the job handler — because the
handler re-runs on every retry; counting there would double-decrement. The event
fires once per terminal outcome.

### Retries + dead-letter queue — BullMQ built-ins

**Chosen:** `attempts: 3` with exponential backoff on every job; a URL whose crawl
errors **throws**, so BullMQ retries it; after the last attempt it stays in BullMQ's
**failed set**, which *is* our DLQ (kept, not removed, so it's inspectable).

**Why throw on error now?** In M2/M3, `crawlUrl` swallowed fetch errors into an
`error` outcome so the CLI wouldn't crash. In the worker we now **re-throw** on that
outcome, because throwing is how you opt into BullMQ's retry/backoff/DLQ machinery.
Expected non-errors (robots-skip, over-budget) return normally and don't retry.

| Alternative | Why not |
|---|---|
| **A separate DLQ queue** we push to manually | More moving parts; BullMQ's failed set already persists failed jobs with their error and attempt history. Promote to a dedicated queue only if we need separate retention/replay policies. |
| **No retries (fail fast)** | Transient network blips (timeouts, 5xx) are the common case; retrying with backoff recovers most of them — the whole point of a crawl's fault tolerance. |

`scripts/dlq.ts` lists the dead-lettered URLs with their error, so failures are
visible and (later) replayable.

### Graceful shutdown

`worker.close()` already waits for in-flight jobs to finish before resolving; on
`SIGINT`/`SIGTERM` we call it, then close Redis/Mongo. BullMQ releases the job lock
on a clean close, and any *un*-closed crash is covered by lock expiry (stalled-job
recovery). So a rolling deploy finishes current URLs and drops nothing. Step A just
makes the intent explicit and logged.

---

## What's tested

- **Completion accounting** — the reference-count logic is exercised end-to-end: seed
  a bounded crawl, run a worker, and observe `Job.status` flip to `completed` with
  `pending` at 0 exactly once.
- **DLQ** — seed a job whose seed URL can't resolve; after retries it appears in
  `scripts/dlq.ts` output, and the job still **completes** (a permanent failure
  decrements `pending` too, so it never wedges completion).

## Exit criteria for Step A

- A bounded crawl **auto-completes**: `Job.status` → `completed` when the frontier
  drains.
- A permanently failing URL lands in the DLQ (visible via `pnpm dlq`) and does **not**
  block completion.
- `Ctrl-C` on a busy worker finishes the current URL before exiting.
- Offline suite stays green.

Then **Step B** (`phase4b.md`): the fetch-time SSRF guard (ADR-0005) and per-domain
rate limiting.
