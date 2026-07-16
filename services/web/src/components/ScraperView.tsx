import { useEffect, useState } from "react";
import {
  getJob,
  getPages,
  cancelJob,
  exportUrl,
  type JobStatus,
  type PageRow,
} from "../api/client";
import { extractedRecords } from "../extracted";
import { PageDetail } from "./PageDetail";

const TERMINAL = ["completed", "cancelled", "failed"];

/**
 * The Scraper page's results view (phase 21). Unlike the Console's JobView
 * (organized around crawl mechanics: depth/status/links), this renders a data
 * table shaped like the CSV export: columns are the extracted field names
 * discovered from the results themselves, rows are pages that produced data.
 */
export function ScraperView({ jobId }: { jobId: string | null }) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<PageRow | null>(null);
  const [preview, setPreview] = useState<string[][] | null>(null);

  async function openPreview() {
    try {
      const res = await fetch(exportUrl(jobId!, "csv"));
      if (!res.ok) throw new Error(`preview failed (${res.status})`);
      setPreview(parseCsv(await res.text()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "preview failed");
    }
  }

  useEffect(() => {
    if (jobId === null) return;
    setJob(null);
    setPages([]);
    setError(null);
    setShowAll(false);
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
    return (
      <p className="muted">
        Start a scrape to see the extracted data here as a table.
      </p>
    );
  }
  if (error) return <p className="error">{error}</p>;
  if (job === null) return <p className="muted">loading…</p>;

  // One table row per extracted record (M22) — a listing page with 20 items
  // contributes 20 rows, a detail page one row.
  const dataRows = pages.flatMap((page) =>
    extractedRecords(page.analysis).map((fields, recordIndex) => ({
      page,
      fields,
      recordIndex,
    })),
  );
  const otherRows = pages.filter((p) => extractedRecords(p.analysis).length === 0);

  // Union of field names across all records — same column-discovery logic as
  // the CSV export. Only `url` is reserved (the fixed source-page column); an
  // extracted `title` is a real data column, since on a listing page every
  // record has its own title and the page's <title> is the wrong value for
  // all of them.
  const columnSet = new Set<string>();
  for (const r of dataRows) {
    for (const key of Object.keys(r.fields)) {
      if (key.toLowerCase() !== "url") columnSet.add(key);
    }
  }
  const columns = [...columnSet];
  const done = TERMINAL.includes(job.status);

  return (
    <div>
      <h2>
        Scrape <code>{job.jobId.slice(0, 8)}</code>{" "}
        <span className={`badge ${job.status}`}>{job.status}</span>
        {!done && (
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
        <Stat label="site" value={job.seedUrl} />
        <Stat
          label="pages scanned"
          value={`${job.pagesPersisted} / ${job.maxPages}`}
        />
        <Stat label="rows with data" value={String(dataRows.length)} />
        {!done && <Stat label="queued" value={String(job.pending)} />}
      </div>

      <div className="exports">
        <button className="preview-btn" type="button" onClick={() => void openPreview()}>
          👁 Preview CSV
        </button>
        <a className="download" href={exportUrl(job.jobId, "csv")}>
          ⬇ Download CSV
        </a>
        <a href={exportUrl(job.jobId, "json")}>JSON</a>
      </div>

      {dataRows.length === 0 && done && (
        <div className="empty-note">
          <p>The crawl finished, but no data could be extracted.</p>
          <p className="muted">
            Common reasons: the site's robots.txt disallows crawling, the site
            served a bot-verification page, or the pages don't contain data we
            recognize. Try the Console page to inspect what each page returned.
          </p>
        </div>
      )}
      {dataRows.length === 0 && !done && pages.length > 0 && (
        <p className="muted">Scanning pages — no extracted data yet…</p>
      )}

      {dataRows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>page</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataRows.map(({ page, fields, recordIndex }) => (
                <tr
                  key={`${page.url}#${recordIndex}`}
                  className="clickable"
                  onClick={() => setSelected(page)}
                >
                  <td className="title" title={page.url}>
                    {page.title ?? page.url}
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="cell" title={cellText(fields[c]) ?? ""}>
                      {cellText(fields[c]) ?? <span className="muted">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {otherRows.length > 0 && (
        <div className="toggle-row">
          <label className="check">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            <span className="muted">
              Show {otherRows.length} crawled page
              {otherRows.length === 1 ? "" : "s"} without extracted data
            </span>
          </label>
          {showAll && (
            <table>
              <thead>
                <tr>
                  <th>status</th>
                  <th>page</th>
                </tr>
              </thead>
              <tbody>
                {otherRows.map((page) => (
                  <tr
                    key={page.url}
                    className="clickable"
                    onClick={() => setSelected(page)}
                  >
                    <td>{page.status ?? "-"}</td>
                    <td className="title" title={page.url}>
                      {page.title ?? page.url}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {selected && (
        <PageDetail page={selected} onClose={() => setSelected(null)} />
      )}
      {preview && (
        <CsvPreview
          rows={preview}
          downloadHref={exportUrl(job.jobId, "csv")}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/**
 * Exact preview of the CSV download (phase 21) — fetched from the same export
 * endpoint the download link points at, so what the user checks here is
 * byte-for-byte what lands in the file. The on-screen results table above is a
 * live view with truncated cells; this is the file itself.
 */
function CsvPreview({
  rows,
  downloadHref,
  onClose,
}: {
  rows: string[][];
  downloadHref: string;
  onClose: () => void;
}) {
  const [header, ...body] = rows;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          ×
        </button>
        <h3>CSV preview</h3>
        <p className="muted">
          {body.length} row{body.length === 1 ? "" : "s"} — exactly what the
          file will contain.
        </p>
        <div className="table-scroll csv-preview">
          <table className="data-table">
            <thead>
              <tr>
                {(header ?? []).map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j} className="cell" title={cell}>
                      {cell === "" ? <span className="muted">—</span> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="exports" style={{ marginTop: 14 }}>
          <a className="download" href={downloadHref}>
            ⬇ Download CSV
          </a>
        </div>
      </div>
    </div>
  );
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, newlines in cells). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** One extracted value as short cell text (objects/arrays collapse to JSON). */
function cellText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
