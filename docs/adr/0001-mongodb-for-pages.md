# 1. MongoDB for job and page storage

Date: 2026-07-05

## Status

Accepted

## Context

The crawler produces two kinds of records that must be persisted:

1. **Job records** — one per crawl: the config (seed URLs, depth/page caps, render
   mode, enabled plugins), status, and live progress counters.
2. **Page records** — one per fetched URL: normalized URL, final URL, HTTP status,
   content type, title/description, depth, parent URL, discovered-link count, and
   the analysis documents produced by the plugins (metadata, SEO, security,
   tech-detect, accessibility).

The page record is the awkward one. Its shape is **not fixed**: which analyses are
present depends on which plugins the job enabled, and each plugin emits its own
sub-document whose schema evolves independently. A crawl of a JS-heavy site with
the screenshot + a11y plugins produces a very different document from a plain
metadata crawl. We are also write-heavy (every fetched page is an upsert) and read
results mostly by job ID or by simple filters/text search, not by complex
multi-table joins.

We need: a flexible per-document shape, a **unique constraint on normalized URL**
(the durable dedup guard from [ADR-0004](0004-frontier-per-domain-scheduling.md)),
cheap high-volume writes, and — later — text search over page content and
metadata. Large blobs (raw HTML, screenshots) are explicitly *not* stored here;
they go to object storage (MinIO), with Mongo holding only the object key.

## Decision

Use **MongoDB** as the primary metadata store for both job and page records.

- The **flexible document model** fits the variable, plugin-driven page shape
  without a migration every time a plugin changes its output. The per-plugin
  analysis sub-documents live as embedded objects on the page document.
- A **unique index on the normalized URL** (scoped per job) provides the durable,
  race-proof dedup backstop that the fast Redis check cannot guarantee alone.
  Concurrent workers racing on the same URL resolve at this index: the loser's
  upsert conflict is treated as a successful dedup, not an error.
- **Text indexes** (or Atlas Search) cover the M5 results-search feature over
  title/description/content without standing up a separate search cluster.
  Elasticsearch is deferred until a proven search-scale need
  ([ADR-0006](0006-modular-monolith-of-services.md)).
- Schemas, indexes, and versioned migrations are owned once in `packages/db` and
  imported by both `api` and `worker`, so the unique-index definition cannot drift
  between services.

## Consequences

### Positive

- No schema migration churn as plugins evolve their output shape.
- The unique-index dedup backstop is a first-class database guarantee, not
  application-enforced.
- High write throughput for the page-upsert hot path.
- Built-in text search defers the operational cost of Elasticsearch.
- Horizontal scaling later via sharding (natural shard key: job ID) if needed.

### Negative / tradeoffs

- **We give up relational integrity.** Job → Page → DiscoveredUrl are genuinely
  relational, and Mongo will not enforce those references for us; the application
  must. This is the strongest argument for Postgres and we accept it knowingly —
  the flexible page shape and write profile outweigh it here.
- **No cross-document transactions by default** across the whole pipeline. We lean
  on idempotent upserts (safe to replay) rather than multi-document ACID. Where we
  need atomicity (the enqueue primitive, the counters), it lives in Redis/Lua, not
  Mongo.
- **Unbounded growth** without a retention policy — page documents and their text
  indexes must have a TTL / per-job expiry story (see workflow.md → data
  lifecycle).
- Document-size limit (16 MB) — another reason blobs live in MinIO, not inline.

## Alternatives considered

- **PostgreSQL** — stronger integrity and real joins across Job/Page/DiscoveredUrl,
  and `JSONB` could hold the variable plugin output. Rejected as the *primary*
  store because the page shape is dominantly document-like and the workload is
  upsert-heavy rather than join-heavy; a hybrid (Postgres for job/url state, blobs
  in S3) remains a defensible future pivot if relational needs grow.
- **Elasticsearch as primary store** — rejected: it is a search index, not a system
  of record; operationally heavy, and we do not want it on the write hot path.
  Deferred to a search-only role behind an ADR.
- **Everything in Redis** — rejected: Redis holds ephemeral coordination state
  (queue, frontier, counters, dedup), not the durable system of record.
