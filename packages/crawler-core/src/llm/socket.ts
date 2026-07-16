import * as cheerio from "cheerio";
import { z } from "zod";
import { GoogleGenAI, Type, ApiError } from "@google/genai";
import type { ExtractionRule } from "@crawler/shared";

export interface GenerateRulesOpts {
  /**
   * "detail" (default): absolute selectors, one record per page. "list" (M22):
   * asks for a repeating-item container selector (`listItem`) plus field
   * selectors relative to each container — one record per item.
   */
  readonly pageType?: "detail" | "list";
}

export interface LlmSocket {
  /**
   * Generates CSS/XPath extraction rules for a domain based on a sample HTML
   * DOM and a natural language intent string.
   */
  generateRules(
    domain: string,
    html: string,
    intent: string,
    opts?: GenerateRulesOpts,
  ): Promise<ExtractionRule>;
}

/**
 * A mock LLM socket for testing the Intent Layer (M13) without requiring
 * actual API keys or LLM calls. It uses naive heuristics based on the intent string.
 */
export const mockLlmSocket: LlmSocket = {
  async generateRules(
    domain: string,
    html: string,
    intent: string,
    opts?: GenerateRulesOpts,
  ): Promise<ExtractionRule> {
    const fields: Record<string, string> = {};
    const i = intent.toLowerCase();

    // Naive heuristic: if they ask for a price, guess .price
    if (i.includes("price")) {
      fields["price"] = ".price";
    }
    // Naive heuristic: if they ask for title, guess h1
    if (i.includes("title") || i.includes("name")) {
      fields["title"] = "h1";
    }
    // Naive heuristic: if they ask for author
    if (i.includes("author")) {
      fields["author"] = ".author";
    }

    // Fallback if the intent didn't match our naive keywords
    if (Object.keys(fields).length === 0) {
      fields["mainContent"] = "main";
    }

    if (opts?.pageType === "list") {
      return { domain, schemaType: "GeneratedSchema", fields, kind: "list", listItem: ".item" };
    }
    return {
      domain,
      schemaType: "GeneratedSchema",
      fields,
    };
  }
};

// Gemini's responseSchema (like most structured-output schemas) wants fixed
// properties, not an open-ended map — so the wire shape is a name/selector array;
// generateRules converts it to the Record shape ExtractionRule expects. Used both
// to build the Gemini-side schema (via Type) and to validate the parsed reply.
const GeneratedRuleSchema = z.object({
  schemaType: z.string(),
  fields: z.array(
    z.object({
      name: z.string(),
      selector: z.string(),
    }),
  ),
});

// List mode (M22): same wire shape plus the required repeating-item container.
const GeneratedListRuleSchema = GeneratedRuleSchema.extend({
  listItem: z.string(),
});

const GEMINI_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    schemaType: {
      type: Type.STRING,
      description: 'Short label for what this extracts, e.g. "Product" or "Article".',
    },
    fields: {
      type: Type.ARRAY,
      description: "One entry per field the intent asked for.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: 'Field name, e.g. "price" or "title".' },
          selector: {
            type: Type.STRING,
            description: "A CSS selector that matches this field's value on the page.",
          },
        },
        required: ["name", "selector"],
      },
    },
  },
  required: ["schemaType", "fields"],
};

const GEMINI_LIST_RESPONSE_SCHEMA = {
  ...GEMINI_RESPONSE_SCHEMA,
  properties: {
    ...GEMINI_RESPONSE_SCHEMA.properties,
    listItem: {
      type: Type.STRING,
      description:
        "A CSS selector matching EACH repeating item container on the page " +
        '(e.g. ".product_pod", "li.result"). Field selectors are relative to one container.',
    },
  },
  required: ["schemaType", "listItem", "fields"],
};

const MAX_HTML_CHARS = 100_000;
// One bounded retry on a rate-limit response (M20 — docs/phase20.md), observed
// directly against the free tier's 15 req/min cap. Not exponential backoff with
// several attempts: this call happens inline in a worker's per-page processing,
// and a long retry sequence stalls that worker instead of letting it move on.
const RATE_LIMIT_RETRY_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strips script/style/nav/footer noise and truncates before sending HTML to the
 * model — selectors don't need script bodies or nav chrome, and an unbounded page
 * scales token cost with page size for no accuracy benefit (vision doc §8b).
 */
function prepareHtmlForPrompt(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, svg, nav, footer").remove();
  $("*").contents().each((_, node) => {
    if (node.type === "comment") $(node).remove();
  });
  const cleaned = $.html();
  return cleaned.length > MAX_HTML_CHARS ? cleaned.slice(0, MAX_HTML_CHARS) : cleaned;
}

/**
 * Real Tier 4 implementation (M15): asks Gemini to infer CSS selectors for the
 * fields named in `intent` from a sample page. `responseSchema` guarantees the
 * model's reply is shaped JSON; a Zod pass on top of that catches anything the
 * schema itself doesn't enforce. Throws on failure — the caller (runPlugins)
 * already isolates Tier 4 errors into the `rules` output.
 */
export function createGeminiLlmSocket(opts: { apiKey: string; model?: string }): LlmSocket {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? "gemini-3.1-flash-lite";

  return {
    async generateRules(
      domain: string,
      html: string,
      intent: string,
      opts?: GenerateRulesOpts,
    ): Promise<ExtractionRule> {
      const isList = opts?.pageType === "list";
      const sample = prepareHtmlForPrompt(html);
      const instructions = isList
        ? "You infer CSS selectors for structured-data extraction from a sample of a webpage's HTML. " +
          "This page LISTS MANY ITEMS (a catalog, search results, a feed). First identify the CSS " +
          "selector that matches EACH repeating item's container element (listItem). Then, for each " +
          "requested field, return a CSS selector RELATIVE TO one item container. Prefer stable, " +
          "specific selectors (classes, itemprop, data attributes) over positional ones. If a field " +
          "can't be found in this sample, omit it rather than guessing."
        : "You infer CSS selectors for structured-data extraction from a sample of a webpage's HTML. " +
          "Given a natural-language description of what to extract, return one CSS selector per requested " +
          "field. Prefer stable, specific selectors (classes, itemprop, data attributes) over positional " +
          "ones. If a field can't be found in this sample, omit it rather than guessing.";
      const request = {
        model,
        contents:
          instructions +
          `\n\nExtraction intent: ${intent}\n\nHTML sample from ${domain}:\n\n${sample}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: isList ? GEMINI_LIST_RESPONSE_SCHEMA : GEMINI_RESPONSE_SCHEMA,
        },
      };

      let response;
      try {
        response = await client.models.generateContent(request);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          await sleep(RATE_LIMIT_RETRY_DELAY_MS);
          response = await client.models.generateContent(request); // one retry, then propagate
        } else {
          throw err;
        }
      }

      const text = response.text;
      if (!text) {
        throw new Error("gemini llm socket: empty response");
      }

      if (isList) {
        const parsed = GeneratedListRuleSchema.parse(JSON.parse(text));
        const fields: Record<string, string> = {};
        for (const { name, selector } of parsed.fields) {
          fields[name] = selector;
        }
        return {
          domain,
          schemaType: parsed.schemaType,
          fields,
          kind: "list",
          listItem: parsed.listItem,
        };
      }

      const parsed = GeneratedRuleSchema.parse(JSON.parse(text));

      const fields: Record<string, string> = {};
      for (const { name, selector } of parsed.fields) {
        fields[name] = selector;
      }

      return { domain, schemaType: parsed.schemaType, fields };
    },
  };
}
