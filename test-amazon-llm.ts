import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { createGeminiLlmSocket } from "./packages/crawler-core/src/llm/socket.ts";
import * as dotenv from "dotenv";

dotenv.config();
chromium.use(stealth());

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log("Fetching Amazon...");
  await page.goto("https://www.amazon.com/dp/B0CMZ6S6L2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000); // wait for JS

  const html = await page.content();
  console.log("HTML size:", html.length);
  console.log("HTML snippet:", html.slice(0, 500));
  await browser.close();
}

run().catch(console.error);
