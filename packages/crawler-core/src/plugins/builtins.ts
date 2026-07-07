import type { AnalyzerPlugin } from "./types.js";

/** SEO signals from the DOM. */
export const seoPlugin: AnalyzerPlugin = {
  name: "seo",
  analyze({ $ }) {
    const title = $("title").first().text().trim();
    const imgs = $("img");
    let missingAlt = 0;
    imgs.each((_, el) => {
      if (!($(el).attr("alt") ?? "").trim()) missingAlt += 1;
    });
    return {
      titleLength: title.length,
      h1Count: $("h1").length,
      hasMetaDescription: $('meta[name="description"]').length > 0,
      images: imgs.length,
      imagesMissingAlt: missingAlt,
    };
  },
};

/** Technology fingerprint from generator meta + script sources. */
export const techPlugin: AnalyzerPlugin = {
  name: "tech",
  analyze({ $ }) {
    const generator = $('meta[name="generator"]').attr("content") ?? null;
    const scripts = $("script[src]")
      .map((_, el) => $(el).attr("src") ?? "")
      .get()
      .join(" ")
      .toLowerCase();
    const detected: string[] = [];
    if (/wp-content|wp-includes/.test(scripts) || /wordpress/i.test(generator ?? ""))
      detected.push("WordPress");
    if (/jquery/.test(scripts)) detected.push("jQuery");
    if (/react|_next\//.test(scripts)) detected.push("React");
    if (/vue/.test(scripts)) detected.push("Vue");
    return { generator, detected };
  },
};

const SECURITY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
] as const;

/** Presence of key security response headers. */
export const securityPlugin: AnalyzerPlugin = {
  name: "security",
  analyze({ headers }) {
    const present: Record<string, boolean> = {};
    let count = 0;
    for (const h of SECURITY_HEADERS) {
      const has = headers[h] !== undefined;
      present[h] = has;
      if (has) count += 1;
    }
    return { present, score: `${count}/${SECURITY_HEADERS.length}` };
  },
};

/**
 * Page metadata (M6 Step C — see docs/phase6.md): canonical URL, OpenGraph/Twitter
 * cards, hreflang alternates, document language, robots meta directives. An analyzer
 * OBSERVES robots directives (noindex/nofollow) — honoring them is crawl behavior
 * and belongs to the politeness work, not a plugin.
 */
export const metadataPlugin: AnalyzerPlugin = {
  name: "metadata",
  analyze({ $, url }) {
    // Relative canonicals/alternates are common — resolve against the page URL so
    // the stored value is absolute and comparable.
    const abs = (href: string | undefined): string | null => {
      if (href === undefined || href.trim() === "") return null;
      try {
        return new URL(href.trim(), url).href;
      } catch {
        return null;
      }
    };
    const og = (key: string): string | null =>
      $(`meta[property="og:${key}"]`).attr("content")?.trim() || null;
    const tw = (key: string): string | null =>
      $(`meta[name="twitter:${key}"]`).attr("content")?.trim() || null;

    const canonical = abs($('link[rel="canonical"]').first().attr("href"));
    // The useful signal: is THIS page the authoritative copy of itself?
    let isCanonical: boolean | null = null;
    if (canonical !== null) {
      try {
        isCanonical = new URL(canonical).href === new URL(url).href;
      } catch {
        /* keep null */
      }
    }

    const hreflang = $('link[rel="alternate"][hreflang]')
      .map((_, el) => ({
        lang: $(el).attr("hreflang") ?? "",
        href: abs($(el).attr("href")),
      }))
      .get()
      .filter((a) => a.lang !== "" && a.href !== null);

    const robotsContent = (
      $('meta[name="robots"]').attr("content") ?? ""
    ).toLowerCase();

    return {
      lang: $("html").attr("lang")?.trim() || null,
      canonical,
      isCanonical,
      og: {
        title: og("title"),
        description: og("description"),
        image: og("image"),
        type: og("type"),
      },
      twitter: {
        card: tw("card"),
        title: tw("title"),
        description: tw("description"),
        image: tw("image"),
      },
      hreflang,
      robots: {
        noindex: robotsContent.includes("noindex"),
        nofollow: robotsContent.includes("nofollow"),
      },
    };
  },
};

export const BUILTIN_PLUGINS: readonly AnalyzerPlugin[] = [
  seoPlugin,
  techPlugin,
  securityPlugin,
  metadataPlugin,
];
