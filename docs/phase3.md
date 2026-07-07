# Phase 3 (Milestone M3) — Persistence: MongoDB + the Durable Unique Index

> **Naming note.** "Phase 3" = milestone **M3**. It implements workflow.md's
> **Phase 5** (persistence). Not related to workflow's own phase numbers.

Through M2, crawl results printed to the terminal and vanished. M3 makes them
**durable and queryable**: page metadata is written to **MongoDB**, and the
`(jobId, url)` **unique index** becomes the durable dedup backstop that ADR-0004
promised — the source of truth behind the fast Redis check.

As with M2, this is split so each step is runnable:

- **Step A (this doc, now):** MongoDB. Persist page metadata, move the job record
  off Redis into a `Job` document, and add a way to read results back.
- **Step B (next, `phase3b.md`):** MinIO blob storage — raw HTML/screenshots keyed
  by content hash, with Mongo holding only the object key (the metadata/blob split,
  workflow Phase 5).

---

## What Step A delivers

| Piece | Where | Responsibility |
|---|---|---|
| MongoDB | `docker-compose.yml` | Durable store for job + page metadata. |
| `@crawler/db` | `packages/db` | Mongoose connection, `Page` + `Job` models, indexes — owned once, imported by worker + seeder. |
| worker persistence | `services/worker` | After a successful crawl, **upsert** the page document. |
| `scripts/seed.ts` | root | Now writes a `Job` document (config + status) to Mongo, then enqueues the seed. |
| `scripts/results.ts` | root | Read a job's saved pages back out — proof the data persisted. |

**What moves, what stays.** Job *config* moves from Redis to a Mongo `Job` document
(durable metadata). Redis keeps what it's good at: the **queue**, the **dedup set**,
and the **counters** — hot coordination state. This is the clean split the design
calls for: Redis = ephemeral coordination, Mongo = system of record.

**Deferred:** blob storage (Step B); completion detection that flips `Job.status`
to `completed` (M4).

---

## Design decisions

### Datastore — MongoDB (ADR-0001, recap)

Page documents have a **variable shape** — which analyses are present depends on
which plugins ran — so a flexible document store fits better than rigid relational
tables, and the workload is upsert-heavy, not join-heavy. Full reasoning and the
Postgres counter-argument live in [ADR-0001](adr/0001-mongodb-for-pages.md); M3 just
implements it.

### ODM — Mongoose

**Chosen:** Mongoose (schemas + models in `packages/db`).

**Why:** the design (ADR-0001, project-structure) specifies Mongoose. It gives us
schema definitions, index declarations co-located with the model, and `.lean()`
reads — enough structure without a migration engine. Owning the models in one
package means the unique-index definition can't drift between the worker and the
seeder.

| Alternative | Why not (here) |
|---|---|
| **Native `mongodb` driver** | Leaner, no ODM overhead — a fair choice. But we'd hand-roll schema/index management that Mongoose gives declaratively, and the design already committed to Mongoose. |
| **Prisma** | Great DX, but its Mongo support is less mature and it fights the "flexible, plugin-driven document shape" that motivated Mongo in the first place. |

### The `(jobId, url)` unique index — the durable dedup backstop

**Chosen:** a **compound unique index** on `{ jobId, url }`, and page writes are
**upserts** keyed on that pair.

**Why compound (per-job), not global:** the same URL can legitimately appear in two
different crawl jobs — they're separate result sets. Uniqueness is *per job*, which
is exactly ADR-0004's "dedup scoped per job." This index is the **durable** guard
that catches any cross-worker race the fast Redis `SADD` might miss: if two workers
ever tried to write the same page, the second hits a duplicate-key error, which we
treat as a **successful dedup, not a failure**.

### Idempotent writes

Page persistence uses `updateOne({jobId,url}, {$set:…}, {upsert:true})`. Re-processing
a URL (e.g. a future retry) **updates in place** rather than duplicating — writes are
safe to replay, which the whole "replay-safe enqueue" story (M2) depends on.

### Port 27018

MongoDB is published on host **27018** (not the default 27017), consistent with the
Redis-on-6380 choice — this machine already runs other stacks, so we avoid port
collisions by default.

---

## What's tested

- **`@crawler/db`** — an integration test (opt-in via `RUN_MONGO_IT=1`, skipped
  offline like the Redis one): upserting the same `(jobId, url)` twice yields **one**
  document; a second distinct URL yields two — proving the unique index + upsert
  idempotency.
- **End-to-end** — `docker compose up -d`, seed a job, run a worker, then
  `pnpm results <jobId>` shows the persisted pages; re-running the crawl does not
  duplicate rows.

## Exit criteria for Step A

- `docker compose up -d` brings up Redis **and** Mongo.
- A crawl writes page documents; `pnpm results <jobId>` reads them back.
- The `(jobId, url)` unique index holds — no duplicate page rows even under
  concurrent workers.
- Offline test suite stays green (Mongo/Redis integration tests self-skip).

Then **Step B** (`phase3b.md`): MinIO blobs + the metadata/blob split.
