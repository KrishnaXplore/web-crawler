# Phase 14 (Milestone M14) — Discovery, Confidence Router, Rule Library Feedback Loop

> Milestone **M14** — three pieces from [vision-no-code-extraction.md](vision-no-code-extraction.md)
> and [architecture-v3.md](architecture-v3.md) that landed together: page-type
> **discovery** (listing vs. detail), the **confidence router** that gates the
> extraction tiers on it, and the Rule Library's **feedback loop** groundwork
> (hit-rate tracking). Like phase13.md, this documents code that was built
> out-of-band and then corrected — see
> `docs/changes/2026-07-10-review-m13-m14-intelligence-layer.md` for the bug list
> and fixes this doc's "as built" description already reflects.

---

## Step A — Discovery: is this page worth extracting?

**Problem it solves:** the coverage experiment behind M11 (phase11.md §8b) found
structured data concentrates on *detail* pages, not listing/navigation pages. Running
the extraction tiers — especially the expensive Tier 4 — on every page a crawl visits
wastes cost on pages that were never going to have the target data.

**What's built:** `discoveryPlugin` (`packages/crawler-core/src/plugins/discovery.ts`)
classifies a page as `listing`, `detail`, or `unknown` using cheap DOM heuristics, no
model call:

| Signal | Points toward |
|---|---|
| `<article>` tag present | detail |
| `itemtype` contains `Product` or `Article` (microdata) | detail |
| Pagination markers (`.pagination`, `[rel=next]`, `.page-numbers`, …) | listing |
| High non-link text density (>2000 chars of body text outside `<a>`) | detail |
| High link density (>50 links, >40% of text is link text) | listing |

Conflicting signals resolve toward `detail` if an explicit Product/Article schema is
present (a paginated article is still an article); otherwise toward `listing`. Output:
`{ pageType, confidence: "high"|"low", signals: string[] }` — `signals` lists exactly
which heuristics fired, so a misclassification is debuggable from the stored analysis,
not a black box.

| Decision | Alternative | Why |
|---|---|---|
| Heuristic DOM signals, no model call | classify via LLM | Discovery runs on *every* page of every crawl — it must be cheap. A misclassification here costs a wasted/skipped extraction attempt, not a wrong answer shipped to the user. |
| `confidence: "low"` when only one signal fired | always report "high" | Signal count is a cheap, honest proxy for classification certainty — surfaced so a future consumer can decide how much to trust a borderline call. |

## Step B — Confidence router: gate the extraction tiers

