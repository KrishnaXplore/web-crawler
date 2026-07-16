import { describe, it, expect } from "vitest";
import { deriveRuleMeta, needsSelfHeal, ruleKey } from "./rules.js";

describe("deriveRuleMeta (gap-analysis fix #7 — Rule Library feedback loop)", () => {
  it("derives hitRate from hits/misses", () => {
    const meta = deriveRuleMeta({
      _id: "shop.example",
      schemaType: "Product",
      fields: { name: "h1", price: ".price" },
      hits: 3,
      misses: 1,
    });
    expect(meta.hitRate).toBe(0.75);
    expect(meta.hits).toBe(3);
    expect(meta.misses).toBe(1);
  });

  it("hitRate is null when the rule has never been used", () => {
    const meta = deriveRuleMeta({ _id: "new.example", schemaType: "Product" });
    expect(meta.hitRate).toBeNull();
    expect(meta.hits).toBe(0);
    expect(meta.misses).toBe(0);
  });

  it("a rule that fails every time has hitRate 0, not null", () => {
    const meta = deriveRuleMeta({ _id: "stale.example", schemaType: "Product", hits: 0, misses: 5 });
    expect(meta.hitRate).toBe(0);
  });

  it("defaults generatedBy to operator and version to 1", () => {
    const meta = deriveRuleMeta({ _id: "a.example", schemaType: "Product" });
    expect(meta.generatedBy).toBe("operator");
    expect(meta.version).toBe(1);
  });

  it("preserves generatedBy: llm and a bumped version", () => {
    const meta = deriveRuleMeta({
      _id: "a.example",
      schemaType: "Product",
      generatedBy: "llm",
      version: 3,
    });
    expect(meta.generatedBy).toBe("llm");
    expect(meta.version).toBe(3);
  });

  it("converts a Map fields doc to a plain record", () => {
    const meta = deriveRuleMeta({
      _id: "a.example",
      schemaType: "Product",
      fields: new Map([["title", "h1"]]),
    });
    expect(meta.fields).toEqual({ title: "h1" });
  });
});

describe("ruleKey / list rules (M22 — multi-record extraction)", () => {
  it("detail rules keep the bare domain (pre-M22 docs stay valid, no migration)", () => {
    expect(ruleKey("shop.example")).toBe("shop.example");
    expect(ruleKey("shop.example", "detail")).toBe("shop.example");
  });

  it("list rules key under domain#list", () => {
    expect(ruleKey("shop.example", "list")).toBe("shop.example#list");
  });

  it("derives kind/listItem/domain from a list-rule doc", () => {
    const meta = deriveRuleMeta({
      _id: "shop.example#list",
      schemaType: "Product",
      fields: { title: "h3 a", price: ".price_color" },
      listItem: ".product_pod",
    });
    expect(meta.domain).toBe("shop.example");
    expect(meta.kind).toBe("list");
    expect(meta.listItem).toBe(".product_pod");
  });

  it("a plain-domain doc is a detail rule with no listItem", () => {
    const meta = deriveRuleMeta({ _id: "shop.example", schemaType: "Product" });
    expect(meta.kind).toBe("detail");
    expect(meta.listItem).toBeUndefined();
  });
});

describe("needsSelfHeal (M17 — Rule Library self-heal)", () => {
  it("does not flag below the minimum sample size, even at 0% hit rate", () => {
    expect(needsSelfHeal(0, 4)).toBe(false); // 4 total < min sample of 5
  });

  it("flags a rule with enough samples and a hit rate below the threshold", () => {
    expect(needsSelfHeal(1, 4)).toBe(true); // 5 total, 20% hit rate
  });

  it("does not flag a rule with enough samples and a healthy hit rate", () => {
    expect(needsSelfHeal(4, 1)).toBe(false); // 5 total, 80% hit rate
  });

  it("does not flag a rule with zero usage", () => {
    expect(needsSelfHeal(0, 0)).toBe(false);
  });

  it("flags a rule that has failed every time, once past the minimum sample", () => {
    expect(needsSelfHeal(0, 5)).toBe(true);
  });
});
