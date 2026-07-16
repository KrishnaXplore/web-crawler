import { useEffect, useState } from "react";
import { JobForm } from "./components/JobForm";
import { JobView } from "./components/JobView";
import { ScraperView } from "./components/ScraperView";
import { ExposurePage } from "./components/ExposurePage";

// Two pages (phase 21): Scraper (default) for getting data out as a
// spreadsheet, Console for everything technical (crawl mechanics + exposure
// audit). Hash-based so the current page survives refresh — no router dep.
type Page = "scrape" | "console";

function pageFromHash(): Page {
  return window.location.hash.startsWith("#/console") ? "console" : "scrape";
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [scrapeJobId, setScrapeJobId] = useState<string | null>(null);
  const [consoleJobId, setConsoleJobId] = useState<string | null>(null);
  const [consoleTab, setConsoleTab] = useState<"crawl" | "exposure">("crawl");

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="app">
      <header>
        <h1>🕷️ Web Scraper</h1>
        <span className="subtitle">turn any website into a spreadsheet</span>
        <nav className="nav">
          <button
            className={`navbtn ${page === "scrape" ? "active" : ""}`}
            onClick={() => (window.location.hash = "#/scrape")}
          >
            Scraper
          </button>
          <button
            className={`navbtn ${page === "console" ? "active" : ""}`}
            onClick={() => (window.location.hash = "#/console")}
          >
            Console
          </button>
        </nav>
      </header>

      {page === "scrape" ? (
        <main>
          <section className="panel">
            <JobForm
              heading="New scrape"
              submitLabel="Start scraping"
              defaultPlugins={["structured", "rules", "discovery"]}
              onCreated={setScrapeJobId}
            />
          </section>
          <section className="panel grow">
            <ScraperView jobId={scrapeJobId} />
          </section>
        </main>
      ) : (
        <>
          <nav className="subnav">
            <button
              className={`navbtn ${consoleTab === "crawl" ? "active" : ""}`}
              onClick={() => setConsoleTab("crawl")}
            >
              Crawl
            </button>
            <button
              className={`navbtn ${consoleTab === "exposure" ? "active" : ""}`}
              onClick={() => setConsoleTab("exposure")}
            >
              🔓 Exposure Audit
            </button>
          </nav>
          {consoleTab === "crawl" ? (
            <main>
              <section className="panel">
                <JobForm onCreated={setConsoleJobId} />
              </section>
              <section className="panel grow">
                <JobView jobId={consoleJobId} />
              </section>
            </main>
          ) : (
            <ExposurePage />
          )}
        </>
      )}
    </div>
  );
}
