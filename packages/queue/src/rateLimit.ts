import { type Redis } from "ioredis";

/**
 * Per-domain rate limiting shared across all workers (ADR-0004). One atomic Redis
 * script keeps a per-domain "next allowed" timestamp: if we're past it, reserve the
 * next slot and return 0 (go now); otherwise return the milliseconds to wait. Because
 * the gate is in Redis, N workers collectively respect one host's rate — a per-worker
 * delay could not.
 */
const ACQUIRE = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')
if now >= nextAt then
  redis.call('SET', KEYS[1], now + interval, 'PX', interval + 1000)
  return 0
else
  return nextAt - now
end
`;

/**
 * Try to reserve a fetch slot for `domain`. Returns 0 if allowed now (slot reserved),
 * else the ms to wait before trying again.
 */
export async function acquireDomainSlot(
  redis: Redis,
  domain: string,
  intervalMs: number,
): Promise<number> {
  const res = await redis.eval(
    ACQUIRE,
    1,
    `rate:${domain}`,
    Date.now().toString(),
    String(intervalMs),
  );
  return Number(res);
}
