import { describe, it, expect } from "vitest";
import { classifyIntentTarget } from "./intentTargetType.js";

describe("classifyIntentTarget (M23 focused crawl)", () => {
  it("empty/undefined intent defaults to detail", () => {
    expect(classifyIntentTarget(undefined)).toBe("detail");
    expect(classifyIntentTarget("")).toBe("detail");
  });

  it("explicit collection markers → collection", () => {
    expect(classifyIntentTarget("all mobile phone prices")).toBe("collection");
    expect(classifyIntentTarget("list every book")).toBe("collection");
    expect(classifyIntentTarget("compare laptops under 50000")).toBe("collection");
    expect(classifyIntentTarget("cheapest phone")).toBe("collection");
    expect(classifyIntentTarget("top rated headphones")).toBe("collection");
  });

  it("plural item nouns → collection", () => {
    expect(classifyIntentTarget("mobile phones name and price")).toBe("collection");
    expect(classifyIntentTarget("extract book titles")).toBe("collection");
  });

  it("single-target phrases → detail", () => {
    expect(classifyIntentTarget("the specs of this phone")).toBe("detail");
    expect(classifyIntentTarget("this product's price and brand")).toBe("detail");
    expect(classifyIntentTarget("review of this laptop")).toBe("detail");
  });

  it("a detail phrase pulls a plural noun back to detail", () => {
    // "specs" is plural but the intent is clearly one item
    expect(classifyIntentTarget("specs of this phone")).toBe("detail");
  });

  it("singular field-shape intent defaults to detail (self-corrects at runtime)", () => {
    // Ambiguous phrasing; the job-level early-stop still gates on single-record
    // evidence, so a listing page overrides this.
    expect(classifyIntentTarget("product name, price, brand")).toBe("detail");
  });

  it("collection marker wins even alongside a singular determiner", () => {
    expect(classifyIntentTarget("all details of the phone")).toBe("collection");
  });

  it("does not false-positive on non-count -s/-ss/-us words", () => {
    expect(classifyIntentTarget("the business address")).toBe("detail");
    expect(classifyIntentTarget("the campus status")).toBe("detail");
  });
});
