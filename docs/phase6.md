# Phase 6 (Milestone M6) — Cancel, Webhooks, Metadata Plugin

> Milestone **M6** — first post-M5 product increment, picked from
> [gap-analysis.md](gap-analysis.md) Tier 2/4 for best effort-to-impact: three small,
> visible features that each exercise a different seam of the finished engine
> (job lifecycle, completion events, plugin host) without touching its core.

- **Step A — Cancel a job**: `POST /jobs/:id/cancel` stops a crawl mid-flight.
- **Step B — Webhooks**: signed HTTP callback when a job completes or is cancelled.
- **Step C — `metadata` plugin**: canonical URL, OpenGraph/Twitter cards, hreflang.

---

## Step A — Cancel (`POST /jobs/:id/cancel`)

Today a submitted job can only run to completion. Cancel gives the operator an
off-switch — essential the first time a depth-3 crawl on a big site was a mistake.

### Design

**A Redis tombstone, checked per URL — not queue surgery.** Cancel sets
`job:{id}:cancelled = 1` (with a TTL comfortably above any job's lifetime) and updates
the Job document to `cancelling`. The worker checks the tombstone at the top of the
handler: if set, the URL is a **no-op** that still flows through the normal completion
accounting (pending decrement in Worker events, unchanged). The queue drains itself;
when `pending` hits 0, completion detection runs as usual.

| Decision | Alternative | Why |
|---|---|---|
| Tombstone + no-op drain | `queue.remove()` the job's queued entries | The queue is **shared across jobs** (competing consumers, ADR-0002); removing one job's entries means scanning/filtering every queued item — O(queue) and racy with in-flight claims. The tombstone is O(1) per URL and cannot race: a URL is either processed before the flag (fine) or no-ops after it. |
| Reuse the pending ref-count for drain | separate cancel bookkeeping | M4's completion invariant (enqueue-before-decrement) already guarantees `pending` reaches 0 exactly once — cancellation gets correct termination for free. |
| Two-phase status: `cancelling` → `cancelled` | flip straight to `cancelled` | Honest: between the API call and the queue draining, in-flight URLs are still finishing. The completion path sets the final `cancelled` state. |

**Completion-path guard.** The completion routine currently marks `completed`
unconditionally when pending hits 0. It now finalizes to **`cancelled` if the tombstone
is set, else `completed`** — one branch, same code path, no second termination
mechanism.

**Semantics.** Cancel is idempotent (second call → same `202`). Cancelling a job that
is already `completed`/`cancelled`/`failed` is a `409`. Pages persisted before the
cancel remain queryable/exportable — a cancelled crawl is a partial result, not a
deleted one.

**Dashboard.** A Cancel button on the live job view (`POST` then keep polling — the
existing poll loop already renders the terminal state).

## Step B — Webhooks (`job.completed` / `job.cancelled`)

Polling `GET /jobs/:id` is fine for the dashboard, but automation wants a push:
"crawl finished, here are the numbers."

### Design

**Per-job `webhookUrl`, not a webhook-management resource.** The job config gains an
optional `webhookUrl` (validated https URL). A `POST /webhooks` CRUD resource with
per-org subscriptions is the multi-tenant shape (architecture-v2 §4) — building it now
would mean inventing subscription storage for a single-tenant service. Same honesty
argument as API-key-vs-JWT in phase5.md; the delivery mechanics below are unchanged
when the resource model lands later.

**Delivery is a BullMQ job — retries come free.** When the completion path finalizes a
job that has a `webhookUrl`, it enqueues a delivery task on a small `webhooks` queue.
Delivery then inherits the engine's existing failure model: exponential backoff,
capped attempts, dead-letter on exhaustion (inspectable via the same DLQ tooling).
No hand-rolled retry loop in the completion path, which stays fast and non-blocking.

**Payload** (JSON): `{ event, jobId, seedUrl, status, pagesPersisted, startedAt,
finishedAt }`. **Signed**: `X-Crawler-Signature: sha256=HMAC(body, WEBHOOK_SECRET)` —
receivers can verify origin; secret comes from env via `packages/config` (optional;
unset ⇒ unsigned, local-dev frictionless).

**A webhook URL is an SSRF vector.** The server fetches a user-supplied URL — exactly
the threat ADR-0005 exists for. Delivery goes through the **same `ssrfGuard`
fetch path as the crawler** (resolve, validate, pin, no redirects followed), plus the
API pre-screens the URL at submit like it pre-screens seeds. A blocked delivery is a
terminal `blocked-ssrf` outcome, not retried.

| Decision | Alternative | Why |
|---|---|---|
| Enqueue delivery on a BullMQ queue | deliver inline from the completion path | Inline delivery couples job finalization to a third party's uptime; a slow receiver would hold worker resources. The queue decouples and gives retries/DLQ for free. |
| Per-job `webhookUrl` | `POST /webhooks` subscription resource | No tenant model yet — a subscription store would be scaffolding. Deferred to the auth/tenancy milestone (gap-analysis Tier 2). |
| HMAC signature | bearer token in a header | Signature authenticates the *body*, survives receiver-side logging, and is the ecosystem convention (GitHub/Stripe-style). |
| Reuse `ssrfGuard` for delivery | plain fetch | The guard exists and the threat is identical; two egress paths with different rules is how SSRF holes happen. |

## Step C — `metadata` analyzer plugin

The fourth built-in, and the first one the original HLD diagram promised that M5
didn't ship. Pure function over the parsed DOM — no new infrastructure, exercises the
plugin host exactly as designed (ADR-0006: "adding a capability is write a plugin").

**Extracts:** canonical URL (`<link rel=canonical>`, resolved absolute),
OpenGraph (`og:title/description/image/type`), Twitter card fields, `hreflang`
alternates, `<html lang>`, and the robots meta directives (`noindex`/`nofollow`).

**Why these fields:** canonical + robots-meta make crawl results *interpretable*
(is this page the authoritative copy? did the site ask not to index it?), and og/twitter
cards are the highest-value structured metadata for the search/export surface.

| Decision | Alternative | Why |
|---|---|---|
| Report `noindex`/`nofollow`, don't enforce | have the pipeline honor robots meta | Enforcement changes crawl behavior and belongs to the politeness work (gap-analysis Tier 3, item 19) behind its own decision; an *analyzer* observes, it doesn't steer. |
| Resolve canonical to absolute URL | store raw attribute | Relative canonicals are common; an absolute URL is comparable against `finalUrl` — that comparison (`isCanonical`) is the useful signal. |

Registered in `builtins.ts` next to seo/tech/security; enabled via the existing
`plugins: ["metadata", …]` config — API, worker, and dashboard plugin toggles pick it
up with no schema change (the dashboard's `AVAILABLE_PLUGINS` list gains one entry).

---

## What's tested

- **A:** unit — completion finalizer picks `cancelled` vs `completed` from the
  tombstone; API `cancel` returns `202` (running), `202` (repeat, idempotent), `409`
  (terminal), `404` (unknown). End-to-end — cancel a deep crawl mid-flight, job lands
  `cancelled` with partial pages intact and `pending` at 0.
- **B:** unit — payload shape + HMAC signature verify; submit-time rejection of
  non-https/internal webhook URLs. End-to-end — a local receiver (tiny http server on
  an allowed address) gets exactly one signed delivery for a completed job; a dead
  receiver exhausts retries into the DLQ.
- **C:** pure unit tests on fixture HTML — canonical resolution (relative→absolute),
  og/twitter extraction, hreflang list, robots-meta flags, and graceful `null`s on a
  page with no metadata.

## Exit criteria

- `POST /jobs/:id/cancel` stops a running crawl; status ends `cancelled`; already-saved
  pages remain queryable and exportable; dashboard Cancel button works.
- A job submitted with `webhookUrl` produces one signed callback on completion **and**
  on cancellation; failed deliveries retry with backoff and dead-letter.
- A job with `plugins:["metadata"]` stores the metadata block per page, visible in
  `GET /jobs/:id/pages` and the dashboard results table.
- Offline suite stays green; no new infra required (same Redis/Mongo/MinIO).
