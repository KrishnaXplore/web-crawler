# Phase 23 (M23) — Focused-crawl mode (goal-driven navigation)

## What

An opt-in crawl mode that navigates *toward the pages that answer the intent*
and stops once the intent is satisfied, instead of expanding breadth-first to
the page budget. Three cooperating parts, all **site-agnostic** (no per-site
code — the property the whole platform is built on):

1. **Intent target-type classification.** A pure helper classifies the intent
   as **detail-bound** ("the specs / price / brand of *this* phone" — one record
   is the goal) or **collection-bound** ("*all* mobile phone prices" — many
   records are the goal). This single distinction drives everything else,
   because "have I collected enough?" means two completely different things for
   the two cases (docs/phase21-era discussion — the trap of treating "enough"
   as one question).

2. **Focused link filtering.** In focused mode with a *detail* intent, the
   enqueue step doesn't just *score* links (M16) — it *filters* to the ones that
   lead toward a product/detail page (the `detail_url_pattern` conventions added
   in the M22 follow-up: `/dp/`, `/p/<id>`, `/item/`, plus category/search hubs
   that bridge to them), and drops obvious non-targets (login, cart, about,
   help). Fewer wasted fetches, faster arrival at the answer. Collection intents
   keep the M16 scoring (breadth matters there — you *want* every product link).

3. **Coverage-driven early stop.** The `isIntentCovered()` check (M17), which
   today decides *per page* whether extraction covered the requested fields, is
   lifted to the *job* level:
   - **Detail intent** → once any page's extracted record covers the intent's
     recognized fields, set a Redis "goal met" flag for the job; subsequent
     enqueue calls short-circuit. The crawl winds down instead of burning the
     rest of the budget on pages it doesn't need.
   - **Collection intent** → coverage is satisfied on the first listing page, so
     it is explicitly **not** used as a stop signal. Breadth is bounded by the
     existing `maxPages`/`maxDepth` budget (quantity-bound, not coverage-bound).

Focused mode is a new optional `focusedCrawl?: boolean` on the job config,
default off — every existing crawl behaves exactly as before.

## Why

Two motivations, established over the preceding design conversation:

- **Efficiency / cost.** Breadth-first crawling opens pages the user never asked
  about. A "find this phone's specs" request shouldn't fetch 50 category pages
  to find 1 product page. Navigating toward the target and stopping when
  satisfied cuts requests, bandwidth, latency, and (for the LLM tier) cost.
- **It's the general, site-agnostic answer** the user explicitly wanted over a
  per-site connector. Focused mode adds *no* bespoke extraction logic; it reuses
  discovery classification, `isIntentCovered`, and `detail_url_pattern`, all of
  which already generalize across domains. The LLM still generates the actual
  selectors per-domain automatically — nobody writes "how to read site X".

Explicit non-goal: this does **not** grant access to sites that block crawlers
(Amazon/Flipkart). Focused mode makes the crawler efficient *where it is allowed
in*; it is not a route past bot protection. The reCAPTCHA/Akamai wall on those
sites is at the first request, so navigating "smarter" changes nothing there.

## Alternatives considered

- **One "enough?" stop condition for all intents.** Rejected — the core insight
  of this phase. Stopping a collection crawl at the first covered record would
  return 20 phones when the user wanted 500; never stopping a detail crawl
  wastes the whole budget. The classifier split is the design.
- **A separate AI "planner" call to pick the next page** (the earlier "Intent
  Planner AI #1" idea). Deferred, same reasoning as the Discovery Stage C
  debates: the rule-based `detail_url_pattern` + keyword scoring already gets to
  the product page on real sites; an always-on planner call adds latency and
  cost for a decision the cheap heuristic makes correctly. Escalate to it only
  if the heuristic is shown to fail.
- **Hard-filtering links (dropping non-matches entirely) for collection
  intents too.** Rejected — a collection crawl legitimately wants breadth, and
  the seed's own links to individual products often *don't* keyword-match the
  intent (a phone's URL is its model name, not "phone"). Filtering there would
  starve the very crawl it's meant to help; scoring (soft priority) is correct
  for collections, filtering (hard) only for detail.
- **Making focused mode the default.** Rejected — it changes crawl semantics
  (early stop, dropped links); existing jobs and the Console's general crawl
  should be untouched. Opt-in, surfaced on the Scraper page.

## Notes / limits

- "Covered" only recognizes the M17 field-concept vocabulary (price, brand,
  title/name, author, description, rating, date). A detail intent whose fields
  are all *outside* that vocabulary never trips the early-stop and falls back to
  the normal budget — same known limitation as M17, documented in
  scraper-edge-cases.md.
- Early stop is best-effort and racy by nature: in-flight pages already past the
  budget check still complete. The goal flag prevents *new* enqueues, it doesn't
  cancel work already queued. That's acceptable — it caps waste, doesn't need to
  be exact.
- Pagination-following for collection intents remains out of scope (noted in
  M22) — focused mode changes *whether* we descend to detail pages, not how far
  we page through a listing.
