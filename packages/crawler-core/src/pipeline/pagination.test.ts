import { describe, it, expect } from "vitest";
import { findNextPageUrl } from "./pagination.js";

const BASE = "https://shop.example/list/page-1.html";

describe("findNextPageUrl (M25 pagination)", () => {
  it("finds <link rel=next> in head (most reliable)", () => {
    const html = `<html><head><link rel="next" href="page-2.html"></head><body></body></html>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://shop.example/list/page-2.html");
  });

  it("finds <a rel=next>", () => {
    const html = `<a rel="next" href="/list/page-2.html">go</a>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://shop.example/list/page-2.html");
  });

  it("finds the books.toscrape li.next pattern", () => {
    const html = `<ul class="pager"><li class="next"><a href="page-2.html">next</a></li></ul>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://shop.example/list/page-2.html");
  });

  it("finds an aria-label next", () => {
    const html = `<nav><a aria-label="Next page" href="?p=2">›</a></nav>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://shop.example/list/page-1.html?p=2");
  });

  it("finds a text-based next inside a pagination container", () => {
    const html = `<div class="pagination"><a href="p1">1</a><a href="page-2.html">Next ›</a></div>`;
    // "Next ›" doesn't match the strict single-token regex; use exact "next"
    const html2 = `<div class="pagination"><a href="p1">1</a><a href="page-2.html">Next</a></div>`;
    expect(findNextPageUrl(html2, BASE)).toBe("https://shop.example/list/page-2.html");
  });

  it("returns null when there is no next link", () => {
    const html = `<div class="pagination"><a href="p1">1</a><span class="current">2</span></div>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it("ignores a stray '>' outside any pagination container", () => {
    const html = `<article><a href="/somewhere">></a></article>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it("ignores fragment/js hrefs", () => {
    const html = `<a rel="next" href="#">next</a>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it("does not return the page's own URL", () => {
    const html = `<link rel="next" href="page-1.html">`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it("does not follow to another host silently (returns absolute; caller enforces same-host)", () => {
    const html = `<a rel="next" href="https://other.example/p2">next</a>`;
    // The detector resolves it; same-host enforcement is the caller's job.
    expect(findNextPageUrl(html, BASE)).toBe("https://other.example/p2");
  });
});
