# Phase 3 Step B (Milestone M3) — Blob Storage: the Metadata/Blob Split

> **Naming note.** Still milestone **M3**, implementing the second half of workflow
> Phase 5. Step A ([phase3.md](phase3.md)) put page *metadata* in MongoDB; Step B
> puts the *bytes* (raw HTML, later screenshots) in **object storage**.

Storing raw HTML inline in Mongo works until it doesn't: documents have a 16 MB cap,
big bodies bloat the working set, and it mixes small hot metadata with large cold
blobs. The production pattern (workflow Phase 5, ADR-0001) is a **split**: metadata
in the database, blobs in object storage, with the DB holding only an object **key**.

---

## What Step B delivers

| Piece | Where | Responsibility |
|---|---|---|
| MinIO | `docker-compose.yml` | S3-compatible object store for raw HTML blobs. |
| `@crawler/storage` | `packages/storage` | Blob client: `putBlob`/`getBlob`, keyed by content hash. |
| Page fields | `@crawler/db` | `htmlKey` + `htmlBytes` on the page document (the pointer, not the bytes). |
| worker | `services/worker` | When `storeHtml` is on, upload the HTML and record its key. |
| `scripts/html.ts` | root | Fetch a stored page's HTML back from MinIO — proof of the split. |

**Opt-in.** Storing HTML is enabled per job with `--store-html` (default off), because
blobs are the fastest-growing, most expensive data and the workflow's data-lifecycle
concern is real. Metadata is always stored; bodies only when asked.

---

## Design decisions

### Object store — MinIO (S3-compatible)

**Chosen:** MinIO in dev, spoken to over the S3 protocol.

**Why:** it's the standard local stand-in for Amazon S3 — same API, so the code that
works against MinIO in dev works against real S3 in production by changing only
endpoint + credentials. It keeps large blobs out of Mongo entirely.

### Client — the `minio` SDK

**Chosen:** the official `minio` JS client.

**Why:** purpose-built and compact for exactly what we need (bucket ensure, put, stat,
get-stream). Clean for a focused blob store.

| Alternative | Why not now |
|---|---|
| **`@aws-sdk/client-s3`** | More portable (first-class AWS) and the likely production choice — but heavier and more verbose for dev. The `putBlob`/`getBlob` seam means swapping to it later touches one file. |
| **Store blobs in Mongo GridFS** | Keeps one datastore, but it's still Mongo carrying cold bytes; the whole point is to offload them. |

### Keys — content hash (`sha256`)

**Chosen:** the object key is `html/<sha256(content)>`.

**Why:** content-addressing gives us **two properties for free**:
1. **Idempotency** — re-storing the same bytes yields the same key; a `stat` check
   skips the re-upload.
2. **Cross-page dedup** — two URLs with byte-identical HTML share one blob
   automatically (workflow Phase 5's "identical content shares one blob").

| Alternative | Why not |
|---|---|
| **Random UUID key** | No idempotency, no content dedup — re-crawls and identical pages each store a fresh copy. |
| **URL-based key** | Ties the blob to one URL, losing cross-URL content dedup, and URLs are unbounded/awkward as keys. |

### The split on the Page document

Mongo stores `htmlKey` (the pointer) and `htmlBytes` (size, for reporting) — **never
the HTML itself**. To read a page's body you look up its key in Mongo, then fetch the
bytes from MinIO. Small hot metadata and large cold blobs live in the store each is
good at.

### Port 9002/9003

MinIO's API is published on **9002** and its console on **9003** (defaults 9000/9001
are taken on this machine — 9000 is SonarQube), consistent with the Redis-6380 /
Mongo-27018 choices.

---

## What's tested

- **`@crawler/storage`** — integration test (opt-in `RUN_MINIO_IT=1`, skipped
  offline): `putBlob` returns a content-hash key; putting the **same** bytes twice
  yields the **same** key and doesn't duplicate; `getBlob` round-trips the content.
- **End-to-end** — seed with `--store-html`, run a worker, then `pnpm exec tsx
  scripts/html.ts <jobId> <url>` fetches the stored HTML back from MinIO via the key
  recorded in Mongo.

## Exit criteria for Step B

- `docker compose up -d` brings up Redis, Mongo, **and** MinIO.
- A `--store-html` crawl records `htmlKey`/`htmlBytes` on pages and uploads bodies to
  MinIO; `scripts/html.ts` reads a body back.
- Identical content across pages shares one blob (content-hash dedup).
- Offline suite stays green (all three integration suites self-skip).

M3 is then **complete**. Next: **M4** (`phase4.md`) — hardening: SSRF guard,
per-domain rate limiting, retries + dead-letter queue, graceful shutdown, and true
completion detection (finally flipping `Job.status` to `completed`).
