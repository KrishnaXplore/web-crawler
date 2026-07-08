import type { AnalyzerPlugin, AnalyzerInput } from "./types.js";

/**
 * Public Exposure Analyzer (M10 — docs/phase10.md). A PASSIVE auditor: it inspects
 * only content the crawl already fetched or saw linked, and flags resources/data that
 * are reachable. It never probes, fabricates URLs, brute-forces, or bypasses auth.
 *
 * The load-bearing signal is the `authenticated` flag: sensitive data on a response
 * the job fetched WITHOUT auth is escalated to `high` — that's the actual leak (the
 * UI gates it but the server doesn't). Behind-auth sensitive data is expected (`info`).
 *
 * Findings store a redacted sample + count, never the raw values — detect & confirm,
 * don't dump.
 */

export type Severity = "info" | "low" | "medium" | "high";
const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

export interface ExposureFinding {
  readonly severity: Severity;
  readonly count: number;
  /** One redacted example, so the operator can locate it without storing PII. */
  readonly sample?: string;
}

export interface ExposureResult {
  readonly authenticated: boolean;
  readonly riskScore: Severity | "none";
  readonly findings: Record<string, ExposureFinding>;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Loose phone matcher: 10+ digits allowing spaces/dashes/(). Avoids matching years/ids.
const PHONE_RE = /(?:\+?\d[\s\-().]?){10,15}/g;
const DOC_EXT = /\.(pdf|docx?|xlsx?|csv|pptx?)($|\?)/i;
const BACKUP_EXT = /\.(zip|tar|tar\.gz|tgz|gz|bak|old|sql|dump)($|\?)/i;
const API_DOC_RE = /\/(swagger|openapi(\.json)?|api-docs|redoc)(\/|$|\?)/i;
// Client-side config already shipped to every visitor — report presence only.
const CLIENT_CONFIG = [
  { key: "firebaseConfig", re: /firebase(?:Config|io\.com)|apiKey["']?\s*[:=]\s*["']AIza/ },
  { key: "stripePublishableKey", re: /pk_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { key: "googleMapsKey", re: /AIza[0-9A-Za-z_\-]{20,}/ },
];

/** Mask a matched value: keep a hint, hide the rest. Never store the raw value. */
function redact(value: string): string {
  const at = value.indexOf("@");
  if (at > 0) {
    return `${value[0]}${"•".repeat(3)}@${"•".repeat(4)}`; // email
  }
  const head = value.replace(/[\s\-().]/g, "").slice(0, 2);
  return `${head}${"•".repeat(6)}`;
}

function collectHrefs($: AnalyzerInput["$"]): string[] {
  return $("a[href]")
    .map((_, el) => $(el).attr("href") ?? "")
    .get()
    .filter((h) => h.length > 0);
}

export const exposurePlugin: AnalyzerPlugin = {
  name: "exposure",
  analyze({ $, body, headers, authenticated, options }) {
    const findings: Record<string, ExposureFinding> = {};

    // Only scan bodies that are actually textual (skip binary/JSON-as-attachment noise
    // is out of scope — crawler only stores text bodies anyway).
    const isHtmlish = (headers["content-type"] ?? "").includes("text") ||
      (headers["content-type"] ?? "").includes("json") ||
      headers["content-type"] === undefined;

    // 1. Sensitive data (PII-shaped) in the response body.
    if (isHtmlish) {
      const emails = body.match(EMAIL_RE) ?? [];
      const phones = body.match(PHONE_RE) ?? [];
      const custom: string[] = [];
      const patterns = extractPatterns(options);
      for (const src of patterns) {
        try {
          const re = new RegExp(src, "g");
          custom.push(...(body.match(re) ?? []));
        } catch {
          /* ignore an invalid operator-supplied regex */
        }
      }
      const total = emails.length + phones.length + custom.length;
      if (total > 0) {
        const first = emails[0] ?? phones[0] ?? custom[0]!;
        findings.sensitiveData = {
          // The finding: sensitive data with NO auth on the request is high risk.
          severity: authenticated ? "info" : "high",
          count: total,
          sample: redact(first),
        };
      }
    }

    // 2. Linked documents / 3. backup archives / 4. API docs — from crawled links only.
    const hrefs = collectHrefs($);
    const docs = hrefs.filter((h) => DOC_EXT.test(h));
    const backups = hrefs.filter((h) => BACKUP_EXT.test(h));
    const apiDocs = hrefs.filter((h) => API_DOC_RE.test(h));
    if (docs.length > 0)
      findings.documents = { severity: "medium", count: docs.length, sample: docs[0] };
    if (backups.length > 0)
      findings.backupFiles = { severity: "high", count: backups.length, sample: backups[0] };
    if (apiDocs.length > 0)
      findings.apiDocs = { severity: "low", count: apiDocs.length, sample: apiDocs[0] };

    // 5. Client-side config already delivered to every visitor — presence only.
    const clientKeys = CLIENT_CONFIG.filter((c) => c.re.test(body)).map((c) => c.key);
    if (clientKeys.length > 0)
      findings.clientConfig = {
        severity: "info",
        count: clientKeys.length,
        sample: clientKeys.join(", "),
      };

    // Overall risk = highest-severity finding (none if clean).
    let riskScore: Severity | "none" = "none";
    for (const f of Object.values(findings)) {
      if (riskScore === "none" || RANK[f.severity] > RANK[riskScore]) riskScore = f.severity;
    }

    return { authenticated, riskScore, findings };
  },
};

/** Pull operator sensitive-data regexes from the per-plugin options blob. */
function extractPatterns(options: AnalyzerInput["options"]): string[] {
  const exposure = (options?.exposure ?? {}) as { patterns?: unknown };
  return Array.isArray(exposure.patterns)
    ? exposure.patterns.filter((p): p is string => typeof p === "string")
    : [];
}
