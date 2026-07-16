import { keywordsFromIntent } from "../discovery/intentKeywords.js";

/**
 * Common extraction-field concepts, mapped to the field-key spellings that
 * commonly carry them. Small and curated, not exhaustive — a keyword with no
 * entry here is given the benefit of the doubt (see isIntentCovered) rather
 * than treated as "definitely missing," since natural language has plenty of
 * words that aren't field names at all (M17 — docs/phase17.md).
 */
const FIELD_CONCEPT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  price: ["price", "cost", "amount"],
  brand: ["brand", "manufacturer", "maker"],
  title: ["title", "name", "headline"],
  name: ["title", "name", "headline"],
  author: ["author", "writer", "byline"],
  description: ["description", "summary"],
  rating: ["rating", "review", "score"],
  date: ["date", "published", "datepublished"],
};

/**
 * Does `fields` (a Tier 1/2 extraction result) cover what `intent` asked for?
 * Cheap, no AI — checks recognized field-concept keywords in `intent` against
 * `fields`'s keys via the alias table above. Requires every recognized
 * keyword to have a match; an intent with no recognized keywords (or no
 * intent at all) is trivially "covered" — there's nothing specific to check
 * Tier 1 against.
 */
export function isIntentCovered(
  fields: Record<string, unknown>,
  intent: string | undefined,
): boolean {
  if (!intent) return true;
  const keywords = keywordsFromIntent(intent);
  if (keywords.length === 0) return true;
  const fieldKeys = Object.keys(fields).map((k) => k.toLowerCase());
  return keywords.every((kw) => {
    const aliases = FIELD_CONCEPT_ALIASES[kw];
    if (!aliases) return true; // unrecognized keyword — benefit of the doubt
    return aliases.some((alias) => fieldKeys.some((fk) => fk.includes(alias)));
  });
}
