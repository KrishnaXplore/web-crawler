import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { extractStructured } from "./structured.js";

const s = (html: string) => extractStructured(cheerio.load(html));

describe("structured extractor (M11 Step 1)", () => {
  it("extracts a JSON-LD Article into a flat record (high confidence)", () => {
    const r = s(`<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Article","headline":"Hello",
       "author":{"@type":"Person","name":"Ada"},"datePublished":"2026-01-01"}
    </script>`);
    expect(r.source).toBe("json-ld");
    expect(r.type).toBe("Article");
    expect(r.confidence).toBe("high");
    expect(r.fields.headline).toBe("Hello");
    expect(r.fields.author).toBe("Ada"); // nested name picked
    expect(r.fields.datePublished).toBe("2026-01-01");
  });

  it("handles @graph and picks the richest node", () => {
    const r = s(`<script type="application/ld+json">
      {"@graph":[
        {"@type":"BreadcrumbList","itemListElement":[]},
        {"@type":"Product","name":"Widget","price":"9.99","brand":"Acme"}
      ]}</script>`);
    expect(r.type).toBe("Product");
    expect(r.fields.name).toBe("Widget");
    expect(r.fields.price).toBe("9.99");
  });

  it("extracts Schema.org microdata when there's no JSON-LD", () => {
    const r = s(`<div itemscope itemtype="https://schema.org/Person">
      <span itemprop="name">Grace</span><span itemprop="jobTitle">Admiral</span></div>`);
    expect(r.source).toBe("microdata");
    expect(r.type).toBe("Person");
    expect(r.fields.name).toBe("Grace");
    expect(r.fields.jobTitle).toBe("Admiral");
  });

  it("falls back to OpenGraph (low confidence) when nothing richer exists", () => {
    const r = s(`<meta property="og:title" content="A Page">
                 <meta property="og:type" content="article">`);
    expect(r.source).toBe("opengraph");
    expect(r.type).toBe("og:article");
    expect(r.confidence).toBe("low");
    expect(r.fields.title).toBe("A Page");
  });

  it("prefers JSON-LD over OpenGraph on the same page", () => {
    const r = s(`<meta property="og:title" content="og one">
      <script type="application/ld+json">{"@type":"Recipe","name":"Cake"}</script>`);
    expect(r.source).toBe("json-ld");
    expect(r.type).toBe("Recipe");
  });

  it("ignores malformed JSON-LD without throwing", () => {
    const r = s(`<script type="application/ld+json">{ not valid json </script>
                 <meta property="og:title" content="fallback">`);
    expect(r.source).toBe("opengraph");
  });

  it("extracts price/priceCurrency from a nested Offer object (was silently dropped)", () => {
    const r = s(`<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Phone",
       "brand":{"@type":"Brand","name":"Redmi"},
       "offers":{"@type":"Offer","price":"12999","priceCurrency":"INR"}}
    </script>`);
    expect(r.fields.name).toBe("Phone");
    expect(r.fields.brand).toBe("Redmi");
    expect(r.fields.price).toBe("12999");
    expect(r.fields.priceCurrency).toBe("INR");
    expect(r.fields.offers).toBeUndefined(); // hoisted, not left as a dropped nested key
  });

  it("extracts price from an array of Offer nodes (multiple sellers/conditions)", () => {
    const r = s(`<script type="application/ld+json">
      {"@type":"Product","name":"Widget",
       "offers":[{"@type":"Offer","price":"49.99","priceCurrency":"USD"},
                 {"@type":"Offer","price":"59.99","priceCurrency":"USD"}]}
    </script>`);
    expect(r.fields.price).toBe("49.99"); // first offer wins — cheap tier, no aggregation
  });

  it("returns none on a page with no structured data", () => {
    const r = s(`<h1>Plain</h1><p>nothing here</p>`);
    expect(r.source).toBe("none");
    expect(r.type).toBeNull();
    expect(r.confidence).toBe("none");
    expect(r.fields).toEqual({});
  });
});
