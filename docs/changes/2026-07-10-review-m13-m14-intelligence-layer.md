# Review — M13/M14 work-in-progress (Intelligence Layer, Rule Library, Discovery, Intent/LLM)

> Date: 2026-07-10. Scope: code added outside the normal session flow (commit
> `5b1b2b2 "Initial commit (M1-M15 complete)"`, unpushed, plus further uncommitted
> changes) — Website Intelligence Layer wiring, Rule Library, Discovery plugin,
> Intent/LLM socket, Dockerfiles, CI. Reviewed against `docs/architecture-v3.md` and
> the established project conventions (phase-doc-before-code, layering, redaction).
>
> This doc is the audit trail: what was found, severity, and what this pass fixes.
> Fixes are tracked as a checklist and ticked off as each lands.

## Findings

### 🔴 Critical — broke build/deploy

- [x] **1. Typecheck failure** — `app.test.ts` mocks `getDomainProfile` with a
  `lastCrawled: Date` field that doesn't exist on `DomainProfile` (real fields are
  `firstSeenAt`/`lastSeenAt: string`); mocks `createJob` with `.mockResolvedValue("job123")`
  though it returns `Promise<void>`.
- [x] **2. CI installs pnpm v8 against a pnpm-9 lockfile** — `ci.yml` pins
  `pnpm/action-setup@v3` to `version: 8`; `pnpm-lock.yaml` is `lockfileVersion: '9.0'`
  (matches `packageManager: pnpm@9.15.0`). `--frozen-lockfile` fails on the mismatch.
- [x] **3. Containerized dashboard can't reach the API** — the `services/web/Dockerfile`
  rewrite dropped `nginx.conf`, which proxied `/api/*` → the api container (the M7
  "no CORS" design). Default nginx has nowhere to send `/api` calls.
- [x] **4. Intent/LLM tier never fires in HTTP mode** (the default, most common path) —
  the worker's `runPlugins()` call omits `intent: cfg.intent`; the renderer's includes
  it. M13's feature only works if `renderMode:"browser"` is explicitly chosen.

### 🟠 High — deviates from architecture-v3

- [x] **5. Layering violation** — `@crawler/core` now depends on `@crawler/db`
  (`llm/socket.ts` imports the `ExtractionRule` *type* from it). Breaks crawler-core's
  pure/infra-free contract (unit-testable with no Mongo, importable anywhere).
- [x] **6. Confidence router doesn't gate on tier success** — `rules`/`structured` run
  independently; the LLM fallback fires whenever no rule exists yet + intent is set,
  even if `structured` already produced a confident record. Defeats the
  cheapest-first/cost-amortization design.
- [x] **7. Rule Library has no hit-rate/versioning** — `RuleModel` is
  `{domain, schemaType, fields, updatedAt}`; architecture-v3 specifies
  `{version, verifiedAt, hitRate, generatedBy, costPerRecord}`. Without hit-rate,
  there's no staleness signal — "self-heal" is currently "regenerate blindly
  whenever absent," not detection-driven healing.
- [x] **8. Skipped tiers mislabeled as errors** — discovery-gated skips write
  `{error: "skipped_by_confidence_router"}`, conflating "intentionally skipped" with
  "plugin failed." Will corrupt error-rate metrics/dashboards later.
- [x] **9. Dockerfile regressions** (api, worker) — dropped `USER node` (now root),
  dropped `pnpm prune --prod` (ships devDependencies + full monorepo source),
  downgraded `node:22-alpine` → `node:20-alpine`. Reverts documented phase7.md ADRs.
  **Fixed 2026-07-11**: restored `node:22-alpine` + `USER node`; switched to
  `pnpm --filter <pkg> deploy --prod` instead of `pnpm prune --prod` (verified live
  that plain `prune --prod` left `typescript` behind in this workspace — `deploy`
  is pnpm's purpose-built command for a self-contained per-package production
  directory and was confirmed via `docker run` to actually exclude it). Both images
  verified: `docker build` succeeds, non-root user confirmed, `tsc` absent from
  the runtime image, and the compiled entrypoint starts correctly (reaches its
  Redis connection attempt, the expected failure mode outside the compose network).

### 🟡 Process
- [x] **10. No `docs/phase13.md` / `phase14.md`** despite code tagged M13/M14 —
  breaks the phase-doc-before-code convention.

## Fix plan (this pass)

Fixing in dependency order — some critical fixes require the high-severity ones
underneath them to be touched at the same time (e.g. #6's router rewrite naturally
also fixes #8's mislabeling and enables #7's hit-rate hook).

1. Fix #1 (typecheck) — correct the test mocks to match real types.
2. Fix #2 (CI pnpm version) — bump to v9 to match `packageManager`.
3. Fix #3 (nginx proxy) — restore `nginx.conf` + reference it in the web Dockerfile.
4. Fix #4 (intent wiring) — pass `intent: cfg.intent` from the worker too.
5. Fix #5 (layering) — move `ExtractionRule` to `@crawler/shared`; drop crawler-core's
   `@crawler/db` dependency.
6. Fix #6 + #8 (router) — rewrite `runPlugins` to walk tiers in order
   (structured → rules → LLM) and stop at first confident hit; label skips distinctly
   from errors.
7. Fix #7 (Rule Library schema) — add `version`, `verifiedAt`, `hitRate`,
   `generatedBy`; bump hit/miss on each use.
8. Fix #9 (Dockerfiles) — restore non-root user + `pnpm prune --prod` + node:22-alpine
   for api/worker.
9. Fix #10 (phase docs) — write `docs/phase13.md` (Intent layer) and `docs/phase14.md`
   (Discovery + confidence router + self-heal) describing what's actually built.

Each fix is verified (typecheck/test/build, and live where practical) before being
checked off above.

## Bonus finding (surfaced during #7's verification, not in the original list)

**#11. `mongoose` imported directly without being a declared dependency**, in both
`services/api/src/routes/health.ts` (static import) and `services/worker/src/index.ts`
(dynamic `import()`) — part of the readiness-probe addition. Neither service's
`package.json` lists `mongoose` (it's only a transitive dep via `@crawler/db`), so
Vite/Node module resolution failed outright — this was hard-failing `pnpm -r test`
(`services/api` collected 0 tests). Fixed by adding `isMongoReady()` to
`packages/db/src/connect.ts` (the package that actually owns the mongoose connection)
and having both services call that instead of reaching into mongoose directly — the
same layering discipline as fix #5.

## Final verification (2026-07-10)

```
pnpm -r build      → clean
pnpm -r typecheck  → clean
pnpm -r test       → all green
  shared        16 passed
  queue          4 passed, 1 skipped
  storage        1 skipped
  db            19 passed, 1 skipped   (was failing before fix #1)
  crawler-core  76 passed              (was 73 before #6's new tests)
  renderer       4 passed, 1 skipped
  api           16 passed              (was 0/failed before #1 + #11)
```

**Status: 9 of 10 findings fixed and verified; #9 (Dockerfile hardening) deferred at
user's request — tracked, not forgotten.** `docs/phase13.md` and `docs/phase14.md`
now document the Intent Layer and Discovery/Confidence-Router/Rule-Library-feedback
work as-built, closing finding #10.
