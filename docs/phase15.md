# Phase 15 (Milestone M15) — Real LLM Provider (Tier 4)

> Closes the gap phase13.md flagged explicitly: *"No real LLM provider wired —
> `mockLlmSocket` is a placeholder, not swappable via config."* This doc is
> written **before** the code, per the project's normal convention.
>
> **Provider note:** this milestone was first built against Anthropic's Claude
> API, then switched to Google's Gemini API before merging — the operator
> wanted a free-tier-eligible provider (Gemini's API key is free to obtain via
> Google AI Studio, with a generous no-cost quota) rather than a paid one. The
> swap only touched the one file that implements `LlmSocket` plus config/env
> plumbing; everything else in this doc (the swappability design, the
> structured-output approach, the HTML preprocessing) carried over unchanged,
> because the interface was designed for exactly this kind of substitution.

## What it solves

Tier 4 of the confidence router (phase14.md) can generate CSS selectors from a
natural-language `intent` — but the only implementation behind `LlmSocket` was
`mockLlmSocket`, a keyword heuristic (`"price"` → `.price`) that exists purely
to prove the routing/persistence/reuse loop without needing an API key. It was
never a real model call. This milestone wires an actual Gemini API call behind
the same interface, so Tier 4 does what architecture-v3 always described it
doing: turn a plain-language ask into working selectors on a domain the Rule
Library has never seen.

## Design

### Provider and model

Google's Gemini API, via the official `@google/genai` Node SDK. Default model
`gemini-3.1-flash-lite`, overridable per-deployment via `GEMINI_MODEL`. Chosen
over a paid provider specifically because Google AI Studio issues a free API
key with a no-cost quota — no billing setup required to try Tier 4 end-to-end.
The model choice was verified live against a real free-tier key, not assumed:
`gemini-2.5-flash` (the model shown in current SDK docs/examples at the time
of writing) turned out to return a clean 404 — "no longer available to new
users" — against a freshly issued key, and `gemini-flash-latest` hit transient
`503`s during testing. `gemini-3.1-flash-lite` is what actually worked
end-to-end, including with `responseSchema` structured output, against this
key at the time this was built — a reminder that model availability drifts
faster than documentation, and a live smoke test beats trusting a doc example.

### Where the code lives

`packages/crawler-core/src/llm/socket.ts` — the same file as the mock. This
doesn't repeat the layering violation fixed in the M13/M14 review (changes-doc
finding #5, `@crawler/db` import for a type): that fix was about crawler-core
depending on an **infra-coupled workspace package** in a way that broke
"unit-testable without Mongo running." An HTTP client for an external API is a
different category — crawler-core already makes outbound HTTP calls directly
(`undici`, in the SSRF-guarded fetch pipeline). Adding `@google/genai` as an
external dependency doesn't reintroduce workspace coupling, and nothing about
it requires a running service to unit-test: tests keep using `mockLlmSocket`
explicitly and never construct the real socket.

### Making the socket actually swappable

`LlmSocket` was already a narrow interface (`generateRules(domain, html,
intent)`), but `runPlugins()` hard-imported `mockLlmSocket` — "swappable" meant
editing an import line, not runtime configuration. This milestone adds:

