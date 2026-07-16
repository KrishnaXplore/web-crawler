import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { rulesPlugin } from "./rules.js";

function s(html: string, options?: Record<string, unknown>) {
  return rulesPlugin.analyze({
    url: "https://example.com",
    $: cheerio.load(html),
    headers: {},
    status: 200,
    body: html,
    authenticated: false,
    options,
  });
}

describe("rules extractor plugin (M11 Step 2)", () => {
  it("returns none if no rules are configured", () => {
    const res = s(`<h1>Test</h1>`);
    expect(res.source).toBe("none");
    expect(res.type).toBeNull();
  });

  it("extracts fields using CSS selectors", () => {
    const html = `
      <div class="product">
        <h1 class="title">Widget</h1>
        <span class="price">$9.99</span>
      </div>
    `;
    const res = s(html, {
      rules: {
        schemaType: "Product",
        fields: {
          name: ".title",
          price: ".price",
        },
      },
    });

    expect(res.source).toBe("rules");
    expect(res.type).toBe("Product");
    expect(res.confidence).toBe("high");
    expect((res.fields as Record<string, string>).name).toBe("Widget");
    expect((res.fields as Record<string, string>).price).toBe("$9.99");
  });

  it("gracefully handles missing elements", () => {
    const html = `<h1 class="title">Widget</h1>`;
    const res = s(html, {
      rules: {
        schemaType: "Product",
        fields: {
          name: ".title",
          price: ".missing",
        },
      },
    });
    
    expect(res.source).toBe("rules");
    expect((res.fields as Record<string, string>).name).toBe("Widget");
    expect((res.fields as Record<string, string>).price).toBeUndefined();
  });
  
  it("returns none if all selectors fail", () => {
    const html = `<div>Plain</div>`;
    const res = s(html, {
      rules: {
        schemaType: "Product",
        fields: {
          name: ".title",
        },
      },
    });

    expect(res.source).toBe("none");
    expect(res.type).toBeNull();
    expect(res.fields).toEqual({});
  });
});

describe("list rules — multi-record extraction (M22)", () => {
  const catalogHtml = `
    <ol class="catalog">
      <li class="product_pod"><h3><a>Book One</a></h3><p class="price_color">£10.00</p></li>
      <li class="product_pod"><h3><a>Book Two</a></h3><p class="price_color">£20.00</p></li>
      <li class="product_pod"><h3><a>Book Three</a></h3></li>
    </ol>
  `;

  it("extracts one record per matching container, fields relative to each", () => {
    const res = s(catalogHtml, {
      rules: {
        schemaType: "Product",
        listItem: ".product_pod",
        fields: { title: "h3 a", price: ".price_color" },
      },
    }) as { records?: Record<string, string>[]; fields: Record<string, string>; confidence: string };

    expect(res.confidence).toBe("high");
    expect(res.records).toEqual([
      { title: "Book One", price: "£10.00" },
      { title: "Book Two", price: "£20.00" },
      { title: "Book Three" }, // no price on this item — no misaligned zip
    ]);
    // fields = first record, so single-record consumers keep working
    expect(res.fields).toEqual({ title: "Book One", price: "£10.00" });
  });

  it("returns none when the container selector matches nothing", () => {
    const res = s(catalogHtml, {
      rules: {
        schemaType: "Product",
        listItem: ".no-such-container",
        fields: { title: "h3 a" },
      },
    }) as { records?: Record<string, string>[]; confidence: string };
    expect(res.confidence).toBe("none");
    expect(res.records).toEqual([]);
  });

  it("drops containers where no field matched", () => {
    const html = `<div class="row"><span class="x">hit</span></div><div class="row"></div>`;
    const res = s(html, {
      rules: { schemaType: "Row", listItem: ".row", fields: { value: ".x" } },
    }) as { records?: Record<string, string>[] };
    expect(res.records).toEqual([{ value: "hit" }]);
  });

  it("caps records at 100 even if the selector matches more", () => {
    const many = `<ul>${'<li class="i"><b>x</b></li>'.repeat(150)}</ul>`;
    const res = s(many, {
      rules: { schemaType: "Item", listItem: ".i", fields: { v: "b" } },
    }) as { records?: Record<string, string>[] };
    expect(res.records).toHaveLength(100);
  });
});
