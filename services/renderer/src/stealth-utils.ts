import type { Page } from "playwright";

/**
 * Common Chrome User-Agents for stealth.
 */
const CHROME_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

export function getRandomChromeUA(): string {
  return CHROME_UAS[Math.floor(Math.random() * CHROME_UAS.length)]!;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Injects random mouse movements, smooth scrolls, and delays to emulate a human reader.
 * This helps bypass behavioral analysis (like Datadome or Akamai).
 */
export async function advancedHumanBehavior(page: Page): Promise<void> {
  try {
    // 1. Initial wait
    await delay(Math.floor(Math.random() * 1000) + 500);

    // 2. Random mouse movements
    const width = page.viewportSize()?.width ?? 1920;
    const height = page.viewportSize()?.height ?? 1080;
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(
        Math.floor(Math.random() * width),
        Math.floor(Math.random() * height),
        { steps: Math.floor(Math.random() * 5) + 5 }
      );
      await delay(Math.floor(Math.random() * 300) + 100);
    }

    // 3. Smooth scroll down
    await page.evaluate(`window.scrollBy({ top: ${Math.floor(Math.random() * 800) + 200}, behavior: "smooth" })`);
    await delay(Math.floor(Math.random() * 1500) + 500);

    // 4. Scroll up slightly
    await page.evaluate(`window.scrollBy({ top: ${-(Math.floor(Math.random() * 300) + 100)}, behavior: "smooth" })`);
    await delay(Math.floor(Math.random() * 500) + 200);
  } catch (err) {
    // Ignore errors (e.g. context closed)
  }
}

/**
 * Checks the HTML payload for common WAF/Bot block pages.
 */
export function isBlocked(html: string): boolean {
  const lower = html.toLowerCase();
  
  // Amazon specific blocks
  if (lower.includes("enter the characters you see below") && lower.includes("amazon")) return true;
  if (lower.includes("sorry, we just need to make sure you're not a robot")) return true;
  if (lower.includes("bm-verify")) return true;
  if (lower.includes("dogs of amazon")) return true; // Dog page (404/block)

  // Cloudflare / Generic WAF
  if (lower.includes("please verify you are a human")) return true;
  if (lower.includes("cloudflare ray id")) return true;
  if (lower.includes("datadome")) return true;

  return false;
}
