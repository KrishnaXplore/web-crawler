import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { discoveryPlugin, type DiscoveryRecord } from "./discovery.js";

function run(html: string, url = "https://example.com"): DiscoveryRecord {
  const $ = cheerio.load(html);
  return discoveryPlugin.analyze({
    url,
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

  it("detects a detail page via JSON-LD Product schema (no microdata)", () => {
    const res = run(`
      <html>
        <body>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Product","name":"Widget"}
          </script>
          <h1>Widget</h1>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("detail");
    expect(res.signals).toContain("has_jsonld_detail_schema");
  });

  it("resolves a real product page to detail even with review-section pagination — the exact Amazon false-positive found in production", () => {
    // Amazon-shaped: JSON-LD Product schema + a review/pagination widget + dense
    // description text. Before the fix, has_pagination + high_text_density
    // conflicted and fell through to "listing" because only itemscope/itemtype
    // microdata counted as an explicit schema signal — Amazon uses JSON-LD.
    const text = "word ".repeat(500);
    const res = run(`
      <html>
        <body>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Product","name":"boAt Rockerz 255 Pro+",
             "offers":{"@type":"Offer","price":"1299","priceCurrency":"INR"}}
          </script>
          <h1>boAt Rockerz 255 Pro+</h1>
          <p>${text}</p>
          <div class="reviews-pagination"><a class="next" href="?page=2">Next</a></div>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("detail");
    expect(res.signals).toContain("has_jsonld_detail_schema");
  });

  it("detects a detail page via JSON-LD inside @graph", () => {
    const res = run(`
      <html>
        <body>
          <script type="application/ld+json">
            {"@graph":[
              {"@type":"BreadcrumbList","itemListElement":[]},
              {"@type":"Article","headline":"Big News"}
            ]}
          </script>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("detail");
    expect(res.signals).toContain("has_jsonld_detail_schema");
  });

  it("ignores malformed JSON-LD without throwing", () => {
    const res = run(`
      <html>
        <body>
          <script type="application/ld+json">{ not valid json </script>
          <ul>
            <li><a href="/p/1">Item 1</a></li>
          </ul>
          <div class="pagination"><a href="?page=2" class="next">Next</a></div>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("listing");
    expect(res.signals).not.toContain("has_jsonld_detail_schema");
  });

  it("does not flag an unrelated JSON-LD type (e.g. Organization) as a detail signal", () => {
    const res = run(`
      <html>
        <body>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Organization","name":"Acme Corp"}
          </script>
          <ul><li><a href="/p/1">Item 1</a></li></ul>
          <div class="pagination"><a href="?page=2" class="next">Next</a></div>
        </body>
      </html>
    `);
    expect(res.pageType).toBe("listing");
    expect(res.signals).not.toContain("has_jsonld_detail_schema");
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

  describe("repeated-item-grid signal (the s-search-result pattern)", () => {
    // Each card: same data attribute value, a link, and enough text (title +
    // price + rating) to look like a real result card, not a nav item.
    const card = (i: number) =>
      `<div data-component-type="s-search-result">
         <a href="/dp/B0${i}"><h2>Smartphone Model ${i} with 8GB RAM and 128GB storage, 5G</h2></a>
         <span>₹${10000 + i},999</span><span>4.${i % 5} out of 5 stars</span>
       </div>`;

    it("classifies a search/category grid as listing even when text density is high — the exact Amazon category-page misclassification", () => {
      // Enough long product blurbs to trip high_text_density (>2000 non-link chars),
      // which used to win and classify the page `detail` on that single signal.
      const filler = `<p>${"Great deals on the latest smartphones. ".repeat(80)}</p>`;
      const res = run(
        `<html><body>${filler}${Array.from({ length: 12 }, (_, i) => card(i)).join("")}</body></html>`,
      );
      expect(res.signals.some((s) => s.startsWith("repeated_item_grid"))).toBe(true);
      expect(res.pageType).toBe("listing");
    });

    it("a product page with a related-items carousel still resolves to detail via its schema", () => {
      const res = run(
        `<html><body>
          <script type="application/ld+json">{"@type":"Product","name":"Main Phone"}</script>
          <h1>Main Phone</h1><p>${"Long product description. ".repeat(100)}</p>
          ${Array.from({ length: 10 }, (_, i) => card(i)).join("")}
        </body></html>`,
      );
      expect(res.pageType).toBe("detail");
    });

    it("does not fire on repeated nav items (short text)", () => {
      const navItems = Array.from(
        { length: 20 },
        (_, i) => `<li data-csa-c-type="item"><a href="/c/${i}">Menu ${i}</a></li>`,
      ).join("");
      const res = run(`<html><body><ul>${navItems}</ul><p>Welcome to the shop.</p></body></html>`);
      expect(res.signals.some((s) => s.startsWith("repeated_item_grid"))).toBe(false);
    });

    it("a rendered product page with NO schema at all resolves to detail via its /dp/ URL — the exact browser-path regression found live", () => {
      // Amazon's hydrated DOM ships zero JSON-LD; this page still has a
      // related-items carousel (grid signal) and review pagination (listing
      // signal). The /dp/ URL convention is the only remaining detail anchor.
      const res = run(
        `<html><body>
          <h1>boAt Rockerz 255 Pro+</h1><p>${"Long product description text. ".repeat(100)}</p>
          <div class="pagination"><a href="?reviews=2">Next reviews</a></div>
          ${Array.from({ length: 10 }, (_, i) => card(i)).join("")}
        </body></html>`,
        "https://www.amazon.in/boAt-Rockerz-255/dp/B08TV2P1N8",
      );
      expect(res.signals).toContain("detail_url_pattern");
      expect(res.pageType).toBe("detail");
    });

    it("a search-results URL gets no detail_url_pattern signal", () => {
      const res = run(
        `<html><body>${Array.from({ length: 12 }, (_, i) => card(i)).join("")}</body></html>`,
        "https://www.amazon.in/s?k=mobile+phones",
      );
      expect(res.signals).not.toContain("detail_url_pattern");
      expect(res.pageType).toBe("listing");
    });

    it("does not fire on repeated containers without links", () => {
      const rows = Array.from(
        { length: 12 },
        (_, i) =>
          `<div data-row="stat">Statistic number ${i} with a fairly long explanatory label attached to it</div>`,
      ).join("");
      const res = run(`<html><body>${rows}</body></html>`);
      expect(res.signals.some((s) => s.startsWith("repeated_item_grid"))).toBe(false);
    });
  });
});
