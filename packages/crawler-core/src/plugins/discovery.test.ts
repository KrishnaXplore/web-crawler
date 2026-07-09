import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { discoveryPlugin, type DiscoveryRecord } from "./discovery.js";

function run(html: string): DiscoveryRecord {
  const $ = cheerio.load(html);
  return discoveryPlugin.analyze({
    url: "https://example.com",
    $,
    headers: {},
    status: 200,
    body: html,
    authenticated: false,
  }) as DiscoveryRecord;
}

describe("discoveryPlugin", () => {
  it("detects a detail page via article tag", () => {
    const res = run(`
      <html>
        <body>
          <article>
            <h1>My Blog Post</h1>
            <p>This is a long post...</p>
          </article>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("detail");
    expect(res.signals).toContain("has_article_tag");
  });

  it("detects a detail page via schema", () => {
    const res = run(`
      <html>
        <body>
          <div itemscope itemtype="http://schema.org/Product">
            <h1>Cool Widget</h1>
          </div>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("detail");
    expect(res.signals).toContain("has_product_schema");
  });

  it("detects a listing page via pagination", () => {
    const res = run(`
      <html>
        <body>
          <ul>
            <li><a href="/p/1">Item 1</a></li>
            <li><a href="/p/2">Item 2</a></li>
          </ul>
          <div class="pagination">
            <a href="?page=2" class="next">Next</a>
          </div>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("listing");
    expect(res.signals).toContain("has_pagination(.pagination)");
  });

  it("detects a listing page via high link density", () => {
    // Lots of links, very little non-link text
    let links = "";
    for (let i = 0; i < 60; i++) {
      links += `<li><a href="/item/${i}">Item ${i}</a></li>\\n`;
    }
    const res = run(`
      <html>
        <body>
          <h1>Categories</h1>
          <ul>
            ${links}
          </ul>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("listing");
    expect(res.signals).toContain("high_link_density");
  });

  it("detects a detail page via high text density", () => {
    // Massive block of text
    const text = "word ".repeat(500); // 2500 characters
    const res = run(`
      <html>
        <body>
          <h1>My Story</h1>
          <p>${text}</p>
          <a href="/home">Back</a>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("detail");
    expect(res.signals).toContain("high_text_density");
  });

  it("resolves unknown pages gracefully", () => {
    const res = run(`
      <html>
        <body>
          <h1>Just a simple landing page</h1>
          <p>Not much here.</p>
          <a href="/login">Login</a>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("unknown");
    expect(res.confidence).toBe("low");
  });
});
