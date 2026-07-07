# Phase 5 Step D (Milestone M5) — The Dashboard

> Milestone **M5**, final step. A React + Vite single-page app over the REST API
> (Step A). Implements the client side of workflow Phase 1 (submit) and Phase 7 (live
> progress).

The dashboard is a thin client: it holds no crawl logic, just calls the API. Submit a
crawl, watch it progress live, browse the results and their analysis, export.

---

## What it delivers

- **Submit form** — seed URL, depth, page cap, same-host, robots, store-HTML, and
  analyzer plugin toggles → `POST /jobs`.
- **Live job view** — polls `GET /jobs/:id`, shows status, pages persisted, and pending
  count updating until `completed`.
- **Results table** — `GET /jobs/:id/pages`: each page's status, depth, title, link
  count, and its plugin **analysis** (SEO / tech / security) inline.
- **Export links** — JSON / CSV via `GET /jobs/:id/export`.

## Design decisions

**React + Vite + TypeScript.** The design specifies it; Vite gives instant dev + a
fast production build, and the app is a natural SPA.

**Dev proxy instead of CORS.** Vite proxies `/api/*` → `http://localhost:3000`
(stripping `/api`), so the browser makes same-origin requests and the API needs no CORS
middleware. In production the reverse proxy (nginx) serves the built static files and
routes `/api` to the API — same shape, no CORS anywhere.

| Alternative | Why not |
|---|---|
| **Enable CORS on the API** | Works, but weakens the API's origin posture for a dev-only convenience. A proxy keeps requests same-origin in both dev and prod. |
| **A data-fetching lib (React Query, etc.)** | Nice, but the app has three endpoints and a poll loop; a small typed `fetch` client + `useEffect` is enough and keeps the dependency surface tiny. |

**Own tsconfig (bundler resolution).** The web app can't use the repo's NodeNext /
`verbatimModuleSyntax` base config (that models Node's runtime resolution). Vite bundles
for the browser, so `web` has a standalone `tsconfig` with `moduleResolution: Bundler`
and `jsx: react-jsx`. This is the browser-safety boundary the earlier docs flagged:
`web` imports only what a bundler can handle — no Node built-ins.

**Excluded from the shared test run.** `web` has no `test` script (its verification is
`vite build` + `tsc --noEmit`), so `pnpm -r test` skips it rather than pulling jsdom
into the suite.

## Verification / exit criteria

- `pnpm --filter @crawler/web build` produces a static bundle; `tsc --noEmit` is clean.
- `pnpm --filter @crawler/web dev` serves the app; with the API running, the proxy
  reaches it.
- Submitting a crawl shows it progress to `completed` and lists the results with
  analysis.

**M5 — and the whole build — is then complete.**
