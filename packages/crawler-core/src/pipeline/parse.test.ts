import { describe, it, expect } from "vitest";
import { parseMeta } from "./parse.js";

describe("parseMeta", () => {
  it("extracts title and meta description", () => {
    const html = `<html><head><title> Hello </title><meta name="description" content=" A page "></head></html>`;
    expect(parseMeta(html)).toEqual({ title: "Hello", description: "A page" });
  });

  it("falls back to og:description", () => {
    const html = `<meta property="og:description" content="OG text">`;
    expect(parseMeta(html)).toEqual({ title: null, description: "OG text" });
  });

  it("prefers meta[name=description] over og:description", () => {
    const html = `<meta name="description" content="primary"><meta property="og:description" content="secondary">`;
    expect(parseMeta(html)).toEqual({ title: null, description: "primary" });
  });

  it("returns nulls when metadata is absent", () => {
    expect(parseMeta("<html><body>no head</body></html>")).toEqual({
      title: null,
      description: null,
    });
  });
});
