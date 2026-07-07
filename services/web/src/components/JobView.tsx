import { useEffect, useState } from "react";
import {
  getJob,
  getPages,
  cancelJob,
  exportUrl,
  type JobStatus,
  type PageRow,
} from "../api/client";

const TERMINAL = ["completed", "cancelled", "failed"];

export function JobView({ jobId }: { jobId: string | null }) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [error, setError] = useState<string | null>(null);

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
            <tr key={p.url}>
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
  const parts: string[] = [];
  const seo = a.seo as { h1Count?: number } | undefined;
  const tech = a.tech as { detected?: string[] } | undefined;
  const sec = a.security as { score?: string } | undefined;
  if (seo?.h1Count !== undefined) parts.push(`h1:${seo.h1Count}`);
  if (tech?.detected?.length) parts.push(tech.detected.join(","));
  if (sec?.score) parts.push(`sec:${sec.score}`);
  return <span>{parts.join(" · ") || "—"}</span>;
}
