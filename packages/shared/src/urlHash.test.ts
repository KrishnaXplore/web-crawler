import { describe, it, expect } from "vitest";
import { urlHash } from "./urlHash.js";

describe("urlHash", () => {
  it("is deterministic", () => {
    expect(urlHash("http://a.com/")).toBe(urlHash("http://a.com/"));
  });

  it("differs for different URLs", () => {
    expect(urlHash("http://a.com/")).not.toBe(urlHash("http://a.com/x"));
  });

  it("returns a 40-char lowercase hex sha1", () => {
    expect(urlHash("http://a.com/")).toMatch(/^[0-9a-f]{40}$/);
  });
});
