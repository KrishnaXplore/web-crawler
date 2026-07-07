# Runbook

Operational guide: how to run the system, what to check when something is wrong,
and the sharp edges we've already hit. Assumes the repo root as working directory
(**important** — `.env` is loaded relative to it).

---

## 1. Ports & endpoints

| Thing | Where | Notes |
|---|---|---|
| REST API | `:3000` | `GET /health` → `{"status":"ok"}` |
| API metrics | `:3000/metrics` | Prometheus text |
| Worker metrics/health | `:9464/metrics`, `:9464/health` | one per worker; override with `WORKER_METRICS_PORT` per replica |
| Dashboard (dev) | `:5173` | Vite; auto-shifts to `:5174` if 5173 is taken |
| Redis | `:6380` | **non-standard** (6379 often taken locally) |
| MongoDB | `:27018` | **non-standard** (27017 ditto) |
| MinIO API / console | `:9002` / `:9003` | console login `minioadmin`/`minioadmin` |

## 2. Start / stop

```bash
pnpm infra:up        # docker compose: redis, mongo, minio (volumes persist)
pnpm api             # builds workspace, then runs services/api via tsx
pnpm worker          # same for the worker; run N of these for N workers
pnpm --filter @crawler/web dev
pnpm infra:down      # stops containers; volumes are kept
```

- Services run TypeScript directly via `tsx` — **a code change needs a process
  restart**, there is no hot reload for api/worker (the Vite dashboard does HMR).
- Workers drain gracefully on SIGINT/SIGTERM: stop pulling, finish in-flight URLs,
  release locks, exit. Kill -9 is also safe — BullMQ's stalled-job detection returns
  the locked jobs to the queue.

## 3. Health checklist (in order)

1. `docker compose ps` — all three containers `healthy`?
2. `curl localhost:3000/health` — API up?
3. `curl localhost:9464/health` — worker up? (`worker ready` also appears in its log)
4. `docker exec crawler-redis redis-cli ping` → `PONG`
5. `docker exec crawler-mongo mongosh --quiet --eval "db.runCommand('ping').ok"` → `1`

## 4. Common failures

### Job stuck — status never reaches `completed`
- `GET /jobs/:id` — is `pending` > 0 and unchanging?
- Is any worker running? (`:9464/health`). If none: start one — the queue is durable,
  work resumes where it left off.
- Check the DLQ (below): if every remaining URL dead-lettered, the pending count
  still drains — a stuck non-zero `pending` with idle workers usually means workers
  died mid-decrement; restart a worker, then as last resort inspect
  `job:{id}:pending` in Redis and compare with `GET /jobs/:id` counts.
- A job can always be force-finished by cancelling it: `POST /jobs/:id/cancel`
  (drains queued URLs as no-ops, keeps partial results).

### Crawl running but every page fails
- `grep` the worker log for the outcome tag: `robots` (site disallows), `ssrf`
  (target resolves to a blocked address — by design), `ERR` (network/5xx → retries).
- Repeated 429/timeouts: raise `CRAWL_DELAY_MS`, or the site is rate-limiting the
  shared egress IP.

### Dead-letter queue (failed URLs / webhook deliveries)
```bash
pnpm dlq                          # list dead-lettered crawl URLs with reasons
docker exec crawler-redis redis-cli ZCARD bull:crawl:failed      # crawl DLQ size
docker exec crawler-redis redis-cli ZCARD bull:webhooks:failed   # webhook DLQ size
```
Entries stay for post-mortem (capped retention 1000). A failed URL was retried 3×
with backoff first; webhook deliveries 5×. SSRF-blocked webhook deliveries fail
once, deliberately without retry.

### Redis / Mongo / MinIO down
Workers and API log connection errors and retry; they do not crash. Restore the
container (`pnpm infra:up`) and the system resumes. Losing Redis loses in-flight
frontier/dedup/counters for running jobs (those jobs should be re-submitted);
completed results in Mongo/MinIO are unaffected.

### Port already in use
Something else on 3000/9464/5173. Find it: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
The dashboard auto-shifts (5173→5174); api/worker do not — stop the squatter or
change `API_PORT` / `WORKER_METRICS_PORT`.

### Webhook never arrived
1. Worker log: `→ webhook … delivered` vs `webhook delivery failed (attempt n/5)`.
2. `SSRF blocked` in the reason? The receiver host resolves to a private/loopback
   address — that's the guard working; use a publicly-resolvable receiver.
3. Receiver must answer 2xx; anything else retries 5× then dead-letters.
4. Signature verification failing on the receiver: compute
   `sha256=HMAC_SHA256(raw_body, WEBHOOK_SECRET)` over the **exact raw body** and
   compare with `X-Crawler-Signature`; confirm both sides use the same secret.

## 5. Data locations & cleanup

| Data | Where | Cleanup |
|---|---|---|
| Job + page documents | Mongo db `crawler`, collections `jobs`, `pages` | `db.pages.deleteMany({jobId})` |
| Raw HTML blobs | MinIO bucket `crawler-blobs`, keys `html/<sha256>` | MinIO console or `mc rm` |
| Queue/dedup/counters | Redis `bull:*`, `seen:{jobId}`, `job:{jobId}:*` | cleared automatically at job finalization |
| Everything (nuke) | | `docker compose down -v` (deletes volumes!) |

## 6. Sharp edges (learned the hard way)

- **Run pnpm scripts from the repo root** — `.env` resolution and workspace builds
  assume it.
- **BullMQ custom job ids must not contain `:`** — it's BullMQ's key separator; we
  use `.` (`{jobId}.{urlHash}`).
- **mongoose and minio are CJS** — under NodeNext use default/namespace imports;
  named imports typecheck fine but fail at runtime (tsc/vitest won't catch it).
- **Integration tests are opt-in** (`RUN_REDIS_IT` / `RUN_MONGO_IT` / `RUN_MINIO_IT`)
  so the default `pnpm -r test` passes with no infra.
- **The SSRF guard blocks private/loopback receivers everywhere** — including
  webhook receivers and any `*.localtest.me`-style DNS tricks. This is by design;
  don't "fix" it in dev, use a public receiver.
- **Each BullMQ `Worker` needs its own Redis connection** (blocking ops); queues can
  share one.
