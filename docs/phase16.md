# Phase 16 (Milestone M16) — Discovery Engine (Goal-Driven Navigation)

> Written before any code, per convention. This is a genuine design collaboration:
> the shape below is the user's proposal (hybrid heuristics → website profile →
> semantic ranking, gated by confidence), refined against what the codebase
> actually does today — four corrections came out of that check, captured in
> "Refinements from design review" below, each backed by reading the real code,
> not assumption.

## The problem

Every milestone so far assumed the operator already knows *which page* has the
data. `intent` ("extract the product title and price") tells the Extraction
Engine what fields to pull once it's looking at the right page — it says
nothing about which page that is. A non-technical user describing a goal —
*"I want all laptops from Amazon"* — doesn't know and shouldn't need to know
that means `amazon.in/s?k=laptop`, and evidence from this session shows what
happens without that knowledge: seeding a crawl at a homepage or a listing page
either extracts nothing (discovery correctly identifies it as a hub, not a
target, and skips it) or burns the page budget wandering through unrelated
links before — if ever — reaching something relevant.

There is currently no component that answers *"which pages should I even go
to?"* — only components that decide, once on a page, whether to extract from
it. This milestone adds that missing piece.

## Architecture

```
        User Goal ("extract laptops from Amazon")
              │
              ▼
        Discovery Engine  ◄──── NEW component, sits ahead of extraction
              │
   ┌──────────┼──────────────────┐
   │          │                  │
   ▼          ▼                  ▼
Stage A    Stage B            Stage C
Pre-fetch  Website Profile    Semantic Ranking
heuristics (learned per-domain (LLM, gated —
(free)     shortcuts, M12      only when A+B
           extension, cheap)   are inconclusive)
   │          │                  │
   └──────────┴──────────────────┘
              │
              ▼
      Prioritized link queue
              │
              ▼
     Crawler Spine (existing) ── fetches pages in priority order
              │
              ▼
   Extraction Engine (existing) ── runs on every fetched page, same as today
```

Discovery does not replace the crawler or the Extraction Engine — it sits
between "a page was just fetched and yielded links" and "which of those links
get crawled, and in what order," reusing the same escalating-cost philosophy
as the Extraction Engine's confidence router (Tier 1 → 2 → 4): try free first,
escalate only when free wasn't enough.

## Refinements from design review

Four corrections to the original proposal, each verified against the actual
code before being written down here — not assumptions:

**1. Interleaved, not two sequential passes.** The original shape drew
discovery and extraction as sequential phases (finish discovering, then start
extracting). Implemented literally, that means crawling every relevant page
*twice* — once to discover it's relevant, once to extract from it — doubling
HTTP traffic. The actual shape: discovery scores and *orders* the link queue;
extraction still runs inline on every fetched page exactly as it does today
(`runPlugins()` after every successful `crawlUrl()`, unchanged). A page fetched
"for discovery" that turns out to have a price on it doesn't need a second
visit.

**2. Stage A heuristics split across two different moments, because the data
isn't all available at the same time.** URL path and anchor text can be scored
*before* fetching a candidate link — cheap, works off the parent page's already
fetched DOM. But "does this page have Product schema" cannot be known before
fetching it. So Stage A is really two things: a **pre-fetch scorer** (new —
this milestone) that ranks *candidate* links using URL/anchor-text signals to
decide *crawl order*, and the **existing `discoveryPlugin`** (M14, unchanged)
that classifies an *already-fetched* page as listing/detail/unknown to decide
*extraction eligibility*. Same "cheap heuristic" spirit, two different jobs,
two different inputs.

