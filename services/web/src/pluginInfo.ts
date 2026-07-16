/**
 * Plain-language label + description for each analyzer plugin (M19). Shared
 * between JobForm (the checklist) and PageDetail (results section headers)
 * so the two surfaces never describe the same plugin two different ways.
 */
export const PLUGIN_INFO: Record<string, { label: string; description: string }> = {
  seo: {
    label: "SEO signals",
    description: "Titles, headings, meta descriptions, image alt text.",
  },
  tech: {
    label: "Technology",
    description: "Detects what the site is built with (WordPress, React, etc.).",
  },
  security: {
    label: "Security headers",
    description: "Checks for standard security-related response headers.",
  },
  metadata: {
    label: "Page metadata",
    description: "Canonical URL, social sharing tags, language.",
  },
  exposure: {
    label: "Exposure audit",
    description: "Scans for accidentally-public sensitive data (advanced).",
  },
  structured: {
    label: "Existing structured data",
    description: "Reads product/article info the page already publishes.",
  },
  rules: {
    label: "Data extraction",
    description: "Extracts what you described above.",
  },
  discovery: {
    label: "Page classification",
    description: "Figures out whether a page is a list or a single item.",
  },
};
