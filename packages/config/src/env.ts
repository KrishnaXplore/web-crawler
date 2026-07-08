import { envSchema, type Env } from "./schema.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

let cached: Env | null = null;

/**
 * Parse and validate process.env against the schema, once. Throws a readable error
 * (listing the offending vars) if validation fails — call this at process start so
 * misconfiguration surfaces immediately, not mid-crawl.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  // Best-effort: load a .env from the current working directory, OR the
  // workspace root.
  try {
    let envPath = join(process.cwd(), ".env");
    if (!existsSync(envPath)) {
      // check workspace root (two levels up from services/* or packages/*)
      const rootEnv = join(process.cwd(), "..", "..", ".env");
      if (existsSync(rootEnv)) {
        envPath = rootEnv;
      }
    }
    process.loadEnvFile?.(envPath);
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
