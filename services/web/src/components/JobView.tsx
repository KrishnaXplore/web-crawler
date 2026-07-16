import { useEffect, useState } from "react";
import {
  getJob,
  getPages,
  cancelJob,
  exportUrl,
  type JobStatus,
  type PageRow,
} from "../api/client";
import { ReportCard } from "./ReportCard";
import { PageDetail } from "./PageDetail";
import { extractedRecords } from "../extracted";

const TERMINAL = ["completed", "cancelled", "failed"];

export function JobView({ jobId }: { jobId: string | null }) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PageRow | null>(null);

  useEffect(() => {
    if (jobId === null) return;
    setJob(null);
    setPages([]);
    setError(null);
    let stop = false;

    async function tick() {
      try {
        const j = await getJob(jobId!);
        if (stop) return;
        setJob(j);
        if (j.pagesPersisted > 0) {
          const { pages: p } = await getPages(jobId!);
          if (!stop) setPages(p);
        }
        if (!TERMINAL.includes(j.status) && !stop) {
          setTimeout(tick, 1500);
        }
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "failed");
      }
    }
    void tick();
    return () => {
      stop = true;
    };
  }, [jobId]);

  if (jobId === null) {
    return <p className="muted">Submit a crawl to see live progress here.</p>;
  }
  if (error) return <p className="error">{error}</p>;
  if (job === null) return <p className="muted">loading…</p>;

  return (
    <div>
      <h2>
        Job <code>{job.jobId.slice(0, 8)}</code>{" "}
        <span className={`badge ${job.status}`}>{job.status}</span>
        {!TERMINAL.includes(job.status) && (
          <button
            className="cancel"
            onClick={() => {
              void cancelJob(job.jobId).catch((err: unknown) =>
                setError(err instanceof Error ? err.message : "cancel failed"),
              );
            }}
          >
            Cancel
          </button>
        )}
      </h2>
      <div className="stats">
        <Stat label="seed" value={job.seedUrl} />
        <Stat label="pages" value={`${job.pagesPersisted} / ${job.maxPages}`} />
        <Stat label="pending" value={String(job.pending)} />
        <Stat label="depth" value={String(job.maxDepth)} />
      </div>
      <ReportCard jobId={job.jobId} status={job.status} />
      <div className="exports">
        <a href={exportUrl(job.jobId, "json")}>export JSON</a>
        <a href={exportUrl(job.jobId, "csv")}>export CSV</a>
      </div>
      <table>
        <thead>
          <tr>
            <th>d</th>
            <th>status</th>
            <th>title</th>
            <th>links</th>
            <th>analysis</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url} className="clickable" onClick={() => setSelected(p)}>
              <td>{p.depth}</td>
              <td>{p.status ?? "-"}</td>
              <td className="title" title={p.url}>
                {p.title ?? p.url}
              </td>
              <td>{p.discoveredLinks}</td>
              <td className="analysis">
                {p.analysis ? <Analysis a={p.analysis} /> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <PageDetail page={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function Analysis({ a }: { a: Record<string, unknown> }) {
  const extracted = extractedPreview(a);

  const parts: string[] = [];
  const seo = a.seo as { h1Count?: number } | undefined;
  const tech = a.tech as { detected?: string[] } | undefined;
  const sec = a.security as { score?: string } | undefined;
  const meta = a.metadata as
    | { robots?: { noindex?: boolean }; isCanonical?: boolean | null }
    | undefined;
  if (seo?.h1Count !== undefined) parts.push(`h1:${seo.h1Count}`);
  if (tech?.detected?.length) parts.push(tech.detected.join(","));
  if (sec?.score) parts.push(`sec:${sec.score}`);
  if (meta?.robots?.noindex) parts.push("noindex");
  if (meta?.isCanonical === false) parts.push("non-canonical");
  const rest = parts.join(" · ");

  if (!extracted && !rest) return <span className="muted">—</span>;
  return (
    <span>
      {extracted && <span className="extraction-hit">{extracted}</span>}
      {extracted && rest ? " · " : null}
      {rest}
    </span>
  );
}

/**
 * A short preview of extracted data, shown directly in the results row so it's
 * visible without clicking into every page. Before this, the row summary only
 * ever showed SEO/tech/security signals — extraction results were invisible
 * from the table, even when extraction was working correctly (only visible by
 * clicking in).
 */
function extractedPreview(a: Record<string, unknown>): string | null {
  const records = extractedRecords(a);
  if (records.length === 0) return null;
  const fields = records[0];
  const suffix = records.length > 1 ? ` (+${records.length - 1} more)` : "";

  const entries = Object.entries(fields).filter(
    ([, v]) => typeof v === "string" || typeof v === "number",
  );
  if (entries.length === 0) return null;

  const preview = entries
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 30)}`)
    .join(", ");
  return `✓ ${preview}${entries.length > 2 ? "…" : ""}${suffix}`;
}
