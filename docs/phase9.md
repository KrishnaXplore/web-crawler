# Phase 9 (Milestone M9) — The Renderer Service

> Milestone **M9** — the first true **package→service extraction** the modular-monolith
> design promised (ADR-0006, architecture-v2 §2): a headless-browser rendering tier.
> Until now the crawler sees only server-rendered HTML; a JavaScript SPA looks like an
> empty shell. M9 adds `services/renderer` — a Playwright pool that executes the page,
> empty shell. M9 adds `services/renderer` — a Playwright pool that executes the page
> and captures the *rendered* DOM.

Why a **service** and not a module in the worker (the ADR-0006 test): Chromium has a
genuinely different profile — hundreds of MB per browser, CPU-heavy, crash-prone, and
scaled by render demand, not crawl demand. Bundling it into every worker replica would
make the cheap thing expensive. This is exactly the extraction architecture-v2 §2
specifies.

- **Step A — the renderer service**: a second queue (`render`) + a second stateless
  consumer wrapping Playwright; `renderMode: "browser"` on the job config routes a
- **Step A — the renderer service**: a second queue (`render`) + a second stateless
  consumer wrapping Playwright; `renderMode: "browser"` on the job config routes a
  whole job to it.

---

## Step A — the renderer service

### Routing: a second queue, same contract

A job declares `renderMode: "http" | "browser"` (default `http` — nothing changes for
existing jobs). At submit, the API enqueues the seed onto the **render queue** instead
of the crawl queue when mode is `browser`; the renderer enqueues discovered children
back onto its own queue. The two consumer fleets never share URLs, and all
coordination state (dedup set, pending counter, cancel tombstone, rate-limit gates)
is the same Redis state — so **completion detection, cancel, webhooks, and maxPages
work identically without modification**.

| Decision | Alternative | Why |
|---|---|---|
| Renderer = second queue **consumer** running the same pipeline with a different fetch | worker calls a renderer HTTP service per URL | Services communicate only through queue + stores (verified property of this codebase); an internal RPC hop would break that, add a synchronous coupling, and hold worker slots hostage to render latency. |
| Whole-job routing via `renderMode` | per-URL heuristic ("looks like a SPA → re-enqueue to renderer") | Deterministic and honest: the user knows which mode ran. A fallback heuristic is a nice later addition; guessing wrong silently is worse than asking. |
| Reuse `crawlUrl` with an injected Playwright `fetch` | a separate render pipeline | `CrawlDeps.fetch` was designed for injection (M1). The renderer builds a `FetchResult` from the rendered page — robots, rate-limit, parse, extract, persist, spread all stay **one code path** in crawler-core. |

### The Playwright fetch

One Chromium instance per process, one fresh **context** per URL (cookies/storage
isolation), small concurrency (default 2 — a browser page is ~2 orders of magnitude
heavier than an HTTP fetch). `page.goto(url)` waits for `load`, then a short
network-idle grace so SPA content lands; `page.content()` is the rendered DOM that
feeds the normal parse/extract/analyze path.

### SSRF in the browser

A rendered page fetches sub-resources and XHRs the crawler never sees — each one is
an egress. Playwright **route interception** vets every request: literal-IP hosts are
checked directly, names are DNS-resolved and **all** addresses checked against the
same `isBlockedAddress` list as the HTTP guard (ADR-0005); anything blocked is
aborted, and the *page* URL itself is pre-checked before `goto`.

Honest caveat, documented rather than hidden: interception validates at *check* time —
it cannot pin the later connection to the validated IP the way the undici agent does,
so a fast-rebinding DNS attacker has a TOCTOU window the HTTP path doesn't have. The
mitigation is the same one architecture-v2 §9 already prescribes: run the renderer in
prod behind an egress network policy with no cluster credentials. Defense-in-depth,
with the residual risk written down.

### Completion stays correct with two consumer fleets

The decrement-on-terminal / finalize-at-zero contract (M4/M6) is now needed by two
services. The ordering-critical core — decrement → read tombstone → finalize → clear
state — moves into `packages/queue` (`finishUrl`, with an injected finalize hook), so
the invariant lives **once**; worker and renderer both call it. Duplicating a
correctness-critical 20 lines across two consumers is how drift bugs are born.



## What's tested

- **A**: unit — the request-vetting predicate (blocked literal IPs, blocked resolved
  names, allowed public hosts, non-http schemes); the `finishUrl` extraction keeps its
  ordering (mocked redis). Integration/e2e — crawl `quotes.toscrape.com/js/` (the
  JS-rendered twin of the test sandbox) in **http mode** (title parses but quote
  content is absent) then **browser mode** (rendered content present) — the capability 
  difference made measurable.

## Exit criteria

- `renderMode:"browser"` job completes end-to-end through the renderer: rendered-DOM
  titles/links, completion/cancel/webhooks all behave.
- The JS-only content of `quotes.toscrape.com/js/` appears in browser-mode results and
  is absent in http-mode results (the proof the renderer earns its keep).
- Offline suite green; http-mode jobs are byte-for-byte unaffected.
