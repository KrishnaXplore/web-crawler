import { describe, it, expect } from "vitest";
import { isIntentCovered } from "./intentCoverage.js";

describe("isIntentCovered (M17)", () => {
  it("is covered when there's no intent at all", () => {
    expect(isIntentCovered({ name: "Widget" }, undefined)).toBe(true);
  });

  it("is covered when the intent has no recognized field-concept keywords", () => {
    expect(isIntentCovered({ name: "Widget" }, "grab everything interesting")).toBe(true);
  });

  it("is NOT covered when a recognized keyword has no matching field — the exact Amazon bug", () => {
    // Tier 1 found name/description/image; intent also asked for price and brand.
    const fields = { name: "Phone", description: "A phone", image: "http://x/y.jpg" };
    expect(isIntentCovered(fields, "extract product name, price, and brand")).toBe(false);
  });

  it("is covered when every recognized keyword has a matching field", () => {
    const fields = { name: "Phone", price: "999", priceCurrency: "INR" };
    expect(isIntentCovered(fields, "extract the name and price")).toBe(true);
  });

  it("matches via the alias table (title -> name)", () => {
    const fields = { name: "Widget" };
    expect(isIntentCovered(fields, "extract the title")).toBe(true);
  });

  it("matches via the alias table (author -> byline)", () => {
    const fields = { byline: "Ada Lovelace" };
    expect(isIntentCovered(fields, "extract the author")).toBe(true);
  });

  it("is NOT covered when fields is empty and intent has a recognized keyword", () => {
    expect(isIntentCovered({}, "extract the price")).toBe(false);
  });
});
