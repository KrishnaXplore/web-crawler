import { describe, it, expect } from "vitest";
import { looksLikeBotChallenge } from "./botChallenge.js";

describe("looksLikeBotChallenge (M20)", () => {
  it("flags the exact Akamai bm-verify shape observed against Amazon", () => {
    const html = `<html><head><meta http-equiv="refresh" content="5; URL='/?bm-verify=AAQ...'" />
      <title>&nbsp;</title></head><body><iframe src="https://x/y.gif"></iframe></body></html>`;
    expect(looksLikeBotChallenge(html, 0)).toBe(true);
  });

  it("does not flag a genuine large content page", () => {
    const html = `<html><body>${"<p>real content</p>".repeat(500)}</body></html>`;
    const linkCount = 50;
    expect(looksLikeBotChallenge(html, linkCount)).toBe(false);
  });

  it("does not flag a small page with no challenge marker (a genuinely tiny real page)", () => {
    const html = `<html><body><h1>Coming soon</h1></body></html>`;
    expect(looksLikeBotChallenge(html, 1)).toBe(false);
  });

  it("does not flag a page that merely mentions 'captcha' but has real content and links", () => {
    const html = `<html><body>${"<p>An article about how captcha systems work.</p>".repeat(300)}</body></html>`;
    expect(looksLikeBotChallenge(html, 40)).toBe(false);
  });

  it("flags a small page with many links but a challenge marker (link-count alone doesn't save it if size still small)", () => {
    // small body, marker present, but MAX_CHALLENGE_LINK_COUNT exceeded -> should NOT flag
    const manyLinks = Array.from({ length: 10 }, (_, i) => `<a href="/${i}">l</a>`).join("");
    const html = `<html><body>captcha check ${manyLinks}</body></html>`;
    expect(looksLikeBotChallenge(html, 10)).toBe(false);
  });
});
