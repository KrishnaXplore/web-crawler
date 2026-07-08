import { describe, it, expect, vi } from "vitest";
import type { Redis } from "ioredis";
import { finishUrl } from "./completion.js";

/** Fake just the three Redis ops the helper touches, recording call order. */
function fakeRedis(opts: { remaining: number; cancelled: boolean }) {
  const calls: string[] = [];
  const redis = {
    decr: vi.fn(async () => (calls.push("decr"), opts.remaining)),
    exists: vi.fn(async () => (calls.push("exists"), opts.cancelled ? 1 : 0)),
    del: vi.fn(async () => (calls.push("del"), 1)),
  } as unknown as Redis;
  return { redis, calls };
}

describe("finishUrl (M9 — extracted M4/M6 completion contract)", () => {
  it("does nothing but decrement while work remains", async () => {
    const { redis, calls } = fakeRedis({ remaining: 3, cancelled: false });
    const finalize = vi.fn();
    await finishUrl(redis, "j1", finalize);
    expect(calls).toEqual(["decr"]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("at zero: reads tombstone BEFORE clearing state, finalizes completed", async () => {
    const { redis, calls } = fakeRedis({ remaining: 0, cancelled: false });
    const order: string[] = [];
    await finishUrl(redis, "j1", async (cancelled) => {
      order.push(`finalize:${cancelled}`);
    });
    expect(calls).toEqual(["decr", "exists", "del"]); // tombstone read precedes del
    expect(order).toEqual(["finalize:false"]);
  });

  it("at zero with tombstone set: finalizes cancelled", async () => {
    const { redis } = fakeRedis({ remaining: 0, cancelled: true });
    const finalize = vi.fn();
    await finishUrl(redis, "j1", finalize);
    expect(finalize).toHaveBeenCalledWith(true);
  });

  it("finalize runs before state is cleared (crash-safety ordering)", async () => {
    const { redis } = fakeRedis({ remaining: 0, cancelled: false });
    let delAtFinalize = 0;
    await finishUrl(redis, "j1", async () => {
      delAtFinalize = vi.mocked(redis.del).mock.calls.length;
    });
    expect(delAtFinalize).toBe(0); // del had not happened yet
  });
});
