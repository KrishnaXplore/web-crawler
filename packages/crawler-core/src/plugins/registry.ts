import * as cheerio from "cheerio";
import type { AnalyzerPlugin } from "./types.js";
import { BUILTIN_PLUGINS } from "./builtins.js";

const REGISTRY = new Map<string, AnalyzerPlugin>(
  BUILTIN_PLUGINS.map((p) => [p.name, p]),
);

export interface RunPluginsArgs {
  readonly url: string;
  readonly html: string;
  readonly headers: Record<string, string>;
  readonly status: number;
  /** True iff the crawl carried auth context (M10). Defaults to false. */
  readonly authenticated?: boolean;
  /** Per-plugin operator config (M10), keyed by plugin name. */
  readonly options?: Record<string, unknown>;
}

/**
 * Run the named analyzer plugins against a page and collect their output keyed by
 * plugin name. The DOM is parsed once and shared. A plugin that throws is isolated:
 * it records an `error` and the others still run (ADR-0006). Returns null if no
 * plugins are requested.
 */
export function runPlugins(
  names: readonly string[],
  args: RunPluginsArgs,
): Record<string, unknown> | null {
  if (names.length === 0) return null;
  const $ = cheerio.load(args.html);
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const plugin = REGISTRY.get(name);
    if (plugin === undefined) continue; // unknown plugin name — skip
    try {
      out[name] = plugin.analyze({
        url: args.url,
        $,
        headers: args.headers,
        status: args.status,
        body: args.html,
        authenticated: args.authenticated ?? false,
        options: args.options,
      });
    } catch (err) {
      out[name] = { error: err instanceof Error ? err.message : "failed" };
    }
  }
  return out;
}

/** Names of all available plugins (for validation / discovery). */
export function availablePlugins(): string[] {
  return [...REGISTRY.keys()];
}