**3. Semantic ranking needs a concrete trigger, not "if unsure."** Gate
condition: escalate to Stage C for a page's candidate-link set only when Stage
A produces no confident winner — every candidate link scores at or near zero
— **and** the candidate count exceeds the remaining page budget (otherwise
there's nothing to disambiguate; just crawl all of them). This keeps the
escalation rare: most real sites have *some* nav structure that scores
non-trivially (a "Faculty" link literally contains "faculty"), so most crawls
never reach Stage C at all. One LLM call per ambiguous hub page (ranking a
short list of links), never one call per candidate link — the mistake the
"AI for every page" option would have made, and the exact failure mode already
observed this session (Gemini's free-tier 15 req/min cap got exhausted
mid-crawl on msrit.edu from *per-page* extraction calls; per-link discovery
calls would be worse).

**4. The actual budget-allocation mechanism is sort-before-enqueue, not BullMQ
job priority — verified by reading `enqueueUrl()`.** The original discussion
proposed BullMQ's `priority` option as the prioritization mechanism. Checking
`packages/queue/src/enqueueUrl.ts` shows the page budget (`maxPages`) is
enforced by rejecting a URL outright the moment the running "seen" count
exceeds the cap (`redis.scard(...) > maxUrls → reject, never queued`) — a hard
gate at enqueue time, not a soft deprioritization. BullMQ's per-job `priority`
field only affects *processing order among jobs already in the queue*; it
cannot rescue a link that was already rejected at the budget gate before
priority ever had a chance to matter. So the mechanism that actually
determines *which* links survive the budget is: **sort a page's discovered
links by score before the enqueue loop runs**, so high-scoring links claim
budget slots first (`packages/queue` version confirmed: `bullmq ^5.34.0`, which
does support `priority` — worth setting too, as a secondary refinement for
cross-page ordering once things are already queued, but it is not sufficient
by itself).

## What's built in this milestone (Step A only)

Given the cost/value ordering above, this milestone builds **Stage A's
pre-fetch scorer only** — the free, always-on tier. Stages B and C are
designed here (so the interfaces they'll need are anticipated) but not built;
seeing Step A's real hit rate first is what should decide whether B/C are
worth their cost, matching the pattern M11 used (Step 1 shipped, Step 2
deferred pending evidence).

### A concrete gap this surfaces: anchor text is currently thrown away

`extractLinks()` (`packages/crawler-core/src/pipeline/extractLinks.ts`)
returns `string[]` — bare normalized URLs. The anchor text (`<a>Faculty</a>` →
`"Faculty"`), which is the single highest-value free signal for scoring, is
read from the DOM and then discarded. This has to change: `extractLinks`
needs a variant (or an added option) that returns `{url, anchorText}[]`
instead of bare strings, and `CrawlResult.links` needs to carry that through
instead of `string[]`. This is a real, mechanical prerequisite, not a detail —
without it there is no anchor text for a scorer to read.

### The scorer

New pure module, `packages/crawler-core/src/discovery/linkScorer.ts` (pure —
no I/O, unit-testable without a DOM or network, same discipline as the rest of
crawler-core):

```ts
export interface LinkCandidate {
  readonly url: string;
  readonly anchorText: string;
}

export interface ScoredLink extends LinkCandidate {
  readonly score: number; // 0 = no signal, higher = more likely relevant
}

export function scoreLinks(
  candidates: readonly LinkCandidate[],
  intent: string,
): ScoredLink[];
```

Reuses the *same* `intent` string already collected for extraction — the user
types one goal, it drives both "where to go" and "what to pull out once
there," exactly matching the one-input philosophy from the design ("User →
goal → platform figures out the rest").

Scoring signals (cheap, deterministic, no network):
- **Keyword overlap** — extract content words from `intent` (lowercase,
  strip stopwords: a/the/from/extract/want/all/of/in/on/get/i/my/…), match
  against anchor text and URL path segments (substring, so "laptop" matches
  "laptops"). Strongest signal.
- **Structural category patterns** — URL paths matching common hub shapes
  (`/category/`, `/products/`, `/department/`, `/faculty/`, `/news/`,
  `/search`, `?q=`, `?k=`) get a smaller boost even without a keyword hit,
  since these structurally tend to lead toward content rather than away from
  it (about pages, policy pages, login, etc. don't match these patterns and
  score lower by default).
- No match → default low score. Not excluded — still crawled if budget allows
  once nothing better remains, so it degrades to today's behavior rather than
  failing closed.

### Wiring into worker/renderer

The `for (const link of result.links) { await enqueueUrl(...) }` loop (present
almost identically in both `services/worker/src/index.ts` and
`services/renderer/src/index.ts`) sorts `result.links` by `scoreLinks(...,
cfg.intent)` descending before the loop runs, when `cfg.intent` is set. No
`intent` → no scoring → today's order (unchanged), so this is purely additive
for existing jobs that don't use `intent`.

## What's designed but NOT built this milestone (Steps B and C)

**Step B — Website Profile reuse.** Extend the M12 domain profile
(`packages/db/src/models/domainProfile.ts`) with a small memory of
"intent keyword → path that worked" per domain, written once a crawl following
a scored link actually reaches a page where extraction produced a non-empty
result. A later crawl on the same domain with keyword-overlapping intent
checks this before running Stage A fresh. This is the same "isolated, optional,
degrades to nothing if absent" shape as the Rule Library — pure win on repeat
crawls, zero cost on the first one.

**Step C — Semantic ranking escalation.** One LLM call (same `LlmSocket`
interface, same Gemini backing as Tier 4 — no new provider integration needed)
ranking a short candidate-link list against `intent`, only under the gate
condition in refinement #3 above.

Both are deferred so Step A's actual hit rate — does keyword/structural
scoring alone get real crawls to the right pages on real sites — can be
measured before spending more design or implementation on B and C. If Step A
turns out to be sufficient most of the time, B and C shrink to true edge-case
handling rather than load-bearing infrastructure.

## What this is not

- Not a guarantee. A badly-worded intent or a site with genuinely opaque
  navigation (no nav menu, JS-only routing) can still miss. Stage A is a
  prioritization heuristic, not a search algorithm with a correctness proof.
- Not a change to `maxPages`/`maxDepth` semantics — the budget is the same
  hard cap as before; this changes *which* pages spend it, not how large it
  is. A goal that needs 500 product pages still needs `maxPages` set high
  enough to reach them.
- Not per-link AI calls, ever — refinement #3 exists specifically to prevent
  the "too expensive for production" failure mode identified during design.

## Exit criteria

- `scoreLinks()` is a pure function, unit-tested without network/DOM
  dependencies (keyword match, structural pattern match, no-match default,
  empty-intent passthrough).
- `extractLinks()` (or a new variant) returns anchor text alongside each URL;
  existing callers that only need bare URLs are unaffected.
- A job with `intent` set and a seed at a hub/listing page (e.g. a category
  page with a nav menu containing an obviously-relevant link) crawls the
  relevant link before less-relevant ones, verified against a real site the
  same way every other milestone this session was verified — a live crawl,
  not just the unit suite.
- A job with no `intent` set behaves identically to before this milestone
  (no regression for existing jobs).
