import { Redis } from "ioredis";
import { loadEnv } from "@crawler/config";

/**
 * Create an ioredis connection configured for BullMQ. `maxRetriesPerRequest: null`
 * is required by BullMQ's blocking operations. Callers own the lifecycle (call
 * `.quit()` when done).
 */
export function createRedis(): Redis {
  const { REDIS_URL } = loadEnv();
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null });
}
