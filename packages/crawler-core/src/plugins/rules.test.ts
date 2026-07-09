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
