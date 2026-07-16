/**
 * Focused-crawl intent classification (M23 — docs/phase23.md).
 *
 * Splits an intent into two goal shapes, because "have I collected enough?"
 * means fundamentally different things for each:
 *
 *  - "collection": the user wants MANY records ("all mobile phone prices",
 *    "list every book", "compare phones"). Coverage is satisfied by the first
 *    listing page, so coverage is NOT a stop signal — breadth is bounded by the
 *    page budget.
 *  - "detail": the user wants ONE record ("the specs of this phone", "this
 *    product's price and brand"). Once a single-record page covers the requested
 *    fields, the goal is met and the crawl can wind down.
 *
 * Pure and rule-based — same discipline as the extraction-tier plugins and the
 * link scorer. Ambiguous intents default to "detail": the conservative choice,
 * because the job-level early-stop that "detail" enables ALSO gates on runtime
 * evidence (it only fires on a *single-record* extraction — a listing page that
 * yields many records overrides the classification and keeps the crawl going).
 * So a collection mislabelled "detail" self-corrects the moment the crawler
 * actually reaches a listing; a detail mislabelled "collection" only loses the
 * early-stop optimization, never correctness.
 */

export type IntentTargetType = "collection" | "detail";

// Explicit "I want many" markers. Whole-word matched so "listing" doesn't hit
// inside "enlisting", etc.
const COLLECTION_MARKERS: readonly string[] = [
  "all",
  "every",
  "each",
  "list",
  "listing",
  "catalog",
  "catalogue",
  "compare",
  "comparison",
  "cheapest",
  "top",
  "best",
  "under",
  "range",
  "options",
  "multiple",
];

// Explicit "I want this one" markers — a singular determiner alone isn't
// enough ("a phone's price" is ambiguous), so we require these stronger phrases
// to actively pull toward detail against a plural noun.
const DETAIL_PHRASES: readonly string[] = [
  "this ",
  "specs of",
  "specification",
  "full details",
  "details of this",
  "review of this",
];

function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(haystack);
}

/**
 * Classify an intent as collection-bound vs detail-bound. An explicit
 * collection marker wins outright. Otherwise a plural item noun (e.g. "phones",
 * "prices", "books") reads as a collection unless a detail phrase pulls it back.
 */
export function classifyIntentTarget(intent: string | undefined): IntentTargetType {
  if (!intent) return "detail";
  const lower = intent.toLowerCase();

  for (const marker of COLLECTION_MARKERS) {
    if (hasWord(lower, marker)) return "collection";
  }

  const detailPull = DETAIL_PHRASES.some((p) => lower.includes(p));
  if (detailPull) return "detail";

  // Plural item noun with no detail phrase → collection. Skips short plurals and
  // common non-count "-s"/"-ss"/"-us"/"-is" endings to cut false positives.
  for (const raw of lower.split(/\s+/)) {
    const w = raw.replace(/[^a-z]/g, "");
    if (w.length >= 5 && w.endsWith("s") && !/(ss|us|is|ous)$/.test(w)) {
      return "collection";
    }
  }

  return "detail";
}
