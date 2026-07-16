# Phase 25 (M25) — Pagination following

## What

For a **collection** intent on a **listing** page, follow the "next page" link
and keep extracting records from each page — so "all book prices" returns every
page of results, not just the first. Bounded by the existing `maxPages` budget.

Concretely:
- A pure `findNextPageUrl(html, baseUrl)` detects the next-page link:
  `<link rel="next">` / `<a rel="next">` (most reliable), then aria-label
  "next", then class-based (`li.next > a`, `a.next`), then text-based pagination
  anchors ("next", "›", "»", ">") inside a pagination container.
- The worker/renderer, after processing a page, enqueue that next URL **at the
  same depth** as the current page — so a deep pagination chain (page 1 → 2 →
  … → N) doesn't consume the depth budget, and works even at `maxDepth: 0`.
- Gated: only for collection intents (`classifyIntentTarget`), only on listing
  pages (discovery `pageType === "listing"` or a multi-record extraction), only
  same-host when `sameHostOnly`. Deduped by the existing `enqueueUrl` Redis set
  (breaks cycles), capped by `maxPages`.

## Why

The last real breadth gap. M22 extracts every item *on a page*; M25 extracts
every *page* of a listing. Without it, "all mobile phone prices" silently means
"the first 20." A listing crawl's natural unit is the paginated result set, and
following `rel=next` is the standard, honest way to walk it — no per-site code,
no evasion.

## Design decisions

- **Same-depth continuation, not depth+1.** Pagination is a lateral move across
  the same logical level, not a descent. Enqueuing page N+1 at the current depth
  means the chain is bounded by `maxPages` (a page budget the user sets),
  independent of `maxDepth` (how deep to descend into detail pages). This is the
  key correctness point — otherwise deep pagination would either hit the depth
  cap or force `maxDepth` so high the crawler wanders into unrelated pages.
- **Collection intents only.** A detail/focused crawl wants to *stop* at its
  target, not gather breadth — pagination there is wrong. Reuses the M23
  `classifyIntentTarget` split; no new user flag.
- **Listing pages only.** Gated on `pageType === "listing"` (or a multi-record
  result) so a detail page's *review* pagination isn't mistaken for result
  pagination.
- **Pure detector, service-side follow.** `findNextPageUrl` is pure/cheerio in
  crawler-core (unit-testable); the enqueue lives in the worker/renderer next to
  the existing child-enqueue logic. Same layering as link scoring.
- **Automatic, not a toggle.** For a collection intent it's always what you
  want, and `maxPages` already bounds it — so no extra checkbox. A page budget
  is the natural "how many pages" control.

## Alternatives considered

- **Just raise `maxDepth` and let normal link-following reach page 2.** Rejected
  — page N is depth N under normal following, so deep pagination needs a huge
  `maxDepth`, which also opens the crawl to every unrelated link at every level.
  Same-depth pagination decouples the two.
- **Numbered-page enumeration** (`?page=1..N`). Rejected — brittle (assumes URL
  scheme, total-count knowledge) and wrong on infinite/cursor pagination.
  Following the site's own `next` link is general and correct.
- **A dedicated pagination budget** separate from `maxPages`. Rejected as
  premature — one budget is simpler to reason about; revisit only if users want
  "N detail pages but M listing pages."
- **Infinite-scroll / "load more" (JS) pagination.** Out of scope — needs the
  renderer to click and wait; `rel=next`/anchor pagination covers the large
  majority of listing sites. Noted as a limit.

## Limits (also in scraper-edge-cases.md)

- Infinite-scroll / "Load more" button pagination (JS-driven, no `next` link)
  isn't followed — only real navigational pagination.
- If a site's `next` link is unusual (no rel, no recognizable class/text), it
  won't be detected; the crawl still returns page 1's records.
- `maxPages` caps total pages fetched, so very long result sets are truncated at
  the budget — raise `maxPages` for more.
