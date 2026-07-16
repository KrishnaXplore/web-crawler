# Phase 20 (Milestone M20) — Crawl Resilience: Rate-Limit Backoff + Bot-Challenge Auto-Retry

> Written before code. Both problems here were directly observed during live
> testing this session, not theoretical: Gemini's free-tier 15 req/min cap
> was hit mid-crawl on `msrit.edu`, and Amazon's Akamai bot-detection served
> a JS proof-of-work interstitial to plain HTTP requests partway through
> testing (confirmed via the SDK's own `ApiError.status` for the first, and by
> reading the actual challenge-page HTML for the second).

## Fix 1 — Tier 4 rate-limit backoff

**The problem:** `createGeminiLlmSocket` makes a bare `generateContent` call
with no retry. Hitting the free tier's per-minute cap (observed directly:
`RESOURCE_EXHAUSTED`, `limit: 15`) fails that page's extraction outright —
`{error: "..."}"` on the `rules` output — even though the *next* minute's
quota would likely have succeeded.

**The fix:** one bounded retry. `@google/genai` throws `ApiError` with a
numeric `.status` (verified against the SDK's own type declarations, not
assumed). On `status === 429`, wait a short fixed delay, retry once, then let
a second failure propagate as before — `runPlugins()`'s existing per-tier
`try/catch` already turns that into `{error}` without crashing the crawl,
unchanged.

**Why one retry, not exponential backoff with several attempts:** Tier 4
calls happen inline in the worker's per-page processing — a long retry
sequence stalls that worker on one page while the whole point of the
distributed-worker design (ADR-0003) is many workers making forward progress
in parallel. A single short wait catches the common case (briefly over a
per-minute cap that resets soon); a page that still fails after one retry is
better handled by moving on and letting a *later* crawl of the same page (or
the domain's already-cached rule, once one exists) succeed instead of one
worker blocking on it.

| Decision | Alternative | Why |
|---|---|---|
| One retry, fixed short delay | Exponential backoff, multiple attempts | A worker stalled on retries isn't doing anything else useful — bounded cost beats a thorough-but-slow retry policy for an inline call in a per-page hot path. |
| Check `ApiError.status === 429` specifically | Retry on any thrown error | A malformed-response error or a genuine bad-request error retrying identically would just fail the same way twice, for no benefit — only the rate-limit case is actually time-sensitive. |

## Fix 2 — Bot-challenge detection extends the existing `renderMode:"auto"` logic

**The problem:** Amazon's Akamai bot-detection served plain HTTP requests a
JS proof-of-work interstitial (tiny body, `bm-verify` challenge marker, zero
real content) — `crawlUrl` reported `outcome: "ok"`, `status: 200`, because
technically the fetch succeeded; there was just nothing real in it. Browser
mode got past it (can execute the JS challenge); HTTP mode never will, and
nothing currently tells a *later* crawl of the same domain to prefer browser
mode.

**The fix reuses infrastructure that already exists**, rather than building
something new: M12's domain profile already has a `needsRender` field,
derived from `renderModesSeen.includes("browser")`, and the API's
`renderMode:"auto"` resolution (`services/api/src/routes/jobs.ts`) already
reads it to route a job to the worker or the renderer. This fix adds a
*second way* `needsRender` can become true — a new `httpChallengeSeen` flag,
set when the worker detects a challenge-shaped response — so the *existing*
auto-routing logic picks up the signal with **no changes needed in
`jobs.ts` at all**.

**Detecting a "challenge-shaped" response** — cheap, generic, not
Amazon-specific (same heuristic discipline as `discoveryPlugin` and the link
scorer): a small pure function checks the already-fetched HTML for size
(genuine content pages are rarely this small) and near-zero extracted links,
combined with common challenge-page phrasing (`bm-verify`, `captcha`,
`checking your browser`, `just a moment`, `enable javascript and cookies`,
`access denied`). Any single signal alone is too weak (a genuinely tiny real
page, or a page that happens to mention "captcha" in an article about bot
detection); requiring the size/link-count signal *and* a marker match keeps
false positives low without needing a maintained per-site rule list.

```
looksLikeBotChallenge(html, linkCount):
  too big or has real navigation → false (not a challenge page)
  otherwise → true if any challenge marker phrase appears
```

Only checked in the worker (HTTP mode) — the renderer already executes
JavaScript, so it's not the one that needs to escalate *to* browser mode.

| Decision | Alternative | Why |
|---|---|---|
| Extend `needsRender`'s derivation with a second boolean flag | A separate "blocked domains" list/mechanism | `needsRender` already *is* "should this domain route to the renderer" — a second reason for the same conclusion belongs in the same derivation, not a parallel system the API route would also need to learn about. |
| Size + link-count + marker-phrase, all required | Marker phrases alone | A page that merely mentions "captcha" in its content (a security blog post, for instance) shouldn't get flagged — requiring it to also look structurally empty (tiny, no real links) rules that out cheaply. |
| Only detected in the worker, not the renderer | Check in both | The renderer already runs a real browser — if it's still getting challenged, browser mode already failed to help, and no signal here would fix that; that's a different, harder problem (headless-browser fingerprinting) not in scope. |

## What this is not

- Not a bot-detection bypass. Nothing here defeats Akamai/Cloudflare-style
  protection — it detects that HTTP mode *didn't* get through and routes
  *future* crawls to the mode that already does (browser rendering), which is
  a legitimate capability this platform already had for JS-rendered SPAs.
- Not a guarantee browser mode always succeeds either — some sites challenge
  headless browsers too (a harder problem, out of scope here, noted honestly
  rather than pretended away).
- Not a general-purpose retry framework — the Tier 4 fix is one specific,
  bounded retry for one specific, observed failure mode, not a new retry
  abstraction other call sites are expected to adopt.

## Exit criteria

- `looksLikeBotChallenge()` is pure, unit-tested (real-content page → false;
  small page with a challenge marker → true; small-but-genuinely-real page
  with no marker → false).
- Gemini socket unit tests cover the retry path (429 then success → succeeds;
  429 twice → the second error propagates) without making a real network
  call (mocked client).
- Live: re-running an Amazon crawl in HTTP mode after a domain has previously
  been flagged with `httpChallengeSeen` shows `renderMode:"auto"` resolving
  to `"browser"` for that domain, without the operator manually selecting it
  — the exact manual step required earlier in this session, now automatic.
