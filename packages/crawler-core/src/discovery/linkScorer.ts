import type { LinkCandidate } from "../pipeline/extractLinks.js";
import { keywordsFromIntent } from "./intentKeywords.js";
import { looksLikeDetailUrl } from "../plugins/discovery.js";

/**
 * Discovery Engine, Stage A (M16 — docs/phase16.md). A page's discovered links
 * are cheap to score before ever fetching them: does the anchor text or URL
 * look like it's related to what the operator described? This is the free,
 * always-on tier — reused Stages (B: per-domain learned shortcuts, C: semantic
 * ranking) escalate from here, not built yet.
 *
 * Pure and rule-based; no network, no AI — same discipline as the M11/M14
 * extraction-tier plugins.
 */

export interface ScoredLink extends LinkCandidate {
  readonly score: number;
}

// Structural hub shapes that tend to lead toward content even without a
// keyword hit — a smaller boost than an actual keyword match, since it's a
// weaker signal (an "about" page can live under /products/about-us/ too).
const CATEGORY_PATTERNS: readonly RegExp[] = [
  /\/categor(y|ies)\//i,
  /\/products?\//i,
  /\/department(s)?\//i,
  /\/faculty\//i,
  /\/news\//i,
  /\/search\b/i,
  /[?&][qk]=/i,
];

const KEYWORD_MATCH_WEIGHT = 10;
const CATEGORY_PATTERN_WEIGHT = 2;
// A path that's *empirically confirmed* to have worked before (M18 — Discovery
// Engine Step B) outranks a plain keyword guess — it's stronger evidence than
// "the anchor text contains a matching word."
const KNOWN_GOOD_PATH_WEIGHT = 50;

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function scoreOne(
  candidate: LinkCandidate,
  keywords: readonly string[],
  knownGoodPaths: ReadonlySet<string>,
): number {
  if (knownGoodPaths.size > 0) {
    const pathname = pathnameOf(candidate.url);
    if (pathname !== null && knownGoodPaths.has(pathname)) return KNOWN_GOOD_PATH_WEIGHT;
  }
  if (keywords.length === 0) return 0;
  const haystack = `${candidate.anchorText} ${candidate.url}`.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw)) score += KEYWORD_MATCH_WEIGHT;
  }
  if (score === 0 && CATEGORY_PATTERNS.some((p) => p.test(candidate.url))) {
    score = CATEGORY_PATTERN_WEIGHT;
  }
  return score;
}

/**
 * Score and sort discovered links by relevance to `intent`, highest first.
 * Ties (including an empty/blank intent, where every link scores 0) preserve
 * the input order — `Array.prototype.sort` is stable — so a job with no
 * intent behaves identically to before this function existed.
 *
 * `knownGoodPaths` (M18, optional, defaults to none) is the caller's job — it
 * lives in `@crawler/db` (domain profiles), and crawler-core stays infra-free,
 * so the caller resolves `getDomainProfile()` + `matchingPathHints()` and
 * passes in plain URL pathnames. Omitting it (or passing none) leaves scoring
 * byte-identical to before this parameter existed.
 */
export function scoreLinks(
  candidates: readonly LinkCandidate[],
  intent: string,
  knownGoodPaths: readonly string[] = [],
): ScoredLink[] {
  const keywords = keywordsFromIntent(intent);
  const pathSet = new Set(knownGoodPaths);
  return candidates
    .map((c) => ({ ...c, score: scoreOne(c, keywords, pathSet) }))
    .sort((a, b) => b.score - a.score);
}

// Non-target paths a focused detail crawl should never spend a fetch on — the
// same account/support/cart chrome that padded the Amazon crawl with junk rows.
const FOCUSED_EXCLUDE_PATTERNS: readonly RegExp[] = [
  /\/(login|signin|register|account|cart|checkout|wishlist|help|support|about|contact|careers|privacy|terms|policy)\b/i,
  /\/(gp\/css|ap\/|customer|orders?)\b/i,
];

const DETAIL_URL_BOOST = 1000;

/**
 * Focused-crawl link ordering (M23 — detail intents only). Same "keep
 * everything, just prioritize" contract as `scoreLinks`, with two focused
 * additions: (1) hard-drop obvious account/support/cart chrome — the junk that
 * padded the Amazon crawl with useless rows and is never on the path to a
 * product; (2) boost links that look like a single-item detail URL to the top,
 * so the crawler heads for product pages first.
 *
 * Crucially it does NOT drop links it merely fails to *recognize* as detail —
 * many sites use non-standard product URLs (books.toscrape's
 * `/catalogue/slug_id/`), and hard-dropping those would strand the crawler on
 * hub pages, worse than not focusing at all (found live 2026-07-11). Unknown
 * links stay, ranked below detail URLs and keyword hubs. The early-stop does the
 * real pruning once a covering page is found; this just orders the approach.
 *
 * Only for detail intents: a collection crawl wants breadth (plain `scoreLinks`).
 */
export function focusLinks(
  candidates: readonly LinkCandidate[],
  intent: string,
  knownGoodPaths: readonly string[] = [],
): ScoredLink[] {
  const keywords = keywordsFromIntent(intent);
  const pathSet = new Set(knownGoodPaths);
  const kept: ScoredLink[] = [];
  for (const c of candidates) {
    if (FOCUSED_EXCLUDE_PATTERNS.some((p) => p.test(c.url))) continue;
    const base = scoreOne(c, keywords, pathSet);
    kept.push({ ...c, score: looksLikeDetailUrl(c.url) ? DETAIL_URL_BOOST + base : base });
  }
  return kept.sort((a, b) => b.score - a.score);
}
