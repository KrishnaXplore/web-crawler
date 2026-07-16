# Phase 17 (Milestone M17) — Extraction Engine: Coverage-Aware Routing + Rule Self-Heal

> Written before code. Both fixes here are driven by concrete bugs found during
> live testing today, not speculation: the coverage gap was observed on a real
> Amazon product page, and the self-heal gap was observed as an actual wrong
> extraction (a rule generated for one page template returning `"2022-23"` as
> a `name` field on a different template).

## Fix 1 — Tier 1 "found something" ≠ "found what was asked for"

**The bug, concretely observed:** crawling an Amazon product page with intent
*"extract product name, price, and brand"*, Tier 1 (structured/JSON-LD) found
`name`, `description`, `image` — confidence `"high"`. The router treats any
non-`"none"` Tier 1 confidence as "resolved" and skips Tier 2/4 entirely. But
Tier 1 never found `price` or `brand` — the two fields the intent actually
asked for — and because it was never asked, Tier 4 never got a chance to look
for them either. The crawl reported success while silently missing the point
of the request.

**The fix:** before skipping Tier 2/4 because Tier 1 succeeded, check whether
Tier 1's fields actually cover what `intent` asked for. If they don't, Tier
2/4 still runs — not to replace Tier 1's result, but to attempt the fields
Tier 1 missed. Both results are kept: `out.structured` holds Tier 1's honest
output, `out.rules` holds whatever Tier 2/4 additionally found. No merging —
each tier's actual contribution stays visible and debuggable, matching this
project's existing preference for transparent tier attribution over an opaque
combined blob.

**How "covers what was asked" is checked** — cheap, no AI, consistent with
every other Tier 1/2 heuristic in this codebase:

- Extract content-word keywords from `intent` (same stopword-stripped
  tokenizer as the Discovery Engine's link scorer — moved to a shared
  `intentKeywords.ts` helper so the two don't drift out of sync).
- For each keyword, check a small **curated alias table** for common
  extraction-field concepts (`price` → `price`/`cost`/`amount`, `brand` →
  `brand`/`manufacturer`/`maker`, `title` → `title`/`name`/`headline`, etc.)
  and see if any alias appears among Tier 1's field *keys*.
- A keyword with no alias-table entry is given the benefit of the doubt
  (treated as covered) — the table only recognizes a curated set of common
  concepts, not a general NLU system, and an unrecognized word (e.g.
  "product" in "extract product name, price, and brand" — a qualifier, not a
  field) shouldn't block escalation on a false negative.
- Coverage requires **every** recognized keyword to have a match — partial
  coverage (found `name`, asked for `name`+`price`+`brand`) is not coverage.

| Decision | Alternative | Why |
|---|---|---|
| Alias table for common field concepts | Ask an LLM whether Tier 1 covers the intent | Would reintroduce a call on the *cheap* tier's decision path — the whole point of Tier 1 is not needing AI. A wrong-but-cheap heuristic that's honest about its limits beats a right-but-expensive one here. |
| Unrecognized keyword → benefit of the doubt | Unrecognized keyword → treat as uncovered (escalate) | The latter would make almost every intent trigger escalation (natural language has lots of words with no field-concept meaning), defeating the cost-amortization the router exists for. |
| No merge — two separate output keys | Merge Tier 4's finds into `out.structured.fields` | Every other tier boundary in this system reports its own output separately (`out.structured`, `out.rules`, `out.discovery`) — merging here would be the one silent exception, and would obscure which tier actually produced which field when debugging a wrong value. |

## Fix 2 — Rule Library self-heal (the "reflex" M14 deferred)

**The bug, concretely observed:** on `msrit.edu`, a rule generated for one
page template (`.entry-title` → treated as `name`) got reused on a
differently-templated page and matched `"2022-23"` — a heading that happened
to be the first thing matching `.entry-title`, not a name at all. The Rule
Library has tracked `hits`/`misses`/`hitRate` since M14 specifically to
surface this kind of drift, but nothing has ever acted on it — hitRate has
been "the sensor, not the reflex" the whole time.

**The fix:** `recordRuleUsage()` (called after every real use of the `rules`
tier) now checks the rule's hit rate immediately after recording the outcome.
If a rule has enough usage history to judge (minimum sample size, avoids
nuking a rule on a single unlucky miss) and its hit rate has fallen below a
threshold, its `fields` are cleared.

**Why clearing `fields` (not deleting the document) is the mechanism:** an
empty `fields: {}` makes `rulesPlugin`'s existing `hasFields` check naturally
return `confidence: "none"` — exactly the state that already triggers Tier 4
regeneration in the router (Fix 1's logic, and the pre-existing M13 escalation
path). No new "is this rule stale" branch needed anywhere else in the system;
self-heal produces the same signal a domain that's *never had* a rule
produces, and every downstream consumer already knows how to handle that.
`version`, `hits`, `misses`, and the domain document itself are preserved —
only the (apparently broken) selectors are cleared, keeping the audit trail
(a future dashboard could show "this rule was auto-cleared on <date>, hit rate
had fallen to X%").

| Decision | Alternative | Why |
|---|---|---|
| Clear `fields` to `{}`, keep the document | Delete the rule document entirely | Deleting loses `version`/`hits`/`misses` history — the exact data a future "why did this rule need regenerating" audit would want. Clearing produces the identical *functional* signal (`confidence: "none"`) without losing it. |
| Minimum sample size before judging | Act on hit rate immediately | A rule's first use failing (one miss, `hitRate: 0`) shouldn't nuke a rule that would have been fine on page 2 — needs enough uses to distinguish "genuinely broken" from "unlucky first page." |
| Threshold + minimum sample as constants, not configurable yet | Per-domain/per-operator tunable thresholds | No evidence yet for what the right numbers are across different site shapes — ship a reasonable default, make it configurable once real usage data says it needs to be. |
| **`upsertRule` resets `hits`/`misses` to 0 on every write (correction, found live)** | Keep counters continuous across regenerations (the original M14 choice) | Live-verified during this milestone: a rule regenerated seconds earlier — and working — inherited its predecessor's 22 accumulated misses from unrelated earlier failures (bot-detection challenge pages, wrong-template reuse) and was immediately self-healed away again, before it had a real trial. M14's "keep history continuous" reasoning assumed nothing would ever *act* on the counters; M17 broke that assumption. A fresh rule needs a fresh trial. |

## What this is not

- Not a fix for the *cause* of a wrong rule (a site redesign, a
  domain with multiple templates and only one rule slot — still the
  `templateHash` gap phase14.md already documented). This fix detects and
  recovers from the *symptom* (a rule that stopped working), not the
  structural cause.
- Not perfect coverage detection — the alias table is small and curated, not
  exhaustive. It catches the concrete cases evidenced today (`price`, `brand`)
  and the other common extraction targets; a sufficiently unusual intent
  phrasing can still slip through uncovered.

## Exit criteria

- `intentKeywords.ts` extracted as a shared helper; `linkScorer.ts`'s existing
  behavior is unchanged (same tests still pass).
- Unit tests: coverage-check heuristic (full coverage, partial coverage,
  unrecognized-keyword benefit-of-the-doubt, empty intent) and
  `needsSelfHeal` (below sample size, above threshold, below threshold).
- Live: re-running the exact Amazon product page from today now escalates to
  Tier 4 for `price`/`brand` instead of stopping at Tier 1's partial result.
- Live: a rule pushed below the hit-rate threshold gets its `fields` cleared,
  and the next crawl on that domain regenerates via Tier 4 rather than
  reusing the broken selectors.
