# Phase 22 (M22) — Multi-record extraction from listing pages

## What

Today the scraper extracts **one record per page** and deliberately skips
listing pages ("navigation hubs, not extraction targets"). M22 makes listing
pages first-class extraction targets: a category page with 20 products yields
20 records — 20 rows in the results table and the CSV.

Concretely:

1. **List rules.** `ExtractionRule` gains `kind: "detail" | "list"` and
   `listItem?: string`. A list rule is the classic scraper pattern: a container
   selector that matches each repeating item (`.product_pod`) plus field
   selectors resolved *relative to each container* (`h3 a`, `.price_color`).

2. **Two rules per domain, not one.** The Rule Library keys list rules under
   `_id = "<domain>#list"` (detail rules keep the bare domain, so every
   existing stored rule remains valid with zero migration). Detail and list
   rules version, hit/miss-track, and self-heal independently — a broken list
   rule can't take down the working detail rule for the same domain, which was
   the failure mode the one-rule-per-domain design guaranteed.

3. **The tier router runs the rules tier on listings.** `discovery`'s
   `pageType: "listing"` used to skip both extraction tiers. Now it skips only
   Tier 1 (structured) — a listing's own JSON-LD is usually about the wrong
   thing (seen live: amazon.in's homepage carousel yielding one promoted
   product's price) — and runs the rules tier with the domain's *list* rule.
   Tier 4 fires under the same conditions as detail pages (nothing found, or
   intent not covered), but asks the LLM for a `listItem` + relative selectors
   instead of absolute ones. The M21 "keep whichever result is better"
   comparison applies unchanged.

4. **Records in results.** In list mode the rules output carries
   `records: [{...}, ...]` and keeps `fields` = the first record, so every
   existing consumer of `fields` (coverage check, path hints, hit/miss
   recording, row preview) works untouched. The CSV export and the Scraper
   table emit one row per record; a listing page contributes N rows.

## Why

This was the single biggest gap in the product-level rating that motivated the
milestone: the most common real scraping request is "all the items on this
page", and the current answer — crawl each item's detail page — costs N fetches
for data the listing already shows, and fails entirely when detail pages are
budget-cut or challenge-blocked. Every serious competitor does multi-record
extraction; it's what separates "a crawler with extraction" from "a scraper".

## Alternatives considered

- **Extract listing items via Tier 1 (ItemList JSON-LD / repeated microdata).**
  Deferred, not rejected — some listings do publish ItemList. But the sites
  where listing extraction matters most (books.toscrape-style catalogs, search
  results) mostly don't, and the JSON-LD flattener is one-record-shaped today.
  The rules tier gives one mechanism that works on both annotated and plain
  HTML; Tier 1 list support can come later behind the same `records` shape.
- **One combined rule document with `detail`/`list` sub-objects.** Rejected:
  every read/write/self-heal path would need restructuring, and hit/miss
  counters would need splitting anyway. The `#list` key suffix reuses all
  existing machinery per kind and needs no migration.
- **Auto-detecting repeating structures without the LLM** (DOM subtree
  clustering). Genuinely interesting, genuinely hard to do well; the LLM
  already sees the sample HTML and names the container reliably. Evidence-based
  escalation says don't build the clever heuristic until the LLM's answer
  proves inadequate.
- **`fields` as arrays in one record** (`title: [a,b,c], price: [x,y,z]`).
  Rejected: positional re-zipping is exactly the misalignment bug every
  scraping tutorial warns about (a missing price shifts every later value one
  row up). Per-container extraction keeps each record's values from the same
  DOM subtree.

## Notes / limits

- Pagination ("next page" of a listing) is explicitly NOT in M22 — the crawler
  already follows links, and listing pagination links score well when they
  match the intent keywords, but there's no dedicated "follow rel=next until
  budget" behavior yet.
- Records are capped at 100 per page (a selector accidentally matching every
  `<div>` shouldn't produce a 5,000-row page).
- A record with zero matched fields is dropped; a page whose list rule matches
  zero containers is `confidence: "none"` — the same regeneration signal as
  detail rules.
