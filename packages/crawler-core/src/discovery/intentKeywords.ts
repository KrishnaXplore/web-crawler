const STOPWORDS = new Set([
  "a", "an", "the", "from", "extract", "want", "all", "of", "in", "on", "get",
  "i", "my", "to", "for", "and", "with", "me", "please", "show", "find",
  "list", "give", "us", "our", "this", "that", "is", "are", "be", "it",
]);

/**
 * Extract the content words from a user's intent string — shared between the
 * Discovery Engine's link scorer (M16, "which pages to visit") and the
 * Extraction Engine's coverage check (M17, "did Tier 1 find what was asked
 * for") so the two don't drift into different notions of "what does this
 * intent care about."
 */
export function keywordsFromIntent(intent: string): string[] {
  return intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
