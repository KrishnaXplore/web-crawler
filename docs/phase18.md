# Phase 18 (Milestone M18) — Discovery Engine Step B: Learned Per-Domain Shortcuts

> Written before code. This is the Step B deferred in `docs/phase16.md`: the
> free heuristic scorer (Step A, shipped) works from nothing every crawl; Step
> B lets a domain's *own crawl history* make the next crawl on it cheaper and
> more accurate, reusing the M12 domain-profile infrastructure that already
> exists for exactly this kind of "remember something about this domain."

## What it solves

Step A's link scorer starts from zero every single crawl — even the second
crawl on a domain it already successfully navigated gets no benefit from the
first. If a crawl on `amazon.in` with intent "mobile phones" already
discovered that `/mobile-phones/b/...` is where the goods are, a later crawl
with an overlapping intent should not have to re-discover that from scratch —
it's the same "cheapest-first, escalate only when needed" principle Step A
itself follows, one level up: a stored answer beats *any* live computation,
free or not.

## Design

### Data model — extending the existing domain profile, not a new one

`domainProfiles` (M12, `packages/db/src/models/domainProfile.ts`) already
exists to hold exactly this kind of "objective facts learned about a domain."
Adding a `pathHints` array to it is a direct extension, not a new
subsystem:

```ts
pathHints: [{
  keywords: [String],   // the intent keywords that led here (M17's keywordsFromIntent)
  path: String,          // the URL *path* that worked (no domain, no query string)
  confirmedAt: Date,
}]
```

Capped at the 20 most recent hints per domain (`$push` + `$slice`), so a
long-lived domain profile doesn't grow unbounded. No de-duplication on write
in this first pass — a path that keeps confirming itself just appears more
than once in the list, which is a simplification, not a correctness problem
(the read side treats any match the same regardless of how many times it
appears).

### Write side — record a hint only when a scored link paid off

After a page's extraction actually produces a non-empty result (`structured`
or `rules` confidence `!== "none"`) **and** the job has an `intent` set, the
worker/renderer record a hint: this page's URL path, tagged with the
intent's keywords. Only pages reached via the crawl (not necessarily only
Discovery-scored ones — the seed page counts too, since a seed *chosen* by
the operator is itself a confirmed-good starting point) contribute a hint.
Best-effort, same convention as `recordDomainObservation`: never fails the
crawl.

### Read side — a known-good path outranks a keyword guess

Before scoring a page's discovered links, the worker/renderer fetch the
domain's profile (one extra Mongo read per page with outgoing links — cheap,
same cost class as the render-mode profile lookup that already happens at job
creation). `scoreLinks()` gains an optional third parameter: the domain's
`pathHints`, filtered to those whose `keywords` overlap the current crawl's
intent keywords. A candidate link whose path matches a surviving hint scores
**above** a plain keyword match (`50` vs. `10`) — it's not a guess anymore,
it's confirmed history for this specific ask on this specific domain.

`scoreLinks(candidates, intent)` (no third argument) behaves exactly as
before — this is purely additive, matching Step A's own "no intent → no
scoring change" non-regression guarantee extended one level: no path hints →
no scoring change either.

| Decision | Alternative | Why |
|---|---|---|
| Extend `domainProfiles`, not a new model | A dedicated `pathHints` collection | The whole point of the M12 domain-profile layer is to be the one place a domain's learned facts accumulate — tech stack, render mode, and now navigation shortcuts are the same *kind* of fact (something true about this domain, learned by crawling it), not different concerns. |
| Match hints by keyword overlap with the *current* intent | Store one hint set per domain, ignore intent differences | A domain crawled once for "mobile phones" and once for "laptop deals" has two different useful paths — matching without checking intent overlap would boost the wrong path for the wrong ask. |
| Known-good path scores above a keyword match, not merely tied | Score them the same | A path is only in the hint list because it *actually worked* before — that's strictly stronger evidence than "the anchor text contains a matching word," which is Step A's untested guess. |
| Cap at 20, no de-dup | Unbounded growth / dedupe-on-write | A cap bounds storage cost with no code complexity; de-duplication is a nice-to-have that doesn't change read-side correctness, deferred until evidence says the list is actually getting noisy. |

## What this is not

- Not Stage C (semantic ranking) — still zero AI calls in the discovery path.
  Stage C remains deferred, per phase16.md, pending evidence Step A+B aren't
  already enough most of the time.
- Not cross-domain learning — a hint learned on `amazon.in` says nothing
  about `flipkart.com`; the whole mechanism is scoped to one domain's own
  history, matching the rest of the Website Intelligence Layer's design.
- Not immune to a site restructuring its navigation — a stale hint just
  scores a now-wrong link highly; it doesn't *exclude* other links, so a
  restructured site still gets crawled, just without the head start it would
  otherwise have gotten. No expiry logic yet (another candidate for "add once
  there's evidence it's needed," not speculatively now).

## Exit criteria

- `pathHints` unit-testable at the pure-function level (`deriveProfile`
  includes them; a `matchingPathHints(hints, intentKeywords)` filter is pure
  and tested standalone).
- `scoreLinks()` with a matching path hint ranks that candidate above a
  plain-keyword-only match; with no hints (or the default omitted third
  argument), behavior is byte-identical to Step A.
- Live: crawl a domain with an intent once (Step A does the discovery work
  from scratch); crawl the *same* domain with an overlapping intent again —
  the second crawl's worker/renderer log (or the resulting page order) shows
  the previously-confirmed path scoring at the top before any page is even
  fetched.