**Problem it solves:** architecture-v3 specifies extraction as "cheapest-first, stop
at first success." The first version of this code ran `structured` and `rules`
independently — Tier 2 (and therefore Tier 4/LLM) could fire even when Tier 1 already
produced a confident record, defeating the cost-amortization goal. Fixed in this pass
(changes-doc finding #6).

**What's built**, in `runPlugins()` (`packages/crawler-core/src/plugins/registry.ts`):

```
discovery (if requested) → pageType
   │
   ├─ listing → structured & rules SKIPPED  { skipped: true, reason: "listing_page" }
   │
   └─ detail/unknown/not-run
        │
        structured (Tier 1, if requested) runs FIRST regardless of array order
        │
        rules (Tier 2, if requested):
          if structured ran AND its confidence != "none"
             → SKIPPED  { skipped: true, reason: "tier1_structured_confident" }
          else
             → runs; if confidence == "none" AND job has `intent`
                → Tier 4 (LLM) generates + re-runs + attaches `generatedRules`
```

Two properties this guarantees:
1. **Tier 2/4 never runs when Tier 1 already answered** — only when `structured` was
   *also requested in the same call* (asking for `rules` alone still runs it
   directly, unconditionally — no implicit Tier-1 dependency forced on a caller who
   didn't ask for it).
2. **A skip is never shaped like an error.** Discovery-gated and confidence-gated
   skips are `{ skipped: true, reason }`; only an actual thrown exception produces
   `{ error }`. This was a real bug (finding #8) — the original code labeled every
   skip `{error:"skipped_by_confidence_router"}`, which would have corrupted any
   future error-rate dashboard built on `analysis.rules.error`.

| Decision | Alternative | Why |
|---|---|---|
| Tier 1 always resolves before Tier 2 in code, regardless of `names` array order | require callers to pass tiers in order | The router's job is to enforce the tier contract; making correctness depend on caller-supplied ordering is fragile and undocumented from the call site. |
| Distinct `skipped` vs `error` shapes | one `error` field with different string reasons | A string reason inside `error` still *reads* as failure to anything scanning for non-empty `error` fields (dashboards, alerting). A separate key is unambiguous. |

## Step C — Rule Library feedback loop (groundwork)

**Problem it solves:** architecture-v3's Website Intelligence Layer (§2.45) named a
Rule Library with `version`, `hitRate`, `verifiedAt`, `generatedBy` as the signal a
future self-heal step watches for staleness. The first version of the Rule model was
`{domain, schemaType, fields, updatedAt}` — no way to observe whether a rule still
works. Fixed in this pass (changes-doc finding #7).

**What's built:**

- `RuleModel` (`packages/db/src/models/rule.ts`) gained `version` (int, bumped on
  every `upsertRule`), `generatedBy` (`"operator"|"llm"`), `hits`/`misses` (raw
  counters), `verifiedAt` (last successful extraction).
- `recordRuleUsage(domain, success)` — called from the worker and renderer every time
  the `rules` tier actually runs (existing rule *or* freshly LLM-generated one) against
  a real page; atomic `$inc`, best-effort (never fails the crawl).
- `deriveRuleMeta(doc)` — pure function, `hitRate = hits/(hits+misses)`, `null` if
  never used. Unit-tested without Mongo (mirrors `deriveProfile`'s pattern from M12).
- `GET /rules/:domain` now returns the full `RuleMeta` (fields + version + hitRate +
  generatedBy + verifiedAt), not just the bare extraction fields — so an operator or
  a future dashboard can see whether a rule is healthy.

**What this is *not* yet:** actual self-healing. Nothing currently *reads* `hitRate`
and decides to regenerate a rule. The counters accrue; the decision logic (M15: "if
hitRate drops below threshold X over N recent uses, flag for regeneration") is not
built. This step is the sensor, not the reflex.

| Decision | Alternative | Why |
|---|---|---|
| `hitRate` derived on read, never stored | store a running percentage | Can't drift from the raw counts it's computed from; same discipline as `needsRender` in the M12 domain profile. |
| Regenerating a rule bumps `version` but does **not** reset `hits`/`misses` | reset counters on regeneration | The domain's usage history stays continuous across regenerations for now; per-rule-version history is a per-org Rule Library concern, deferred to M15 alongside tenancy. |
| Usage recorded for both operator-authored and LLM-generated rules alike | only track LLM-generated rule health | An operator-authored CSS rule goes stale on a site redesign exactly the same way a generated one does — the signal should cover both. |

## Related: `renderMode:"auto"` (M12's deferred read-before-crawl, now built)

Not originally scoped to M14, but landed alongside it and depends on the same
Intelligence Layer read path: `POST /jobs` accepts `renderMode:"auto"` (now the
default), which calls `getDomainProfile(hostname)` and resolves to `"browser"` if the
domain's profile has `needsRender: true`, else `"http"`. This is exactly the
optimization phase12.md's thin slice explicitly deferred ("skip HTTP-then-render
waste") — closing that gap. Tested in `app.test.ts` (both branches: known
needs-render domain, and unseen/no-profile domain defaulting to `"http"`).

---

## What's tested

- `discovery.test.ts` — 6 unit tests: article/schema → detail, pagination → listing,
  text/link density heuristics, conflicting-signal resolution, unknown fallback.
- `registry.test.ts` — "M14 Confidence Router" describe block: extraction runs on
  detail pages, is skipped (correctly labeled) on listing pages, and Tier 2 is skipped
  when Tier 1 already succeeded (this pass's new test, changes-doc finding #6).
- `rules.test.ts` (packages/db) — 6 unit tests for `deriveRuleMeta`: hitRate
  computation, null-when-unused, 0-vs-null distinction, generatedBy/version defaults
  and preservation, Map→Record field conversion.
- Not yet tested: an actual self-heal decision (none exists to test yet — see gaps).

## Exit criteria (retroactive — already met)

- A crawl with `["discovery","structured","rules"]` on a listing page skips both
  extraction tiers with a `skipped` (not `error`) shape.
- The same set on a detail page where `structured` succeeds does not invoke `rules`.
- `rules` alone (no `structured` requested) still runs unconditionally.
- Every use of the `rules` tier — hit or miss — is recorded and visible via
  `GET /rules/:domain`'s derived `hitRate`.
- Offline suite green (crawler-core 76 tests, db 19 tests).

## Honest gaps for a future pass (M15)

- **No self-heal decision logic** — hitRate is tracked but nothing acts on it yet.
- **No per-org Rule Library scoping** — rules remain globally keyed by domain
  (documented and deliberate, per architecture-v3 §I, until multi-tenancy lands).
- **No `templateHash`** (architecture-v3's spec includes it, for detecting *which*
  page template a rule applies to within a domain that has multiple layouts) — the
  current model is one rule set per domain, not per template.
- **No `costPerRecord` tracking** — the Rule Library doesn't yet measure what Tier 4
  generation actually cost, so amortization can't be quantified, only assumed.
