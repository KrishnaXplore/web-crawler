# Phase 21 — Two-page dashboard: Scraper vs. Console

## What

Split the dashboard into exactly two top-level pages:

1. **Scraper** (the default landing page) — for the north-star user: someone
   non-technical who wants data out of a website as a spreadsheet.
   - Same form controls as today (checkboxes stay — the user explicitly kept
     them), but with extraction-oriented defaults: `structured`, `rules`, and
     `discovery` pre-ticked, and the "What do you want to extract?" intent box
     placed prominently near the top.
   - **The results view is the actual change.** Instead of the crawl-mechanics
     table (depth / status / links), the Scraper shows a *data table*: columns
     are the extracted field names (`name`, `price`, `brand`, …) discovered from
     the results themselves — the same shape as the fixed CSV export — and rows
     are pages that actually produced data. Pages with nothing extracted are
     hidden behind a "show all crawled pages" toggle so menus/footers/404s don't
     drown the data.
   - A prominent **Download CSV** button.
   - When a finished job produced zero extracted rows, say so explicitly and
     hint at likely causes (robots disallowed, bot challenge, no recognizable
     data) instead of showing an empty table.

2. **Console** — everything else, essentially today's UI unchanged: the full
   crawl dashboard (report card, page rows, analysis previews, JSON export) plus
   the Exposure Audit, which moves from a top-level nav item to a small tab
   inside the Console. Top nav therefore has exactly two buttons.

Navigation is hash-based (`#/scrape`, `#/console`) so the current page survives
a refresh and can be linked — hand-rolled, no router dependency.

## Why

Live use showed the core problem wasn't feature crowding, it was that the
results view is organized around *how the crawler works* rather than *what the
user came for*. A user who typed "mobile phone" into the intent box got back
rows of URLs, HTTP statuses and link counts — the actual scraped data was
invisible (first fixed as a row preview, then as real CSV columns). This phase
applies the same lesson to the primary screen itself: the scraping audience
gets a spreadsheet-shaped view; the technical audience keeps the mechanics
view, one tab over.

Two pages instead of the previously-discussed three (Extraction / Security /
Developer): the audit and developer audiences are the same person in practice —
someone technical inspecting a site — so a third page was extra surface with no
extra clarity.

## Alternatives considered

- **Three workspaces (Extraction / Site Audit / Developer Console)** — rejected
  by the user in favor of two; the audit/developer split added navigation
  without adding clarity.
- **Hiding the checkboxes on the Scraper page** — rejected by the user
  ("keep the tick boxes. I don't have problem"). Plain-language checkbox labels
  (M19) already make them understandable; the defaults just change.
- **A router library (react-router)** — overkill for two pages; ~20 lines of
  hash handling gives refresh-safe, linkable pages with zero dependencies.
- **Backend changes / separate endpoints per page** — none needed. Both pages
  hit the same API; the split is purely presentational (which also keeps it
  cheap to revisit).

## Notes

- The Scraper's data-table column logic (merge `structured` + `rules` fields,
  `rules` wins on collision, union of keys across pages, `url`/`title` reserved)
  intentionally mirrors `extractedDataFor()` in the API's CSV export, so what
  the user sees on screen matches what downloads.
- `getPages` fetches up to 200 rows for the on-screen table; the CSV download
  remains the complete dataset (it iterates every persisted page server-side).
