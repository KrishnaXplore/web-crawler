/**
 * The scraped rows a page contributes to the results table. A listing page
 * extracted via a list rule (M22) carries `records: [...]` — one row per
 * repeating item. A detail page contributes at most one row: `structured`
 * (Tier 1) and `rules` (Tier 2/4) fields merged rather than picked, since
 * M17's coverage-aware routing means both can legitimately contribute
 * complementary fields to the same page. `rules` wins on a key collision —
 * it's the more specifically-requested tier. Mirrors `extractedRowsFor()` in
 * the API's export route so the on-screen data table matches the downloaded
 * CSV. Empty array = nothing extracted.
 */
export function extractedRecords(
  analysis: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] {
  const structured = analysis?.structured as
    | { fields?: Record<string, unknown>; confidence?: string }
    | undefined;
  const rules = analysis?.rules as
    | {
        fields?: Record<string, unknown>;
        confidence?: string;
        records?: Record<string, unknown>[];
      }
    | undefined;

  if (rules?.confidence && rules.confidence !== "none" && rules.records?.length) {
    return rules.records;
  }

  const merged: Record<string, unknown> = {};
  if (structured?.confidence && structured.confidence !== "none" && structured.fields) {
    Object.assign(merged, structured.fields);
  }
  if (rules?.confidence && rules.confidence !== "none" && rules.fields) {
    Object.assign(merged, rules.fields);
  }
  return Object.keys(merged).length > 0 ? [merged] : [];
}
