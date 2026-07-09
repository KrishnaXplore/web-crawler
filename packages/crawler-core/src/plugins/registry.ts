import * as cheerio from "cheerio";
import type { AnalyzerPlugin } from "./types.js";
import { BUILTIN_PLUGINS } from "./builtins.js";
import { mockLlmSocket } from "../llm/socket.js";
import { rulesPlugin } from "./rules.js";

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
  /** Natural language intent (M13). */
  readonly intent?: string;
}

/**
 * Run the named analyzer plugins against a page and collect their output keyed by
 * plugin name. The DOM is parsed once and shared. A plugin that throws is isolated:
 * it records an `error` and the others still run (ADR-0006).
 * 
 * M14: Acts as the Confidence Router. If 'discovery' identifies the page as a 'listing',
 * the 'rules' and 'structured' plugins are skipped to save CPU/LLM cost.
 * 
 * M13: Acts as LLM Socket router. If 'intent' is present and 'rules' plugin returns
 * no confidence, falls back to the LLM to generate new rules.
 * 
 * Returns null if no plugins are requested.
 */
export async function runPlugins(
  names: readonly string[],
  args: RunPluginsArgs,
): Promise<Record<string, unknown> | null> {
  if (names.length === 0) return null;
  const $ = cheerio.load(args.html);
  const out: Record<string, unknown> = {};

  const input = {
    url: args.url,
    $,
    headers: args.headers,
    status: args.status,
    body: args.html,
    authenticated: args.authenticated ?? false,
    options: args.options,
  };

  // M14 Confidence Router: Evaluate discovery first if requested
  let isListing = false;
  if (names.includes("discovery")) {
    const plugin = REGISTRY.get("discovery");
    if (plugin) {
      try {
        const res = plugin.analyze(input);
        out["discovery"] = res;
        if ((res as any).pageType === "listing") {
          isListing = true;
        }
      } catch (err) {
        out["discovery"] = { error: err instanceof Error ? err.message : "failed" };
      }
    }
  }

  for (const name of names) {
    if (name === "discovery") continue; // Already ran

    // M14 Confidence Router: Skip extraction on listing pages
    if (isListing && (name === "rules" || name === "structured")) {
      out[name] = { error: "skipped_by_confidence_router" };
      continue;
    }

    const plugin = REGISTRY.get(name);
    if (plugin === undefined) continue; // unknown plugin name — skip
    try {
      out[name] = plugin.analyze(input);
      
      // M13/M14 LLM Fallback (Tier 4)
      if (name === "rules" && (out[name] as any).confidence === "none" && args.intent) {
        const domain = new URL(args.url).hostname;
        const generatedRule = await mockLlmSocket.generateRules(domain, args.html, args.intent);
        
        // Re-run the rules plugin with the newly generated rules
        const fallbackInput = {
          ...input,
          options: {
            ...input.options,
            rules: generatedRule,
          }
        };
        const fallbackResult = plugin.analyze(fallbackInput) as any;
        
        // Attach the generated rules so the worker can persist them
        fallbackResult.generatedRules = generatedRule;
        out[name] = fallbackResult;
      }

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
