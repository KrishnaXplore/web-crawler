# 6. A modular monolith of services, not microservice sprawl

Date: 2026-07-06

## Status

Accepted

## Context

A later design proposal ("distributed-web-intelligence-platform") expanded the
system from three deployables (worker, api, web) to six-plus: separate
`auth-service`, `scheduler`, `notification-service`, an `elasticsearch` search
tier, and a full `kubernetes` + `helm` deployment surface, alongside a genuinely
good `plugins/` extensibility model.

The extensibility ideas are worth adopting. The *service decomposition* is not —
at least not yet. Splitting a system into many services before there is a scaling
or team-boundary reason to do so is the **distributed-monolith anti-pattern**:
you pay the full operational cost of microservices (N deploy pipelines, N
health/monitoring targets, network hops, partial-failure modes, cross-service
versioning, distributed debugging) while retaining monolith-level coupling,
because the services still change together and share the same data.

Each new service is not free. `auth-service`, `notification-service`, and
`scheduler` as independent apps each add: a Dockerfile, a deploy step, a readiness
probe, a Prometheus target, a failure mode, an inter-service contract to version,
and a network hop on the hot path. For a single-team portfolio-scale system, that
cost buys nothing that a well-factored package or module does not already provide.

The mark of a production-ready architecture is the **right** number of services,
not the maximum. Amazon, Google, and every "we regret our microservices" postmortem
agree: start as a modular monolith with clean internal boundaries, and extract a
service only when a specific, named pressure demands it.

## Decision

We keep **three deployable services** — `worker`, `api`, `web` — and express every
other "service" from the proposal as a **package or a module** with a clean
boundary, so extraction later is cheap but is not paid for now.

| Proposed as a service | Decision | Lives as |
|---|---|---|
| `auth-service` | Library | `packages/auth` (JWT verify + RBAC), used by `api` middleware |
| `scheduler` | Module | `services/worker/src/scheduler/` — BullMQ repeatable jobs |
| `notification-service` | Deferred | future queue consumer; documented, not built |
| Elasticsearch tier | Deferred | Mongo text search now; ES behind a future ADR |
| `custom-plugin-sdk` | Deferred | internal `AnalyzerPlugin` interface first; public SDK once stable |
| Kubernetes **and** Helm | One, not both | Helm is parameterized k8s — pick a single prod path |

**Extraction criteria.** A module/package graduates to its own service only when it
meets at least one of:

1. **Independent scaling.** It must scale on a different axis than its host (e.g.
   screenshot rendering is CPU/GPU-bound and would starve the API — extract it).
2. **Independent deploy cadence / team ownership.** A separate team ships it on a
   different schedule.
3. **Fault isolation.** Its failure must not be allowed to take down its host, and
   in-process isolation is insufficient.
4. **Independent runtime / resource profile.** It needs a different language,
   memory ceiling, or dependency set that pollutes the host image.

Until a candidate meets one of these, it stays a package/module. The clean
boundary (its own package, a typed interface) is what makes the eventual
extraction a mechanical refactor rather than a rewrite.

**We DO adopt** the proposal's `plugins/` model and its `crawler-core` domain
separation — those improve modularity *without* adding deployables, which is
exactly the trade we want.

## Consequences

### Positive

- **Lower operational surface.** Three services to deploy, monitor, and reason
  about, not six-plus. Fewer network hops on the request path.
- **Coupling is honest.** Code that changes together lives together; we are not
  paying microservice tax for monolith coupling.
- **Extraction stays cheap.** Because auth/scheduler/notifications already have
  package/module boundaries and typed interfaces, promoting one to a service later
  is a mechanical change, not a redesign.
- **The good ideas survive.** `plugins/` and `crawler-core` give us the
  extensibility and domain separation the proposal was reaching for.

### Negative / tradeoffs

- **Blast radius per service is larger.** A bug in `packages/auth` ships inside the
  `api` process; there is no process boundary isolating it. Accepted — auth logic
  is small and well-tested, and process isolation is not worth a service.
- **Scaling is coarser.** `api` and its auth/validation scale together. Accepted
  until auth or search demonstrably needs its own scaling axis (criterion 1).
- **"Why isn't this a microservice?" in interviews.** This is a feature: the
  answer — *"I extract on named pressure, not by default"* — signals more seniority
  than reflexively drawing a service per noun.

## Alternatives considered

- **Full microservices as proposed** — rejected: pays the distributed-monolith tax
  with no team-boundary or independent-scaling justification at this stage.
- **Single monolith (everything in one process)** — rejected: the worker genuinely
  must scale horizontally and independently of the API (the core thesis, ADR-0003),
  so worker/api/web *do* earn separate deployables.
- **Modular monolith of services (this decision)** — the middle path: the minimum
  number of services the scaling story actually requires, with clean internal
  boundaries for everything else.
```
