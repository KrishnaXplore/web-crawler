import { pino, stdSerializers, type Logger } from "pino";

export type { Logger };

/**
 * Structured logging (M7 Step B — see docs/phase7.md, HLD §9). One JSON line per
 * event to stdout; shipping/rotation is the platform's job (twelve-factor). Services
 * bind context once — `log.child({ jobId })` — so every line in a crawl is traceable
 * across N workers. Level via LOG_LEVEL (default "info").
 *
 * Scripts (CLIs) intentionally keep console: their stdout is the user interface,
 * not a log stream.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    serializers: { err: stdSerializers.err },
    redact: {
      paths: ["*.authorization", "*.apiKey", "*.secret", "*.password"],
      censor: "[redacted]",
    },
  });
}
