# Vision & Research Plan — No-Code Extraction ("scraping for everyone")

> North star: **let a person with no technical knowledge turn any website into clean,
> structured data.** This document is the research plan for the next stage — it defines
> the direction, what we reuse, the hard problems, the research questions, and a phased
> roadmap. It is deliberately above the phase-doc level: we research and decide the
> wedge *before* speccing `phaseN.md` for implementation.

One-line pitch:
> *An intelligent extraction platform: describe the data you want (or point at an
> example), and it generates a reliable, self-checking extractor that runs on the
> crawler you already have — rule-based first, AI only when rules can't.*

---

## 1. The core problem: specification, not fetching

For a non-technical user the barrier was never crawling — the engine (M1–M10) already
fetches, renders JS, respects robots, scales, exports. The barrier is **specification**:
they cannot write CSS/XPath, don't think in URLs or selectors, and don't know what data
"shape" they're after. So the entire product reduces to one question:

> **How does a person express *what* they want without technical knowledge — and how do
> we turn that intent into a reliable, repeatable, self-healing extractor?**

Everything below serves that question.

## 2. What already exists (leverage) vs what's new

| Capability | Status | Role in the vision |
|---|---|---|
| Distributed crawl, depth/scope, dedup, completion | ✅ M1–M4 | visits the pages |
| Headless rendering (JS sites) | ✅ M9 renderer | reaches SPA/dynamic content |
| robots / rate-limit / SSRF | ✅ M4 | polite, safe collection |
| Plugin dispatcher (analyzers) | ✅ M5 | the extractor "engine" socket |
| `metadata` plugin (OpenGraph, canonical) | ✅ M6 | partial structured extraction |
| Streamed export (JSON/CSV) | ✅ M5 | dataset output |
| Report + dashboard | ✅ M8 | results UI to build on |
| **JSON-LD / Schema.org / microdata extraction** | ⬜ new | the cheap, high-yield rule tier |
| **CSS/XPath rule extractor (operator/generated rules)** | ⬜ new | targeted extraction |
| **Intent → rules layer** (point-click or NL) | ⬜ new | the accessibility breakthrough |
| **Discovery** ("which pages have the data") | ⬜ new | removes "I don't know the URL" |
| **Verification / confidence + self-healing** | ⬜ new | the research core |
| **Dataset provenance (source, license, date)** | ⬜ new | open-data ethics |

So ~70% of the *execution* stack exists. The research stage is the **top layer
(intent → rules)**, the **discovery layer**, and the **verification layer**.

## 3. Architecture

```
User intent
  ("names + prices from this shop"  OR  click the price on one page)
        │
        ▼
Rule generation  (ONCE per site)
  structured-data auto-map → heuristics → [optional AI] → CSS/XPath/schema rules
        │
        ▼
Discovery + crawl  (M1–M9)
  seed / sitemap → visit pages → renderer for JS → classify page type
        │
        ▼  run the generated rules cheaply per page
Extraction engine  (tiered, rule-based)
  JSON-LD → Schema.org/microdata → OpenGraph → CSS → XPath → [optional AI fallback]
        │
        ▼
Verification  (confidence score; flag low-confidence for review / self-heal)
        │
        ▼
Clean typed records + provenance → Export (CSV / JSON / NDJSON / Sheets / API)
```

Two design commitments carried from the research discussion:

**AI writes the scraper, it doesn't do the scraping.** Any AI assist runs **once** to
turn intent into rules (or to repair broken rules), not per page. The cheap rule engine
does the bulk work. This removes the cost/latency/hallucination objections and keeps AI
an **optional, off-by-default socket** — the system is fully functional on rules alone.

**You specify *what*, not *where*.** Discovery finds the pages: crawl broadly (optionally
sitemap-seeded), run rules on every page, keep pages that yield a confident record of the
target type. "I don't know which page" is answered by "any page the extractor is
confident on."

