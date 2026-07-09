# Architecture v3 — Web Intelligence Platform (Production)

> The authoritative production design. It supersedes the branch sketches in discussion
> and unifies three earlier docs: the engine HLD ([architecture.md](architecture.md)),
> the production-ops target ([architecture-v2.md](architecture-v2.md)), and the
> extraction direction ([vision-no-code-extraction.md](vision-no-code-extraction.md)).
>
> One platform, one distributed crawler **spine**, feeding **two capability branches** —
> **Website Analysis** (audit a site) and the **Extraction Engine** (get structured data
> from a site) — that are *plugin categories on a shared dispatcher, not separate
> engines*. Package name is already `web-intelligence-platform`; this is its shape.

---

## 1. The thesis in one picture

```
                              Web Intelligence Platform
                                        │
                             ┌──────────▼──────────┐
                             │  API / Gateway edge  │  auth · quotas · validate · SSRF pre-screen
                             └──────────┬──────────┘
                                        │ enqueue job
                          ┌─────────────▼──────────────┐
                          │  Distributed Crawler SPINE  │
                          │  frontier · dedup · robots  │
                          │  rate-limit · completion    │
                          └───────┬─────────────┬───────┘
                     HTTP fetch   │             │  Browser render (Playwright)
                   (default,cheap)│             │  (JS sites, opt-in)
                                  └──────┬──────┘
                                         ▼
                              HTML / Rendered DOM  (+ optional raw-HTML blob)
                                         │
              ┌──────────────────────────┴──────────────────────────┐
              ▼  branch A                                            ▼  branch B
     ┌──────────────────┐                             ┌──────────────────────────────┐
     │ WEBSITE ANALYSIS │                             │      EXTRACTION ENGINE         │
     │ (audit plugins)  │                             │ target-driven, tiered          │
     │  seo · security  │                             │  ┌───── Discovery ──────┐      │
     │  tech · metadata │                             │  │ sitemap · page-type  │      │
     │  exposure · perf │                             │  └──────────┬──────────┘      │
     └────────┬─────────┘                             │   ┌─────────▼──────────┐       │
              │                                       │   │ Confidence router   │◄──┐   │
              │                                       │   │  (verify + escalate)│   │   │
              │                                       │   └─┬────────┬───────┬──┘   │   │
              │                                       │  T1 │     T2 │    T4 │      │   │
              │                                       │ structured  rules   LLM    │   │
              │                                       │ (JSON-LD/   (CSS/    (opt,  │   │
              │                                       │  microdata/ XPath +  fallbk)│   │
              │                                       │  OG)        Rule Lib)───────┘   │
              │                                       └──────────────┬────────────────┘
              │  analysis blob                                       │ typed records + provenance
              └───────────────────────┬──────────────────────────────┘
                                       ▼
                        Storage:  MongoDB (jobs·pages·records·rules)
                                  · Redis (queues/coordination) · S3/MinIO (blobs)
                                       ▼
                        Dashboard  ·  REST API  ·  Streamed Export  ·  Webhooks
```

**The load-bearing decision:** Analysis and Extraction are *both* consumers of the same
crawled DOM, and *both* are plugins on the same dispatcher. The "two branches" is a
**capability grouping** (for UI/API/billing), **not** a code fork. The spine, storage,
and edge are shared. This is what makes one team able to serve both a freelance-audit
use case and a data-extraction business without building two systems.

---

## 2. Layers (bottom-up)

### 2.1 The Spine — Distributed Crawler (built: M1–M9)
Stateless workers pull URL jobs from Redis/BullMQ; per-URL pipeline is
`robots → rate-limit → SSRF guard → fetch|render → parse → extract-links → branch
plugins → persist → spread`. Two fetch modes share one contract:
- **HTTP** (default, ~5 ms) — `@crawler/core` + undici, SSRF-pinned.
- **Browser render** (opt-in, `services/renderer`) — Playwright, for JS/SPA content.

Completion (ref-counted), cancel (tombstone), retries→DLQ, graceful drain, per-domain
politeness — all already implemented and shared by both branches unchanged.

### 2.2 The Dispatcher — one plugin host, two categories
Every capability is an `AnalyzerPlugin` (`analyze(input) → record`) run by the host
(`crawler-core/src/plugins`). Plugins are **tagged by category**:

| Category | Plugins (built) | Purpose |
|---|---|---|
| **analysis** | `seo`, `security`, `tech`, `metadata`, `exposure` (+ `performance`, `a11y` later) | audit / report on the site |
| **extraction** | `structured` (built); `rules`, `llm` (planned) | pull structured data out of the site |

A job selects plugins by name or by category. The category drives *presentation and
billing*, not execution — one dispatcher, one code path.

### 2.3 Branch A — Website Analysis (built: M5–M10)
Runs the audit plugins, aggregates into the **Website Health Report** (M8) +
**Exposure Report** (M10). Output: SEO/security/tech scores, exposure findings,
performance. Serves the **freelance / security-audit** use case. Essentially complete.

### 2.4 Branch B — Extraction Engine (building: M11+)
Target-driven (you specify an *entity/field set*, e.g. `Product{name,price}`), not
URL-driven. Structured as a **confidence-routed tier stack**:

