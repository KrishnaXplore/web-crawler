import type { ReactNode } from "react";
import type { PageRow } from "../api/client";
import { PLUGIN_INFO } from "../pluginInfo";

/**
 * Per-page drill-down (M8 Step B). Clicking a result row opens the full record for
 * that page — every signal the crawl captured, plus the raw JSON. The difference
 * between a data table and a website-analysis tool.
 *
 * M19: each analyzer's output renders as a readable key-value list by default
 * (not raw JSON) — see renderValue below. "Raw JSON" stays available, collapsed,
 * as the power-user/debugging fallback; nothing is hidden, just not the default.
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
                <h4>{PLUGIN_INFO[name]?.label ?? name}</h4>
                <KeyValueBlock data={data} />
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

/** Renders a plugin's output as a key-value list instead of a JSON blob. */
function KeyValueBlock({ data }: { data: unknown }) {
  if (data === null || typeof data !== "object") {
    return <p className="muted">{String(data)}</p>;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return <p className="muted">(nothing found)</p>;
  return (
    <dl className="kv">
      {entries.map(([key, value]) => (
        <div key={key} className="kv-row">
          <dt>{key}</dt>
          <dd>{renderValue(value, 0)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Scalars render as text; a flat array of scalars joins with commas; one level of
 * nested plain object renders as an indented nested list; anything deeper than that
 * falls back to compact inline JSON for just that value, not the whole block.
 */
function renderValue(value: unknown, depth: number): ReactNode {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) {
      return value.length > 0 ? value.map(String).join(", ") : <span className="muted">—</span>;
    }
    return <code>{JSON.stringify(value)}</code>;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="muted">—</span>;
  if (depth >= 1) return <code>{JSON.stringify(value)}</code>;

  return (
    <dl className="kv kv-nested">
      {entries.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{renderValue(v, depth + 1)}</dd>
        </div>
      ))}
    </dl>
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
