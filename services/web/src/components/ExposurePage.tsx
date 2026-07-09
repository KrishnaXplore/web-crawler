import { useState } from "react";
import { createJob } from "../api/client";
import { JobView } from "./JobView";

/**
 * Dedicated Public Exposure Analyzer page (M10). Its own form tuned for an audit —
 * custom sensitive-data patterns, an optional authenticated-baseline session, and the
 * opt-in "reveal full matches" toggle — always running the `exposure` plugin. Live
 * results (incl. the Exposure panel) reuse JobView.
 */
export function ExposurePage() {
  const [seedUrl, setSeedUrl] = useState("https://quotes.toscrape.com/");
  const [maxDepth, setMaxDepth] = useState(1);
  const [maxPages, setMaxPages] = useState(25);
  const [respectRobots, setRespectRobots] = useState(true);
  const [patternsText, setPatternsText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [reveal, setReveal] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function parsePatterns(): string[] {
    return patternsText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // Each line "Header: value" → a header. Enables the authenticated baseline pass.
  function parseHeaders(): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const line of headersText.split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (name) out[name] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
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
        sameHostOnly: true,
        respectRobots,
        storeHtml: false,
        plugins: ["exposure"],
        exposurePatterns: parsePatterns(),
        requestHeaders: parseHeaders(),
        exposureReveal: reveal,
      });
      setJobId(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="panel">
        <form onSubmit={submit}>
          <h2>Public Exposure Audit</h2>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Finds data reachable <strong>without authentication</strong> on a site you
            own or are authorized to test. Passive: it never probes or fabricates URLs.
          </p>
          <label>
            Seed URL
            <input value={seedUrl} onChange={(e) => setSeedUrl(e.target.value)} />
          </label>
          <div className="row">
            <label>
              Max depth
              <input type="number" min={0} max={10} value={maxDepth}
                onChange={(e) => setMaxDepth(Number(e.target.value))} />
            </label>
            <label>
              Max pages
              <input type="number" min={1} max={1000} value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))} />
            </label>
          </div>
          <label>
            Sensitive-data patterns (one regex per line — e.g. a roll-number format)
            <textarea
              rows={3}
              value={patternsText}
              onChange={(e) => setPatternsText(e.target.value)}
              placeholder={"1MS\\d{2}[A-Z]{2}\\d{3}\n\\b\\d{10}\\b"}
            />
          </label>
          <label>
            Auth headers for the baseline pass (one per line, "Name: value")
            <textarea
              rows={2}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={"Cookie: session=…\nAuthorization: Bearer …"}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={respectRobots}
              onChange={(e) => setRespectRobots(e.target.checked)} />
            Respect robots.txt
          </label>
          <label className="check">
            <input type="checkbox" checked={reveal}
              onChange={(e) => setReveal(e.target.checked)} />
            Reveal full matches (default: redacted)
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "starting…" : "Run exposure audit"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </section>
      <section className="panel grow">
        <JobView jobId={jobId} />
      </section>
    </main>
  );
}
