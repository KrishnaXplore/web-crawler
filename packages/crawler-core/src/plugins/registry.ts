import * as cheerio from "cheerio";
import type { AnalyzerPlugin } from "./types.js";
import { BUILTIN_PLUGINS } from "./builtins.js";
import { mockLlmSocket, type LlmSocket } from "../llm/socket.js";
import { rulesPlugin } from "./rules.js";
import { isIntentCovered } from "./intentCoverage.js";

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
  /**
   * The Tier 4 implementation to use for intent-driven rule generation (M15).
   * Defaults to `mockLlmSocket` — callers opt into a real provider explicitly by
   * constructing one (e.g. `createAnthropicLlmSocket`) and passing it here.
   */
  readonly llmSocket?: LlmSocket;
}

/** A plugin's self-reported extraction confidence, when it has one (Tier 1/2 records). */
function confidenceOf(result: unknown): "high" | "low" | "none" | undefined {
  const c = (result as { confidence?: unknown } | null | undefined)?.confidence;
  return c === "high" || c === "low" || c === "none" ? c : undefined;
}

/**
 * Run the named analyzer plugins against a page and collect their output keyed by
 * plugin name. The DOM is parsed once and shared. A plugin that throws is isolated:
 * it records an `error` and the others still run (ADR-0006).
 *
 * Confidence router (M13/M14/M17, architecture-v3 §2.4 "cheapest-first, stop at first
 * success"): when a job asks for BOTH `structured` (Tier 1) and `rules` (Tier 2),
 * Tier 1 always runs first regardless of the order `names` were given in; Tier 2 only
 * runs its selector/LLM logic if Tier 1 did NOT produce a confident result COVERING
 * what `intent` asked for (M17 — see ./intentCoverage.ts) — it is an escalation path,
 * not an independent extraction. A Tier 1 hit that only partially covers the intent
 * (e.g. found `name`/`description` but the intent also asked for `price`) does NOT
 * block escalation; both tiers' outputs are kept separately (`out.structured`,
 * `out.rules`), never merged, so it's always visible which tier found what. Asking for
 * `rules` alone (no `structured`) runs it directly, unconditionally — no implicit
 * Tier-1 dependency.
 *
 * `discovery`, when requested, changes what runs on a `listing` page (M22): Tier 1
 * (structured) is skipped — recorded as `{ skipped: true, reason }`, distinct from
 * `{ error }` — because a listing's own JSON-LD is usually about the wrong thing;
 * the rules tier runs in LIST mode instead, using the domain's list rule
 * (`options.listRules`: a `listItem` container selector + per-container field
 * selectors) and producing `records: [...]` — one record per repeating item.
 *
 * Tier 4 (LLM) fires only from the `rules` slot, only when the job supplied an
 * `intent`, and only when Tier 2 found nothing OR its result doesn't cover the
 * intent (M21) — see `../llm/socket.ts`. The regenerated rule's output replaces
 * Tier 2's only when it's strictly better (covers the intent when the stored rule
 * didn't, or extracts more fields); only then is it attached as `generatedRules`
 * for the caller to persist to the Rule Library.
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

  // Discovery runs first (if requested) — its pageType gates the extraction tiers.
  let isListing = false;
  if (names.includes("discovery")) {
    const plugin = REGISTRY.get("discovery");
    if (plugin) {
      try {
        const res = plugin.analyze(input);
        out.discovery = res;
        isListing = (res as { pageType?: string }).pageType === "listing";
      } catch (err) {
        out.discovery = { error: err instanceof Error ? err.message : "failed" };
      }
    }
  }

  // Tier 1 (structured) resolves before Tier 2 (rules), regardless of the order
  // `names` were given in, so the router below can see whether it already succeeded.
  let structuredConfidence: "high" | "low" | "none" | undefined;
  if (names.includes("structured")) {
    if (isListing) {
      out.structured = { skipped: true, reason: "listing_page" };
    } else {
      const plugin = REGISTRY.get("structured");
      if (plugin) {
        try {
          out.structured = plugin.analyze(input);
          structuredConfidence = confidenceOf(out.structured);
        } catch (err) {
          out.structured = { error: err instanceof Error ? err.message : "failed" };
        }
      }
    }
  }

  for (const name of names) {
    if (name === "discovery" || name === "structured") continue; // already handled

    // Listing pages run the rules tier in LIST mode (M22): the domain's list
    // rule (listItem + relative selectors) swaps in for the detail rule, and a
    // Tier 4 escalation asks for a list rule. Structured stays skipped above —
    // a listing's own JSON-LD is usually about the wrong thing (seen live:
    // amazon.in's homepage carousel yielding one promoted product's price).
    const listMode = name === "rules" && isListing;
    const effectiveInput = listMode
      ? {
          ...input,
          options: {
            ...input.options,
            rules: (input.options as { listRules?: unknown } | undefined)?.listRules,
          },
        }
      : input;

    const plugin = REGISTRY.get(name);
    if (plugin === undefined) continue; // unknown plugin name — skip

    try {
      if (
        name === "rules" &&
        structuredConfidence !== undefined &&
        structuredConfidence !== "none" &&
        isIntentCovered(
          (out.structured as { fields?: Record<string, unknown> } | undefined)?.fields ?? {},
          args.intent,
        )
      ) {
        // Tier 1 already produced a record covering what the intent asked for —
        // Tier 2/4 is an escalation path and isn't needed. A Tier 1 hit that only
        // partially covers the intent (M17) does NOT skip here.
        out[name] = { skipped: true, reason: "tier1_structured_confident" };
        continue;
      }

      out[name] = plugin.analyze(effectiveInput);

      // Tier 4 (LLM fallback): only for `rules`, only when the operator supplied
      // an intent, and only when the stored rule found nothing (M15) OR what it
      // found doesn't cover the intent (M21 — the M17 coverage check applied one
      // tier down). Without the coverage half, a rule with one stale selector
      // (found live: books.toscrape.com's `.price` matching nothing while `h1`
      // still hit) extracts the surviving fields at high confidence forever and
      // the broken selector never heals.
      if (name === "rules" && args.intent) {
        const current = out[name] as { fields?: Record<string, unknown> } | undefined;
        const currentFields = current?.fields ?? {};
        const currentCovers = isIntentCovered(currentFields, args.intent);
        if (confidenceOf(out[name]) === "none" || !currentCovers) {
          const domain = new URL(args.url).hostname;
          const socket = args.llmSocket ?? mockLlmSocket;
          const generatedRule = await socket.generateRules(
            domain,
            args.html,
            args.intent,
            { pageType: listMode ? "list" : "detail" },
          );
          const fallbackResult = plugin.analyze({
            ...effectiveInput,
            options: { ...effectiveInput.options, rules: generatedRule },
          }) as Record<string, unknown>;
          // Keep whichever result is better — the regenerated rule can come back
          // worse than the partial one it's replacing (LLMs miss), and a page
          // that already yielded `title` must not lose it to a failed retry.
          // Only a kept fallback carries `generatedRules`, so the caller never
          // persists a regenerated rule that underperformed the stored one.
          const fallbackFields = (fallbackResult.fields as Record<string, unknown>) ?? {};
          const fallbackCovers = isIntentCovered(fallbackFields, args.intent);
          const fallbackIsBetter =
            (fallbackCovers && !currentCovers) ||
            (fallbackCovers === currentCovers &&
              Object.keys(fallbackFields).length > Object.keys(currentFields).length);
          if (fallbackIsBetter) {
            fallbackResult.generatedRules = generatedRule;
            out[name] = fallbackResult;
          }
        }
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
