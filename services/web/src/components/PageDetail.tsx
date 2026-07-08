import type { PageRow } from "../api/client";

/**
 * Per-page drill-down (M8 Step B). Clicking a result row opens the full record for
 * that page — every signal the crawl captured, plus the raw JSON. The difference
 * between a data table and a website-analysis tool.
 */
export function PageDetail({ page, onClose }: { page: PageRow; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="close">
          ×
        </button>
        <h3>{page.title ?? "(untitled)"}</h3>
        <a className="modal-url" href={page.url} target="_blank" rel="noreferrer">
          {page.url}
        </a>

        <div className="detail-stats">
          <Stat label="status" value={page.status ?? "—"} />
          <Stat label="depth" value={page.depth} />
          <Stat label="outgoing links" value={page.discoveredLinks} />
        </div>

        {page.analysis && (
          <div className="detail-analysis">
            {Object.entries(page.analysis).map(([name, data]) => (
              <div key={name} className="analysis-block">
                <h4>{name}</h4>
                <pre>{JSON.stringify(data, null, 2)}</pre>
              </div>
            ))}
          </div>
        )}

        <details className="detail-raw">
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify(page, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
