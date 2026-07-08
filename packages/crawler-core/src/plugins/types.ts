import type { CheerioAPI } from "cheerio";

/** What every analyzer plugin receives for a page. */
export interface AnalyzerInput {
  readonly url: string;
  /** Parsed DOM (loaded once by the host and shared across plugins). */
  readonly $: CheerioAPI;
  /** Response headers, lowercased. */
  readonly headers: Record<string, string>;
  readonly status: number;
  /**
   * Raw response body — some analyzers (M10 exposure) scan text that isn't DOM
   * (inline JSON, script contents).
   */
  readonly body: string;
  /**
   * True iff the crawl job supplied auth context (requestHeaders). The exposure
   * plugin (M10) escalates sensitive-data findings that appear when this is false —
   * data reachable with no auth is the actual leak.
   */
  readonly authenticated: boolean;
  /**
   * Operator-supplied config for analyzers (M10) — e.g. custom sensitive-data
   * regexes. Keyed by plugin name.
   */
  readonly options?: Record<string, unknown>;
}

/**
 * An analyzer plugin (ADR-0006): a pure function over a page that returns a JSON-able
 * result. Adding a capability is "write a plugin", not "edit the pipeline". A plugin
 * that throws is isolated by the host — it fails its own analysis, not the crawl.
 */
export interface AnalyzerPlugin {
  readonly name: string;
  analyze(input: AnalyzerInput): Record<string, unknown>;
}
