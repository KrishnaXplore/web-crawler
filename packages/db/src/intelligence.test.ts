import { describe, it, expect } from "vitest";
import { deriveProfile, matchingPathHints } from "./intelligence.js";

describe("deriveProfile (M12 Website Intelligence Layer)", () => {
  it("derives needsRender=false for an http-only domain", () => {
    const p = deriveProfile({
      _id: "quotes.toscrape.com",
      pagesObserved: 5,
      techStack: ["jQuery"],
      renderModesSeen: ["http"],
      lastStatusOk: true,
      firstSeenAt: new Date("2026-07-01"),
      lastSeenAt: new Date("2026-07-09"),
    });
    expect(p.domain).toBe("quotes.toscrape.com");
    expect(p.needsRender).toBe(false);
    expect(p.pagesObserved).toBe(5);
    expect(p.techStack).toEqual(["jQuery"]);
  });

  it("derives needsRender=true when the browser was used", () => {
    const p = deriveProfile({ _id: "spa.example", renderModesSeen: ["http", "browser"] });
    expect(p.needsRender).toBe(true);
  });

  it("derives needsRender=true when HTTP mode was bot-challenged (M20), even if browser was never used", () => {
    const p = deriveProfile({
      _id: "amazon.example",
      renderModesSeen: ["http"],
      httpChallengeSeen: true,
    });
    expect(p.needsRender).toBe(true);
    expect(p.httpChallengeSeen).toBe(true);
  });

  it("fills sane defaults for a sparse doc", () => {
    const p = deriveProfile({ _id: "new.example" });
    expect(p.pagesObserved).toBe(0);
    expect(p.techStack).toEqual([]);
    expect(p.renderModesSeen).toEqual([]);
    expect(p.needsRender).toBe(false);
    expect(p.lastStatusOk).toBe(true);
    expect(p.pathHints).toEqual([]);
  });

  it("derives pathHints from the raw doc", () => {
    const p = deriveProfile({
      _id: "amazon.in",
      pathHints: [{ keywords: ["mobile", "phones"], path: "/mobile-phones/b/", confirmedAt: new Date("2026-07-10") }],
    });
    expect(p.pathHints).toEqual([
      { keywords: ["mobile", "phones"], path: "/mobile-phones/b/", confirmedAt: "2026-07-10T00:00:00.000Z" },
    ]);
  });
});

describe("matchingPathHints (M18 — Discovery Engine Step B)", () => {
  const hints = [
    { keywords: ["mobile", "phones"], path: "/mobile-phones/b/", confirmedAt: "2026-07-10T00:00:00.000Z" },
    { keywords: ["laptop", "deals"], path: "/laptops/b/", confirmedAt: "2026-07-09T00:00:00.000Z" },
  ];

  it("returns hints whose keywords overlap the current intent", () => {
    expect(matchingPathHints(hints, ["mobile", "phones", "cheap"])).toEqual([hints[0]]);
  });

  it("returns an empty array when nothing overlaps", () => {
    expect(matchingPathHints(hints, ["faculty", "email"])).toEqual([]);
  });

  it("returns an empty array for empty intent keywords", () => {
    expect(matchingPathHints(hints, [])).toEqual([]);
  });

  it("can match multiple hints at once", () => {
    expect(matchingPathHints(hints, ["mobile", "laptop"])).toEqual(hints);
  });
});
