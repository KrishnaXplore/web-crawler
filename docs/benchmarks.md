# Benchmarks — Horizontal Scaling (M7 Step D)

The HLD's central claim (§4): **adding worker replicas increases crawl throughput,
until domain-mix politeness caps it.** This measures that claim with real crawls.

## Method

- `scripts/load-test.ts` submits the same fixed seed set through the public API and
  reports wall-clock pages/sec once every job reaches a terminal state.
- **Seed set (multi-domain on purpose):** `books.toscrape.com` + `quotes.toscrape.com`
  (public scraping sandboxes), depth 3, 200-page cap each → **379 pages** per run
  (dedup makes the workload identical across runs).
- Politeness interval `CRAWL_DELAY_MS=50` → hard per-domain cap of 20 pages/s,
  so the **theoretical ceiling for this 2-domain mix ≈ 40 pages/s minus fetch
  latency**; in practice the interleaving of ~200–400 ms fetches against a 50 ms
  token gate puts the practical ceiling near ~20 pages/s.
- Worker concurrency 4 per replica. State cleaned between runs (fresh jobIds).

**Environment:** Apple M4, 16 GB, macOS 15.7, Node v24, Redis/Mongo/MinIO in Docker
on the same machine, residential network. Measured 2026-07-08.

## Results

| Workers | Pages | Wall clock | Throughput | Speedup vs 1 |
|--------:|------:|-----------:|-----------:|-------------:|
| 1 | 379 | 38.5 s | **9.86 pages/s** | 1.0× |
| 2 | 379 | 24.1 s | **15.70 pages/s** | 1.59× |
| 4 | 379 | 20.1 s | **18.82 pages/s** | 1.91× |

```
 pages/s
   20 ┤                        ●  ← politeness ceiling (~20/s for this domain mix)
   16 ┤            ●
   12 ┤
   10 ┤  ●
      └──┬───────────┬─────────┬──
         1           2         4   workers
```

## Reading the curve

- **1 → 2 workers: +59%.** Throughput scales with replicas while fetch capacity is
  the bottleneck — the stateless-worker thesis (ADR-0003) holding in practice.
- **2 → 4 workers: +20%, flattening.** The curve bends exactly where the design says
  it must: a 2-domain mix is politeness-capped near ~20 pages/s, and 4 workers sit at
  ~94% of that ceiling. More workers cannot (and *should not*) push a polite crawler
  past the per-domain rate gate.
- **Implication:** scaling is governed by **domain mix, not worker count**. A crawl
  spanning 20 domains would keep scaling well past 4 workers; a single-domain crawl
  would barely scale past 1. This is the correct behavior for a polite crawler, and
  why capacity planning for this system starts from the seed set's domain diversity.

## Caveats (honest ones)

- Single machine, workers share CPU/network with the infra containers — a
  distributed deployment would shift absolute numbers (likely up).
- Residential network; latency to the sandbox sites dominates per-fetch time.
- Small N (one run per configuration); variance not characterized. Numbers are
  indicative, not statistical.
- 379 pages is a small workload; steady-state rates (the mid-run readings) matched
  the end-to-end averages within ~5%, so ramp-up effects are minor but present.

## Reproducing

```bash
pnpm infra:up && pnpm api            # terminal 1
CRAWL_DELAY_MS=50 pnpm worker        # terminal 2 (repeat per replica,
                                     #  each with a distinct WORKER_METRICS_PORT)
pnpm exec tsx scripts/load-test.ts --max-pages 200   # terminal 3
```
