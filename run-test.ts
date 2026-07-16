import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const jobConfig = {
    seedUrl: 'https://www.amazon.in/s?k=smartphones',
    maxDepth: 1,
    maxPages: 100,
    sameHostOnly: true,
    respectRobots: true,
    storeHtml: true,
    renderMode: "browser",
    intent: "list of smartphone models, their prices, and ratings",
    focusedCrawl: true,
    plugins: ["rules"]
  };

  console.log("Submitting job...");
  const res = await fetch("http://localhost:3000/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jobConfig)
  });
  const data = await res.json();
  const jobId = data.jobId;
  console.log("Job ID:", jobId);

  // Poll until done
  while (true) {
    const statusRes = await fetch(`http://localhost:3000/jobs/${jobId}`);
    const statusData = await statusRes.json();
    console.log("Status:", statusData.status, "Pages scanned:", statusData.stats?.pagesScanned);
    if (statusData.status === "completed" || statusData.status === "failed") {
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Get CSV
  const csvRes = await fetch(`http://localhost:3000/jobs/${jobId}/export?format=csv`);
  const csv = await csvRes.text();
  console.log("\n--- CSV RESULT ---");
  console.log(csv);
}

run().catch(console.error);
