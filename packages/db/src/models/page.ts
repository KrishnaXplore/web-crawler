import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * A persisted page result (metadata only; raw HTML/screenshots go to blob storage
 * in M3 Step B, referenced by key). `url` is normalized.
 *
 * The compound `(jobId, url)` UNIQUE index is the durable dedup backstop (ADR-0004):
 * uniqueness is per-job (the same URL may appear in different crawl jobs), and it
 * catches any cross-worker race the fast Redis dedup might miss.
 */
const pageSchema = new Schema(
  {
    jobId: { type: String, required: true },
    url: { type: String, required: true },
    finalUrl: { type: String, default: null },
    status: { type: Number, default: null },
    contentType: { type: String, default: null },
    title: { type: String, default: null },
    description: { type: String, default: null },
    depth: { type: Number, required: true },
    parentUrl: { type: String, default: null },
    discoveredLinks: { type: Number, default: 0 },
    // Blob pointer (M3 Step B): the HTML lives in object storage, not here.
    htmlKey: { type: String, default: null },
    htmlBytes: { type: Number, default: null },
    // Analyzer plugin output (M5 Step C), keyed by plugin name.
    analysis: { type: Schema.Types.Mixed, default: null },
    fetchedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

pageSchema.index({ jobId: 1, url: 1 }, { unique: true });
// Full-text search over page metadata (M5 Step E). Mongo allows one text index.
pageSchema.index({ title: "text", description: "text" });

export const PageModel = model("Page", pageSchema);
