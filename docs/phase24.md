# Phase 24 (M24) — Value normalization (price & currency)

## What

Extracted values today are raw page text: `"₹99,499.00"`, `"£51.77"`, `"13999"`,
`"Rs. 1,699"`. A spreadsheet can't sum or sort those. M24 adds a normalization
pass that, for price-like fields, emits two **additional** machine-usable
fields alongside the original:

- `<field>_amount` — a real number (`99499`, `51.77`, `13999`, `1699`)
- `<field>_currency` — an ISO-style code when detectable (`INR`, `GBP`, `USD`)

So `price: "₹99,499.00"` becomes `price: "₹99,499.00"`, `price_amount: 99499`,
`price_currency: "INR"`. The original is **never replaced** — it stays
human-readable; the derived fields are what formulas use. This flows through
everything automatically: the results table, the CSV columns, and the JSON
export.

Applied to Tier 1 (`structured`) fields, Tier 2/4 (`rules`) fields, and every
record of a multi-record listing.

## Why

This was the one correctness-adjacent gap the live test matrix kept surfacing:
extraction is *correct* but the output isn't spreadsheet-clean. A user who
scrapes 50 phone prices wants to sort by price or total a column — impossible
with `"₹99,499.00"` as text. Normalization is the difference between "data on a
screen" and "data you can actually work with," and it's the highest-value,
lowest-risk polish available.

## Design decisions

- **Additive, not destructive.** Keep the original string; add siblings. Lossless
  — the raw `"₹99,499.00"` is the human label, `_amount`/`_currency` the machine
  values. Users pick the column they need.
- **Value-driven detection first, field-name second.** A value carrying a
  currency symbol/token (`₹`, `$`, `Rs`, `INR`) is normalized regardless of field
  name. A field *named* price-like (`price`/`cost`/`mrp`/`amount`/`fee`) is
  normalized only if its value parses as a bare number. This pair avoids false
  positives — `rating: "4.5 out of 5 stars"` has no currency and isn't a
  price-named field, so it's left alone.
- **First number token, not global digit-strip.** Parse the first monetary
  number run in the string (`"4.5 out of 5"` → `4.5`, not `455`). Guards against
  concatenating unrelated digits.
- **Separator inference** handles Western (`1,234.56`) and Indian (`99,499.00`)
  grouping, with a best-effort European fallback (`1.234,56`). Documented limits
  below.
- **A separate pass, not inside `runPlugins`.** Extraction stays pure and its
  tests unchanged; `normalizeAnalysis(analysis)` runs in the worker/renderer
  right after extraction, before persist. Clean pipeline stage, no ripple into
  the confidence router or its tests.
- **Prices only (this milestone).** Ratings ("4.5/5"), units ("128GB"), and
  dates are deliberately out of scope — price is the flagged gap and the clear
  win. The normalizer is structured so those can be added later behind the same
  `_<suffix>` convention.

## Alternatives considered

- **Replace the original with the number.** Rejected — lossy. `"Rs. 1,699"`
  carries currency + formatting a bare `1699` drops, and some users want the
  display string.
- **Normalize in the CSV export only.** Rejected — then the on-screen table and
  JSON export stay raw, and the same logic would need duplicating. Normalizing
  once at extraction time feeds all three consumers.
- **A full money-parsing library.** Overkill for the shapes we see; a focused
  ~60-line parser covers ₹/$/£/€ + Rs/INR/USD and Western/Indian grouping, with
  no dependency. Revisit only if real data proves it insufficient.
- **Ask the LLM to return numbers.** Rejected — adds cost/nondeterminism to a
  problem a deterministic parser solves exactly, and Tier 1 (no LLM) needs it too.

## Limits (also in scraper-edge-cases.md)

- Ambiguous single-comma/dot European formats (`1.234` = 1234 or 1.234?) are
  best-effort; Western/Indian formats are reliable.
- A price *range* (`"£10 – £20"`) normalizes to the first number only.
- `¥` maps to JPY (could be CNY); `$` maps to USD (could be CAD/AUD). Symbol
  ambiguity is resolved to the most common default, not guessed per-site.