```
Discovery ──► pick candidate DETAIL pages (not landings)
     │        sitemap ingest · page-type classify (listing vs detail) · type-target
     ▼
For each page, the confidence router tries tiers cheapest-first and STOPS when the
result clears a confidence threshold:
  Tier 1  structured   JSON-LD → Schema.org microdata → OpenGraph   (built; ~40% coverage)
  Tier 2  rules        Rule Library lookup → CSS → XPath            (per-site/template rules)
  Tier 4  LLM (opt)    generate extraction strategy → validate → SAVE to Rule Library
                       (off by default; privacy-aware; runs ONCE per template, then Tier 2 reuses it)

Confidence router (NOT a tier): verifies each tier's output (field types, completeness,
cross-page consistency) and decides "good enough" vs "escalate". This is the research core.
```

Output: typed records with **provenance** (source URL, fetch date, license) →
`extractionRecords`. Serves the **data-extraction / open-data business** use case.

**Why the Rule Library matters:** the LLM tier is expensive, so it runs **once** to
generate a rule for a site-template, which is **cached and reused** by Tier 2 forever.
This amortizes AI to near-zero per-page cost — the answer to "LLM scraping is too
expensive." The LLM is an *optional socket*, never a per-page dependency.

### 2.45 The Website Intelligence Layer — per-domain memory (planned; the differentiator)
The platform is otherwise stateless: every crawl re-derives everything. The Intelligence
Layer gives it **memory + a feedback loop**, making the "intelligence" in the name real.
It is a **cross-cutting store consulted at the edges of the crawl**, not an inline stage:

```
   READ (before/at crawl):  worker consults the domain profile
     → needs browser render?  → skip HTTP-then-render waste
     → known rules for this template? → Tier 2 reuses instead of regenerating
     → rate-limit / robots history, page-type map, last-seen fingerprints
                          │  crawl runs (spine + branches)
   WRITE (after):  update the profile
     → extraction success + confidence + hit-rate, cost per record
     → tech fingerprint, render requirement, content fingerprint (change detection)
```

