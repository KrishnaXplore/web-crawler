import { describe, it, expect } from "vitest";
import { parseRobots } from "./robots.js";

describe("parseRobots", () => {
  it("allows everything when there are no rules", () => {
    const r = parseRobots("", "mybot");
    expect(r.isAllowed("/anything")).toBe(true);
    expect(r.crawlDelay).toBeNull();
  });

  it("applies Disallow for the matching user-agent", () => {
    const txt = `User-agent: *\nDisallow: /private`;
    const r = parseRobots(txt, "mybot");
    expect(r.isAllowed("/private/x")).toBe(false);
    expect(r.isAllowed("/public")).toBe(true);
  });

  it("prefers a UA-specific group over the wildcard group", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: mybot",
      "Disallow: /admin",
    ].join("\n");
    const r = parseRobots(txt, "MyBot/1.0");
    expect(r.isAllowed("/anything")).toBe(true); // wildcard's blanket ban ignored
    expect(r.isAllowed("/admin/panel")).toBe(false);
  });

  it("uses longest-match precedence, Allow winning ties", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /a",
      "Allow: /a/b",
    ].join("\n");
    const r = parseRobots(txt, "mybot");
    expect(r.isAllowed("/a/x")).toBe(false); // matches Disallow /a
    expect(r.isAllowed("/a/b/c")).toBe(true); // longer Allow /a/b wins
  });

  it("treats an empty Disallow as no restriction", () => {
    const txt = `User-agent: *\nDisallow:`;
    expect(parseRobots(txt, "mybot").isAllowed("/anything")).toBe(true);
  });

  it("supports the $ end-anchor", () => {
    const txt = `User-agent: *\nDisallow: /*.pdf$`;
    const r = parseRobots(txt, "mybot");
    expect(r.isAllowed("/doc.pdf")).toBe(false);
    expect(r.isAllowed("/doc.pdf?x=1")).toBe(true); // $ anchors the end
  });

  it("parses Crawl-delay for the matched group", () => {
    const txt = `User-agent: mybot\nCrawl-delay: 5\nDisallow: /x`;
    expect(parseRobots(txt, "mybot").crawlDelay).toBe(5);
  });

  it("ignores comments and blank lines", () => {
    const txt = `# a comment\nUser-agent: *   # inline\nDisallow: /secret # nope`;
    const r = parseRobots(txt, "mybot");
    expect(r.isAllowed("/secret/y")).toBe(false);
    expect(r.isAllowed("/ok")).toBe(true);
  });

  it("shares one rule block across consecutive User-agent lines", () => {
    const txt = [
      "User-agent: botA",
      "User-agent: botB",
      "Disallow: /shared",
    ].join("\n");
    expect(parseRobots(txt, "botB").isAllowed("/shared/z")).toBe(false);
    expect(parseRobots(txt, "botA").isAllowed("/shared/z")).toBe(false);
  });
});
