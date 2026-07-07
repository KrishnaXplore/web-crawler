// prom-client is CJS; default-import then destructure for reliable ESM interop.
import promClient from "prom-client";

const { Registry, collectDefaultMetrics, Counter, Histogram } = promClient;

/** One shared registry. Metric names/labels are a contract Prometheus depends on. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Pages processed by the worker, labelled by outcome. */
export const pagesTotal = new Counter({
  name: "crawler_pages_total",
  help: "Pages processed, by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/** Fetch duration histogram (seconds). */
export const fetchDuration = new Histogram({
  name: "crawler_fetch_seconds",
  help: "Time to crawl one URL",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/** HTTP requests served by the API. */
export const httpRequests = new Counter({
  name: "crawler_http_requests_total",
  help: "HTTP requests handled by the API",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

/** Prometheus exposition text. */
export function metricsText(): Promise<string> {
  return registry.metrics();
}

export const contentType = registry.contentType;
