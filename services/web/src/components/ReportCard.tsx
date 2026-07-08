import { useEffect, useState } from "react";
import { getReport, type HealthReport } from "../api/client";

/**
 * Website Health Report (M8 Step B) — the actionable headline for a finished crawl:
 * turns per-page telemetry into "what's wrong with this site". Fetched once the job
 * reaches a terminal state.
 */
export function ReportCard({ jobId, status }: { jobId: string; status: string }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const terminal = ["completed", "cancelled", "failed"].includes(status);

  useEffect(() => {
    if (!terminal) {
      setReport(null);
      return;
    }
    let stop = false;
    void getReport(jobId)
      .then((r) => !stop && setReport(r.report))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [jobId, terminal]);

  if (!terminal || report === null) return null;

  const ok = (b: boolean) => (b ? "ok" : "warn");
  const dur =
    report.crawlDurationMs === null
      ? "—"
      : `${(report.crawlDurationMs / 1000).toFixed(1)}s`;

  return (
    <div className="report">
      <h3>Website Health Report</h3>
      <div className="report-grid">
        <Metric label="Pages crawled" value={report.pagesCrawled} state="ok" />
        <Metric label="Broken pages" value={report.brokenPages} state={ok(report.brokenPages === 0)} />
        <Metric label="Crawl duration" value={dur} state="ok" />
        <Metric label="Avg links / page" value={report.avgLinksPerPage} state="ok" />
        <Metric label="Internal / external links" value={`${report.internalLinks} / ${report.externalLinks}`} state="ok" />
        <Metric
          label="Avg response"
          value={report.avgResponseTimeMs === null ? "—" : `${report.avgResponseTimeMs} ms`}
          state="ok"
        />
        <Metric label="Avg words / page" value={report.avgWordCount ?? "—"} state="ok" />
        <Metric label="Security score" value={report.securityScore ?? "—"} state="ok" />
        <Metric label="Technology" value={report.technology.join(", ") || "—"} state="ok" />
        <Metric label="Missing H1" value={`${report.pagesMissingH1} pages`} state={ok(report.pagesMissingH1 === 0)} />
        <Metric
          label="Missing meta desc"
          value={`${report.pagesMissingMetaDescription} pages`}
          state={ok(report.pagesMissingMetaDescription === 0)}
        />
        <Metric label="Images missing alt" value={report.imagesMissingAlt} state={ok(report.imagesMissingAlt === 0)} />
        <Metric
          label="Status (2xx/3xx/4xx/5xx)"
          value={`${report.statusBreakdown["2xx"]}/${report.statusBreakdown["3xx"]}/${report.statusBreakdown["4xx"]}/${report.statusBreakdown["5xx"]}`}
          state="ok"
        />
        <Metric label="Robots.txt" value={report.robotsRespected ? "Respected" : "Ignored"} state="ok" />
        {report.mostLinkedPage && (
          <Metric
            label="Most linked"
            value={`${short(report.mostLinkedPage.url)} (${report.mostLinkedPage.inLinks})`}
            state="ok"
          />
        )}
      </div>

      {report.exposure && <ExposurePanel exposure={report.exposure} />}
    </div>
  );
}

function ExposurePanel({
  exposure,
}: {
  exposure: NonNullable<HealthReport["exposure"]>;
}) {
  const leaks = exposure.unauthSensitiveUrls;
  const risky = exposure.maxRisk === "high" || exposure.maxRisk === "medium";
  return (
    <div className="report" style={{ marginTop: 12 }}>
      <h3>
        Exposure Report{" "}
        <span className={`badge ${risky ? "cancelled" : "completed"}`}>
          risk: {exposure.maxRisk}
        </span>
      </h3>
      <div className="report-grid">
        {Object.entries(exposure.categoryCounts).map(([cat, n]) => (
          <Metric key={cat} label={cat} value={`${n} pages`} state={ok(!risky)} />
        ))}
      </div>
      {leaks.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <strong className="error">
            ⚠ Sensitive data returned WITHOUT authentication ({leaks.length}):
          </strong>
          <ul>
            {leaks.slice(0, 20).map((u) => (
              <li key={u}>
                <code>{u}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  function ok(good: boolean) {
    return good ? "ok" : "warn";
  }
}

function Metric({ label, value, state }: { label: string; value: string | number; state: "ok" | "warn" }) {
  return (
    <div className={`metric ${state}`}>
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

function short(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.host : u.pathname;
  } catch {
    return url;
  }
}
