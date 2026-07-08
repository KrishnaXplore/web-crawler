import { describe, it, expect } from "vitest";
import { reduceReport, type ReportPage, type ReportMeta } from "./report.js";

const meta: ReportMeta = { crawlDurationMs: 2400, robotsRespected: true };

function page(p: Partial<ReportPage>): ReportPage {
  return {
    status: 200,
    discoveredLinks: 0,
    parentUrl: null,
    ...p,
  };
}

describe("reduceReport (M8 Step A)", () => {
  it("summarizes a healthy multi-page crawl", () => {
    const pages = [
      page({ status: 200, discoveredLinks: 8, h1Count: 1, hasMetaDescription: true,
             techDetected: ["jQuery"], securityScore: "3/5" }),
      page({ status: 200, discoveredLinks: 4, parentUrl: "https://site/", h1Count: 1,
             hasMetaDescription: true, techDetected: ["jQuery"], securityScore: "3/5" }),
      page({ status: 200, discoveredLinks: 6, parentUrl: "https://site/", h1Count: 0,
             hasMetaDescription: false, techDetected: ["jQuery"], securityScore: "3/5" }),
    ];
    const r = reduceReport(pages, meta);
    expect(r.pagesCrawled).toBe(3);
    expect(r.statusBreakdown["2xx"]).toBe(3);
    expect(r.brokenPages).toBe(0);
    expect(r.totalDiscoveredLinks).toBe(18);
    expect(r.avgLinksPerPage).toBe(6);
    expect(r.pagesMissingH1).toBe(1);
    expect(r.pagesMissingMetaDescription).toBe(1);
    expect(r.technology).toEqual(["jQuery"]);
    expect(r.securityScore).toBe("3/5");
    expect(r.mostLinkedPage).toEqual({ url: "https://site/", inLinks: 2 });
    expect(r.crawlDurationMs).toBe(2400);
    expect(r.robotsRespected).toBe(true);
  });

  it("classifies status codes and counts broken pages", () => {
    const r = reduceReport(
      [
        page({ status: 200 }),
        page({ status: 301 }),
        page({ status: 404 }),
        page({ status: 500 }),
        page({ status: null }),
      ],
      meta,
    );
    expect(r.statusBreakdown).toEqual({ "2xx": 1, "3xx": 1, "4xx": 1, "5xx": 1, other: 1 });
    expect(r.brokenPages).toBe(2);
  });

  it("picks the modal security score and most frequent tech", () => {
    const r = reduceReport(
      [
        page({ securityScore: "1/5", techDetected: ["React", "jQuery"] }),
        page({ securityScore: "3/5", techDetected: ["React"] }),
        page({ securityScore: "3/5", techDetected: ["React"] }),
      ],
      meta,
    );
    expect(r.securityScore).toBe("3/5");
    expect(r.technology[0]).toBe("React"); // seen 3× vs jQuery 1×
  });

  it("aggregates link scope, response time, and word count (Step C signals)", () => {
    const r = reduceReport(
      [
        page({ internalLinks: 6, externalLinks: 2, responseTimeMs: 100, wordCount: 300 }),
        page({ internalLinks: 4, externalLinks: 0, responseTimeMs: 200, wordCount: 500 }),
      ],
      meta,
    );
    expect(r.internalLinks).toBe(10);
    expect(r.externalLinks).toBe(2);
    expect(r.avgResponseTimeMs).toBe(150);
    expect(r.avgWordCount).toBe(400);
  });

  it("leaves response time / word count null when unmeasured", () => {
    const r = reduceReport([page({}), page({})], meta);
    expect(r.avgResponseTimeMs).toBeNull();
    expect(r.avgWordCount).toBeNull();
    expect(r.internalLinks).toBe(0);
  });

  it("sums images missing alt across pages", () => {
    const r = reduceReport(
      [page({ imagesMissingAlt: 2 }), page({ imagesMissingAlt: 5 }), page({})],
      meta,
    );
    expect(r.imagesMissingAlt).toBe(7);
  });

  it("is graceful on an empty crawl", () => {
    const r = reduceReport([], meta);
    expect(r.pagesCrawled).toBe(0);
    expect(r.avgLinksPerPage).toBe(0);
    expect(r.mostLinkedPage).toBeNull();
    expect(r.securityScore).toBeNull();
    expect(r.technology).toEqual([]);
  });

  it("handles pages with no analysis block (plugins disabled)", () => {
    const r = reduceReport([page({ discoveredLinks: 3 }), page({ discoveredLinks: 5 })], meta);
    expect(r.pagesMissingH1).toBe(0); // undefined h1Count is not "missing"
    expect(r.pagesMissingMetaDescription).toBe(0);
    expect(r.securityScore).toBeNull();
    expect(r.totalDiscoveredLinks).toBe(8);
  });
});
