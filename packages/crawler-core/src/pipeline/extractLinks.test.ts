import { describe, it, expect } from "vitest";
import { extractLinks } from "./extractLinks.js";

const page = "http://a.com/dir/page";

describe("extractLinks", () => {
  it("resolves relative links against the page URL", () => {
    const html = `<a href="/x">1</a><a href="y">2</a><a href="../z">3</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      "http://a.com/x",
      "http://a.com/dir/y",
      "http://a.com/z",
    ]);
  });

  it("honors <base href>", () => {
    const html = `<base href="http://a.com/other/"><a href="q">q</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      "http://a.com/other/q",
    ]);
  });

  it("de-dupes links that normalize to the same URL", () => {
    const html = `<a href="/x?b=2&a=1">1</a><a href="/x?a=1&b=2#f">2</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      "http://a.com/x?a=1&b=2",
    ]);
  });

  it("skips non-http(s) links (mailto:, javascript:)", () => {
    const html = `<a href="mailto:x@a.com">m</a><a href="javascript:void 0">j</a><a href="/ok">ok</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      "http://a.com/ok",
    ]);
  });

  it("drops self-links (a bare #anchor resolves to the page itself)", () => {
    const html = `<a href="#top">top</a><a href="">empty</a><a href="/ok">ok</a>`;
    expect(extractLinks(html, page, { sameHostOnly: false })).toEqual([
      "http://a.com/ok",
    ]);
  });

  it("filters off-host links when sameHostOnly is set", () => {
    const html = `<a href="http://a.com/keep">k</a><a href="http://other.com/drop">d</a>`;
    expect(extractLinks(html, page, { sameHostOnly: true })).toEqual([
      "http://a.com/keep",
    ]);
  });
});
