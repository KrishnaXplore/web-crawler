# Phase 5 Steps B / C / E (Milestone M5) — Metrics, Plugins, Search & Export

> Milestone **M5**, three backend steps done together. Step D (React dashboard) is
> separate. Implements workflow Phases 7 (observability) and 8 (export), plus the
> plugin extensibility from ADR-0006.

---

## Step B — Metrics (`prom-client`)

`@crawler/metrics` owns one Prometheus registry + shared metric objects; the API and
worker both import it and expose `/metrics` for Prometheus to scrape (workflow
Phase 7).

- **API** — a `/metrics` route + a middleware counting `http_requests_total{method,
  route,status}` and request-duration.
- **Worker** — a tiny `node:http` server (metrics/health only, since a worker has no
  HTTP surface of its own) exposing `crawler_pages_total{outcome}` and a
  fetch-duration histogram.

**Why a shared package:** metric *names* are a contract Prometheus/Grafana depend on;
defining them once stops the API and worker from drifting on names/labels.

| Decision | Alternative | Why |
|---|---|---|
| `prom-client` | hand-rolled counters | It's the standard, handles exposition format + default process metrics for free. |
| Worker `/metrics` via `node:http` | reuse Express | The worker isn't a web service; a 20-line http server avoids pulling Express into it. |

## Step C — Analyzer plugins (ADR-0006)

Analysis is pluggable, not baked in. A **plugin host** in `@crawler/core` runs the
analyzers a job enables against each page's parsed DOM + response headers, and the
worker stores their combined output on the page document under `analysis`.

Built-in analyzers:
- **seo** — h1 count, title length, meta-description presence, images missing `alt`.
- **tech** — framework/CMS fingerprint from `<meta generator>` and script sources.
- **security** — presence of key response headers (HSTS, CSP, X-Frame-Options, …).

To enable `security`, `fetch` now captures **response headers** (it previously kept
only content-type). Jobs pick analyzers via a `plugins: string[]` config field
(empty = no analysis).

| Decision | Alternative | Why |
|---|---|---|
| Analyzers as functions behind one interface | separate npm packages loaded dynamically | The interface is what matters (ADR-0006); the public SDK / dynamic loading is deferred until the interface stabilizes. |
| Run in the worker, store `analysis` on the page | run in the API on read | Analysis is per-page compute done once at crawl time, not per request. |

## Step E — Search & Export

- **Search** — a MongoDB **text index** on `title`+`description`; `GET /search?q=&jobId=`
  returns matches. Mongo text search (not Elasticsearch — deferred, ADR-0006) is
  enough at this scale.
- **Export** — `GET /jobs/:id/export?format=json|csv` **streams** results from Mongo
  rather than buffering them (workflow Phase 8), so a large job doesn't blow up memory.

| Decision | Alternative | Why |
|---|---|---|
| Mongo text index | Elasticsearch | One datastore, no new infra; ES stays behind an ADR until a real search-scale need. |
| Streamed CSV/JSON | build the whole string in memory | Bounded memory for large result sets — the Phase 8 requirement. |

---

## What's tested / exit criteria

- **B:** `GET /metrics` on the API returns Prometheus text; the worker's metrics port
  serves counters that increment as it crawls.
- **C:** a job with `plugins:["seo","tech","security"]` stores an `analysis` block on
  each page (verified via `GET /jobs/:id/pages` / Mongo).
- **E:** `GET /jobs/:id/export?format=csv` streams a CSV; `GET /search?q=…` returns
  matching pages.
- Offline suite stays green (plugin analyzers get pure unit tests).
