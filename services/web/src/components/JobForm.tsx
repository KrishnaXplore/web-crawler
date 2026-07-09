import { useState } from "react";
import { createJob, AVAILABLE_PLUGINS } from "../api/client";

export function JobForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [seedUrl, setSeedUrl] = useState("https://www.iana.org");
  const [maxDepth, setMaxDepth] = useState(1);
  const [maxPages, setMaxPages] = useState(10);
  const [sameHostOnly, setSameHostOnly] = useState(true);
  const [respectRobots, setRespectRobots] = useState(true);
  const [storeHtml, setStoreHtml] = useState(false);
  const [plugins, setPlugins] = useState<string[]>(["seo", "tech", "security"]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [renderMode, setRenderMode] = useState<"auto" | "http" | "browser">("auto");
  const [intent, setIntent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function togglePlugin(name: string) {
    setPlugins((cur) =>
      cur.includes(name) ? cur.filter((p) => p !== name) : [...cur, name],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { jobId } = await createJob({
        seedUrl,
        maxDepth,
        maxPages,
        sameHostOnly,
        respectRobots,
        storeHtml,
        plugins,
        webhookUrl: webhookUrl.trim() || undefined,
        renderMode,
        intent: intent.trim() || undefined,
      });
      onCreated(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>New crawl</h2>
      <label>
        Seed URL
        <input value={seedUrl} onChange={(e) => setSeedUrl(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Max depth
          <input
            type="number"
            min={0}
            max={10}
            value={maxDepth}
            onChange={(e) => setMaxDepth(Number(e.target.value))}
          />
        </label>
        <label>
          Max pages
          <input
            type="number"
            min={1}
            max={1000}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={sameHostOnly}
          onChange={(e) => setSameHostOnly(e.target.checked)}
        />
        Same host only
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={respectRobots}
          onChange={(e) => setRespectRobots(e.target.checked)}
        />
        Respect robots.txt
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={storeHtml}
          onChange={(e) => setStoreHtml(e.target.checked)}
        />
        Store raw HTML
      </label>
      <label>
        Webhook URL (optional — POSTed on completion)
        <input
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://example.com/hook"
        />
      </label>
      <label>
        Render Mode
        <select value={renderMode} onChange={(e) => setRenderMode(e.target.value as any)}>
          <option value="auto">Auto (Intelligence Layer)</option>
          <option value="http">HTTP (Fast)</option>
          <option value="browser">Browser (JS/SPA)</option>
        </select>
      </label>
      <label>
        Intent (M13 - natural language extraction target)
        <input
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="e.g., extract the product price and name"
        />
      </label>
      <fieldset>
        <legend>Analyzer plugins</legend>
        {AVAILABLE_PLUGINS.map((name) => (
          <label className="check" key={name}>
            <input
              type="checkbox"
              checked={plugins.includes(name)}
              onChange={() => togglePlugin(name)}
            />
            {name}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={busy}>
        {busy ? "submitting…" : "Start crawl"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
