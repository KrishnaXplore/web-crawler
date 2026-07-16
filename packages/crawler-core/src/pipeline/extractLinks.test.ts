import { describe, it, expect } from "vitest";
import { extractLinks } from "./extractLinks.js";

const page = "http://a.com/dir/page";

describe("extractLinks", () => {
  it("resolves relative links against the page URL", () => {
    const html = `<a href="/x">1</a><a href="y">2</a><a href="../z">3</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      { url: "http://a.com/x", anchorText: "1" },
      { url: "http://a.com/dir/y", anchorText: "2" },
      { url: "http://a.com/z", anchorText: "3" },
    ]);
  });

  it("honors <base href>", () => {
    const html = `<base href="http://a.com/other/"><a href="q">q</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      { url: "http://a.com/other/q", anchorText: "q" },
    ]);
  });

  it("de-dupes links that normalize to the same URL, keeping the first anchor text", () => {
    const html = `<a href="/x?b=2&a=1">first</a><a href="/x?a=1&b=2#f">second</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      { url: "http://a.com/x?a=1&b=2", anchorText: "first" },
    ]);
  });

  it("skips non-http(s) links (mailto:, javascript:)", () => {
    const html = `<a href="mailto:x@a.com">m</a><a href="javascript:void 0">j</a><a href="/ok">ok</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      { url: "http://a.com/ok", anchorText: "ok" },
    ]);
  });

  it("drops self-links (a bare #anchor resolves to the page itself)", () => {
    const html = `<a href="#top">top</a><a href="">empty</a><a href="/ok">ok</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      { url: "http://a.com/ok", anchorText: "ok" },
    ]);
  });

  it("filters off-host links when sameHostOnly is set", () => {
    const html = `<a href="http://a.com/keep">k</a><a href="http://other.com/drop">d</a>`;
    expect(extractLinks(html, page, { sameHostOnly: true })).toEqual([
      { url: "http://a.com/keep", anchorText: "k" },
    ]);
  });

  it("trims whitespace from anchor text", () => {
    const html = `<a href="/x">\n  Faculty  \n</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      { url: "http://a.com/x", anchorText: "Faculty" },
    ]);
  });
});
