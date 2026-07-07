import { envSchema, type Env } from "./schema.js";

let cached: Env | null = null;

/**
 * Parse and validate process.env against the schema, once. Throws a readable error
 * (listing the offending vars) if validation fails — call this at process start so
 * misconfiguration surfaces immediately, not mid-crawl.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  // Best-effort: load a .env from the current working directory if present
  // (Node >=20.12). Real env vars already set take precedence.
  try {
    process.loadEnvFile?.();
  } catch {
    /* no .env file — fine, defaults + real env apply */
  }

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