**It unifies four separately-planned features into one primitive:** the **Rule Library**
(§2.4), **self-healing** (a dropping rule hit-rate is the trigger), **render-requirement
detection**, and **cross-crawl verification** (compare against last time). It also gives
the *analysis* branch **change-over-time** for free ("security score dropped since last
scan; new exposure appeared") — the headline feature for recurring audits.

Two scopes, because of tenancy:
- **Global domain facts** (tech stack, render requirement, page-type map, fingerprints)
  — objective, shareable across orgs as collective knowledge.
- **Per-org rules & targets** (selectors encode a client's intent) — isolated by `orgId`.

The **feedback loop keeps the memory honest**: rules are versioned + scored by hit-rate;
a falling hit-rate flags staleness → self-heal (regenerate rule) instead of silently
returning garbage. Staleness detection *is* the verification problem; the loop is its
mechanism — the research core, now with a home.

Implementation: a `@crawler/intelligence` package + Mongo collections
(`domainProfiles` global, `rules` per-org) consulted by the workers. **A package and a
store, not a new service** — it's a genuine new concern, but adds no deployable.

### 2.5 Storage & Edge (built)
MongoDB (jobs, pages, analysis, extraction records, rule library), Redis (queues +
coordination), S3/MinIO (raw HTML/screenshots, content-hash keys). Stateless Express
API + React dashboard + streamed export + signed webhooks.

---

## 3. Data model (additions for the extraction branch)

| Collection | Role | Status |
|---|---|---|
| `jobs` | job config incl. `mode: analyze \| extract \| both`, plugin/category selection, extraction **target spec**, auth headers (secret) | extend |
| `pages` | per-page crawl result + `analysis` blob (both branches write here) | built |
| `extractionRecords` | typed records `{ entity, fields, source, confidence, provenance }` | new |
| `domainProfiles` | **Intelligence Layer (global)**: `{ domain, techStack, needsRender, pageTypeMap, contentFingerprints, robotsCache, lastCrawledAt }` — objective facts, shared | new |
| `rules` | **Intelligence Layer (per-org Rule Library)**: `{ orgId, domain, templateHash, entity, tier, selectorSpec, generatedBy, version, verifiedAt, hitRate, costPerRecord }` — versioned, scored, reused | new |

Multi-tenant from the start (arch-v2): every doc carries `orgId`; blob keys prefixed per
org; **rules & targets are per-org** (a client's selectors aren't shared), while
**domain facts are global** collective knowledge.

---

## 4. Runtime topology (production)

```
CDN(web) → Ingress/WAF/TLS → api ×N (stateless, KEDA/HPA on RPS)
                                  │  outbox → enqueue
              Redis (Sentinel/Cluster): crawl · render · webhook · (extract-heavy) queues
                                  │
   ┌──────────────────────────────┼───────────────────────────────┐
   ▼                              ▼                                ▼
 worker ×N (KEDA on queue depth)  renderer ×M (browser pool)   [extractor ×K — optional]
   HTTP crawl + all plugins       JS render + all plugins       LLM/heavy extraction only
   └──────────────┬───────────────┴────────────────┬────────────┘
        Mongo (replica set, majority)      S3 (versioned, lifecycle)
                                  │
        OTel traces · Prom metrics · pino logs · Grafana/Alerts
```

**Scaling decisions:**
- Analysis + Tier1/Tier2 extraction are cheap → run **inside the existing crawl/render
  workers** (no new service). Keep the dispatcher shared.
- **Only the LLM tier** has a different profile (latency, cost, external API). If/when it
  lands, route just those jobs to an **`extract-heavy` queue + optional `extractor`
  service** — the same package→service extraction test that justified the renderer
  (ADR-0006). Not before it's needed.
- Workers scale on **queue depth (KEDA)**; api on RPS; renderer on render-queue depth.

---

## 5. Control flow (both branches, one job)

```
submit job (mode, plugins/categories, [target spec], [auth]) 
  → api validates + SSRF pre-screen → Job(pending) → enqueue seed
  → worker/renderer: robots → rate-limit → SSRF → fetch|render → parse
      → run selected plugins:
           analysis plugins  → analysis blob      (Branch A)
           extraction: discovery-gated confidence router → record  (Branch B)
      → persist page + analysis + extractionRecord
      → spread in-scope links (depth+1)
  → completion at pending=0 → finalize → webhook
  → read: report (analysis)  ·  dataset export (extraction)  ·  dashboard
```

A `both`-mode job runs analysis *and* extraction on each page in one pass — one crawl,
two outputs. That shared crawl is the platform's core efficiency.

---

## 6. Security, safety & ethics (unified)
- **SSRF**: fetch-time IP-pinned guard (ADR-0005) on HTTP *and* browser (route
  interception) *and* webhook delivery. One egress policy.
- **Politeness**: robots + per-domain rate limit, honest UA — both branches.
- **Exposure branch** (audit): passive, detect-&-confirm, redacted-by-default,
  authorized targets only (M10).
- **Extraction branch** (data): respect robots/ToS, capture **license + provenance**
  per record; the LLM tier must never ship raw sensitive values to an external model
  (send structure, or run local). Auth headers are secret: read by workers, never in
  API responses or on Page results.
- **Tenancy**: orgId isolation, per-org quotas, audit log (arch-v2).

---

## 7. What's built vs target

| Layer | Status |
|---|---|
| Spine (crawl, render, robots, rate-limit, SSRF, completion, cancel, retries/DLQ) | ✅ M1–M9 |
| Dispatcher + shared plugin host | ✅ M5 |
| **Analysis branch** (seo/security/tech/metadata/exposure) + report + dashboard + export | ✅ M5–M10 |
| **Extraction Tier 1** (structured) | ✅ M11 Step 1 |
| Extraction Tier 2 (CSS/XPath + Rule Library) | ⬜ M11 Step 2 |
| Discovery (sitemap, listing-vs-detail, target-driven) | ⬜ M12 |
| **Website Intelligence Layer** (domain profile + Rule Library + feedback loop) | ⬜ new — the differentiator |
| Confidence router / verification / self-heal (driven by the Intelligence Layer's hit-rate) | ⬜ M14 |
| LLM tier + rule generation (optional socket) | ⬜ M13/M14 |
| Intent layer (point-click / NL → rules) | ⬜ M13 |
| Production ops (HA stores, KEDA, OTel, tenancy, CI/CD) | ⬜ arch-v2 backlog |

The platform is ~70% of this architecture already. The remaining build is the
Extraction branch's tiers 2–4 + discovery + the intent/verification research, plus the
production-ops hardening tracked in [gap-analysis.md](gap-analysis.md).

---

## 8. Key decisions (this doc's ADRs)

| # | Decision | Rationale |
|---|---|---|
| A | Two branches = **plugin categories**, not separate engines | shared dispatcher already exists; a code fork is building for the diagram |
| B | **Confidence is a router/verifier that wraps the tiers**, not a tier | it decides & verifies; it doesn't extract |
| C | **Discovery is an explicit layer** before extraction | data showed structured content lives on detail pages, not landings — extraction is useless without reaching them |
| D | **Rule Library caches generated rules for reuse** | amortizes the expensive LLM tier to near-zero per-page cost |
| E | **LLM is an optional, isolated tier** behind an interface | keeps the platform fully functional rule-only; contains cost/privacy blast radius |
| F | Extraction runs **in the existing workers**; only the LLM tier may become a service | ADR-0006's "service only when the scaling profile differs" |
| G | One crawl serves **both branches** (`mode:both`) | the core efficiency: don't crawl twice to audit and extract |
| H | **Website Intelligence Layer** = per-domain memory (profile + Rule Library + feedback loop), a shared cross-cutting store consulted at the crawl edges | makes "intelligence" real; unifies rule-library + self-heal + render-detection + cross-crawl verification into one primitive; evolutionary, not a redesign |
| I | Intelligence Layer has **two scopes**: global domain facts (shared) + per-org rules/targets (isolated) | objective facts are collective knowledge; selectors encode client intent |
