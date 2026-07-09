import { useState } from "react";
import { JobForm } from "./components/JobForm";
import { JobView } from "./components/JobView";
import { ExposurePage } from "./components/ExposurePage";

type View = "crawler" | "exposure";

export function App() {
  const [view, setView] = useState<View>("crawler");
  const [jobId, setJobId] = useState<string | null>(null);

  return (
    <div className="app">
      <header>
        <h1>🕷️ Crawler Dashboard</h1>
        <span className="subtitle">distributed web-intelligence platform</span>
        <nav className="nav">
          <button
            className={`navbtn ${view === "crawler" ? "active" : ""}`}
            onClick={() => setView("crawler")}
          >
            Crawler
          </button>
          <button
            className={`navbtn ${view === "exposure" ? "active" : ""}`}
            onClick={() => setView("exposure")}
          >
            🔓 Exposure Audit
          </button>
        </nav>
      </header>

      {view === "crawler" ? (
        <main>
          <section className="panel">
            <JobForm onCreated={setJobId} />
          </section>
          <section className="panel grow">
            <JobView jobId={jobId} />
          </section>
        </main>
      ) : (
        <ExposurePage />
      )}
    </div>
  );
}
