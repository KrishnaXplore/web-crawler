# 5. SSRF defense: fetch-time, IP-pinned, per-redirect

Date: 2026-07-05

## Status

Accepted

## Context

A crawler fetches arbitrary user-supplied URLs from inside our network. That is
exactly the capability an attacker needs for Server-Side Request Forgery (SSRF):
submit a job whose URL points at an internal target and let our infrastructure
make the request that the attacker cannot. High-value targets include:

- Loopback / localhost (`127.0.0.0/8`, `::1`).
- Private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6
  `fc00::/7`).
- Link-local (`169.254.0.0/16`), which includes the **cloud metadata endpoint
  `169.254.169.254`** — often the highest-value target, as it can leak IAM
  credentials.

The naive defense — validate the URL's host at submission time (Phase 1) and
reject private addresses — is **insufficient** and bypassable two ways:

1. **DNS rebinding (TOCTOU).** The host resolves to a public IP when the API
   validates it, then to `127.0.0.1` (or the metadata IP) by the time a worker
   fetches it. The DNS answer changed between check and use.
2. **Redirects.** A public URL that the validator accepts responds with a `302`
   to `http://169.254.169.254/…`. If redirects are followed by the HTTP client's
   default behavior, the internal request is made without any re-check.

## Decision

**The authoritative SSRF guard runs at fetch time, in the worker, on every
connection — not (only) at submission.** Concretely:

1. **Fetch-time resolution.** Resolve the host to IP(s) at the moment of fetch and
   reject any answer in a loopback / private / link-local / unique-local range.
   Validation and use happen together.

2. **IP-pinned connections.** Connect to the **exact IP that was validated**, not
   by re-resolving the hostname inside the HTTP client. This closes the rebinding
   window: the address we checked is the address we connect to. (Implementation:
   a custom `lookup`/agent that returns the pre-validated IP, or connect by IP
   with the `Host` header set.)

3. **Manual, per-hop redirect handling.** Disable the HTTP client's automatic
   redirect following. Follow redirects ourselves, and re-run steps 1–2 on **every
   hop**, up to a bounded maximum. Record the final URL. Any hop resolving to a
   forbidden range aborts the fetch.

4. **Applies to every attacker-influenced fetch**, including the `robots.txt`
   fetch (Phase 4.1), not just the page fetch.

5. **Submission-time pre-screen remains** (Phase 1) as a cheap early reject and
   fast user feedback, but it is explicitly *not* the security boundary.

Scheme is also restricted to `http`/`https` (no `file:`, `gopher:`, `ftp:`, etc.).

## Consequences

### Positive

- Closes the DNS-rebinding and redirect bypasses that a submission-time-only check
  leaves open.
- Protects the cloud metadata endpoint, the single most damaging SSRF target.
- One guard covers page fetches, `robots.txt`, and every redirect hop uniformly.

### Negative / tradeoffs

- **We cannot use the HTTP client's default redirect follower**; we own the
  redirect loop. Slightly more code, and we must enforce our own max-hop cap.
- **IP pinning complicates connection setup** (custom lookup/agent) and interacts
  with hosts behind CDNs that return many rotating IPs — we validate and pin the
  one we resolved for this attempt; a retry re-resolves.
- **Multi-A-record / IPv6 dual-stack hosts** must have *every* returned address
  validated, not just the first, or an attacker can smuggle a private IP among
  public ones.
- A determined attacker controlling authoritative DNS with very low TTLs is
  bounded by the pin: the worst case is one connection to a validated public IP,
  never to an internal one.

## Alternatives considered

- **Submission-time validation only** — rejected: bypassable via rebinding and
  redirects (see Context).
- **Egress firewall / network policy blocking RFC-1918 and link-local from worker
  pods** — a strong *defense in depth* and recommended in addition, but it is an
  infra control outside the app and does not protect environments where it is
  absent. This ADR keeps the guard in the application; the firewall complements
  it.
- **Allowlist of permitted destinations** — too restrictive for a general-purpose
  crawler whose purpose is to fetch arbitrary public URLs.