## 4. The hard problems (what "research properly" actually means)

These are where real no-code tools spend their effort; they are the substance of the
research stage, ranked by difficulty/interest:

1. **Verification without ground truth** — did a rule extract *correctly*? Defining
   "confidence" for extraction is the deepest open question. Signals to research:
   field-type validation, cross-page consistency, structured-data agreement, completeness.
2. **Self-healing** — sites change HTML; rules silently break and produce garbage or
   nothing. Detecting breakage and regenerating rules is largely unsolved and a strong,
   novel research angle.
3. **Generalization from one example** — a single sample page → correct rules for all
   similar pages, including missing fields and layout variants.
4. **Navigation / pagination** — "get all of it" across next-buttons and infinite scroll,
   generically, without per-site code.
5. **Anti-bot reality** — captchas, rate limits, IP blocks. Unglamorous but where much
   practical effort goes; scope it honestly (respect limits; don't build evasion).

## 5. Research questions (the framing that makes this a project, not a clone)

- Can we generate **reliable extraction rules from a single example or a natural-language
  intent**, and **verify** them **without ground truth**?
- Can the system **detect when its own rules have broken** on a site change and **self-
  repair** with minimal human input?
- **When is AI actually needed** vs when do structured-data + heuristics suffice — and can
  we **route to the expensive path only when confidence is low**? (the hybrid question, in
  service of accessibility)

Any one of these, answered well on real sites, is a legitimate contribution.

## 6. Competitive landscape & wedge (be honest)

The no-code space is crowded: Octoparse, ParseHub, Browse AI, Apify, Import.io,
Firecrawl, Diffbot. We do **not** try to out-feature them. We pick **one narrow wedge**
and go deep. Candidates, strongest first:

| Wedge | Why it's underserved | Fit here |
|---|---|---|
| **Self-healing extractors** | Everyone's scrapers break on site changes; few auto-repair | Research-shaped; differentiates hard |
| **Open-data harvesting + license provenance** | Tools ignore licensing/attribution; open-data teams need it | Clean (no privacy tension), on-brand, ethical |
| **Trustworthy extraction (verification you can see)** | Users can't tell if a no-code scrape is *right* | Directly serves "no knowledge" users |

Recommendation: pick **one** for the research stage (lean self-healing *or* open-data +
provenance). "Everything for everyone" is the trap.

## 7. Phased roadmap (post-M10)

Each becomes its own `phaseN.md` when we commit to build it. Ordered so every phase
ships value and nothing later blocks earlier.

| Phase | Theme | Contents (rule-based first; AI optional/off) |
|---|---|---|
| **M11 — Extraction engine** | the shared core | Step 1 ✅ structured tier (JSON-LD→microdata→OG); Step 2 ⬜ CSS/XPath tier drawing rules from the Rule Library; typed records; confidence; provenance export |
| **M12 — Website Intelligence Layer** | **per-domain memory (the differentiator)** | `@crawler/intelligence` + Mongo `domainProfiles` (global facts: tech, render-requirement, page-type map, content fingerprint) + `rules` (per-org Rule Library: versioned, hit-rate-scored). Consulted at crawl edges (READ before / WRITE after). **Underlies rule reuse (M11 Step 2), self-heal (M15), and analysis change-over-time.** See architecture-v3 §2.45 |
| **M13 — Discovery** | "which page" | sitemap ingestion; page-type classification (listing vs detail); type-targeted extraction (specify a schema/field set, not URLs). Uses the domain profile's page-type map |
| **M14 — Intent layer** | accessibility | point-and-click example → rule inference; natural-language intent → rule generation (heuristics; **optional** AI socket, never per-page); generated rules saved to the Rule Library |
| **M15 — Trust / self-heal** | the research core | verification/confidence surfaced; **falling rule hit-rate (from the Intelligence Layer) triggers self-heal**; "review low-confidence" queue |
| **M16 — Operate** | for real users | scheduled re-runs, change alerts (diff vs stored fingerprint), export to Sheets/API/webhook (webhooks already exist) |

**Sequencing note:** M11 Step 2's rule reuse and M15's self-heal both depend on the
**Intelligence Layer (M12)** — so the natural order is M11 Step 1 (done) → a thin
**M12** slice (domainProfiles + Rule Library skeleton + render-requirement memory) →
M11 Step 2 (CSS/XPath reading from it) → M13+. The exposure analyzer (M10) and the
analysis branch both also become consumers of the Intelligence Layer (change-over-time).

## 8. Ethics & licensing (different from the security side, still real)

Open ≠ do-anything. A credible open-data harvester:
- respects **robots.txt** and rate limits (already default),
- records **license** (CC-BY etc.) and **attribution** per dataset,
- stores **provenance** (source URL + fetch timestamp) on every record,
- does **not** build anti-bot/evasion or ignore a site's terms.

This is a feature and a differentiator, not a constraint.

## 8b. Coverage experiment — findings (2026-07-09, real data)

Ran the §9 experiment: fetched 10 real public sites (raw HTML) + re-rendered 3 JS-heavy
ones in headless Chromium, checking JSON-LD / microdata / OpenGraph presence.

**Raw-HTML structured-data coverage: ~40%** (4/10 had JSON-LD or microdata):
- ✅ bbc.com/news (JSON-LD WebPage), python.org (WebSite), wikipedia (Article),
  quotes.toscrape (microdata ×10).
- ❌ theguardian, MDN, books.toscrape, data.gov, eventbrite (raw HTML had none);
  allrecipes returned **402** (blocked).
- **OpenGraph is more common** than JSON-LD (bbc, python, data.gov, eventbrite) → a
  reliable low tier.

**Rendering did NOT rescue the ❌ sites** — Guardian/Eventbrite still showed 0 JSON-LD
after JS ran. Two honest reasons, both design-relevant:
1. **Structured data lives on DETAIL pages, not landing pages.** I probed homepages;
   JSON-LD concentrates on the specific article/event/product page. → **Discovery
   (reaching detail pages) matters as much as extraction.**
2. **Anti-bot / consent walls** serve a stripped page to bots (allrecipes 402, likely
   Guardian/Eventbrite). → **anti-bot is a real coverage ceiling; scope it honestly.**

**Design conclusions (corrected):**
- JSON-LD + microdata + OG is a worthwhile *cheap first tier* but covers **~40%, not the
  majority** → a **CSS/XPath tier is required**, not optional; and the long tail is where
  an AI rule-generator would (eventually) earn its place. The hybrid design is now
  justified by data, not assumption.
- **Reach detail pages** (M12 discovery) is as important as the extractor itself.
- Run extraction on the **rendered DOM** for JS sites, but don't expect rendering alone to
  fix coverage.

## 9. Research-stage checklist (do this before speccing M11)

1. **Prior-art survey** — use 3–4 tools (Browse AI, Octoparse, Firecrawl, ParseHub);
   record exactly where a non-technical person gets stuck. That gap is the opening.
2. **Measure structured-data coverage** — on ~10–20 real target sites, how often does
   JSON-LD / Schema.org alone yield the wanted fields? That number decides how much (if
   any) AI is actually needed. *This is the single most decision-relevant experiment.*
3. **Pick one wedge** (§6) and write it down as the project's POV.
4. **Draft the intent→rule loop** on paper, with **verification** front and center.
5. Only then: `docs/phase11.md` for the extraction engine.

---

**Summary:** you already own the execution engine. The next stage is research on the
three new layers — **intent → rules**, **discovery**, and **verification/self-healing** —
with AI as an optional rule-generator, never a per-page dependency. Build the rule-based
extraction engine (M11) as the shared foundation; the open-data harvester and the
exposure auditor both become consumers of it.
