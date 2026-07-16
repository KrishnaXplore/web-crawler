import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { createGeminiLlmSocket } from "./packages/crawler-core/src/llm/socket.ts";
import * as dotenv from "dotenv";

dotenv.config();
chromium.use(stealth());

async function run() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log("Fetching Amazon IN...");
  await page.goto("https://www.amazon.in/mobile-phones/b/?ie=UTF8&node=1389401031", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000); // wait for JS

  const html = await page.content();
  console.log("HTML size:", html.length);

  const llm = createGeminiLlmSocket({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "gemini-2.5-pro"
  });

  const rules = await llm.generateRules(
    "amazon.in",
    html,
    "mobile phone related data",
    { pageType: "list" }
  );

  console.log("\n--- AI GENERATED RULES ---");
  console.log(JSON.stringify(rules, null, 2));

  await browser.close();
}
run().catch(console.error);
