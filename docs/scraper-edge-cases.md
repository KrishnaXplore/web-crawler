# Scraper edge cases

Known edge cases and limitations of the extraction pipeline, organized by the
stage where they bite. Most of these were discovered through live testing
(Amazon, Netflix, books.toscrape.com, Wikipedia, msrit.edu), not speculation —
each entry says what happens, why, and what (if anything) mitigates it.

## Reaching the page

**robots.txt disallow → the page is skipped, silently from the data's point of
view.** With "Respect robots.txt" on (the default), a disallowed URL produces
`outcome: "skipped-robots"` and no row. Some sites use default-deny with a
named allowlist (seen live on Netflix: `User-agent: * → Disallow: /`, then
explicit `Allow` for Googlebot/ClaudeBot/etc.) — our honest UA isn't on such
lists, so the whole site yields nothing. This is by design; we don't spoof the
crawler identity to bypass an explicit access policy.

**Bot-challenge pages look like successful fetches.** A challenge page (seen
live: Amazon's Akamai `bm-verify` page) returns HTTP 200 with real HTML — just
not the product's HTML. `looksLikeBotChallenge()` catches the common shape
(tiny page + almost no links + marker phrases like `bm-verify`, `captcha`,
"checking your browser") and records `httpChallengeSeen` on the domain profile,
so the *next* crawl in `auto` render mode uses the browser. Consequence: the
**first** crawl of a challenge-protected domain can come back empty; re-running
the same job usually works. A challenge page that doesn't match the heuristic
is stored as if it were content.

**JavaScript-only sites extract nothing in HTTP mode.** Same first-crawl
pattern: `auto` mode only learns a domain `needsRender` from evidence, so the
first pass on a fresh JS-heavy domain may fetch empty shells. Workaround:
explicitly pick "Browser" render mode for sites you know are JS-rendered.

**Rate limiting.** The Gemini call (Tier 4) retries once after 3s on a 429,
then gives up for that page. A site rate-limiting the crawler mid-job produces
error rows for the affected pages; there is no per-domain backoff yet.

## Deciding what to extract (tier routing)

**No intent → no AI, ever.** Tier 4 only fires when the job has an intent
string. Without one, you get whatever the page already publishes (JSON-LD /
microdata / OpenGraph) plus any stored rule for the domain — a page with
neither yields an empty row.

**Intent coverage only understands known field concepts.** `isIntentCovered()`
recognizes price, brand, title/name, author, description, rating, and date
(plus aliases). An intent keyword outside that table — "warranty", "isbn",
"ingredients" — gets the benefit of the doubt: if Tier 1 found *anything*
confident, the router assumes the intent is covered and does **not** escalate
to the LLM. Symptom: you asked for a field, Tier 1 returned other fields, and
the one you wanted never appears. Workaround: also use one of the recognized
concepts in the intent, or crawl a page where Tier 1 finds nothing (forcing
escalation).

**An intent made only of stopwords is treated as covered.** "get me all of it"
tokenizes to nothing, so no escalation happens and no rules are generated.

**Listing pages extract multiple records; misclassification changes the mode.**
Since M22, a page classified as `listing` runs the rules tier in list mode
(one record per repeating item container) while Tier 1 (structured) stays
skipped there. A *detail* page misclassified as a listing (possible on pages
with no schema markup, where classification falls back to link-density
heuristics) gets list-mode treatment — usually zero or garbled records. The
reverse also happens: a listing that slips through as `detail` extracts one
record, e.g. one arbitrary product's JSON-LD from a homepage carousel — seen
live on amazon.in's front page, which yielded a price belonging to a promoted
product, not to the page itself.

## Extracting (Tiers 1, 2, 4)

**Tier 1 only hoists known nested objects.** JSON-LD nesting is flattened by
picking `name`/`url`/`@id` from nested objects, with one special case for
`offers` (hoists `price`/`priceCurrency` — added after the generic logic was
found live to silently drop Amazon's price). Other nested structures
(`aggregateRating.ratingValue`, `author.jobTitle`, deep arrays) lose everything
except name/url.

**LLM-generated selectors can be subtly wrong.** Seen live: Gemini generated
`.price` for books.toscrape.com, whose real class is `.price_color` — the rule
"worked" (title matched) while the price column stayed empty forever.
Mitigations, in order of arrival: (M21) a stored rule whose output doesn't
cover the intent triggers regeneration, and the regenerated result only
replaces the old one if it's strictly better; (M17-era) hit/miss tracking
self-heals a rule whose hit rate drops below 30% over ≥5 uses by clearing it,
forcing regeneration on the next intent-carrying crawl.

**One rule per domain per kind.** The Rule Library keeps one detail rule and
one list rule per hostname (M22) — they version and self-heal independently,
so a broken list rule can't take down a working detail rule. Within a kind,
though, every page template still shares one selector set: a detail rule
generated from a product page fails on that domain's article pages; the misses
accumulate and can self-heal away a rule that works fine on the template it
was made for. Big multi-template sites are the worst case.

**Regeneration needs an intent to recover.** Self-heal clears a stale rule's
fields; the regeneration only happens on a later crawl that carries an intent.
Intent-less crawls of that domain extract nothing from the rules tier
indefinitely.

**Prices are normalized; other values are still raw text.** Since M24, a
price-like field (`"₹99,499.00"`) also emits `<field>_amount` (a real number,
`99499`) and `<field>_currency` (`INR`) alongside the original — those are the
spreadsheet-usable columns. Normalization is best-effort: ambiguous European
`1.234`-style grouping, price *ranges* (only the first number is taken), and
symbol ambiguity (`¥`→JPY not CNY, `$`→USD) are known limits. Everything
non-price (ratings like `"4.5 out of 5 stars"`, units like `"128GB"`, dates)
is still raw text with no parsing — deliberately out of M24's scope.

## Focused-crawl mode (M23)

**Focused mode helps most on gradual crawls, not seed-fan-out crawls.** The
early-stop flag prevents *new* enqueues once a detail intent is satisfied; work
already queued still drains. If the seed page fans out to more links than the
page budget in one hop (e.g. a homepage with 50 category links), the budget is
consumed at depth 1 before any detail page completes, so the early-stop can't
reduce the count. Clean win case (verified live): seeding a product page
directly with a detail intent crawled 1 page vs 40 for the same non-focused
crawl. It shines on search → product-page navigation, less on wide hub seeds.

**Detail-link prioritization relies on conventional product URLs.** `focusLinks`
boosts links matching `/dp/`, `/p/<id>`, `/item/`, `/gp/product/`. A site with a
non-standard product URL scheme (books.toscrape's `/catalogue/slug_id/`) won't
get the boost — those links are still crawled (never dropped, only
deprioritized), just not prioritized ahead of hubs. So focused mode navigates to
products fastest on sites using common URL conventions.

**The collection-vs-detail split is heuristic.** `classifyIntentTarget` reads
intent grammar (plural nouns, "all"/"every" → collection; "this"/"specs of" →
detail) and defaults to detail when ambiguous. A collection mislabelled "detail"
self-corrects at runtime — the early-stop only fires on a *single-record* page,
so reaching a listing (many records) overrides it. A detail mislabelled
"collection" just loses the early-stop optimization, never correctness.

## Discovering pages (link scoring)

**Keyword scoring is literal substring matching.** "mobile phone" prioritizes
links whose URL or anchor text contains "mobile" or "phone" — it will not
connect "smartphone", "cell", or a Hindi anchor text to the same concept.
Synonym-blind by design (semantic ranking is a deliberate non-feature until
evidence demands it — see docs/phase16.md).

**The page budget can still cut the good pages.** Scoring reorders links
before enqueueing, but `maxPages` is enforced at enqueue time; on a site where
the first fetched pages fan out into hundreds of links, relevant links found
later can lose the race. Raising Max pages is the lever.

**Pagination is followed for collection intents on listing pages (M25).** A
"next page" link (`rel=next`, or a recognizable pagination anchor) is walked as
a same-depth continuation, bounded by `maxPages` — so "all book prices" spans
every page, not just the first. Limits: only navigational pagination is
followed, not JS **infinite-scroll / "Load more"** (no `next` link to follow);
an unrecognizable next-link (no rel, unusual class/text) isn't detected; and
`maxPages` truncates very long result sets (raise it for more).

**Path hints cap at 20 per domain.** Learned "this path worked for this
intent" hints are kept most-recent-first; a domain used for many different
intents rotates old hints out.

## Output (table, CSV, JSON)

**CSV columns are the union across pages.** A field extracted on one page and
not another leaves empty cells — that's normal, not data loss. Pages where
nothing was extracted are excluded from the CSV entirely (a crawl of 10 pages
with 1 product yields 1 row); the JSON export is the complete record of every
crawled page.

**An extracted field named `url` is folded out of the CSV columns** to avoid a
duplicate header with the fixed source-page column (spreadsheet apps mishandle
duplicates). Extracted `title` IS a real data column — on a listing page every
record has its own title, so it can't be folded into per-page metadata.

**Non-string values are JSON-stringified into their cell.** An extracted array
or object lands as JSON text in one cell.

**The on-screen table shows at most 200 pages; the CSV/JSON exports are always
complete** (they stream every persisted page server-side).

## Limits

- `maxPages` caps at 1000, `maxDepth` at 10 (validated at job creation).
- Data deeper than `maxDepth` clicks from the seed is never reached.
- With "Same host only" on (default), links to other hosts — including a
  site's separate product/CDN subdomains — are not followed.
