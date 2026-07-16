# Phase 13 (Milestone M13) — Intent Layer (LLM socket, Tier 4)

> Milestone **M13** — the accessibility layer from
> [vision-no-code-extraction.md](vision-no-code-extraction.md): let an operator
> describe what they want in plain language instead of writing CSS selectors. This
> doc describes the code **as built** (originally landed out-of-band, corrected and
> verified in `docs/changes/2026-07-10-review-m13-m14-intelligence-layer.md`) rather
> than being written before the code — noted here because it breaks this project's
> normal phase-doc-before-code convention; treat it as the retroactive record.

Scope actually delivered: a natural-language `intent` string on a job, routed through
the confidence router (M14) as **Tier 4 — the last-resort fallback**, generating CSS
selectors that are then run through the existing Tier 2 (`rules`) extractor and, on
success, saved to the Rule Library for reuse. **Point-and-click intent** (the other
half of the vision doc's M13) is not built.

---

## What's built

### The `LlmSocket` interface

```ts
interface LlmSocket {
  generateRules(domain: string, html: string, intent: string): Promise<ExtractionRule>;
}
```

One method: given a page's HTML and a natural-language intent, produce an
`ExtractionRule` (`{ domain, schemaType, fields: Record<name, cssSelector> }`) —
the same shape Tier 2 already consumes. This is the "optional isolated socket"
architecture-v3 specified: nothing else in the pipeline knows or cares whether the
implementation behind `LlmSocket` is a real model call or not.

### `mockLlmSocket` — the current implementation

A keyword-heuristic stand-in (`packages/crawler-core/src/llm/socket.ts`), **not a
real LLM call**. It pattern-matches the intent string (`"price"` → `.price`,
`"title"`/`"name"` → `h1`, `"author"` → `.author`) and falls back to `{mainContent:
"main"}` if nothing matches. This exists so the Tier 4 *plumbing* — routing, rule
persistence, reuse — can be built and tested without an API key or network call, per
the vision doc's "prove the loop before the AI" ordering.

**Swapping in a real model** means implementing `LlmSocket` against an actual
provider and changing the one import in `registry.ts`. No other file changes.

### Where Tier 4 fires (the confidence router)

`runPlugins()` in `packages/crawler-core/src/plugins/registry.ts` invokes the LLM
socket **only** when: the job requested the `rules` plugin, `rules` ran (Tier 2) and
returned `confidence: "none"` (no existing rule matched, or none existed), **and**
the job supplied `intent`. This is genuinely last-resort — Tier 1 (`structured`) is
tried first when requested, and Tier 2 with an *existing* Rule Library entry is tried
before ever reaching Tier 4 (see phase14.md's confidence-router section for the full
tier-gating logic, which this fix pass corrected to actually short-circuit on Tier 1
success — see the changes doc, finding #6).

On a hit, the generated rule is re-run immediately (so the page gets its extraction
result in the same pass) and attached as `generatedRules` on the output, which the
worker/renderer persist to the Rule Library (`upsertRule(rule, {generatedBy:"llm"})`)
— **Tier 2 reuses it on every subsequent page of that domain**, so the expensive tier
runs once per template, not once per page (the cost-amortization goal from
architecture-v3 decision D).

### Submission surface

- `JobConfig.intent?: string` (packages/shared) — persisted on the Job.
- API: `POST /jobs` accepts `intent` (zod: optional string), threaded into the config.
- Dashboard: `JobForm.tsx` has an "Intent" text input, forwarded to `createJob`.
- Both `services/worker` and `services/renderer` pass `intent: cfg.intent` into
  `runPlugins` (this fix pass corrected the worker, which had been omitting it —
  the default HTTP crawl path could never reach Tier 4 before that fix).

## What's explicitly NOT built

| Vision doc's M13 scope | Status |
|---|---|
| Natural-language intent → rule generation | ✅ (heuristic mock, swappable interface) |
| Point-and-click example selection → rule inference | ❌ not built — no browser extension or click-capture UI exists |
| Real LLM call | ❌ `mockLlmSocket` only |
| Verification of a generated rule against multiple pages before trusting it | ❌ deferred to M14/M15 (self-heal) |

## Design decisions (recovered rationale)

| Decision | Alternative | Why |
|---|---|---|
| `LlmSocket` as a narrow interface, mock implementation first | wire a real provider immediately | Proves the routing/persistence/reuse loop is correct before spending on a real model call — matches the vision doc's explicit ordering ("prove the loop, then the AI"). |
| Tier 4 only reachable via Tier 2's `rules` slot | a standalone `llm` plugin name | Keeps one extraction result per page (`out.rules`) rather than two competing outputs; the generated rule *becomes* a Tier 2 rule, which is the whole point (Rule Library reuse). |
| Generated rule saved with `generatedBy:"llm"` | save without provenance | Lets the Rule Library (M14/phase14.md fix #7) distinguish operator-authored from AI-generated rules — relevant once hit-rate-driven review/self-heal exists. |

## What's tested

- Unit (`registry.test.ts`, "M13 Intent Layer / LLM Socket"): given an intent and no
  existing rule, the mock generates selectors, extraction runs against them
  successfully, and `generatedRules` is attached to the output.
- Not yet tested: persistence round-trip (rule actually reused on a second page of the
  same domain) — covered manually via the worker/renderer wiring, not by an automated
  integration test yet.

## Exit criteria (retroactive — already met)

- A job with `plugins:["rules"]` and an `intent` on a domain with no existing rule
  triggers Tier 4, extracts on the same page, and persists a reusable rule.
- The same job run again on the same domain reuses the persisted rule (Tier 2) without
  invoking the LLM socket again — confidence !== "none" short-circuits Tier 4.
- Offline suite green (crawler-core 76 tests including the Tier 4 test).

## Honest gaps for a future pass

- No real LLM provider wired — `mockLlmSocket` is a placeholder, not swappable via
  config (would need a small factory + env var to choose an implementation).
- No point-and-click intent capture — the vision doc's other accessibility path.
- No verification step before trusting a freshly-generated rule (a single lucky
  selector match doesn't mean the rule generalizes to the domain's other pages) — this
  is exactly what phase14.md's hit-rate tracking is *for*, but nothing yet acts on a
  low hit-rate automatically.
