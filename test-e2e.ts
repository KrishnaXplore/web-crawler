import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { createGeminiLlmSocket } from "./packages/crawler-core/src/llm/socket.ts";
import { advancedHumanBehavior, isBlocked, getRandomChromeUA } from "./services/renderer/src/stealth-utils.ts";
import { ProxyProvider } from "./services/renderer/src/proxy.ts";
import * as dotenv from "dotenv";

dotenv.config();
chromium.use(stealth());

async function run() {
  const proxyProvider = new ProxyProvider();
  const proxyConfig = proxyProvider.getProxy();
  const launchArgs: any = { headless: true, args: ["--no-sandbox"] };
  
  if (proxyConfig) {
    const parts = proxyConfig.replace("http://", "").split("@");
    const [user, pass] = parts[0].split(":");
    const server = parts[1];
    launchArgs.proxy = { server: `http://${server}`, username: user, password: pass };
  }

  const browser = await chromium.launch(launchArgs);
  const context = await browser.newContext({
    userAgent: getRandomChromeUA(),
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  console.log("Fetching Amazon search...");
  await page.goto("https://www.amazon.com/s?k=smartphones", { waitUntil: "domcontentloaded" });
  await advancedHumanBehavior(page);
  
  const html = await page.content();
  console.log("HTML size:", html.length);
  if (isBlocked(html)) {
      console.log("BLOCKED!");
      await browser.close();
      return;
  }

  const socket = createGeminiLlmSocket({ apiKey: process.env.GEMINI_API_KEY! });
  console.log("Generating rules for search page (collection)...");
  
  try {
      const listRules = await socket.generateRules("amazon.com", html, "mobile phones", { pageType: "list" });
      console.log("Search Rules:", JSON.stringify(listRules, null, 2));
  } catch (e) {
      console.log("Error generating list rules:", e);
  }

  console.log("Fetching an Amazon product page...");
  // Find a product link
  const productHref = await page.evaluate(() => {
      const a = document.querySelector('a.a-link-normal.s-no-outline');
      return a ? (a as HTMLAnchorElement).href : null;
  });
  
  if (!productHref) {
      console.log("No product link found!");
  } else {
      console.log("Product URL:", productHref);
      await page.goto(productHref, { waitUntil: "domcontentloaded" });
      await advancedHumanBehavior(page);
      const prodHtml = await page.content();
      console.log("Product HTML size:", prodHtml.length);
      
      console.log("Generating rules for product page (detail)...");
      try {
          const prodRules = await socket.generateRules("amazon.com", prodHtml, "extract product name and price");
          console.log("Product Rules:", JSON.stringify(prodRules, null, 2));
      } catch (e) {
          console.log("Error generating prod rules:", e);
      }
  }

  await browser.close();
}

run().catch(console.error);