- `createGeminiLlmSocket({ apiKey, model? })` — a factory returning an
  `LlmSocket`, so construction (which needs a key) is separate from the
  interface (which doesn't).
- `RunPluginsArgs.llmSocket?: LlmSocket` — an optional field, defaulting to
  `mockLlmSocket` when omitted. Callers now choose the implementation instead
  of the module choosing it for them.
- Worker and renderer each construct **one** socket at startup — real if
  `GEMINI_API_KEY` is set, `mockLlmSocket` otherwise — and pass it into every
  `runPlugins()` call.

This is the actual "optional isolated socket" architecture-v3 called for:
the platform functions with no API key configured (mock, as before);
configuring a key upgrades Tier 4 without touching any other code path. It's
also what made the Claude→Gemini swap itself cheap: only the factory function
and the two env var names changed.

### Secret handling

`GEMINI_API_KEY` — optional, zod-validated in `@crawler/config`'s schema, same
pattern as `WEBHOOK_SECRET`: unset by default so local dev and the test suite
never need a key, never logged, never returned by any API response.
`GEMINI_MODEL` is a plain optional string (not a secret) defaulting to
`gemini-3.1-flash-lite`.

### Structured output, not free-text parsing

The socket sets `responseMimeType: "application/json"` and a `responseSchema`
(Gemini's `Type` enum, not raw JSON Schema) on the `generateContent` call,
rather than asking the model for JSON in prose and hoping. Unlike Anthropic's
`messages.parse()`, the Gemini SDK doesn't auto-validate against a Zod schema,
so the socket parses `response.text` as JSON and then runs it through a Zod
schema itself — same end result (a typed value or a thrown error), one extra
explicit step. As with the earlier Claude version, `fields` is shaped as an
array of `{name, selector}` pairs on the wire (structured-output schemas
generally want fixed properties, not an open-ended map), converted to the
`Record<string, string>` shape `ExtractionRule` and the `rules` plugin expect,
after parsing.

### Cost and context control

Before sending HTML to the model, the socket strips `<script>`, `<style>`,
`<svg>`, `<nav>`, `<footer>`, and HTML comments (cheerio — already a
crawler-core dependency), then truncates to a fixed character budget. A full
page isn't needed to infer a handful of CSS selectors, and sending it
uncontrolled would scale token cost with page size for no accuracy benefit —
this was flagged as a cost/context-window risk back in the original
vision doc's hybrid-scraping research (§8b).

### Error handling

The socket does no retry/fallback of its own — a thrown error propagates to
`runPlugins()`'s existing per-tier `try/catch`, which already turns any Tier 4
failure into `{error}` on the `rules` output without crashing the crawl. No new
error-handling surface needed.

| Decision | Alternative | Why |
|---|---|---|
| `@google/genai` in crawler-core, factory function not a singleton | inject an HTTP client instance | A factory keeps the interface unaware of *how* the key is obtained (env var, secret manager, whatever a future service prefers) — same shape as `createBlobStore()`/`createRedis()` elsewhere in the codebase. |
| Optional `llmSocket` arg on `runPlugins`, default `mockLlmSocket` | a module-level "current implementation" you swap by calling a setter | An explicit argument is visible at every call site and trivially testable — no hidden global state, no risk of a test leaking its mock into another test. |
| `fields` as `{name, selector}[]` on the wire, `Record` after parsing | try to coerce a `Record` schema through the structured-output config anyway | Fixed-property schemas are the common denominator across providers; keeping this shape also meant the Claude→Gemini swap didn't need to touch the wire format at all. |
| Truncate + strip noise tags before sending HTML | send the full raw HTML | Selectors don't need script bodies, styles, or nav chrome — sending them is pure token cost with no signal. |
| Gemini over Claude | keep the paid Claude integration | Operator chose a free-tier-eligible provider; the swappable-interface design meant this cost nothing architecturally to change. |

## What this is *not*

- Not a provider-agnostic abstraction. One real implementation
  (`createGeminiLlmSocket`) plus the mock. A second provider, if ever wanted,
  is another factory behind the same `LlmSocket` interface — the interface was
  already designed for this (and just proved it, going from Claude to Gemini).
- Not a verification step. A generated rule is trusted immediately, same gap
  phase14.md already documented (hit-rate tracking exists; nothing acts on a
  low hit-rate yet).
- Not point-and-click intent capture — still a plain-text `intent` field, the
  other half of the original vision doc that remains unbuilt.

## Exit criteria

- `packages/crawler-core` typechecks and builds with the new dependency; unit
  tests continue to pass using `mockLlmSocket` (no test requires network
  access or an API key).
- With `GEMINI_API_KEY` unset (the default), worker/renderer behavior is
  byte-for-byte unchanged from before this milestone — `mockLlmSocket` still
  runs Tier 4.
- With `GEMINI_API_KEY` set, a crawl with an `intent` and no existing rule
  produces real Gemini-generated selectors, extracts on the same page, and
  persists the rule for reuse — verified manually against a live domain
  (no automated integration test; matches the precedent set by phase13.md's
  "not yet tested: persistence round-trip" gap, which also required live
  infrastructure this repo's offline suite doesn't spin up).
