# Phase 8 (Milestone M8) — Insights & Presentation

> Milestone **M8** — no engine work. The crawler is 9.5/10; the *presentation* of what
> it finds is ~6/10. This milestone turns raw per-page crawl telemetry into an
> **actionable website report** and a **drill-down** — converting "a crawler that
> collects data" into "a tool that hands you a website audit." Implements the read-side
> of workflow Phase 8 (reporting).

The guiding observation: **most of a useful report is already in MongoDB.** Every page
already stores its status, title, depth, discovered-link count, and the full `analysis`
block (seo/tech/security/metadata). A report is therefore mostly an *aggregation query*,
not new crawling — the cheapest high-impact work left in the project.

- **Step A — Report API**: `GET /jobs/:id/report` aggregates the job's pages into a
  Website Health Report. Pure read-side, no schema change.
- **Step B — Dashboard: report view + page drill-down**: render the report as the
  headline of a completed job; make each result row open a full-page detail.
- **Step C — Capture the missing signals**: the few report fields the schema doesn't
  yet hold (response time, word count, internal/external link split) — small worker/
  plugin additions that light up the remaining report lines.

---

## Step A — Report API (`GET /jobs/:id/report`)

A single endpoint that runs a MongoDB aggregation over the job's pages and returns a
summary document. Everything here is derivable from data **already stored** (M3–M6):

| Report field | Source (already persisted) |
|---|---|
| pagesCrawled | `countPages(jobId)` |
| crawlDurationMs | job `createdAt` → `completedAt` |
| statusBreakdown (2xx/3xx/4xx/5xx) | `page.status` |
| brokenPages | pages with `status >= 400` |
| technology | most common `analysis.tech.detected` across pages |
| securityScore | modal `analysis.security.score` |
| pagesMissingH1 | count where `analysis.seo.h1Count === 0` |
| pagesMissingMetaDescription | count where `analysis.seo.hasMetaDescription === false` |
| imagesMissingAlt | sum of `analysis.seo.imagesMissingAlt` |
| totalDiscoveredLinks / avgLinksPerPage | sum/avg of `discoveredLinks` |
| mostLinkedPage (in-degree) | group by `parentUrl` — the link graph is reconstructable |
| robotsRespected | job config `respectRobots` |

**Design.**

| Decision | Alternative | Why |
|---|---|---|
| One aggregation endpoint, computed on read | precompute + store a report doc at completion | Reads are infrequent and cheap at this page scale; computing on demand keeps the write path untouched and the report always consistent with the current pages. Precompute is a later optimization if a job has millions of pages. |
| Mongo aggregation pipeline | fetch all pages, reduce in Node | The database does grouping/counting far better and doesn't stream every page into the API's memory (the same bounded-memory discipline as the export cursor). |
| Report is per-job | site-level across jobs | A crawl *is* the unit a user reasons about; cross-job trends are a later analytics concern. |

Returns `404` for an unknown job; works on any job with persisted pages (a `cancelled`
job yields a partial report — honest, not an error).

## Step B — Dashboard: report view + drill-down

**Report view.** When a job is `completed`/`cancelled`, the dashboard fetches
`/report` and renders the **Website Health Report** as the headline above the results
table — the mock the review asked for:

```
Website Health Report
 ✓ Pages Crawled: 9          ✓ Security Score: 3/5
 ✓ Broken Pages: 0           ✓ Technology: jQuery
 ✓ Avg Links/Page: 7         ✓ Missing H1: 2 pages
 ✓ Crawl Duration: 2.4s      ✓ Missing Meta Desc: 2 pages
 ✓ Robots.txt: Respected     ✓ Most Linked: /support
```

**Page drill-down.** Clicking a result row opens a detail view for that page:
URL + finalUrl, title, response status, depth, incoming/outgoing links, the full
analysis broken out (SEO / security / tech / metadata), the raw stored HTML link
(MinIO, when `storeHtml`), and a **Raw JSON** panel. This is the "Open Page" the
review called out — the difference between a data table and a professional analysis
tool.

| Decision | Alternative | Why |
|---|---|---|
| Report rendered from the API's aggregation | compute the summary in the browser from the pages list | The pages list is paginated/capped; the report must reflect *all* pages, which only the server-side aggregation sees. |
| Drill-down reuses the existing page doc | a new per-page endpoint | `GET /jobs/:id/pages` already returns the analysis; the detail view is a richer render of data it can request, plus the existing `htmlKey` for the raw HTML link. Minimal new surface. |
| Client stays a thin typed fetch client | add a data-fetching lib | Consistent with phase5d — three endpoints and a poll loop don't justify React Query. |

## Step C — Capture the missing signals

A few report lines need data the schema doesn't yet hold. Each is a small, honest
addition at crawl time (the primitives already exist — `fetch` has the timing hook,
`extractLinks` already computes `hostOf`):

- **responseTimeMs** — `fetch.ts` wraps the request in a timer already used for the
  metrics histogram; persist it per page.
- **wordCount** — the parsed DOM is in hand; count visible text tokens in `parse.ts`
  (or a tiny addition to the `seo` analyzer).
- **internalLinks / externalLinks** — `extractLinks` knows the page host; return the
  split counts instead of only a total, and store both.
- **scriptCount / stylesheetCount** — cheap DOM counts, natural additions to the
  `tech`/`seo` analyzers.

These extend the report (avg response time, internal vs external split, word count)
without changing any existing field — additive schema, no migration.

**Deliberately deferred to the renderer milestone (architecture-v2):**
**screenshots** and **broken outbound-link checking** (which needs following links
solely to test their status). Both are real work with their own home; the report
ships without them and gains them later.

---

## What's tested

- **A**: unit — the aggregation reducer over a fixture set of page docs (missing-H1
  count, status breakdown, most-linked, averages) with mocked db; `GET /report`
  returns `404` for unknown, a partial report for a cancelled job. End-to-end — crawl
  a real multi-page site, assert the report numbers match a hand count.
- **B**: `vite build` + `tsc --noEmit` clean; the report view renders from a
  fixture; drill-down opens a page's full analysis.
- **C**: unit — link split (internal vs external) on fixture HTML; response-time and
  word-count fields populate on a live crawl.

## Exit criteria

- `GET /jobs/:id/report` returns an accurate Website Health Report for a completed
  crawl; numbers reconcile with `GET /jobs/:id/pages`.
- The dashboard shows the report as a completed job's headline and opens a full
  per-page drill-down with raw JSON + stored-HTML link.
- Response time, word count, and internal/external link split are captured and appear
  in the report.
- Offline suite stays green; no engine/pipeline behavior changed.
