# CLAUDE.md — start here

This is the onboarding map for the **Web Intelligence Platform** — a distributed,
no-code web crawler + extraction engine. Read this first; it points you to the
specific files/docs you need instead of forcing a full-repo scan.

It's a **map, not a mirror**: it explains what each part does and why, and links
to the detailed `docs/phaseN.md` history. When you change behaviour, update the
relevant section here so it stays trustworthy.

---

## 1. What this is

A pnpm/TypeScript monorepo that takes a URL + a plain-English intent ("extract
product name, price, brand") and returns structured data — **with no
hand-written selectors**. It crawls, classifies pages, and extracts using a
cheapest-first tier ladder (structured data → stored CSS rules → LLM-generated
rules). It's built as three cooperating services on a shared job queue, plus a
React dashboard.

North star: make scraping easy for non-technical users on the sites that permit
it. It is **not** an Amazon/Flipkart scraper — see §9.

## 2. Non-negotiable conventions (respect these)

- **Phase-doc-before-code.** Every milestone gets a `docs/phaseN.md` (what / why
  / alternatives) written *before* implementation. Follow this for new work.
- **Verify live, not just unit tests.** Real bugs in this project were found by
  running actual crawls, not by tests passing. After a change: build, typecheck,
  test, then run a real crawl and check the result.
- **Honest identity, robots by default.** The crawler identifies itself
  truthfully (`CRAWL_USER_AGENT`) and respects `robots.txt`. It does **not**
  spoof identity, simulate human behaviour, rotate proxies to evade blocks, or
  solve CAPTCHAs. This is a firm design line (see §9) — do not add evasion.
- **Layering.** `@crawler/core` is pure/infra-free (no Mongo/Redis imports) so
  it stays unit-testable and portable. Shared types live in `@crawler/shared`.
- **Cheapest-first extraction.** Never call the LLM when structured data or a
  stored rule already covers the intent. Cost discipline is a core design goal.

## 3. Run it

```bash
pnpm install
docker compose up -d              # redis + mongo + minio  (or: pnpm infra:up)
cp .env.example .env              # then add GEMINI_API_KEY for the LLM tier

# Build everything, then start each service (separate terminals):
pnpm -r build
node services/api/dist/index.js       # API      :3000
node services/worker/dist/index.js    # worker   (metrics :9464)
node services/renderer/dist/index.js  # renderer (metrics :9465)
pnpm --filter @crawler/web dev        # dashboard :5173  (proxies /api → :3000)
```

- Root scripts: `pnpm build | test | typecheck` (all `-r` recursive).
- **Local infra ports are non-default** (another project owns the defaults on
  this machine): Redis **6380**, Mongo **27018**, MinIO **9002** — see
  `.env.example`. Start services from the repo root so dotenv finds `.env`.
- Common cleanup gotcha: stray `node dist/index.js` processes hold metrics ports
  (9464/9465) and Vite (5173). `ps aux | grep dist/index.js` and kill before
  restarting.

## 4. Architecture at a glance

```
Dashboard (React/Vite, :5173)
      │  POST /jobs
API (Express, :3000) ──enqueue──> BullMQ/Redis
      │                                │
      │                    ┌───────────┴───────────┐
      │                 Worker                   Renderer
      │              (undici+Cheerio)          (Playwright)
      │                    │  http mode           │ browser mode
      │                    └───────────┬──────────┘
      │                        runPlugins() = extraction engine
      │                                │
      └── reads ── MongoDB (jobs/pages/rules/domainProfiles)
                   MinIO (raw HTML blobs)
```

renderMode `auto` picks http vs browser from the domain profile (`needsRender`).
Worker and renderer share the same extraction path and enqueue logic.

## 5. Package & service map

**`packages/` (libraries):**
- `shared` — types (`JobConfig`, `ExtractionRule`, `WebhookPayload`), URL
  normalize, urlHash. The dependency-free base everything imports.
- `crawler-core` — the pure engine (no infra). Pipeline (`fetch`, `robots`,
  `extractLinks`, `crawlUrl`, `ssrfGuard`, `botChallenge`), plugins (extraction
  tiers), discovery (link scoring, intent classification), `llm/socket.ts`
  (Gemini). **Most logic lives here.**
- `db` — Mongoose models (`job`, `page`, `rule`, `domainProfile`) + repositories
  (`repository.ts`, `rules.ts`, `intelligence.ts`, `report.ts`).
- `queue` — BullMQ wiring: `enqueueUrl` (dedup via Redis SADD), `jobStore`
  (pending ref-count, cancel + goal-met tombstones), `completion`, `rateLimit`.
- `storage` — MinIO blob store (content-hash keys).
- `config` / `logger` / `metrics` — env schema (zod), pino logger, prom-client.

**`services/` (deployables):**
- `api` — Express REST. Routes: `jobs` (create/cancel/status/report/pages/export),
  `domains`, `rules`, `search`, `health`, `metrics`. Middleware: auth (API key),
  SSRF prescreen, zod validate.
- `worker` — BullMQ consumer, http-mode fetch. The main crawl loop:
  fetch → runPlugins → persist → score/filter links → enqueue children.
- `renderer` — same loop but via Playwright (browser mode). Mirrors worker.
- `web` — React dashboard. Two pages (`#/scrape` default, `#/console`).
  `ScraperView` = data-table results; `JobForm`; `extracted.ts` mirrors the API
  CSV field logic.

## 6. The extraction engine (the core) — `crawler-core/src/plugins/registry.ts`

`runPlugins(names, args)` walks tiers cheapest-first and stops at the first that
covers the intent:

1. **discovery** (`discovery.ts`) — classifies the page `listing`|`detail`|
   `unknown` from signals (JSON-LD schema, `detail_url_pattern`,
   `repeated_item_grid`, link/text density). Gates the tiers below.
2. **Tier 1 structured** (`structured.ts`) — JSON-LD → microdata → OpenGraph.
   Free, no AI. Skipped on listing pages.
3. **Tier 2 rules** (`rules.ts`) — stored CSS selectors from the Rule Library.
   Supports **multi-record** list rules (`listItem` container + relative
   selectors) → `records[]`, one per item (M22).
4. **Tier 4 LLM** (`llm/socket.ts`) — Gemini generates selectors from the page +
   intent, but **only** when Tiers 1–2 didn't cover the intent
   (`intentCoverage.ts` — recognized field concepts: price/brand/title/name/
   author/description/rating/date). Regenerated rules are persisted and only
   replace the old result if strictly better.

Key idea (M17): "found something" ≠ "found what was asked for." Coverage, not
mere presence, decides escalation.

## 7. Other subsystems

- **Rule Library** (`db/rules.ts`) — per-domain (and `domain#list`) stored
  rules with hits/misses/version. **Self-heals**: a rule whose hit-rate drops
  below 30% over ≥5 uses is cleared → regenerates next crawl.
- **Domain intelligence** (`db/intelligence.ts`) — per-domain profiles;
  `needsRender` derived from observations drives renderMode `auto`;
  `httpChallengeSeen` (from `botChallenge.ts`) auto-routes challenged domains to
  the browser. Learned `pathHints` boost link scoring.
- **Discovery / focused crawl** (`discovery/`) — `scoreLinks` (keyword +
  category + known-good-path), `focusLinks` (M23: prioritize detail URLs, drop
  junk, never strand), `classifyIntentTarget` (collection vs detail), coverage-
  driven early stop via the goal-met tombstone.
- **Exposure audit** (`plugins/exposure.ts`) — passive sensitive-data detector
  for **authorized** audits (own/permitted sites); Console → Exposure tab.
- **Ops** — cancellation (Redis tombstone + drain), webhooks (HMAC-signed,
  BullMQ retry/DLQ), per-domain rate limiting (Redis Lua), SSRF guards,
  prom-client metrics.

## 8. Milestone history

Detailed record is in `docs/phaseN.md` (one per milestone). Quick index:

- **M1–M5**: crawl core, queue/worker, DB+blob storage, completion/SSRF/rate-
  limit, REST API + dashboard + plugins.
- **M6–M10**: cancel + webhooks + metadata plugin; logging/Docker; health
  report; renderer service (browser mode); exposure audit.
- **M11–M14**: extraction Tier 1 (structured); domain intelligence; intent
  layer + confidence router; rule library feedback loop.
- **M15–M18**: real Gemini LLM (`gemini-3.1-flash-lite`); discovery link
  scoring; coverage-aware routing; learned path hints.
- **M19–M23**: dashboard UX (plain language, real CSV columns, preview);
  bot-challenge → auto-browser; two-page UI; **multi-record extraction**;
  **focused-crawl mode**.

`docs/scraper-edge-cases.md` is the living limitations doc — read it before
promising behaviour. `docs/architecture-v3.md` is the definitive design;
`docs/gap-analysis.md` the backlog. Git history is squashed (`5b1b2b2` covers
M1–M15); the phase docs are the real changelog.

## 9. The Amazon / access-control stance (you WILL be asked)

The crawler cannot scrape Amazon/Flipkart, and this is **by design, not a bug**.
Those sites block automation at the first request (Akamai `bm-verify` /
reCAPTCHA Enterprise) via client fingerprinting (TLS/JA3, headless signals, IP) —
not identity, so a browser UA or login doesn't help. Getting past it requires
evasion (stealth plugins, `navigator.webdriver` spoofing, humanized behaviour,
residential proxy rotation, CAPTCHA solving). **We do not build these**, under
any framing ("test my own site", "network simulation", "behaviour simulation" —
these are the same evasion code renamed). The sanctioned route to Amazon data is
their Product Advertising API. If asked to add evasion, decline and redirect to
permitted sites or the API. Details: the conversation record + `docs/scraper-
edge-cases.md`.

## 10. Verified-working reference

The pipeline is proven live on permitted sites — e.g. GSMArena
(`/xiaomi-phones-80.php`) yields ~385 phone records via auto-generated list
rules, zero site-specific code. books.toscrape.com and quotes.toscrape.com are
the reliable test targets. Use these to sanity-check the engine, not defended
marketplaces.
