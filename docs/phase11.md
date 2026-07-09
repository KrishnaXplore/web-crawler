# Phase 11 (Milestone M11) — Extraction Engine (Step 1: structured data)

> Milestone **M11** — the shared **extraction engine** from
> [vision-no-code-extraction.md](vision-no-code-extraction.md): turn crawled pages into
> clean, typed records. Built rule-tiers-first, AI as an off-by-default socket. This
> doc is **Step 1: the structured-data tier** (JSON-LD → Schema.org microdata →
> OpenGraph), the cheap first pass the coverage experiment (§8b) showed covers ~40% of
> real pages for near-zero cost. CSS/XPath (Step 2) and the intent/AI layer come later.

Why start here: it's the highest yield-per-effort tier (self-labeling data, no per-site
config), it's pure and unit-testable, it reuses the plugin dispatcher, and every later
tier (CSS, AI) is a *fallback* from it — so it must exist first.

---

## Step 1 — the `structured` extractor

A plugin (same `AnalyzerPlugin` interface as seo/exposure) that emits a **normalized
record** from a page's embedded structured data, trying tiers in order and stopping at
the first that yields fields:

| Tier | Source | Notes |
|---|---|---|
| 1. JSON-LD | `<script type="application/ld+json">` | richest; handles `@graph`, arrays, `@type` |
| 2. Microdata | `[itemscope][itemtype]` + `[itemprop]` | Schema.org in-DOM (e.g. quotes.toscrape) |
| 3. OpenGraph | `<meta property="og:*">` | most common; a thin but reliable floor |

**Output** (stored under `analysis.structured`):
```jsonc
{
  "type": "Article",           // detected schema type, or "og:website", or null
  "source": "json-ld",         // which tier produced it
  "fields": { "headline": "…", "author": "…", "datePublished": "…", "image": "…" },
  "confidence": "high"         // high (json-ld/microdata) | low (og-only) | none
}
```

### Design decisions

| Decision | Alternative | Why |
|---|---|---|
| Tiered, first-hit-wins | merge all tiers | Keeps provenance clear (`source`) and confidence meaningful; JSON-LD beats an OG guess. A later "merge/enrich" mode can come once single-tier is proven. |
| Normalize into a flat `fields` map | store raw JSON-LD | A flat record is what export/datasets need; the raw blob is noise for a non-technical user. Raw is recoverable from `storeHtml`. |
| `confidence` = tier-derived | ML/heuristic score | Honest first cut: JSON-LD/microdata = high, OG-only = low. Real verification (cross-page consistency) is M14; don't fake it now. |
| A plugin, not a new pipeline | bespoke extract stage | The dispatcher already runs per page in worker + renderer; an extractor is just a plugin that emits a record. Zero new plumbing; the renderer path gives JS-site coverage for free. |
| Run on the **rendered DOM** when renderMode=browser | http only | §8b: JS sites need rendering to even reach the DOM (though it's not a silver bullet). Already free via M9. |

### Provenance (open-data ethics, vision §8)

When the `structured` plugin runs, the page record already carries `url` and
`fetchedAt`; the engine adds nothing secret. Dataset **license/attribution** capture is
a small follow-on (read `<link rel="license">` / a job-level license note) — noted here,
implemented with Step 2's export shaping so it's not half-done.

## Explicitly deferred (so Step 1 stays honest)

- **CSS/XPath tier** (operator/generated selectors) → M11 Step 2.
- **Discovery** (sitemap, listing-vs-detail, type-targeting) → M12. Step 1 extracts
  whatever page it's given; it does not yet *find* detail pages.
- **Intent → rules** (point-click / NL / AI) → M13.
- **Verification / self-heal** (real confidence) → M14.
- **AI fallback** → an interface seam only; no implementation.

## What's tested

- Pure unit tests on fixtures: JSON-LD `Article`/`Product` (incl. `@graph` and arrays);
  microdata with nested `itemprop`; OG-only floor; malformed JSON-LD ignored; a page with
  no structured data → `{ type:null, confidence:"none" }`. Tier precedence (JSON-LD wins
  over OG on the same page).
- Live: crawl bbc.com/news + wikipedia + quotes.toscrape with `plugins:["structured"]`;
  assert records extracted with the right `source`/`type`; export to JSON shows clean
  records.

## Exit criteria

- A crawl with `plugins:["structured"]` stores a normalized record per page that has
  structured data, with `type`, `source`, `fields`, `confidence`.
- JSON-LD beats microdata beats OG; malformed data never throws (plugin isolation holds).
- Records export via the existing JSON/CSV surface.
- Offline suite green; no AI; nothing probes or fabricates URLs.
