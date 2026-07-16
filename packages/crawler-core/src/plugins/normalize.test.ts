import { describe, it, expect } from "vitest";
import { normalizePrice, normalizeAnalysis, collapseDuplicatedText } from "./normalize.js";

describe("normalizePrice (M24 value normalization)", () => {
  it("parses currency symbol + Indian grouping", () => {
    expect(normalizePrice("price", "₹99,499.00")).toEqual({ amount: 99499, currency: "INR" });
  });

  it("parses £ and $ with decimals", () => {
    expect(normalizePrice("price", "£51.77")).toEqual({ amount: 51.77, currency: "GBP" });
    expect(normalizePrice("price", "$1,234.56")).toEqual({ amount: 1234.56, currency: "USD" });
  });

  it("parses the 'Rs.' token", () => {
    expect(normalizePrice("price", "Rs. 1,699")).toEqual({ amount: 1699, currency: "INR" });
  });

  it("parses a trailing currency code", () => {
    expect(normalizePrice("cost", "1699 INR")).toEqual({ amount: 1699, currency: "INR" });
  });

  it("normalizes a bare number when the field name is price-like", () => {
    expect(normalizePrice("price", "13999")).toEqual({ amount: 13999, currency: null });
    expect(normalizePrice("mrp", "2,499")).toEqual({ amount: 2499, currency: null });
  });

  it("does NOT normalize a non-price field with no currency", () => {
    expect(normalizePrice("rating", "4.5 out of 5 stars")).toBeNull();
    expect(normalizePrice("model_name", "Galaxy A57")).toBeNull();
    expect(normalizePrice("title", "The 39 Steps")).toBeNull();
  });

  it("takes the first number token, not a global digit strip", () => {
    // "4.5 out of 5" must not become 455; but with a price field + currency it's a price
    expect(normalizePrice("price", "$4.5 for 5 units")).toEqual({ amount: 4.5, currency: "USD" });
  });

  it("returns null when a price field has no parseable number", () => {
    expect(normalizePrice("price", "See price in cart")).toBeNull();
  });

  it("handles European decimal comma", () => {
    expect(normalizePrice("price", "€1.234,56")).toEqual({ amount: 1234.56, currency: "EUR" });
  });

  it("a price range normalizes to the first number (documented limit)", () => {
    expect(normalizePrice("price", "£10 – £20")).toEqual({ amount: 10, currency: "GBP" });
  });
});

describe("normalizeAnalysis (enrichment across the analysis)", () => {
  it("adds _amount/_currency siblings to rules records without touching originals", () => {
    const analysis: Record<string, unknown> = {
      rules: {
        confidence: "high",
        fields: { title: "A Light in the Attic", price: "£51.77" },
        records: [
          { title: "A Light in the Attic", price: "£51.77" },
          { title: "Sapiens", price: "£54.23" },
        ],
      },
    };
    normalizeAnalysis(analysis);
    const rules = analysis.rules as any;
    expect(rules.fields.price).toBe("£51.77"); // original untouched
    expect(rules.fields.price_amount).toBe(51.77);
    expect(rules.fields.price_currency).toBe("GBP");
    expect(rules.records[1]).toEqual({
      title: "Sapiens",
      price: "£54.23",
      price_amount: 54.23,
      price_currency: "GBP",
    });
  });

  it("normalizes structured.fields too", () => {
    const analysis: Record<string, unknown> = {
      structured: { confidence: "high", fields: { name: "Phone", price: "₹13,999" } },
    };
    normalizeAnalysis(analysis);
    expect((analysis.structured as any).fields.price_amount).toBe(13999);
    expect((analysis.structured as any).fields.price_currency).toBe("INR");
    expect((analysis.structured as any).fields.name).toBe("Phone");
  });

  it("is a safe no-op on missing/empty analysis", () => {
    expect(() => normalizeAnalysis(null)).not.toThrow();
    expect(() => normalizeAnalysis(undefined)).not.toThrow();
    expect(() => normalizeAnalysis({})).not.toThrow();
    const skipped: Record<string, unknown> = { rules: { skipped: true } };
    expect(() => normalizeAnalysis(skipped)).not.toThrow();
  });

  it("does not double-enrich on a second pass", () => {
    const analysis: Record<string, unknown> = {
      rules: { fields: { price: "$10" } },
    };
    normalizeAnalysis(analysis);
    normalizeAnalysis(analysis);
    const keys = Object.keys((analysis.rules as any).fields);
    expect(keys).toEqual(["price", "price_amount", "price_currency"]);
  });

  it("collapses a duplicated description field in place (books.toscrape artifact)", () => {
    const full =
      "It's hard to imagine a world without A Light in the Attic. This now-classic " +
      "collection of poetry celebrates its 20th anniversary. ...more";
    const truncated = full.slice(0, 90); // the preview copy, cut mid-sentence
    const analysis: Record<string, unknown> = {
      rules: { confidence: "high", fields: { description: `${truncated} ${full}` } },
    };
    normalizeAnalysis(analysis);
    expect((analysis.rules as any).fields.description).toBe(full);
  });
});

describe("collapseDuplicatedText", () => {
  const full =
    "It's hard to imagine a world without A Light in the Attic. This now-classic " +
    "collection of poetry celebrates its 20th anniversary with this special edition.";

  it("drops a truncated leading copy and keeps the full text", () => {
    const truncated = full.slice(0, 100);
    expect(collapseDuplicatedText(`${truncated} ${full}`)).toBe(full);
  });

  it("collapses an exact doubling", () => {
    expect(collapseDuplicatedText(`${full} ${full}`)).toBe(full);
  });

  it("leaves a normal (non-duplicated) description untouched", () => {
    expect(collapseDuplicatedText(full)).toBe(full);
  });

  it("does not collapse short values or coincidental word repeats", () => {
    expect(collapseDuplicatedText("Home Home")).toBe("Home Home");
    const legit =
      "The best of the best products, chosen from the best brands for the best value.";
    expect(collapseDuplicatedText(legit)).toBe(legit); // repeats "best" but isn't a prefix dup
  });
});
