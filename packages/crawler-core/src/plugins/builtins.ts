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

export const BUILTIN_PLUGINS: readonly AnalyzerPlugin[] = [
  seoPlugin,
  techPlugin,
  securityPlugin,
];
