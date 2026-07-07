import { z } from "zod";

/**
 * The environment contract. Mirrors .env.example. Every service parses this once
 * at boot (see ./env) and refuses to start on an invalid/missing value rather than
 * failing deep inside a request.
 */
export const envSchema = z.object({
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  MONGO_URL: z.string().url().default("mongodb://localhost:27018/crawler"),
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().int().positive().default(9002),
  MINIO_USE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_BUCKET: z.string().default("crawler-blobs"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_KEY: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9464),
  CRAWL_DELAY_MS: z.coerce.number().int().nonnegative().default(200),
  CRAWL_USER_AGENT: z
    .string()
    .default("web-intelligence-platform-crawler/0.1 (+https://example.com/bot)"),
});

export type Env = z.infer<typeof envSchema>;
