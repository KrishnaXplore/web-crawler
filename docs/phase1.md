# Phase 1 (Milestone M1) — The Pure Crawl Core

> **Naming note.** "Phase 1" here means **milestone M1** in the build order. It is
> *not* the same as "Phase 1" in [workflow.md](workflow.md), which is job
> submission. M1 implements the offline, pure-logic heart of the workflow's
> **Phase 4** pipeline (parse, extract, normalize, robots). The confusing overlap
> is called out once here so it never bites later.

## What M1 delivers

The smallest slice that is real, runnable, and needs **zero infrastructure** (no
Redis, Mongo, Docker, or network) — so it is fully unit-testable and gives us
running code with passing tests before we take on operational complexity.

Two packages:

| Package | Modules | Responsibility |
|---|---|---|
| `@crawler/shared` | `types`, `normalize`, `urlHash` | Pure domain types + URL canonicalization + the dedup key. The leaf every other package imports. |
| `@crawler/core` | `pipeline/extractLinks`, `pipeline/parse`, `pipeline/robots` | Pure crawl logic: pull links from HTML, read page metadata, parse robots.txt. |

**Explicitly deferred** (they require I/O or infra, so they belong to later
milestones): the network `fetch`, the `crawlUrl` orchestrator that wires
fetch→parse→extract, the SSRF guard, dedup/queue/frontier (M2), persistence (M3),
and the analyzer plugins (M5). M1 builds the pieces those will *call*, not the
wiring.

---

## Foundation choices (tooling)

### Package manager & monorepo — pnpm workspaces

**Chosen:** pnpm workspaces (`pnpm-workspace.yaml`, `packages/*` + `services/*` +
`plugins/*`).

