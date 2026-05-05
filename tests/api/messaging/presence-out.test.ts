/**
 * STATE-DRIVEN tests — `src/api/messaging/presence-out.ts`.
 *
 * `setViewing(internal, convId, durationMs)` and `setRead(internal, convId, messageId)`
 * both call `ensureSession`, then resolve the session/realm slots.
 * Without a live bundle session (LIVE-ONLY territory) they exit early.
 *
 * Tests here verify:
 *  - Both functions return Promises.
 *  - Both resolve without throwing when session/realm are undefined.
 *  - `ensureSession` is called once per invocation.
 *  - `setViewing` with `durationMs = 0` resolves immediately.
 *  - `setRead` accepts both `string` and `bigint` message-id shapes.
 *  - Both tolerate `ensureSession` rejection propagating.
 */
import { describe, expect, test } from "bun:test";
import { setViewing, setRead } from "../../../src/api/messaging/presence-out.ts";
import { TypedEventBus } from "../../../src/lib/typed-event-bus.ts";
import type { MessagingInternal } from "../../../src/api/messaging/internal.ts";
import type { MessagingEvents } from "../../../src/api/messaging/interface.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, presenceSliceFixture } from "../../lib/fixtures/index.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";

// ── helper ─────────────────────────────────────────────────────────────────────

/**
 * Build a `MessagingInternal` with no session/realm (pre-bringup).
 * `ensureSession` is a spy.
 */
function makeInternal(opts: { failEnsure?: boolean } = {}): {
  internal: MessagingInternal;
  ensureCalls: number[];
} {
  const bus = new TypedEventBus<MessagingEvents>();
  const ensureCalls: number[] = [];

  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({ presence: presenceSliceFixture() }))
    .build();
  const ctx: ClientContext = {
    sandbox,
    dataStore: new MemoryDataStore(),
  } as unknown as ClientContext;

  const internal: MessagingInternal = {
    ctx: () => Promise.resolve(ctx),
    events: bus,
    ensureSession: async () => {
      ensureCalls.push(Date.now());
      if (opts.failEnsure) throw new Error("ensure-failed");
    },
    session: { get: () => undefined, set: () => {} },
    realm: { get: () => undefined, set: () => {} },
    presenceInitialized: { value: false },
    presenceSessions: new Map(),
  };
  return { internal, ensureCalls };
}

const CONV_ID = "cccccccc-dddd-eeee-ffff-000000000000";
const MSG_ID_STR = "9007199254740991";
const MSG_ID_BIG = 9007199254740991n;

// ── setViewing ─────────────────────────────────────────────────────────────────

describe("messaging/presence-out — setViewing", () => {
  test("returns a Promise", () => {
    const { internal } = makeInternal();
    const p = setViewing(internal, CONV_ID, 0);
    expect(p).toBeInstanceOf(Promise);
  });

  test("resolves without throwing when session is undefined", async () => {
    const { internal } = makeInternal();
    await expect(setViewing(internal, CONV_ID, 0)).resolves.toBeUndefined();
  });

  test("ensureSession is called once", async () => {
    const { internal, ensureCalls } = makeInternal();
    await setViewing(internal, CONV_ID, 0);
    expect(ensureCalls).toHaveLength(1);
  });

  test("resolves quickly with durationMs=0", async () => {
    const { internal } = makeInternal();
    const t0 = Date.now();
    await setViewing(internal, CONV_ID, 0);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("propagates ensureSession rejection", async () => {
    const { internal } = makeInternal({ failEnsure: true });
    await expect(setViewing(internal, CONV_ID, 0)).rejects.toThrow("ensure-failed");
  });
});

// ── setRead ────────────────────────────────────────────────────────────────────

describe("messaging/presence-out — setRead", () => {
  test("returns a Promise with a string messageId", () => {
    const { internal } = makeInternal();
    const p = setRead(internal, CONV_ID, MSG_ID_STR);
    expect(p).toBeInstanceOf(Promise);
  });

  test("returns a Promise with a bigint messageId", () => {
    const { internal } = makeInternal();
    const p = setRead(internal, CONV_ID, MSG_ID_BIG);
    expect(p).toBeInstanceOf(Promise);
  });

  test("resolves without throwing when session is undefined (string id)", async () => {
    const { internal } = makeInternal();
    await expect(setRead(internal, CONV_ID, MSG_ID_STR)).resolves.toBeUndefined();
  });

  test("resolves without throwing when session is undefined (bigint id)", async () => {
    const { internal } = makeInternal();
    await expect(setRead(internal, CONV_ID, MSG_ID_BIG)).resolves.toBeUndefined();
  });

  test("ensureSession is called once", async () => {
    const { internal, ensureCalls } = makeInternal();
    await setRead(internal, CONV_ID, MSG_ID_STR);
    expect(ensureCalls).toHaveLength(1);
  });

  test("propagates ensureSession rejection", async () => {
    const { internal } = makeInternal({ failEnsure: true });
    await expect(setRead(internal, CONV_ID, MSG_ID_STR)).rejects.toThrow("ensure-failed");
  });

  test("setRead accepts zero as messageId", async () => {
    const { internal } = makeInternal();
    await expect(setRead(internal, CONV_ID, "0")).resolves.toBeUndefined();
  });
});
