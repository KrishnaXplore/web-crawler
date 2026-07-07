import { describe, it, expect } from "vitest";
import { normalizeUrl, hostOf, InvalidUrlError } from "./normalize.js";

describe("normalizeUrl", () => {
  it("lowercases scheme and host but preserves path case", () => {
    expect(normalizeUrl("HTTP://Example.COM/Path")).toBe(
      "http://example.com/Path",
    );
  });

  it("drops the fragment", () => {
    expect(normalizeUrl("https://a.com/x#section")).toBe("https://a.com/x");
  });

  it("removes default ports", () => {
    expect(normalizeUrl("http://a.com:80/")).toBe("http://a.com/");
    expect(normalizeUrl("https://a.com:443/")).toBe("https://a.com/");
  });

  it("keeps non-default ports", () => {
    expect(normalizeUrl("http://a.com:8080/")).toBe("http://a.com:8080/");
  });

  it("gives an empty path a trailing slash", () => {
    expect(normalizeUrl("http://a.com")).toBe("http://a.com/");
  });

  it("sorts query params for a stable key", () => {
    expect(normalizeUrl("http://a.com/?b=2&a=1")).toBe("http://a.com/?a=1&b=2");
  });

  it("strips tracking params", () => {
    expect(normalizeUrl("http://a.com/?utm_source=x&q=1")).toBe(
      "http://a.com/?q=1",
    );
  });

  it("resolves relative URLs against a base", () => {
    expect(normalizeUrl("/b/c", "http://a.com/x/y")).toBe("http://a.com/b/c");
    expect(normalizeUrl("../z", "http://a.com/x/y")).toBe("http://a.com/z");
  });

  it("collapses equivalent URLs to the same string", () => {
    const a = normalizeUrl("HTTP://A.com:80/p?y=2&x=1#f");
    const b = normalizeUrl("http://a.com/p?x=1&y=2");
    expect(a).toBe(b);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeUrl("ftp://a.com")).toThrow(InvalidUrlError);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(InvalidUrlError);
  });

  it("rejects empty and unparseable input", () => {
    expect(() => normalizeUrl("")).toThrow(InvalidUrlError);
    expect(() => normalizeUrl("   ")).toThrow(InvalidUrlError);
    expect(() => normalizeUrl("not a url")).toThrow(InvalidUrlError);
  });
});

describe("hostOf", () => {
  it("returns the lowercased host", () => {
    expect(hostOf("HTTP://Example.com/x")).toBe("example.com");
  });

  it("resolves against a base", () => {
    expect(hostOf("/path", "https://sub.a.com/")).toBe("sub.a.com");
  });
});
