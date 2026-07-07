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
