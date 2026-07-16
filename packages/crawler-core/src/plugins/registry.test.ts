import { describe, it, expect } from "vitest";
import { runPlugins, availablePlugins } from "./registry.js";

const html = `<html><head>
  <title>My Page</title>
  <meta name="description" content="d">
  <meta name="generator" content="WordPress 6.4">
  <script src="/wp-includes/js/jquery.min.js"></script>
</head><body>
  <h1>One</h1>
  <img src="a.png" alt="ok"><img src="b.png">
</body></html>`;

describe("runPlugins", () => {
  it("returns null when no plugins requested", async () => {
    expect(await runPlugins([], { url: "http://a.com", html, headers: {}, status: 200 })).toBeNull();
  });

  it("runs seo, tech, security and keys output by name", async () => {
    const out = (await runPlugins(["seo", "tech", "security"], {
      url: "http://a.com",
      html,
      headers: { "strict-transport-security": "max-age=1", "x-frame-options": "DENY" },
      status: 200,
    }))!;
    expect(out.seo).toMatchObject({ h1Count: 1, images: 2, imagesMissingAlt: 1, hasMetaDescription: true });
    expect(out.tech).toMatchObject({ detected: expect.arrayContaining(["WordPress", "jQuery"]) });
    expect(out.security).toMatchObject({ score: "2/5" });
  });

  it("skips unknown plugin names", async () => {
    const out = (await runPlugins(["nope"], { url: "http://a.com", html, headers: {}, status: 200 }))!;
    expect(out).toEqual({});
  });

  it("exposes available plugin names", () => {
    expect(availablePlugins()).toEqual(expect.arrayContaining(["seo", "tech", "security"]));
  });

  describe("M14 Confidence Router", () => {
    const detailHtml = `<html><body>
      <article>
        <h1>Detail Page</h1>
        <p>This is a long article.</p>
      </article>
    </body></html>`;

    const listingHtml = `<html><body>
      <ul>
        <li><a href="/1">1</a></li>
        <li><a href="/2">2</a></li>
      </ul>
      <div class="pagination"><a class="next" href="?p=2">Next</a></div>
    </body></html>`;

    it("runs extraction on detail pages", async () => {
      const out = (await runPlugins(["discovery", "rules"], {
        url: "http://a.com",
        html: detailHtml,
        headers: {},
        status: 200,
        options: { rules: [] },
      }))!;
      expect((out.discovery as any).pageType).toBe("detail");
      // "rules" plugin ran (returns confidence: "none" because rules array is empty, no error)
      expect(out.rules).toBeDefined();
      expect((out.rules as any).error).toBeUndefined();
    });

    it("on listing pages: skips structured, runs rules in list mode (M22)", async () => {
      const out = (await runPlugins(["discovery", "rules", "structured"], {
        url: "http://a.com",
        html: listingHtml,
        headers: {},
        status: 200,
        options: {}, // no stored rules of either kind, no intent
      }))!;
      expect((out.discovery as any).pageType).toBe("listing");
      // structured is intentionally skipped — a listing's own JSON-LD is usually
      // about the wrong thing. NOT an error shape.
      expect(out.structured).toEqual({ skipped: true, reason: "listing_page" });
      // rules RAN (list mode) — with no list rule and no intent it just finds nothing.
      expect((out.rules as any).skipped).toBeUndefined();
      expect((out.rules as any).confidence).toBe("none");
      expect((out.rules as any).error).toBeUndefined();
    });

    it("M22: extracts one record per item on a listing page via the domain's list rule", async () => {
      const catalog = `<html><body>
        <ul>
          <li class="pod"><h3><a href="/1">Book One</a></h3><p class="price">£10</p></li>
          <li class="pod"><h3><a href="/2">Book Two</a></h3><p class="price">£20</p></li>
        </ul>
        <div class="pagination"><a class="next" href="?p=2">Next</a></div>
      </body></html>`;
      const out = (await runPlugins(["discovery", "rules"], {
        url: "http://a.com",
        html: catalog,
        headers: {},
        status: 200,
        options: {
          listRules: {
            schemaType: "Product",
            listItem: ".pod",
            fields: { title: "h3 a", price: ".price" },
          },
        },
      }))!;
      expect((out.discovery as any).pageType).toBe("listing");
      expect((out.rules as any).records).toEqual([
        { title: "Book One", price: "£10" },
        { title: "Book Two", price: "£20" },
      ]);
      expect((out.rules as any).confidence).toBe("high");
    });

    it("M22: escalates to a LIST-mode Tier 4 generation on listings with an intent", async () => {
      let seenPageType: string | undefined;
      const socket = {
        generateRules: async (
          domain: string,
          _html: string,
          _intent: string,
          opts?: { pageType?: string },
        ) => {
          seenPageType = opts?.pageType;
          return {
            domain,
            schemaType: "Product",
            kind: "list" as const,
            listItem: "li",
            fields: { title: "a" },
          };
        },
      };
      const out = (await runPlugins(["discovery", "rules"], {
        url: "http://a.com",
        html: listingHtml,
        headers: {},
        status: 200,
        options: {}, // no stored list rule
        intent: "all the titles",
        llmSocket: socket,
      }))!;
      expect(seenPageType).toBe("list");
      expect((out.rules as any).records).toEqual([{ title: "1" }, { title: "2" }]);
      expect((out.rules as any).generatedRules.kind).toBe("list");
    });

    it("skips Tier 2 (rules) when Tier 1 (structured) already produced a confident record", async () => {
      const structuredHtml = `<html><body>
        <article><h1>Detail Page</h1><p>This is a sufficiently long article body to read as detail content, not a listing.</p></article>
        <script type="application/ld+json">{"@type":"Product","name":"Widget","price":"9.99"}</script>
      </body></html>`;
      const out = (await runPlugins(["structured", "rules"], {
        url: "http://a.com",
        html: structuredHtml,
        headers: {},
        status: 200,
        options: { rules: { schemaType: "Product", fields: { name: "h1" } } },
      }))!;
      expect((out.structured as any).confidence).toBe("high");
      // rules was NOT executed — Tier 1 already answered confidently.
      expect(out.rules).toEqual({ skipped: true, reason: "tier1_structured_confident" });
    });

    it("M17: does NOT skip Tier 2/4 when Tier 1 only partially covers the intent — the exact Amazon bug", async () => {
      // Tier 1 finds name/description (no price) via JSON-LD; intent also asks for price.
      const html = `<html><body>
        <script type="application/ld+json">{"@type":"Product","name":"Phone","description":"A nice phone"}</script>
        <h1 class="title">Phone</h1><span class="price">$999</span>
      </body></html>`;
      const out = (await runPlugins(["structured", "rules"], {
        url: "http://a.com",
        html,
        headers: {},
        status: 200,
        options: { rules: undefined }, // no existing rule for this domain
        intent: "extract the name and price",
      }))!;
      expect((out.structured as any).confidence).toBe("high");
      expect((out.structured as any).fields.price).toBeUndefined();
      // rules was NOT skipped — Tier 1's partial result didn't cover "price".
      expect((out.rules as any).skipped).toBeUndefined();
      expect((out.rules as any).generatedRules).toBeDefined();
    });

    it("still runs rules directly when structured wasn't requested at all", async () => {
      const html = `<html><body><h1>My Product</h1></body></html>`;
      const out = (await runPlugins(["rules"], {
        url: "http://a.com",
        html,
        headers: {},
        status: 200,
        options: { rules: { schemaType: "Product", fields: { title: "h1" } } },
      }))!;
      expect(out.structured).toBeUndefined();
      expect((out.rules as any).confidence).toBe("high");
      expect((out.rules as any).fields).toEqual({ title: "My Product" });
    });
  });

  describe("M13 Intent Layer / LLM Socket", () => {
    const html = `<html><body><h1 class="title">My Product</h1><span class="price">$10</span></body></html>`;

    it("generates rules via LLM if intent is present and rules are missing", async () => {
      const out = (await runPlugins(["rules"], {
        url: "http://example.com",
        html,
        headers: {},
        status: 200,
        options: { rules: undefined }, // No rules exist
        intent: "extract the price and title",
      }))!;

      // 1. Check that rules ran and extracted the correct data
      const rulesOut = out.rules as any;
      expect(rulesOut.confidence).toBe("high");
      expect(rulesOut.fields).toEqual({
        title: "My Product",
        price: "$10",
      });

      // 2. Check that the generated rules were attached
      expect(rulesOut.generatedRules).toBeDefined();
      expect(rulesOut.generatedRules.fields).toEqual({
        title: "h1",
        price: ".price",
      });
    });

    it("M21: escalates when the stored rule only partially covers the intent — the books.toscrape.com bug", async () => {
      // Stored rule's price selector is stale (.stale-price matches nothing);
      // title still extracts, so confidence is "high" — pre-M21 that blocked
      // Tier 4 forever and the price column stayed empty.
      const out = (await runPlugins(["rules"], {
        url: "http://example.com",
        html,
        headers: {},
        status: 200,
        options: {
          rules: { schemaType: "Product", fields: { title: "h1", price: ".stale-price" } },
        },
        intent: "extract the price and title",
      }))!;
      const rulesOut = out.rules as any;
      expect(rulesOut.fields).toEqual({ title: "My Product", price: "$10" });
      // The regenerated rule is attached for persistence — it healed the selector.
      expect(rulesOut.generatedRules.fields).toEqual({ title: "h1", price: ".price" });
    });

    it("M21: keeps the stored rule's partial result when regeneration comes back worse", async () => {
      const badSocket = {
        generateRules: async () => ({
          domain: "example.com",
          schemaType: "Product",
          fields: { title: ".nope", price: ".also-nope" },
        }),
      };
      const out = (await runPlugins(["rules"], {
        url: "http://example.com",
        html,
        headers: {},
        status: 200,
        options: {
          rules: { schemaType: "Product", fields: { title: "h1", price: ".stale-price" } },
        },
        intent: "extract the price and title",
        llmSocket: badSocket,
      }))!;
      const rulesOut = out.rules as any;
      // Partial result survives; the failed regeneration is NOT persisted.
      expect(rulesOut.fields).toEqual({ title: "My Product" });
      expect(rulesOut.generatedRules).toBeUndefined();
    });

    it("M21: does NOT call the LLM when the stored rule already covers the intent", async () => {
      let called = false;
      const spySocket = {
        generateRules: async () => {
          called = true;
          return { domain: "example.com", schemaType: "Product", fields: {} };
        },
      };
      const out = (await runPlugins(["rules"], {
        url: "http://example.com",
        html,
        headers: {},
        status: 200,
        options: {
          rules: { schemaType: "Product", fields: { title: "h1", price: ".price" } },
        },
        intent: "extract the price and title",
        llmSocket: spySocket,
      }))!;
      expect((out.rules as any).fields).toEqual({ title: "My Product", price: "$10" });
      expect(called).toBe(false);
    });
  });
});
