import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { metadataPlugin } from "./builtins.js";

const PAGE_URL = "https://example.com/articles/one";

function analyze(html: string, url = PAGE_URL) {
  return metadataPlugin.analyze({
    url,
    $: cheerio.load(html),
    headers: {},
    status: 200,
  }) as Record<string, any>;
}

const FULL_PAGE = `<!doctype html>
<html lang="en-GB"><head>
  <link rel="canonical" href="/articles/one">
  <meta property="og:title" content="One">
  <meta property="og:description" content="The first article">
  <meta property="og:image" content="/img/one.png">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="One (tw)">
  <link rel="alternate" hreflang="de" href="https://example.com/de/articles/one">
  <link rel="alternate" hreflang="fr" href="/fr/articles/one">
  <meta name="robots" content="noindex, nofollow">
</head><body></body></html>`;

describe("metadata plugin (M6 Step C)", () => {
  it("resolves a relative canonical to absolute and flags isCanonical", () => {
    const m = analyze(FULL_PAGE);
    expect(m.canonical).toBe("https://example.com/articles/one");
    expect(m.isCanonical).toBe(true);
  });

  it("flags a non-canonical page (canonical points elsewhere)", () => {
    const m = analyze(
      `<html><head><link rel="canonical" href="https://example.com/articles/one"></head></html>`,
      "https://example.com/articles/one?utm=x",
    );
    expect(m.isCanonical).toBe(false);
  });

  it("extracts og and twitter card fields", () => {
    const m = analyze(FULL_PAGE);
    expect(m.og).toEqual({
      title: "One",
      description: "The first article",
      image: "/img/one.png",
      type: "article",
    });
    expect(m.twitter.card).toBe("summary");
    expect(m.twitter.title).toBe("One (tw)");
    expect(m.twitter.image).toBeNull();
  });

  it("collects hreflang alternates with hrefs resolved absolute", () => {
    const m = analyze(FULL_PAGE);
    expect(m.hreflang).toEqual([
      { lang: "de", href: "https://example.com/de/articles/one" },
      { lang: "fr", href: "https://example.com/fr/articles/one" },
    ]);
  });

  it("reports robots meta directives and document lang", () => {
    const m = analyze(FULL_PAGE);
    expect(m.robots).toEqual({ noindex: true, nofollow: true });
    expect(m.lang).toBe("en-GB");
  });

  it("is graceful on a page with no metadata at all", () => {
    const m = analyze(`<html><head><title>bare</title></head><body></body></html>`);
    expect(m.canonical).toBeNull();
    expect(m.isCanonical).toBeNull();
    expect(m.lang).toBeNull();
    expect(m.og.title).toBeNull();
    expect(m.twitter.card).toBeNull();
    expect(m.hreflang).toEqual([]);
    expect(m.robots).toEqual({ noindex: false, nofollow: false });
  });

  it("ignores a malformed canonical href", () => {
    const m = analyze(
      `<html><head><link rel="canonical" href="http://"></head></html>`,
    );
    expect(m.canonical).toBeNull();
    expect(m.isCanonical).toBeNull();
  });
});
