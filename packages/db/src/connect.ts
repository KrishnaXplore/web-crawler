// mongoose is CommonJS; a default import is the interop that works at runtime under
// Node's ESM loader (named imports like `connection` aren't reliably detected).
import mongoose from "mongoose";
import { loadEnv } from "@crawler/config";

let connected = false;

/**
 * Connect to MongoDB once (idempotent). Ensures model indexes — including the
 * `(jobId, url)` unique index that is the durable dedup backstop — exist.
 */
export async function connectMongo(): Promise<void> {
  if (connected) return;
  const { MONGO_URL } = loadEnv();
  await mongoose.connect(MONGO_URL);
  connected = true;
}

export async function disconnectMongo(): Promise<void> {
  if (!connected) return;
  await mongoose.connection.close();
  connected = false;
}

/**
 * True iff the Mongo connection is actually up (readyState 1). For readiness probes
 * (gap-analysis Tier 1). Callers should not need to import `mongoose` themselves just
 * to check this — that would leak an internal dependency across the package boundary
 * and require every consumer to declare `mongoose` directly (the bug this fixes).
 */
export function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}
