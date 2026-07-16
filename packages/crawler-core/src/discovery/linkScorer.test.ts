import { describe, it, expect } from "vitest";
import { scoreLinks, focusLinks } from "./linkScorer.js";
import type { LinkCandidate } from "../pipeline/extractLinks.js";

describe("scoreLinks (M16 Discovery Engine — Stage A)", () => {
  it("ranks a keyword match in anchor text above unrelated links", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/about", anchorText: "About Us" },
      { url: "http://a.com/faculty", anchorText: "Faculty" },
      { url: "http://a.com/sports", anchorText: "Sports" },
    ];
    const ranked = scoreLinks(candidates, "extract CSE faculty from MSRIT");
    expect(ranked[0]!.url).toBe("http://a.com/faculty");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("matches keywords in the URL path when anchor text doesn't help", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/electronics/laptops", anchorText: "Shop now" },
      { url: "http://a.com/help", anchorText: "Shop now" },
    ];
    const ranked = scoreLinks(candidates, "I want all laptops from Amazon");
    expect(ranked[0]!.url).toBe("http://a.com/electronics/laptops");
  });

  it("gives a smaller boost to category-shaped URLs when no keyword matches at all", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/products/", anchorText: "Browse" },
      { url: "http://a.com/contact-us", anchorText: "Contact" },
    ];
    const ranked = scoreLinks(candidates, "extract gadget prices");
    expect(ranked[0]!.url).toBe("http://a.com/products/");
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked[1]!.score).toBe(0);
  });

  it("prefers an exact keyword match over a bare structural pattern match", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/products/mobiles", anchorText: "Mobiles" },
      { url: "http://a.com/products/", anchorText: "All Products" },
    ];
    const ranked = scoreLinks(candidates, "extract mobile phones");
    expect(ranked[0]!.url).toBe("http://a.com/products/mobiles");
  });

  it("preserves input order when intent is empty (no regression for jobs without intent)", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/z", anchorText: "Z" },
      { url: "http://a.com/a", anchorText: "A" },
    ];
    const ranked = scoreLinks(candidates, "");
    expect(ranked.map((r) => r.url)).toEqual(["http://a.com/z", "http://a.com/a"]);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it("preserves input order among equally-scored candidates (stable sort)", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/1", anchorText: "Random" },
      { url: "http://a.com/2", anchorText: "Also random" },
    ];
    const ranked = scoreLinks(candidates, "extract widgets");
    expect(ranked.map((r) => r.url)).toEqual(["http://a.com/1", "http://a.com/2"]);
  });
});

describe("scoreLinks with knownGoodPaths (M18 — Discovery Engine Step B)", () => {
  it("ranks a known-good path above a plain keyword match", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://amazon.in/mobile-phones/b/", anchorText: "Mobiles" }, // keyword match
      { url: "http://amazon.in/wireless-earbuds/dp/xyz", anchorText: "Boat Earbuds" }, // known-good, no keyword match
    ];
    const ranked = scoreLinks(candidates, "extract mobile phones", ["/wireless-earbuds/dp/xyz"]);
    expect(ranked[0]!.url).toBe("http://amazon.in/wireless-earbuds/dp/xyz");
  });

  it("omitting knownGoodPaths behaves identically to before this parameter existed", () => {
    const candidates: LinkCandidate[] = [
      { url: "http://a.com/faculty", anchorText: "Faculty" },
      { url: "http://a.com/sports", anchorText: "Sports" },
    ];
    const withDefault = scoreLinks(candidates, "extract faculty");
    const withEmpty = scoreLinks(candidates, "extract faculty", []);
    expect(withDefault).toEqual(withEmpty);
  });

  it("a known-good path that doesn't appear among candidates has no effect", () => {
    const candidates: LinkCandidate[] = [{ url: "http://a.com/faculty", anchorText: "Faculty" }];
    const ranked = scoreLinks(candidates, "extract faculty", ["/some/other/path"]);
    expect(ranked[0]!.score).toBe(10); // plain keyword match weight, not the known-good weight
  });
});

describe("focusLinks (M23 focused crawl — detail intents)", () => {
  const candidates: LinkCandidate[] = [
    { url: "http://shop.com/login", anchorText: "Sign in" },
    { url: "http://shop.com/cart", anchorText: "Cart" },
    { url: "http://shop.com/about-us", anchorText: "About" },
    { url: "http://shop.com/products/phones", anchorText: "Phones" }, // hub
    { url: "http://shop.com/p/galaxy-s24", anchorText: "Galaxy S24" }, // detail
    { url: "http://shop.com/dp/B0ABC", anchorText: "boAt earbuds" }, // detail
  ];

  it("ranks detail-page links above hub links", () => {
    const ranked = focusLinks(candidates, "specs of this phone");
    expect(ranked[0]!.url).toMatch(/\/(p|dp)\//);
    expect(ranked[1]!.url).toMatch(/\/(p|dp)\//);
  });

  it("drops account/cart/support chrome entirely", () => {
    const ranked = focusLinks(candidates, "specs of this phone");
    const urls = ranked.map((r) => r.url);
    expect(urls).not.toContain("http://shop.com/login");
    expect(urls).not.toContain("http://shop.com/cart");
    expect(urls).not.toContain("http://shop.com/about-us");
  });

  it("keeps category/search hubs as bridges (nonzero keyword score)", () => {
    const ranked = focusLinks(candidates, "phones");
    expect(ranked.map((r) => r.url)).toContain("http://shop.com/products/phones");
  });

  it("keeps detail links even when they don't keyword-match the intent", () => {
    // /dp/B0ABC has no "phone" keyword, but it's the target shape — must survive.
    const ranked = focusLinks(candidates, "phone");
    expect(ranked.map((r) => r.url)).toContain("http://shop.com/dp/B0ABC");
  });

  it("does NOT drop unrecognized links — only deprioritizes them (no stranding)", () => {
    // A non-standard product URL (books.toscrape style) is neither a known detail
    // pattern nor a keyword match, but must still be crawled, ranked last.
    const odd: LinkCandidate[] = [
      { url: "http://shop.com/dp/B0ABC", anchorText: "phone" },
      { url: "http://shop.com/catalogue/some-item_42/index.html", anchorText: "Some Item" },
    ];
    const ranked = focusLinks(odd, "the price");
    expect(ranked.map((r) => r.url)).toContain("http://shop.com/catalogue/some-item_42/index.html");
    // detail URL still ranks first
    expect(ranked[0]!.url).toBe("http://shop.com/dp/B0ABC");
  });
});
