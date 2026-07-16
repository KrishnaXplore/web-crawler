import { useState } from "react";
import { createJob, AVAILABLE_PLUGINS } from "../api/client";
import { PLUGIN_INFO } from "../pluginInfo";

interface JobFormProps {
  onCreated: (id: string) => void;
  /** Panel heading + submit label — the Scraper and Console pages differ. */
  heading?: string;
  submitLabel?: string;
  /** Which analyzers start ticked (checkboxes stay user-editable either way). */
  defaultPlugins?: string[];
}

export function JobForm({
  onCreated,
  heading = "New crawl",
  submitLabel = "Start crawl",
  defaultPlugins = ["seo", "tech", "security"],
}: JobFormProps) {
  const [seedUrl, setSeedUrl] = useState("https://www.iana.org");
  const [maxDepth, setMaxDepth] = useState(1);
  const [maxPages, setMaxPages] = useState(10);
  const [sameHostOnly, setSameHostOnly] = useState(true);
  const [respectRobots, setRespectRobots] = useState(true);
  const [storeHtml, setStoreHtml] = useState(false);
  const [plugins, setPlugins] = useState<string[]>(defaultPlugins);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [renderMode, setRenderMode] = useState<"auto" | "http" | "browser">("auto");
  const [intent, setIntent] = useState("");
  const [focusedCrawl, setFocusedCrawl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function togglePlugin(name: string) {
    setPlugins((cur) =>
      cur.includes(name) ? cur.filter((p) => p !== name) : [...cur, name],
    );
  }

  // Typing an extraction request only works if the "rules" analyzer also runs
  // (that's the tier that reads `intent` and acts on it) — nobody describing
  // what they want in plain English should have to know that. Auto-enable it;
  // never auto-disable, in case someone also wants it on for other reasons.
  function updateIntent(value: string) {
    setIntent(value);
    if (value.trim() !== "") {
      setPlugins((cur) => (cur.includes("rules") ? cur : [...cur, "rules"]));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // People type "www.site.com", not "https://www.site.com" — don't make
      // that a validation error when the intent is unambiguous.
      const url = /^https?:\/\//i.test(seedUrl.trim())
        ? seedUrl.trim()
        : `https://${seedUrl.trim()}`;
      const { jobId } = await createJob({
        seedUrl: url,
        maxDepth,
        maxPages,
        sameHostOnly,
        respectRobots,
        storeHtml,
        plugins,
        webhookUrl: webhookUrl.trim() || undefined,
        renderMode,
        intent: intent.trim() || undefined,
        focusedCrawl: focusedCrawl && intent.trim() !== "" ? true : undefined,
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
      <h2>{heading}</h2>
      <label>
        Seed URL
        <input value={seedUrl} onChange={(e) => setSeedUrl(e.target.value)} />
      </label>
      <label>
        What do you want to extract? (optional)
        <input
          value={intent}
          onChange={(e) => updateIntent(e.target.value)}
          placeholder="e.g., the product's name and price"
        />
        <span className="muted hint">
          Describe it in plain English — no need to know CSS or HTML. We'll figure out
          how to get it from the page.
        </span>
      </label>
      {intent.trim() !== "" && (
        <label className="check">
          <input
            type="checkbox"
            checked={focusedCrawl}
            onChange={(e) => setFocusedCrawl(e.target.checked)}
          />
          Focused crawl — head straight for the matching pages, stop when found
        </label>
      )}
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
          <option value="auto">Auto (recommended — picks the right mode per site)</option>
          <option value="http">Fast (plain page fetch)</option>
          <option value="browser">Stealth Browser (Bypasses Anti-Bot & Renders JavaScript)</option>
        </select>
      </label>
      <fieldset>
        <legend>What to check</legend>
        {AVAILABLE_PLUGINS.map((name) => {
          const info = PLUGIN_INFO[name];
          return (
            <label className="check plugin-check" key={name}>
              <input
                type="checkbox"
                checked={plugins.includes(name)}
                onChange={() => togglePlugin(name)}
              />
              <span>
                {info?.label ?? name}
                {info && <span className="muted"> — {info.description}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <button type="submit" disabled={busy}>
        {busy ? "submitting…" : submitLabel}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
