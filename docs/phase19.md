# Phase 19 (Milestone M19) — Dashboard: Plain-Language UI, Structured Results

> Written before code. Closes the last concretely-identified gaps from the
> earlier UX audit (this session): raw plugin names with no explanation, a
> "JS/SPA" jargon term, and a results view that falls back to raw
> `JSON.stringify` for every extracted field.

## What it solves

Everything under the hood now works for a non-technical user — Discovery
Engine navigation, coverage-aware extraction, self-healing rules. But the
audit from earlier in this project found three concrete presentation gaps
that still require technical background to get past:

1. The plugin checklist shows raw internal names (`seo`, `tech`, `security`,
   `metadata`, `exposure`, `structured`, `rules`, `discovery`) with no
   explanation of what any of them do.
2. "Render Mode" has an option literally labeled `Browser (JS/SPA)`.
3. Clicking into a result shows `JSON.stringify(data, null, 2)` for every
   analyzer's output — readable to a developer, not to anyone else.

None of these are functional bugs — the crawl and extraction work regardless.
They're the last presentation layer standing between "the platform is
zero-knowledge-friendly" and "the platform *works* but still looks like a
dev tool once you're inside it."

## Design

### A shared plugin-info map

One small data file (`services/web/src/pluginInfo.ts`) maps each plugin's
internal name to a plain-language label and one-line description. Both
`JobForm` (the checklist) and `PageDetail` (the results section headers)
import it, so the two surfaces never drift into describing the same plugin
two different ways.

### Render Mode wording

`Browser (JS/SPA)` → `Browser (for sites that need JavaScript to load)`.
"Auto" and "HTTP" options get the same treatment — plain descriptions instead
of internal terms ("Intelligence Layer" is a project-internal name, not
something a user needs to know exists).

### Structured results instead of raw JSON

`PageDetail`'s per-analyzer block currently does `JSON.stringify(data, null,
2)` unconditionally. Replace it with a small recursive key-value renderer:

- scalar (string/number/boolean) → shown as plain text
- `null`/`undefined` → an em dash
- array of scalars → comma-joined
- one level of nested plain object (the common shape — e.g. `rules.fields`,
  `discovery.signals`) → an indented nested list
- anything else (deeper nesting, mixed arrays) → falls back to compact inline
  JSON *for that value only*, not the whole block

This isn't a bespoke UI per plugin (that would be a much larger, higher-
maintenance surface than the actual problem calls for) — it's one generic
renderer that happens to produce a readable result for the common shapes
every analyzer plugin in this codebase already returns (flat records, or one
level of nesting). The **"Raw JSON" collapsed section stays** as the power-
user fallback — nothing is hidden, it's just not the default view anymore.

| Decision | Alternative | Why |
|---|---|---|
| One generic key-value renderer | A bespoke display component per plugin (`SeoView`, `RulesView`, ...) | Every plugin's output is already a flat-ish record — a generic renderer gets the readability win without an 8-component surface to maintain, one per analyzer, that has to be updated whenever a plugin's output shape changes. |
| Keep "Raw JSON" as a collapsed fallback | Remove raw JSON entirely | Nothing should become *less* inspectable — a developer or power user debugging a wrong extraction still needs the exact shape. Collapsed-by-default serves both audiences. |
| Shared `pluginInfo.ts`, not inline strings in each component | Duplicate the label/description in both `JobForm` and `PageDetail` | Two copies of "what does `rules` mean" will eventually say different things; one file can't drift from itself. |

## What this is not

- Not a visual redesign — same layout, same CSS variables, same dark theme.
  This is copy and one rendering strategy, not a UI overhaul.
- Not a fix for every remaining piece of jargon in the app ("max depth,"
  "robots.txt," "webhook" still appear) — scoped to the three items the audit
  actually flagged as concrete blockers, not a full copy pass.

## Exit criteria

- `pluginInfo.ts` covers all 8 plugin names; `JobForm`'s checklist and
  `PageDetail`'s section headers both use it.
- Render Mode dropdown has no raw jargon in its option text.
- A result with a typical extraction (`rules.fields: {name, price}`) renders
  as a readable list, not a JSON blob, by default; the same data is still
  available verbatim under "Raw JSON."
- Verified in an actual browser (screenshot), not just a successful build —
  matching this project's established pattern for UI changes.
