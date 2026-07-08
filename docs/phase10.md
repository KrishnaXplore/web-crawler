# Phase 10 (Milestone M10) — Public Exposure Analyzer

> Milestone **M10** — turns the crawler into a **defensive auditing tool**: given a
> site you own or are authorized to test, it finds resources and data that are
> reachable **without authentication** and flags them. Implemented as one more
> analyzer plugin behind the existing dispatcher (ADR-0006) plus auth-aware crawling —
> no engine changes.

The motivating case: a portal whose **UI** requires login, but whose **server**
doesn't enforce it — the login only hides a `<div>`, or the API returns data to any
caller (broken access control / IDOR). The tool's job is to **detect, confirm, and
scope** that exposure so it can be fixed — not to harvest the exposed data.

## Scope & ethics (load-bearing, not boilerplate)

This is an **auditor, not an attacker**. The design enforces that:

- **Passive only.** It analyzes resources the crawl **already fetched or saw linked**
  (pages, robots.txt, sitemap, `<a href>`, JS already delivered to every visitor). It
  does **not** guess/probe paths (`/.git/`, `/backup.sql`, `/.env`), brute-force,
  fuzz, or bypass auth. Discovery comes from the crawl, never from fabricated URLs.
- **Detect & confirm, don't dump.** Findings store **redacted samples and counts**
  (e.g. `email ×47, first match: j••••@••••.edu`), never bulk-exfiltrated records.
  A copy of a client's full dataset is a liability the tool refuses to create.
- **Authorized targets only.** The tool is run by the site's own
  developer/owner/authorized tester. Nothing about it is covert — honest User-Agent,
  robots respected by default (auditors may disable for their own sites).

These aren't limitations bolted on; they're what separates a legitimate exposure
report from an offensive tool, and they're encoded in the plugin's behavior.

---

## Step A — auth-aware crawling (the two-pass method)

Detecting "leaks despite a login" needs a comparison the crawler can't currently make,
because it always fetches anonymously. M10 Step A lets a job carry request
**auth context** so an operator can run:

1. **Authenticated baseline** — a job with a valid session header/cookie: learns where
   the sensitive data legitimately lives.
2. **Unauthenticated pass** — the same targets with no auth. **Anything still
   returning the sensitive data is the leak.**

**Design.** Job config gains an optional `requestHeaders?: Record<string,string>`
(e.g. `{ "Cookie": "session=…" }` or `{ "Authorization": "Bearer …" }`). `fetch`
merges them; the browser renderer sets them via `extraHTTPHeaders`. The analyzer input
gains `authenticated: boolean` (true iff the job supplied auth context), so the
exposure plugin can distinguish "sensitive data behind auth" (expected) from
"sensitive data with no auth" (the finding).

| Decision | Alternative | Why |
|---|---|---|
| Per-job `requestHeaders` | a full login/session-management flow | Honest for an audit tool: the tester supplies a session they already hold. Automating login is scope creep and fragile. |
| `authenticated` flag = "job supplied auth" | detect auth per-response | The operator knows which pass is which; a boolean is unambiguous and can't misclassify. |
| Secrets (cookies/tokens) never persisted on the Page | store them for replay | Audit hygiene — the tool holds the client's session only in-flight, never at rest. |

## Step B — the `exposure` analyzer plugin

A pure function over the page (same `AnalyzerInput` as seo/security), returning an
exposure summary. It classifies signals into categories, each with a severity, and —
critically — a **finding is escalated when it appears on an unauthenticated response**.

Detectors (all passive, over already-fetched content):

| Category | Signal | Severity driver |
|---|---|---|
| `sensitiveData` | PII-shaped matches in the response body: emails, phone numbers, and operator-supplied patterns (roll numbers, PAN/Aadhaar-like, etc.) | **high if `!authenticated`** |
| `documents` | Linked `.pdf/.docx/.xlsx/.csv` | medium |
| `backupFiles` | Linked `.zip/.tar/.gz/.bak/.old/.sql` (only if actually linked in crawled HTML) | high |
| `apiDocs` | Links/paths to `/swagger`, `/openapi.json`, `/api-docs` seen in the crawl | low/info |
| `clientConfig` | Client-side config already shipped to every visitor: `firebaseConfig`, Stripe **publishable** keys, Maps keys | info (report presence, never validate/use) |
| `robotsSensitive` | Disallowed paths in robots.txt that look sensitive (`/admin`, `/backup`, `/private`) — **reported, never visited** | info |

Each match is stored **redacted** with a count and one masked example. The plugin
computes a per-page `riskScore` (none/low/medium/high) from the highest-severity
category present.

| Decision | Alternative | Why |
|---|---|---|
| Redacted sample + count | store full matched values | Detect-don't-dump: enough to prove and prioritize, without hoarding PII. |
| Detectors are config-driven regex categories | hard-coded rules only | The operator adds domain patterns (a college's roll-number format) without code changes; reduces false positives, which is the real research problem. |
| Reuses the plugin dispatcher | a separate scan mode | It's an analyzer — one more entry in `plugins:[…]`, same as seo. No new pipeline. |

## Step C — exposure report & surfacing

The M8 report gains an **Exposure** section aggregating the plugin's per-page output:
counts by category, the highest risk score across the crawl, and the list of URLs that
returned `sensitiveData` **while unauthenticated** (the actionable findings). Dashboard
shows an "Exposure" panel; the page drill-down shows a page's exposure detail
(redacted). Export includes exposure columns so the finding travels into a client
report.

The framing that makes this more than a regex list (and the research angle): the
severity/prioritization logic exists to **reduce false positives** — "a linked PDF"
is not a leak; "PII returned on an unauthenticated endpoint that the UI gates" is. The
`authenticated` cross-reference is what turns noise into a real finding.

---

## What's tested

- **A**: unit — `fetch` merges `requestHeaders`; the `authenticated` flag propagates to
  `AnalyzerInput`. (No live login in tests.)
- **B**: pure unit tests on fixture HTML/headers — each detector category
  (email/phone/custom-pattern matches, linked docs, backup extensions, client-config
  presence), redaction of samples, and severity escalation when `authenticated:false`
  vs `true`.
- **C**: report aggregation over fixture pages (counts, max risk, unauth-sensitive URL
  list); dashboard builds.

## Exit criteria

- A job can be run with `requestHeaders` (authenticated) and without; the `exposure`
  plugin flags sensitive-data-bearing responses, escalating those seen **without auth**.
- Findings are **redacted samples + counts**, never full records.
- The report/dashboard show an Exposure section listing the unauthenticated-sensitive
  URLs — enough to prove, scope, and fix a leak (the results-portal case).
- Offline suite green; detectors are pure and unit-tested; nothing probes or fabricates
  URLs.
