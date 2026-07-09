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

    it("skips extraction on listing pages", async () => {
      const out = (await runPlugins(["discovery", "rules", "structured"], {
        url: "http://a.com",
        html: listingHtml,
        headers: {},
        status: 200,
        options: { rules: [] },
      }))!;
      expect((out.discovery as any).pageType).toBe("listing");
      // rules and structured were actively skipped
      expect(out.rules).toEqual({ error: "skipped_by_confidence_router" });
      expect(out.structured).toEqual({ error: "skipped_by_confidence_router" });
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
  });
});
