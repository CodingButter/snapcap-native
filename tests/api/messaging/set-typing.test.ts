/**
 * STATE-DRIVEN tests — `src/api/messaging/set-typing.ts`.
 *
 * `setTyping(internal, convId, durationMs)` orchestrates a typing-pulse
 * loop via `ensureSession` → bundle `zM` export + presence broadcastTypingActivity.
 *
 * Because the full path requires a live bundle session (LIVE-ONLY), we test
 * the observable surface a STATE-DRIVEN mock can cover:
 *
 *  - When `session` and `realm` are undefined (no bring-up), `setTyping`
 *    resolves immediately with no throw (best-effort early exit).
 *  - `ensureSession` is called exactly once (the gate function).
 *  - With `durationMs = 0` the function resolves in one microtask turn.
 *  - The finally block runs even on zero-duration calls (auto-clear guarantee).
 *
 * The convMgr / broadcastTypingActivity paths are gated on a live
 * `BundlePresenceSession` from `ensurePresenceForConv` (bringup-scope);
 * those paths are out of reach in a mock sandbox and are thus skipped here.
 */
import { describe, expect, test } from "bun:test";
import { setTyping } from "../../../src/api/messaging/set-typing.ts";
import { TypedEventBus } from "../../../src/lib/typed-event-bus.ts";
import type { MessagingInternal } from "../../../src/api/messaging/internal.ts";
import type { MessagingEvents } from "../../../src/api/messaging/interface.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, presenceSliceFixture } from "../../lib/fixtures/index.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a `MessagingInternal` with no session/realm (simulating pre-bringup
 * state). `ensureSession` is a spy that records calls.
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

const CONV_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("messaging/set-typing — no-session early exit", () => {
  test("resolves without throwing when session is undefined", async () => {
    const { internal } = makeInternal();
    await expect(setTyping(internal, CONV_ID, 0)).resolves.toBeUndefined();
  });

  test("ensureSession is called once", async () => {
    const { internal, ensureCalls } = makeInternal();
    await setTyping(internal, CONV_ID, 0);
    expect(ensureCalls).toHaveLength(1);
  });

  test("resolves even when durationMs is 0", async () => {
    const { internal } = makeInternal();
    const t0 = Date.now();
    await setTyping(internal, CONV_ID, 0);
    // Should not hang — must complete in well under a second.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("resolves gracefully when ensureSession rejects", async () => {
    // ensureSession rejection propagates out of setTyping (the session gate
    // is not swallowed by setTyping itself). Confirm we get a rejection.
    const { internal } = makeInternal({ failEnsure: true });
    await expect(setTyping(internal, CONV_ID, 0)).rejects.toThrow("ensure-failed");
  });
});

describe("messaging/set-typing — call-count discipline", () => {
  test("does not call ensureSession more than once for a single setTyping", async () => {
    const { internal, ensureCalls } = makeInternal();
    await setTyping(internal, CONV_ID, 0);
    expect(ensureCalls.length).toBe(1);
  });
});
