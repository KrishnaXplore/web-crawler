/**
 * Value normalization (M24 — docs/phase24.md). Extracted values are raw page
 * text ("₹99,499.00", "£51.77", "Rs. 1,699"); a spreadsheet can't sum those.
 * This pass adds machine-usable siblings for price-like fields — `<field>_amount`
 * (a real number) and `<field>_currency` (an ISO-style code) — alongside the
 * original.
 *
 * It also repairs one extraction artifact in place: source markup that stores a
 * truncated *preview* of a value immediately followed by its full text inside a
 * single element (seen live on books.toscrape.com — a book's description `<p>`
 * contains "…love th" then restarts "It's hard to imagine…"). A single, correct
 * selector still `.text()`s both, so no selector fix helps; the value has to be
 * de-duplicated after extraction. See `collapseDuplicatedText`.
 *
 * Runs as a separate stage after extraction (called from the worker/renderer),
 * not inside runPlugins, so the extraction tiers and their tests stay pure.
 */

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  "₹": "INR",
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY", // ambiguous with CNY — defaults to JPY (see phase24 limits)
  "₩": "KRW",
  "₫": "VND",
  "฿": "THB",
  "₽": "RUB",
};

// Word/abbreviation currency tokens, matched case-insensitively on word bounds.
const CURRENCY_TOKENS: Readonly<Record<string, string>> = {
  rs: "INR",
  inr: "INR",
  usd: "USD",
  gbp: "GBP",
  eur: "EUR",
  jpy: "JPY",
  cny: "CNY",
  aud: "AUD",
  cad: "CAD",
  rub: "RUB",
};

// Field names that signal a price even when the value carries no currency mark
// (e.g. `price: "13999"`).
const PRICE_FIELD_NAMES = /(^|_)(price|cost|mrp|amount|fee|rate|total|salary)($|_)/i;

/** Detect a currency from a value's symbol or token; null if none present. */
function detectCurrency(value: string): string | null {
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (value.includes(sym)) return code;
  }
  const lower = value.toLowerCase();
  for (const [tok, code] of Object.entries(CURRENCY_TOKENS)) {
    // Word-boundary-ish: token surrounded by non-letters (so "rs" in "hours"
    // doesn't match, but "Rs." and "1699 INR" do).
    if (new RegExp(`(^|[^a-z])${tok}([^a-z]|$)`, "i").test(lower)) return code;
  }
  return null;
}

/**
 * Parse the first monetary number run in a string into a real number. Uses the
 * first number token (not a global digit-strip) so "4.5 out of 5" → 4.5, not
 * 455. Infers thousands vs decimal separators for Western (1,234.56) and Indian
 * (99,499.00) grouping, with a best-effort European (1.234,56) fallback.
 */
function parseAmount(value: string): number | null {
  const m = value.match(/\d[\d.,]*\d|\d/);
  if (!m) return null;
  let s = m[0];

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // The rightmost separator is the decimal point.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", "."); // European: 1.234,56
    } else {
      s = s.replace(/,/g, ""); // Western/Indian: 1,234.56 / 99,499.00
    }
  } else if (hasComma) {
    // Comma only: thousands if it groups digits by 3, else a decimal comma.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    // Dot only: European thousands if grouped by 3, else a decimal point.
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }

  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

export interface NormalizedPrice {
  readonly amount: number;
  readonly currency: string | null;
}

/**
 * Normalize a single field value if it's a price. A value is a price when it
 * carries a currency mark, OR the field name is price-like and the value parses
 * as a bare number. Returns null for non-prices (e.g. "4.5 out of 5 stars",
 * "Galaxy A57") so nothing unrelated is enriched.
 */
export function normalizePrice(key: string, value: string): NormalizedPrice | null {
  const currency = detectCurrency(value);
  const priceyName = PRICE_FIELD_NAMES.test(key);
  if (currency === null && !priceyName) return null;
  const amount = parseAmount(value);
  if (amount === null) return null;
  return { amount, currency };
}

const AMOUNT_SUFFIX = "_amount";
const CURRENCY_SUFFIX = "_currency";

// Only bother de-duplicating reasonably long values, and only trust a repeat
// whose leading copy is at least this long — short repeats ("Home Home") are far
// more likely to be legitimate than a truncation artifact.
const MIN_DEDUPE_LENGTH = 60;
const MIN_REPEAT_PREFIX = 25;

/**
 * Collapse a value that is a leading (possibly truncated) copy of itself followed
 * by the full text — the books.toscrape.com description artifact. Detection is
 * deliberately strict to avoid mangling legitimate text: the opening must recur,
 * and everything before that recurrence must be an exact PREFIX of what follows
 * (so a truncated preview qualifies, but merely repeating a word does not). When
 * it matches, the fuller trailing copy wins; otherwise the value is returned
 * unchanged. Pure — unit-tested without the DOM.
 */
export function collapseDuplicatedText(value: string): string {
  const s = value.trim();
  if (s.length < MIN_DEDUPE_LENGTH) return value;
  const opening = s.slice(0, MIN_REPEAT_PREFIX);
  const second = s.indexOf(opening, MIN_REPEAT_PREFIX);
  if (second === -1) return value;
  const lead = s.slice(0, second).trim();
  const rest = s.slice(second).trim();
  // The leading copy must be a prefix of the trailing one (truncation allowed:
  // "…love th" is a prefix of "…love that…") — that's what proves duplication.
  if (lead.length >= MIN_REPEAT_PREFIX && rest.startsWith(lead)) return rest;
  return value;
}

/** Normalize a fields object in place: repair duplicated text, then add
 *  `_amount`/`_currency` siblings for any price-like string value. Iterates a
 *  snapshot so added keys aren't re-scanned. */
function enrichFields(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (key.endsWith(AMOUNT_SUFFIX) || key.endsWith(CURRENCY_SUFFIX)) continue;
    if (typeof value !== "string") continue;
    const cleaned = collapseDuplicatedText(value);
    if (cleaned !== value) fields[key] = cleaned;
    const norm = normalizePrice(key, cleaned);
    if (norm === null) continue;
    fields[`${key}${AMOUNT_SUFFIX}`] = norm.amount;
    if (norm.currency !== null) fields[`${key}${CURRENCY_SUFFIX}`] = norm.currency;
  }
}

/**
 * Walk an analysis object and normalize price-like values across every place
 * extraction stores them: `structured.fields`, `rules.fields`, and each of
 * `rules.records`. Mutates in place (the analysis is `Record<string, unknown>`
 * bound for Mongo, so numeric siblings are fine). No-ops on anything missing.
 */
export function normalizeAnalysis(analysis: Record<string, unknown> | null | undefined): void {
  if (!analysis) return;
  const enrich = (node: unknown): void => {
    const fields = (node as { fields?: unknown } | undefined)?.fields;
    if (fields && typeof fields === "object") enrichFields(fields as Record<string, unknown>);
  };
  enrich(analysis.structured);
  enrich(analysis.rules);
  const records = (analysis.rules as { records?: unknown } | undefined)?.records;
  if (Array.isArray(records)) {
    for (const rec of records) {
      if (rec && typeof rec === "object") enrichFields(rec as Record<string, unknown>);
    }
  }
}
