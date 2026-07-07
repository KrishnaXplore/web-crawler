# Phase 2 (Milestone M2) — From Library to Runnable Crawler

> **Naming note.** "Phase 2" = milestone **M2**. It is *not* workflow.md's numbered
> phases. See [phase1.md](phase1.md) for the same disclaimer.

M2 is where the pure functions from M1 become a thing you can actually *run*. It is
big, so it is built in **two steps**:

- **Step A (this document, now):** a single-process, in-memory crawler — the network
  `fetch`, the `crawlUrl` orchestrator, and a **CLI** so you can crawl a real URL
  from the terminal. No Redis, no queue, no Docker.
- **Step B (next, `phase2b.md`):** make it distributed — BullMQ queue, the stateless
  worker loop, and Redis discovery-time dedup (ADR-0004). This is where the design's
  scaling thesis actually lands.

Step A exists so there is a **runnable, observable crawler early**, before taking on
infrastructure. The CLI's in-memory frontier/dedup are deliberately throwaway — Step
B replaces them with Redis. Building A first means we validate fetch/parse/extract
against the live web before debugging it *through* a queue.

---

## What Step A delivers

| Module | Where | Responsibility |
|---|---|---|
| `pipeline/fetch.ts` | `@crawler/core` | HTTP GET with User-Agent, timeout, response-size cap, content-type; returns final URL + body. |
| `pipeline/crawlUrl.ts` | `@crawler/core` | Orchestrates one URL: robots gate → fetch → parse → extract. Dependency-injected, so it is unit-testable **without network**. |
| `scripts/crawl.ts` | root | A BFS CLI: `crawl <url> [--depth N] [--max-pages N] [--same-host] [--no-robots] [--delay ms]`. In-memory visited-set + robots cache. |

**Deferred to Step B / later:** Redis dedup, BullMQ queue, the stateless worker,
per-domain rate limiting, and the **authoritative SSRF guard** (M4 / ADR-0005) —
Step A uses the platform's default redirect handling and records the final URL, with
a `TODO(M4)` where the per-hop SSRF guard will slot in.

---

## Design decisions

### HTTP client — Node's built-in `fetch` (undici)

**Chosen:** the global `fetch` that ships with Node 24, wrapped with an
`AbortController` timeout and a streaming size cap.

**Why:** zero dependencies for the exact feature set we need — a timeout, a byte
cap read off the response stream (so a giant file can't exhaust memory), the final
URL after redirects, and the `content-type`. It's the same engine the big HTTP
libraries wrap anyway.

| Alternative | Why not (here) |
|---|---|
| **got** | Excellent (retries, streams, hooks). But retries/backoff are a *queue* concern in our design (BullMQ, Step B), and adding a dep for what built-in `fetch` already does is unnecessary weight at Step A. |
| **axios** | Ubiquitous, but no first-class streaming size-cap, an extra dep, and its own redirect model we'd have to bend for the M4 SSRF guard. |
| **node-fetch** | Legacy polyfill for a capability Node now has natively. No reason. |

**Redirects — interim choice.** Step A uses `redirect: "follow"` and records
`response.url` as the final URL. This is knowingly *not* the ADR-0005 design (manual,
per-hop, IP-pinned re-validation). SSRF is an M4 concern; the code carries a
`TODO(M4)` so the swap is explicit, not forgotten.

### Orchestrator — `crawlUrl` with dependency injection

**Chosen:** `crawlUrl(url, deps, options)` where `deps.fetch` and `deps.robotsFor`
are **injected functions**, not hard-wired network calls.

**Why:** it makes the orchestrator a pure, deterministic unit — tests pass a fake
fetcher returning canned HTML and assert the outcome (`ok` / `skipped-robots` /
`error`, links, metadata) with **no network**. The CLI injects the real
`fetchPage`; tests inject a stub. Same code, both paths.

| Alternative | Why not |
|---|---|
| **`crawlUrl` calls `fetchPage` directly** | Simpler to write, but then the orchestrator can only be tested against the live web — flaky, slow, and untestable offline. DI is the small upfront cost that buys deterministic tests. |

### CLI — a BFS runner using `node:util.parseArgs`

**Chosen:** a breadth-first crawler with an in-memory `visited` set and a per-origin
robots cache, args parsed by the built-in `node:util.parseArgs`, run via **tsx**.

**Why BFS + in-memory:** it's the smallest thing that demonstrates the *whole* loop
— fetch, extract, enqueue-children, respect depth/page caps, be polite — so you can
watch a crawl spread across a site. The in-memory frontier/dedup are explicitly the
parts Step B throws away for Redis; keeping them trivial now avoids gold-plating code
with a two-week shelf life.

| Decision | Alternative | Why chosen |
|---|---|---|
| **`node:util.parseArgs`** | commander / yargs | Built-in, zero-dep, enough for a handful of flags. A full CLI framework is unjustified for a dev tool. |
| **Run with `tsx`** | Compile then `node` | `tsx` runs the TS script directly for fast iteration; the library packages still build normally. |
| **In-memory dedup/frontier** | Wire Redis now | Redis dedup is the M2 *Step B* headline; doing it now would mean standing up Docker before the crawler even fetches. Prove fetch/parse first. |

### Politeness in the CLI

The CLI honors `robots.txt` by default (skip with `--no-robots`) and sleeps between
requests (`--delay`, default 200 ms), taking the max of the flag and any robots
`Crawl-delay`. This is a *simplified* stand-in for the real per-domain token-bucket
rate limiter (M4) — good enough to be a well-behaved citizen when you point it at a
live site, without pretending to be the production limiter.

---

## What's tested

- **`crawlUrl`** — fully unit-tested via injected fake fetch/robots: HTML page →
  links + metadata; non-HTML → no links; fetch throws → `error`; robots disallow →
  `skipped-robots` (and fetch is never called). No network.
- **`fetchPage`** — the thin network wrapper is validated by **running the CLI
  against a live, crawl-safe URL** (`https://example.com`) rather than unit tests, so
  we don't couple the suite to a network or stand up a local server at this step.
  (A local-server integration test is a fair Step B addition.)

## Exit criteria for Step A

- `pnpm -r test` stays green (M1 tests + new `crawlUrl` tests).
- `pnpm -r typecheck` clean.
- `pnpm crawl https://example.com` fetches, parses, and reports — a crawler you can
  actually run.

Then **Step B** (`phase2b.md`): BullMQ + Redis dedup + the stateless worker, turning
this single process into the horizontally-scalable engine the design is about.
