import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { createGeminiLlmSocket } from "./packages/crawler-core/src/llm/socket.ts";
import * as dotenv from "dotenv";

dotenv.config();
chromium.use(stealth());

async function run() {
  console.log("Launching visible browser...");
  // headless: false so the user can see it happen live!
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const targetUrl = "https://www.amazon.com/s?k=smartphones";
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  
  // Wait a few seconds for the user to see the page loaded, and for JS to finish
  await page.waitForTimeout(4000); 

  console.log("Extracting HTML...");
  const html = await page.content();
  console.log(`HTML size grabbed: ${html.length} characters.`);
  
  console.log("\nPassing to Gemini AI for extraction...");
  const llm = createGeminiLlmSocket({ 
    apiKey: process.env.GEMINI_API_KEY!, 
    model: "gemini-2.5-pro-exp-0205" // using pro for best accuracy
  });
  
  const rules = await llm.generateRules(
    "amazon.com",
    html,
    "mobile phone related information"
  );

  console.log("\n--- AI GENERATED RULES ---");
  console.log(JSON.stringify(rules, null, 2));


  console.log("\nClosing browser in 3 seconds...");
  await page.waitForTimeout(3000);
  await browser.close();
}

run().catch(console.error);
