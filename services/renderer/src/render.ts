import type { Browser } from "playwright";
import type { FetchResult } from "@crawler/core";
import { SsrfError } from "@crawler/core";
import { isRequestAllowed } from "./ssrf.js";

export interface RenderOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
}

/**
 * Render one URL in a fresh browser context and produce a FetchResult (rendered DOM as
 * the body, so the normal parse/extract/analyze path applies).
 *
 * Throws SsrfError if the page URL resolves to a blocked address — same terminal
 * outcome as the HTTP guard, so crawlUrl records it as blocked-ssrf, not retried.
 */
export async function renderPage(
  url: string,
  browser: Browser,
  opts: RenderOptions,
): Promise<FetchResult> {
  if (!(await isRequestAllowed(url))) {
    throw new SsrfError(new URL(url).hostname, "blocked before navigation");
  }

  const context = await browser.newContext({ userAgent: opts.userAgent });
  const startedAt = Date.now();
  try {
    // Vet every sub-resource the page tries to fetch (same list as the HTTP guard).
    await context.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      if (await isRequestAllowed(reqUrl)) await route.continue();
      else await route.abort("blockedbyclient");
    });

    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: opts.timeoutMs,
    });
    // Give SPA content a brief chance to settle; ignore if it never idles.
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);

    const body = await page.content();
    const status = response?.status() ?? 0;
    const finalUrl = page.url();


    const headers = response ? lowerHeaders(await response.allHeaders()) : {};
    return {
      finalUrl,
      status,
      contentType: headers["content-type"] ?? "text/html",
      headers,
      body,
      truncated: false,
      responseTimeMs: Date.now() - startedAt,
    };
  } finally {
    await context.close();
  }
}

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
