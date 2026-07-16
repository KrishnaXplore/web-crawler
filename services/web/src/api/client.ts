// Typed client for the REST API. All calls go through the Vite /api proxy.

export interface CreateJobInput {
  seedUrl: string;
  maxDepth: number;
  maxPages: number;
  sameHostOnly: boolean;
  respectRobots: boolean;
  storeHtml: boolean;
  plugins: string[];
  webhookUrl?: string;
  // Exposure audit (M10)
  exposurePatterns?: string[];
  requestHeaders?: Record<string, string>;
  exposureReveal?: boolean;
  renderMode?: "http" | "browser" | "auto";
  intent?: string;
  focusedCrawl?: boolean;
}

export interface JobStatus {
  jobId: string;
  seedUrl: string;
  status: string;
  maxDepth: number;
  maxPages: number;
  pagesPersisted: number;
  pending: number;
  createdAt: string;
  completedAt: string | null;
}

export interface PageRow {
  url: string;
  status: number | null;
  title: string | null;
  depth: number;
  discoveredLinks: number;
  analysis: Record<string, unknown> | null;
}

export interface HealthReport {
  pagesCrawled: number;
  statusBreakdown: Record<"2xx" | "3xx" | "4xx" | "5xx" | "other", number>;
  brokenPages: number;
  totalDiscoveredLinks: number;
  avgLinksPerPage: number;
  internalLinks: number;
  externalLinks: number;
  avgResponseTimeMs: number | null;
  avgWordCount: number | null;
  pagesMissingH1: number;
  pagesMissingMetaDescription: number;
  imagesMissingAlt: number;
  technology: string[];
  securityScore: string | null;
  mostLinkedPage: { url: string; inLinks: number } | null;
  exposure: {
    maxRisk: "none" | "info" | "low" | "medium" | "high";
    categoryCounts: Record<string, number>;
    unauthSensitiveUrls: string[];
  } | null;
  crawlDurationMs: number | null;
  robotsRespected: boolean;
}

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      issues?: { path?: string; message?: string }[];
    };
    // Surface WHAT failed, not just that something did — "validation failed"
    // alone sends the user hunting through every field.
    const detail = body.issues
      ?.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .filter(Boolean)
      .join("; ");
    throw new Error(
      detail
        ? `${body.error ?? "request failed"} — ${detail}`
        : (body.error ?? `request failed (${res.status})`),
    );
  }
  return res.json() as Promise<T>;
}

export async function createJob(input: CreateJobInput): Promise<{ jobId: string }> {
  return json(
    await fetch(`${BASE}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function getJob(id: string): Promise<JobStatus> {
  return json(await fetch(`${BASE}/jobs/${id}`));
}

export async function cancelJob(
  id: string,
): Promise<{ jobId: string; status: string }> {
  return json(await fetch(`${BASE}/jobs/${id}/cancel`, { method: "POST" }));
}

export async function getPages(id: string): Promise<{ pages: PageRow[] }> {
  return json(await fetch(`${BASE}/jobs/${id}/pages?limit=200`));
}

export async function getReport(id: string): Promise<{ report: HealthReport }> {
  return json(await fetch(`${BASE}/jobs/${id}/report`));
}

export function exportUrl(id: string, format: "json" | "csv"): string {
  return `${BASE}/jobs/${id}/export?format=${format}`;
}

export const AVAILABLE_PLUGINS = [
  "seo",
  "tech",
  "security",
  "metadata",
  "exposure",
  "structured",
  "rules",
  "discovery",
] as const;
