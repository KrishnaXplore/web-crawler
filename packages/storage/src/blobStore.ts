import { createHash } from "node:crypto";
// minio's named exports aren't reliably detected by Node's ESM loader; a namespace
// import works whether the package resolves as CJS or ESM.
import * as Minio from "minio";
import { loadEnv } from "@crawler/config";

export interface PutResult {
  /** Content-addressed object key, e.g. "html/<sha256>". */
  readonly key: string;
  readonly bytes: number;
}

export interface BlobStore {
  /** Create the bucket if it doesn't exist. Call once at startup. */
  ensureBucket(): Promise<void>;
  /** Store bytes under a content-hash key (idempotent). */
  putBlob(content: Buffer | string, contentType: string): Promise<PutResult>;
  /** Fetch bytes back by key. */
  getBlob(key: string): Promise<Buffer>;
}

export function createBlobStore(): BlobStore {
  const env = loadEnv();
  const client = new Minio.Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });
  const bucket = env.MINIO_BUCKET;

  return {
    async ensureBucket() {
      const exists = await client.bucketExists(bucket).catch(() => false);
      if (!exists) await client.makeBucket(bucket);
    },

    async putBlob(content, contentType) {
      const buf =
        typeof content === "string" ? Buffer.from(content, "utf-8") : content;
      const key = `html/${createHash("sha256").update(buf).digest("hex")}`;

      // Idempotent + content-dedup: identical bytes → identical key; skip re-upload.
      try {
        await client.statObject(bucket, key);
        return { key, bytes: buf.length };
      } catch {
        /* not present → upload below */
      }

      await client.putObject(bucket, key, buf, buf.length, {
        "Content-Type": contentType,
      });
      return { key, bytes: buf.length };
    },

    async getBlob(key) {
      const stream = await client.getObject(bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    },
  };
}
