import { type Redis } from "ioredis";
import { decrPending, clearJobState, isCancelled } from "./jobStore.js";

/**
 * Reference-counted completion for one terminal URL (M4/M6, extracted in M9 because
 * TWO consumer fleets — worker and renderer — now need it and this ordering is
 * correctness-critical, so it must live once):
 *
 *   decrement pending → at exactly 0: read cancel tombstone → finalize → clear state.
 *
 * The tombstone MUST be read before clearJobState wipes it, and finalize MUST run
 * before the transient state is cleared (a crash after finalize re-runs nothing;
 * finalize is idempotent via the guarded status update).
 *
 * The finalize hook persists the terminal status and fires side effects (webhook
 * enqueue) — injected so this package doesn't grow a dependency on @crawler/db.
 */
export async function finishUrl(
  redis: Redis,
  jobId: string,
  finalize: (cancelled: boolean) => Promise<void>,
): Promise<void> {
  const remaining = await decrPending(redis, jobId);
  if (remaining !== 0) return;
  const cancelled = await isCancelled(redis, jobId);
  await finalize(cancelled);
  await clearJobState(redis, jobId);
}
