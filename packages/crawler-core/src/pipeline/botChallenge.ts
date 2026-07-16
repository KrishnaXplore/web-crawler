// A page this small carrying almost no real links is very unlikely to be
// genuine content — real pages this session ranged from tens to hundreds of
// KB; a JS-challenge interstitial (observed directly: Amazon's Akamai
// bm-verify page) was ~2KB with zero real navigation.
const MAX_CHALLENGE_HTML_LENGTH = 6_000;
const MAX_CHALLENGE_LINK_COUNT = 3;

// Common bot-detection/challenge-page phrasing — not exhaustive, cheap and
// generic rather than a maintained per-vendor rule list (M20 — docs/phase20.md).
const CHALLENGE_MARKERS: readonly RegExp[] = [
  /bm-verify/i,
  /captcha/i,
  /checking your browser/i,
  /cf-challenge/i,
  /just a moment/i,
  /enable javascript and cookies/i,
  /access denied/i,
  /request unsuccessful/i,
];

/**
 * Does this fetched page look like a bot-detection challenge rather than real
 * content? Both the size/link-count signal AND a marker-phrase match are
 * required — either alone is too weak (a small genuine page; an article that
 * merely mentions "captcha") — so this stays a cheap, low-false-positive
 * heuristic rather than a maintained per-site rule list.
 */
export function looksLikeBotChallenge(html: string, linkCount: number): boolean {
  if (html.length > MAX_CHALLENGE_HTML_LENGTH || linkCount > MAX_CHALLENGE_LINK_COUNT) {
    return false;
  }
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}