**Why:** pnpm's content-addressed store symlinks dependencies, so the many small
packages in this monorepo share one physical copy of each dep instead of N copies.
Its strict `node_modules` also prevents "phantom dependencies" (importing a package
you didn't declare) — exactly the discipline a multi-package repo needs so the
"services never import each other except through declared packages" rule (ADR-0003)
is enforced by the tool, not by convention.

| Alternative | Why not (for this repo) |
|---|---|
| **npm workspaces** | Works, and it's what shipped with Node here. But its flat hoisting permits phantom deps, and it lacks pnpm's disk-sharing across many packages. Fine for a single app; weaker for a 10-package monorepo. |
| **Yarn (Berry/PnP)** | Capable, but PnP's non-standard resolution fights some tools (ts, vitest, editors); more setup friction than value here. |
| **Nx / Rush** | Heavier orchestration frameworks. Overkill at M1; pnpm + a task runner covers us until the build graph is actually large. |

> **Turbo is deferred.** The design names Turbo for task caching. At M1 there is one
> buildable package, so `pnpm -r <script>` recursion is enough. Turbo earns its
> place once multiple packages make cache-aware, parallel task graphs pay off
> (M2+). Adding it now would be config without benefit.

### Language & compiler — TypeScript, NodeNext, `strict`

**Chosen:** TypeScript with `module`/`moduleResolution: NodeNext`, `strict: true`,
plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. One `tsconfig.base.json`
every package extends.

**Why:** NodeNext gives us real ESM that matches how Node actually resolves at
runtime (hence `.js` extensions on relative imports in `.ts` source). `strict` +
`noUncheckedIndexedAccess` catch the whole class of `undefined` bugs that bite a
crawler handling messy real-world input. A single base config means compiler
settings can't drift between packages.

| Alternative | Why not |
|---|---|
| **Plain JS + JSDoc** | No compile step, but loses the type-safety that makes the shared contracts (the `Page` shape, the queue payload) reliable across services. |
| **`moduleResolution: Bundler`** | Simpler (no `.js` extensions), but it models a bundler's resolution, not Node's. Our services run *directly* on Node, so NodeNext is the honest choice. `web` (bundled) can differ locally. |
| **Loose (non-strict) TS** | Cheaper short-term, more runtime surprises. Not worth it for correctness-critical crawl code. |

### Test runner — Vitest

**Chosen:** Vitest (`vitest run` per package).

**Why:** Native ESM + TypeScript with no Babel/ts-jest transform config, fast, and
a Jest-compatible API so knowledge transfers. Zero-config against our NodeNext
setup, which is the main pain point with the alternatives.

| Alternative | Why not |
|---|---|
| **Jest** | Ubiquitous, but ESM + TS support is still friction-heavy (ts-jest / babel, `extensionsToTreatAsEsm`). More config for the same result. |
| **`node:test`** | Zero deps and built in — attractive — but thinner assertion/mocking ergonomics and weaker watch/reporting for a growing suite. A reasonable future switch; Vitest wins on DX now. |

---

## `@crawler/shared`

### `normalize.ts` — URL canonicalization

This is the most consequential pure function in the system: its output is **both**
the Redis dedup key and the MongoDB unique-index value, so two URLs that mean "the
same page" must produce a byte-identical string, deterministically.

**Canonicalization rules implemented:**
1. Parse with the WHATWG `URL` (optionally resolving a relative URL against a base).
2. Reject non-`http(s)` schemes and empty/unparseable input (`InvalidUrlError`).
3. Lowercase scheme + host (WHATWG already does; we're explicit).
4. Drop the fragment (`#…`) — never part of server identity.
5. Drop the default port (`:80` for http, `:443` for https).
6. Empty path → `/`.
7. **Sort query params** (stable sort) and **strip tracking params** (`utm_*`,
   `gclid`, `fbclid`).

**Why these rules:** each one collapses a spelling difference that would otherwise
create a duplicate crawl of the same page. Sorting query params means `?a=1&b=2`
and `?b=2&a=1` dedupe to one entry; stripping `utm_*` means a link shared with
campaign tags doesn't get re-crawled as "new."

| Decision | Alternative | Why we chose as we did |
|---|---|---|
| **WHATWG `URL`** (built-in) | The `normalize-url` npm package | The built-in is zero-dependency, spec-correct, and already handles the hard parts (IDN, percent-encoding). `normalize-url` is more aggressive (it strips `www`, forces https, removes trailing slashes) — opinionated transforms that can merge genuinely different pages. We want *predictable* canonicalization we control, not maximal collapsing. |
| **Strip only `utm_*`/click-IDs** | Strip nothing / strip `ref`, `session`, etc. | Stripping nothing fragments dedup on shared links. Stripping too much (e.g. `ref`, arbitrary session params) risks merging distinct pages. The conservative default is safest; callers can extend via `stripParams`. |
| **Keep trailing slash as-is** | Force-remove or force-add trailing slash | `/a` and `/a/` can be *different* resources on some servers. Rewriting them risks false dedup. We leave the path authoritative. |
| **Sort query params** | Preserve original order | Order is not semantically meaningful for dedup and preserving it splits the key. Sorting is the standard canonical-form move. |

### `urlHash.ts` — the dedup key

**Chosen:** SHA-1 hex of the normalized URL.

**Why:** we need a short, fixed-length, uniformly-distributed key for Redis
(`dedup:{jobId}:{hash}`) rather than storing full, variable-length URLs as keys.
SHA-1 is fast and its collision risk is irrelevant here — this is a *hash key, not a
security primitive*, and the MongoDB unique index on the full normalized URL is the
durable backstop that would catch any astronomically-unlikely collision.

| Alternative | Why not |
|---|---|
| **SHA-256** | Fine, but 64 hex chars vs 40 for no practical benefit at this collision scale — just bigger Redis keys. |
| **Non-crypto hash (xxhash/murmur)** | Faster, but adds a dependency and native build for a saving that doesn't matter at our key volume; `node:crypto` is built in. |
| **Store the full URL as the key** | No hashing, but unbounded key length and worse memory locality in Redis; also leaks the URL structure into every key. |

### `types.ts`

Pure, dependency-free domain types (`JobStatus`, `CrawlJobConfig`, `CrawlJobData`,
`Page`, `DiscoveredUrl`). Kept free of any `node:` import so they stay
**browser-bundle-safe** (the `web` app imports them type-only) — the reason
`urlHash` (which uses `node:crypto`) is a *separate* module, not part of `types`.

---

## `@crawler/core`

### `pipeline/extractLinks.ts` — link discovery

Loads HTML, honors `<base href>`, resolves + normalizes every `<a href>`, applies
same-host scope, and de-dupes within the page (returns a `Set` as an array).

**Chosen HTML library: Cheerio.**

**Why:** we only need to *read* the DOM (query `<a>`, `<base>`, `<title>`, `<meta>`),
never execute scripts. Cheerio parses server-rendered HTML with a jQuery-like API,
is fast, and has a small footprint. JS-heavy pages that need a real DOM are the
`renderMode: "headless"` path (a later milestone), not this function.

| Alternative | Why not (for static extraction) |
|---|---|
| **jsdom** | A full DOM + partial browser emulation — much heavier and slower; we don't need script execution or layout here. |
| **linkedom** | Lighter than jsdom and a good option, but Cheerio's selector ergonomics and ubiquity win for simple querying; easy to swap later if needed. |
| **Regex over HTML** | Classic mistake — HTML is not regular; breaks on comments, attributes, malformed markup. Never parse HTML with regex. |
| **parse5 directly** | It's the correct-spec parser (Cheerio uses it under the hood) but low-level; Cheerio gives us the query layer for free. |

### `pipeline/parse.ts` — page metadata

Reuses Cheerio to pull `title` and `description` (falling back to `og:description`).
Deliberately minimal: **richer analysis (SEO, security, a11y, tech-detect) is the
job of the analyzer plugins (workflow Phase 4.6), not this function** — keeping the
core thin is what the plugin model (ADR-0006) buys us.

### `pipeline/robots.ts` — robots.txt

A **hand-rolled minimal parser**: per-user-agent Allow/Disallow groups with
longest-match precedence (Allow wins ties), `*` wildcard and `$` end-anchor support,
and `Crawl-delay` extraction (which will feed the per-domain rate limiter in M4).

**Why hand-rolled rather than a library:** robots parsing is small, and owning it
means (a) no dependency for ~120 lines, (b) we control exactly how `Crawl-delay`
flows into our rate limiter, and (c) it's trivially unit-testable with no I/O. The
scope is intentionally "polite-crawler correct," not "every Google extension."

| Alternative | Why not / when to reconsider |
|---|---|
| **`robots-parser` npm** | Well-tested and handles more edge cases. A reasonable swap if we hit real-world robots files our parser mishandles — but it's a dependency for logic we can own and test cheaply, and it doesn't cleanly hand us `Crawl-delay` wired to our limiter. |
| **Google's `robots.txt` spec in full** | Sitemaps directives, complex precedence, etc. — more than a polite crawler needs at M1. We can grow toward it if required. |

---

## What's tested at M1

Pure functions, so tests are exhaustive and fast (16 passing in `shared` already;
`core` tests cover the same ground):

- **normalize:** scheme/host casing, fragment/port/trailing-slash handling, query
  sorting, tracking-param stripping, relative resolution, scheme rejection, and the
  key property — *equivalent URLs collapse to one string*.
- **urlHash:** determinism, distinctness, format.
- **extractLinks:** relative resolution, `<base href>`, in-page de-dup, non-http(s)
  skipping, same-host filtering.
- **parseMeta:** title/description extraction, `og:` fallback, absent-metadata nulls.
- **robots:** allow/disallow precedence, wildcards, crawl-delay (added with the
  module).

## Exit criteria for M1

- `pnpm -r test` green across `shared` and `core`.
- `pnpm -r typecheck` clean under `strict`.
- No network, no infra required to run any of it.

When those hold, M1 is done and M2 (queue + stateless worker + dedup, which pulls
in Redis/BullMQ and Docker) begins — documented in its own `phase2.md`.
