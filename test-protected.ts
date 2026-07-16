import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const jobConfig = {
    // BestBuy uses strong PerimeterX (HUMAN) bot protection.
    seedUrl: 'https://www.bestbuy.com/site/searchpage.jsp?st=laptops',
    maxDepth: 1,
    maxPages: 3, // Just 3 pages to test bypass and extraction
    sameHostOnly: true,
    respectRobots: true,
    storeHtml: true,
    renderMode: "browser", // Stealth mode
    intent: "list of laptop models, their prices, and customer ratings",
    focusedCrawl: true,
    plugins: ["rules"]
  };

  console.log("Submitting job to a highly protected site (BestBuy)...");
  const res = await fetch("http://localhost:3000/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jobConfig)
  });
  
  if (!res.ok) {
    console.error("Failed to submit job:", await res.text());
    return;
  }
  
  const data = await res.json();
  const jobId = data.jobId;
  console.log("Job ID:", jobId);

  // Poll until done
  while (true) {
    const statusRes = await fetch(`http://localhost:3000/jobs/${jobId}`);
    const statusData = await statusRes.json();
    process.stdout.write(`\rStatus: ${statusData.status} | Pages scanned: ${statusData.stats?.pagesScanned ?? 0}`);
    if (statusData.status === "completed" || statusData.status === "failed") {
      console.log();
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
