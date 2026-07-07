import { useState } from "react";
import { JobForm } from "./components/JobForm";
import { JobView } from "./components/JobView";

export function App() {
  const [jobId, setJobId] = useState<string | null>(null);

  return (
    <div className="app">
      <header>
        <h1>🕷️ Crawler Dashboard</h1>
        <span className="subtitle">distributed web-intelligence platform</span>
      </header>
      <main>
        <section className="panel">
          <JobForm onCreated={setJobId} />
        </section>
        <section className="panel grow">
          <JobView jobId={jobId} />
        </section>
      </main>
    </div>
  );
}
