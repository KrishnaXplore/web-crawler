import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { crawlUrl, fetchPage } from "@crawler/core";
import { renderPage } from "./render.js";

// Launches Chromium and hits the network — opt in with RUN_RENDER_IT=1, so the
// default offline suite (pnpm -r test) stays fast and network-free.
const RUN_IT = process.env.RUN_RENDER_IT === "1";

describe.skipIf(!RUN_IT)("Renderer E2E Capability", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("proves capability difference between http and browser mode on JS-rendered content", async () => {
    const url = "http://quotes.toscrape.com/js/";

    // 1. HTTP mode
    const httpDeps = {
      fetch: (u: string) =>
        fetchPage(u, {
          userAgent: "test-bot",
          timeoutMs: 10000,
          maxBytes: 1024 * 1024,
        }),
    };

    const httpResult = await crawlUrl(url, httpDeps, {
      sameHostOnly: true,
      respectRobots: false,
    });

    expect(httpResult.outcome).toBe("ok");
    expect(httpResult.title).toBe("Quotes to Scrape");
    // In HTTP mode, the quote text is inside a script tag, so Cheerio won't see it as text in the DOM.
    // We expect the DOM to NOT have "Albert Einstein" in a standard text element.
    expect(httpResult.html).not.toContain('<div class="quote"');

    // 2. Browser mode
    const browserDeps = {
      fetch: (u: string) =>
        renderPage(u, browser, {
          userAgent: "test-bot",
          timeoutMs: 20000,
        }),
    };

    const browserResult = await crawlUrl(url, browserDeps, {
      sameHostOnly: true,
      respectRobots: false,
    });

    expect(browserResult.outcome).toBe("ok");
    expect(browserResult.title).toBe("Quotes to Scrape");
    // In Browser mode, the JS executes and creates the quote divs.
    expect(browserResult.html).toContain('<div class="quote"');
    expect(browserResult.html).toContain("Albert Einstein");
  }, 30000); // give it a longer timeout
});
