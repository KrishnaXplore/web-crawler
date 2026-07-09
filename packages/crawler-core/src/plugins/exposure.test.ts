import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { exposurePlugin, type ExposureResult } from "./exposure.js";

function analyze(
  html: string,
  opts: {
    authenticated?: boolean;
    patterns?: string[];
    contentType?: string;
    reveal?: boolean;
  } = {},
): ExposureResult {
  return exposurePlugin.analyze({
    url: "https://portal.college.edu/results",
    $: cheerio.load(html),
    body: html,
    headers: { "content-type": opts.contentType ?? "text/html" },
    status: 200,
    authenticated: opts.authenticated ?? false,
    options: { exposure: { patterns: opts.patterns ?? [], reveal: opts.reveal } },
  }) as ExposureResult;
}

describe("exposure plugin (M10)", () => {
  it("escalates sensitive data to HIGH when the response was unauthenticated", () => {
    const r = analyze("<p>contact bob@college.edu for results</p>", { authenticated: false });
    expect(r.findings.sensitiveData.severity).toBe("high");
    expect(r.findings.sensitiveData.count).toBe(1);
    expect(r.riskScore).toBe("high");
  });

  it("treats the same data behind auth as expected (info, not a finding)", () => {
    const r = analyze("<p>contact bob@college.edu</p>", { authenticated: true });
    expect(r.findings.sensitiveData.severity).toBe("info");
    expect(r.riskScore).toBe("info");
  });

  it("redacts the sample — never stores the raw value", () => {
    const r = analyze("<p>bob@college.edu</p>", { authenticated: false });
    const s = r.findings.sensitiveData.sample!;
    expect(s).not.toContain("bob@college.edu");
    expect(s).toContain("•");
  });

  it("stores the FULL value when reveal is opted in (default stays redacted)", () => {
    const redacted = analyze("<p>bob@college.edu</p>", { reveal: false });
    expect(redacted.findings.sensitiveData.sample).not.toContain("bob@college.edu");

    const revealed = analyze("<p>bob@college.edu</p>", { reveal: true });
    expect(revealed.findings.sensitiveData.sample).toBe("bob@college.edu");
  });

  it("matches an operator-supplied roll-number pattern", () => {
    const r = analyze("<td>1MS21CS045</td><td>1MS21CS046</td>", {
      authenticated: false,
      patterns: ["1MS\\d{2}[A-Z]{2}\\d{3}"],
    });
    expect(r.findings.sensitiveData.count).toBe(2);
  });

  it("flags linked backup archives as high and documents as medium", () => {
    const r = analyze(
      `<a href="/files/db-backup.sql">db</a><a href="/docs/fees.pdf">fees</a>`,
    );
    expect(r.findings.backupFiles.severity).toBe("high");
    expect(r.findings.documents.severity).toBe("medium");
  });

  it("detects API docs links (low)", () => {
    const r = analyze(`<a href="/swagger/index.html">api</a>`, { authenticated: true });
    expect(r.findings.apiDocs.severity).toBe("low");
  });

  it("reports client-side config presence without storing values", () => {
    const r = analyze(
      `<script>const k="pk_live_abcdef1234567890";</script>`,
      { authenticated: true },
    );
    expect(r.findings.clientConfig.sample).toContain("stripePublishableKey");
  });

  it("is clean (riskScore none) on a benign page", () => {
    const r = analyze("<h1>Welcome</h1><p>No data here.</p>", { authenticated: false });
    expect(r.riskScore).toBe("none");
    expect(Object.keys(r.findings)).toHaveLength(0);
  });

  it("ignores an invalid operator regex without throwing", () => {
    const r = analyze("<p>x</p>", { authenticated: false, patterns: ["([unclosed"] });
    expect(r.riskScore).toBe("none");
  });
});
