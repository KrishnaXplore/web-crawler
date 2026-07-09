# Phase 12 (Milestone M12) — Website Intelligence Layer (thin slice)

> Milestone **M12** — the platform's **per-domain memory** (architecture-v3 §2.45): the
> differentiator that makes "intelligence" real and unblocks rule reuse (M11 Step 2) and
> self-heal (M15). This doc is the **thin first slice**: a `domainProfiles` store that
> the crawl **writes to after each page** and can be **read** back — remembering tech
> stack, render mode, and activity per domain. The Rule Library, discovery map, and
> self-heal loop are later steps on this foundation.

Why start thin: memory is only useful once something writes to it and something reads it.
This slice proves the read/write loop end-to-end with the cheapest useful facts, so the
richer profile fields (rules, page-type map, content fingerprints) accrete onto a
working spine rather than being scaffolded empty.

---

## What this slice delivers

A global (not per-org yet) **domain profile**, updated as a side effect of crawling and
queryable via the API:

```jsonc
// GET /domains/quotes.toscrape.com
{
  "domain": "quotes.toscrape.com",
  "firstSeenAt": "…", "lastSeenAt": "…",
  "pagesObserved": 27,
  "techStack": ["jQuery"],          // union across crawls
  "renderModesSeen": ["http"],      // http and/or browser
  "needsRender": false,             // derived: did any page need the browser?
  "lastStatusOk": true
}
```

- **WRITE** — after each successfully crawled page, the worker/renderer records an
  observation `{ tech, renderMode, statusOk }` for the page's domain.
- **READ** — `GET /domains/:domain` returns the accumulated profile.

That's the whole loop. It immediately demonstrates *memory*: crawl a domain twice and
`pagesObserved` grows, `lastSeenAt` advances, `techStack` persists.

## Design decisions

| Decision | Alternative | Why |
|---|---|---|
| Store in `@crawler/db` (`domainProfiles` model) for now | new `@crawler/intelligence` package immediately | The slice is one model + two functions; a package is justified once rules + self-heal + page-map accrete (arch-v3 names it as the eventual home). Promote then, not now — no empty scaffolding. |
| **Atomic Mongo operators** (`$addToSet`/`$inc`/`$set`/`$setOnInsert`) for the write | read-modify-write merge | N workers observe the same domain concurrently; atomic ops are race-free and lose no tech entries. No read needed on the hot path. |
| `needsRender` **derived** on read, not stored | store a flag | It's a pure function of `renderModesSeen`; deriving avoids a second write and keeps the raw facts canonical. Unit-testable offline. |
| Global profile (no `orgId` yet) | per-org from day one | Tech stack / render need are **objective domain facts** → collective knowledge (arch-v3 decision I). Per-org *rules* come with the Rule Library step. |
| Best-effort write (failures don't fail the crawl) | transactional | The profile is an optimization/memory, never correctness. A dropped observation is harmless; never let it break a page. |

## Explicitly deferred (kept out of the thin slice)

- **Rule Library** (per-org rules, versioned, hit-rate) → M11 Step 2 / its own step.
- **READ-before-crawl** optimization (skip HTTP-then-render using `needsRender`) → next
  slice; this one only proves write+read.
- **Page-type map, content fingerprints, change-over-time** → later; the model leaves
  room but this slice doesn't populate them.
- **Per-org scoping / self-heal** → M15.

## What's tested

- Pure unit test of `deriveProfile` (raw doc → typed profile incl. `needsRender` from
  `renderModesSeen`; empty/absent fields).
- API: `GET /domains/:id` → 404 for an unknown domain, profile for a known one (mocked db).
- Integration (opt-in `RUN_MONGO_IT`): two observations on a domain upsert one profile
  with `pagesObserved: 2` and unioned tech.
- Live: crawl quotes.toscrape twice, confirm the profile accumulates.

## Exit criteria

- Crawling a domain creates/updates its profile; `GET /domains/:domain` returns it.
- `needsRender` is true iff a page was crawled in browser mode; tech unions across pages.
- Profile writes never fail a crawl; offline suite green.
