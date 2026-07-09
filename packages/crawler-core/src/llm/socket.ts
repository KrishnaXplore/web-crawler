import type { ExtractionRule } from "@crawler/db";

export interface LlmSocket {
  /**
   * Generates CSS/XPath extraction rules for a domain based on a sample HTML
   * DOM and a natural language intent string.
   */
  generateRules(domain: string, html: string, intent: string): Promise<ExtractionRule>;
}

/**
 * A mock LLM socket for testing the Intent Layer (M13) without requiring
 * actual API keys or LLM calls. It uses naive heuristics based on the intent string.
 */
export const mockLlmSocket: LlmSocket = {
  async generateRules(domain: string, html: string, intent: string): Promise<ExtractionRule> {
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

    return {
      domain,
      schemaType: "GeneratedSchema",
      fields,
    };
  }
};
