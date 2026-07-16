import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { renderPage } from "./src/render.js";
import { ProxyProvider } from "./src/proxy.js";
import { getRandomChromeUA } from "./src/stealth-utils.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SITES = [
  "https://www.amazon.com",
  "https://www.amazon.in",
  "https://www.91mobiles.com",
  "https://www.linkedin.com",
  "https://www.instagram.com",
  "https://www.facebook.com",
  "https://x.com",
  "https://www.ticketmaster.com",
  "https://www.bestbuy.com",
  "https://www.walmart.com",
];

async function main() {
  console.log("Starting bulk stealth test...");
  chromium.use(stealth());
  
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const proxyProvider = new ProxyProvider();
  
  let csvContent = "URL,Status,Blocked,Title,Time(ms)\n";

  for (const url of SITES) {
    console.log(`\nTesting ${url}...`);
    try {
      const result = await renderPage(url, browser, {
        userAgent: getRandomChromeUA(),
        timeoutMs: 60000,
        proxy: proxyProvider.getProxy(),
      });

      const titleMatch = result.body.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/,/g, "") : "No Title Found";
      
      console.log(`SUCCESS: [${result.status}] ${title} (${result.responseTimeMs}ms)`);
      csvContent += `${url},${result.status},false,${title},${result.responseTimeMs}\n`;
    } catch (err: any) {
      console.error(`ERROR on ${url}: ${err.message}`);
      const blocked = err.message === "BLOCKED_BY_WAF";
      csvContent += `${url},ERROR,${blocked},${err.message.replace(/,/g, " ")},0\n`;
    }
  }

  await browser.close();

  const outputPath = path.resolve("test_results.csv");
  await fs.writeFile(outputPath, csvContent);
  console.log(`\nDone! Results saved to ${outputPath}`);
}

main().catch(console.error);
