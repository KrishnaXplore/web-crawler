import { describe, it, expect } from "vitest";
import { deriveProfile } from "./intelligence.js";

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

  it("fills sane defaults for a sparse doc", () => {
    const p = deriveProfile({ _id: "new.example" });
    expect(p.pagesObserved).toBe(0);
    expect(p.techStack).toEqual([]);
    expect(p.renderModesSeen).toEqual([]);
    expect(p.needsRender).toBe(false);
    expect(p.lastStatusOk).toBe(true);
  });
});
