# Phase 4 Step B (Milestone M4) — Safety: SSRF Guard + Per-Domain Rate Limiting

> **Naming note.** Milestone **M4**, second half. Step A was operational correctness;
> Step B is safety. Implements [ADR-0005](adr/0005-ssrf-defense.md) and the per-domain
> rate limiting from [ADR-0004](adr/0004-frontier-per-domain-scheduling.md).

Until now the worker would fetch *any* URL — including `http://127.0.0.1`,
`http://169.254.169.254/` (cloud metadata), or a public URL that redirects to one.
That makes the crawler an **SSRF weapon**. Step B closes that, and adds the
politeness the earlier "simple delay" only approximated.

---

## What Step B delivers

| Piece | Where | Responsibility |
|---|---|---|
| SSRF guard | `@crawler/core` `pipeline/ssrfGuard` | Fetch-time DNS validation, IP-pinning, per-redirect re-check. |
| rate limiter | `@crawler/queue` `rateLimit` | Per-domain token/interval gate in Redis, shared across workers. |
| worker wiring | `services/worker` | Acquire a domain slot before fetching; treat SSRF blocks as a non-retried outcome. |

---

## Design decisions

### SSRF guard — fetch-time, IP-pinned, per-redirect (ADR-0005)

The submission-time check is a fast reject but **not** the security boundary (DNS can
rebind; redirects can jump inward). The authoritative guard runs at fetch time. We
implement it with an **undici `Agent` whose `connect.lookup` validates every DNS
resolution**:

1. **Fetch-time resolution + validation.** Every connection resolves the host through
   our `lookup`, which rejects any address in a loopback / private / link-local /
   unique-local range (IPv4 + IPv6, including IPv4-mapped IPv6 and the
   `169.254.169.254` metadata address).
2. **IP-pinning.** `lookup` returns the exact validated address undici then connects
   to — so the address we checked is the address we use (defeats DNS-rebinding TOCTOU).
3. **Per-redirect.** Redirects are followed through the *same* guarded dispatcher, so
   **every hop** re-resolves through the validating `lookup`. A public URL that `302`s
   to an internal address is rejected at the hop.
4. **Everything attacker-influenced** goes through it — the page fetch *and* the
   `robots.txt` fetch.
5. **Scheme restricted** to `http`/`https`.

**Why the `connect.lookup` approach** rather than a manual resolve-then-fetch: doing
it in the dispatcher's lookup gives validation *and* pinning *and* per-redirect
coverage in one place, for free, because undici routes every hop (including redirects)
through the dispatcher. A manual loop would have to re-implement redirect following
and could still race between resolve and connect.

| Alternative | Why not |
|---|---|
| **Validate the URL's host string only** | Misses DNS resolution entirely — `http://a-name-that-resolves-to-127.0.0.1/` sails through. Must check the *resolved IP*. |
| **Resolve manually, then `fetch(ip)`** | Loses the `Host` header / TLS SNI unless carefully restored, and doesn't cover redirect hops. The dispatcher lookup avoids both problems. |
| **Egress firewall only** | Great defense-in-depth (recommended too), but it's infra outside the app and absent in many environments; the guard must live in the code (ADR-0005). |

**Outcome, not error.** An SSRF block is a distinct `blocked-ssrf` outcome (like
`skipped-robots`) — **not** a transient `error`. So it is *not* retried and does *not*
dead-letter: it will always fail, so retrying is pointless.

### Per-domain rate limiting — a Redis interval gate

**Chosen:** before fetching, a worker acquires a slot for the URL's **domain** via an
atomic Redis Lua script: it stores the next-allowed timestamp per domain; if now is
past it, it reserves the next slot and returns `0` (go), else returns the ms to wait.
The worker sleeps and retries until it gets a slot. The interval is the domain's
robots `Crawl-delay` (when respected) or the configured default.

**Why per-domain, in Redis:** politeness is a property of the *target host*, shared
across **all** workers — one global Redis gate is what stops N workers from
collectively hammering one site (ADR-0004). A per-worker delay (what M2 had) doesn't:
4 workers × "200 ms each" still means 20 req/s at the host.

| Alternative | Why not now |
|---|---|
| **Re-queue with delay** instead of in-process sleep | The "proper" BullMQ move (frees the worker slot). More complex; for M4 an in-process wait is simpler and correct. Noted as a scale-time improvement, and it's the ADR-0004 frontier-scheduler direction. |
| **Per-worker delay** | Doesn't bound *aggregate* per-host rate — the whole point. |

---

## What's tested

- **`isBlockedAddress`** — pure unit tests (offline): loopback, all private ranges,
  link-local/metadata, IPv6 loopback/ULA/link-local, IPv4-mapped IPv6, and that public
  addresses pass. This is the security-critical logic, tested exhaustively.
- **End-to-end SSRF** — seeding `http://127.0.0.1/` or `http://169.254.169.254/`
  results in a `blocked-ssrf` outcome, no fetch, no DLQ.
- **Rate limiting** — a same-host crawl is spaced by the interval across concurrent
  workers (observable in timings); normal crawls still complete.

## Exit criteria for Step B

- A crawl seeded at a private/loopback/metadata address is **blocked** at fetch time
  (`blocked-ssrf`), and a public URL that redirects to one is blocked at the hop.
- Per-domain fetches are rate-limited across all workers by a shared Redis gate.
- Offline suite green (SSRF address tests included).

**M4 is then complete.** Next: **M5** — the product surface (REST API, dashboard,
auth, analyzer plugins, metrics, search, export).
