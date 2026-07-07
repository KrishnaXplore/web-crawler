import { describe, it, expect, vi } from "vitest";
import { crawlUrl, type CrawlDeps } from "./crawlUrl.js";
import { parseRobots } from "./robots.js";
import type { FetchResult } from "./fetch.js";

function fetchResult(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    finalUrl: "http://a.com/",
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: {},
    body: "",
    truncated: false,
    ...overrides,
  };
}

const opts = { sameHostOnly: false, respectRobots: false };

describe("crawlUrl", () => {
  it("fetches an HTML page and returns metadata + links", async () => {
    const deps: CrawlDeps = {
      fetch: async () =>
        fetchResult({
          finalUrl: "http://a.com/",
          body: `<title>Home</title><a href="/x">x</a><a href="http://b.com/y">y</a>`,
        }),
    };
    const r = await crawlUrl("http://a.com/", deps, opts);
    expect(r.outcome).toBe("ok");
    expect(r.title).toBe("Home");
    expect(r.links).toEqual(["http://a.com/x", "http://b.com/y"]);
  });

  it("returns no links for non-HTML content", async () => {
    const deps: CrawlDeps = {
      fetch: async () =>
        fetchResult({ contentType: "application/pdf", body: "%PDF-1.7" }),
    };
    const r = await crawlUrl("http://a.com/file", deps, opts);
    expect(r.outcome).toBe("ok");
    expect(r.links).toEqual([]);
    expect(r.title).toBeNull();
  });

  it("reports an error outcome when fetch throws (without crashing)", async () => {
    const deps: CrawlDeps = {
      fetch: async () => {
        throw new Error("ETIMEDOUT");
      },
    };
    const r = await crawlUrl("http://a.com/", deps, opts);
    expect(r.outcome).toBe("error");
    expect(r.error).toBe("ETIMEDOUT");
    expect(r.status).toBeNull();
  });

  it("skips a robots-disallowed URL and never fetches it", async () => {
    const fetchSpy = vi.fn(async () => fetchResult());
    const deps: CrawlDeps = {
      fetch: fetchSpy,
      robotsFor: async () => parseRobots("User-agent: *\nDisallow: /private", "bot"),
    };
    const r = await crawlUrl("http://a.com/private/x", deps, {
      sameHostOnly: false,
      respectRobots: true,
    });
    expect(r.outcome).toBe("skipped-robots");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors sameHostOnly", async () => {
    const deps: CrawlDeps = {
      fetch: async () =>
        fetchResult({
          finalUrl: "http://a.com/",
          body: `<a href="http://a.com/keep">k</a><a href="http://b.com/drop">d</a>`,
        }),
    };
    const r = await crawlUrl("http://a.com/", deps, {
      sameHostOnly: true,
      respectRobots: false,
    });
    expect(r.links).toEqual(["http://a.com/keep"]);
  });
});
