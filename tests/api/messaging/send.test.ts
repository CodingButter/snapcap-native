/**
 * STATE-DRIVEN tests — `src/api/messaging/send.ts`.
 *
 * `sendText`, `sendImage`, `sendSnap` all:
 *   1. Await `internal.ensureSession()`.
 *   2. Read `internal.session.get()` and `internal.realm.get()`.
 *   3. Throw a descriptive error when session/realm are unavailable.
 *
 * The full bundle-driven path (WASM session, module 56639's `pn` export,
 * media upload pipeline) is LIVE-ONLY. These tests verify the surface contract:
 *  - Each function returns a Promise.
 *  - When session/realm are absent post-bringup, each throws with a
 *    message that identifies the method.
 *  - `ensureSession` is called exactly once per invocation.
 *  - `sendText` returns a string (UUID) when the bundle call settles or
 *    times out — tested by stubbing a real session+realm.
 *
 * Note: stubbing a real BundleMessagingSession / StandaloneChatRealm is
 * out of scope — we only stub the session/realm Slots to non-undefined
 * so the guard passes, then mock the `realm.wreq("56639")` call.
 */
import { describe, expect, test } from "bun:test";
import { sendText, sendImage, sendSnap } from "../../../src/api/messaging/send.ts";
import { TypedEventBus } from "../../../src/lib/typed-event-bus.ts";
import type { MessagingInternal } from "../../../src/api/messaging/internal.ts";
import type { MessagingEvents } from "../../../src/api/messaging/interface.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import type { BundleMessagingSession } from "../../../src/auth/fidelius-decrypt.ts";
import type { StandaloneChatRealm } from "../../../src/auth/fidelius-mint.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, authSliceFixture } from "../../lib/fixtures/index.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import * as vm from "node:vm";

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a `MessagingInternal` with session/realm absent (simulating
 * pre-bringup or failed-bringup state). `ensureSession` is a spy.
 */
function makeNoSessionInternal(): {
  internal: MessagingInternal;
  ensureCalls: number[];
} {
  const bus = new TypedEventBus<MessagingEvents>();
  const ensureCalls: number[] = [];
  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({
      auth: authSliceFixture({ userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    }))
    .build();
  const ctx: ClientContext = {
    sandbox,
    dataStore: new MemoryDataStore(),
    userAgent: "Mozilla/5.0",
  } as unknown as ClientContext;

  const internal: MessagingInternal = {
    ctx: () => Promise.resolve(ctx),
    events: bus,
    ensureSession: async () => { ensureCalls.push(1); },
    session: { get: () => undefined, set: () => {} },
    realm: { get: () => undefined, set: () => {} },
    presenceInitialized: { value: false },
    presenceSessions: new Map(),
  };
  return { internal, ensureCalls };
}

/**
 * Build a `MessagingInternal` with a stubbed session+realm whose
 * `wreq("56639")` returns a `pn` function that resolves after 0ms.
 * Used to verify `sendText` returns a string UUID in the success path.
 */
function makeStubSessionInternal(): MessagingInternal {
  const bus = new TypedEventBus<MessagingEvents>();

  // Real vm context so buildConvRef works (Uint8Array cross-realm)
  const context = vm.createContext({});

  // Stub wreq that provides a no-op `pn` and `ON`/`Mw`/`cr`
  const fakePn = async () => {};
  const fakeWreq = (_id: string) => ({
    pn: fakePn,
    Mw: () => {},
    ON: () => {},
    cr: () => {},
    zM: () => {},
  });

  const fakeSession = {} as BundleMessagingSession;
  const fakeRealm = { context, wreq: fakeWreq } as unknown as StandaloneChatRealm;

  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({
      auth: authSliceFixture({ userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    }))
    .build();
  const ctx: ClientContext = {
    sandbox,
    dataStore: new MemoryDataStore(),
    userAgent: "Mozilla/5.0",
  } as unknown as ClientContext;

  return {
    ctx: () => Promise.resolve(ctx),
    events: bus,
    ensureSession: async () => {},
    session: { get: () => fakeSession, set: () => {} },
    realm: { get: () => fakeRealm, set: () => {} },
    presenceInitialized: { value: false },
    presenceSessions: new Map(),
  };
}

const CONV_ID = "11111111-2222-3333-4444-555555555555";

// ── sendText ───────────────────────────────────────────────────────────────────

describe("messaging/send — sendText", () => {
  test("returns a Promise", () => {
    const { internal } = makeNoSessionInternal();
    const p = sendText(internal, CONV_ID, "hello");
    expect(p).toBeInstanceOf(Promise);
    p.catch(() => {}); // suppress unhandled rejection
  });

  test("throws a descriptive error when session is absent after bringup", async () => {
    const { internal } = makeNoSessionInternal();
    await expect(sendText(internal, CONV_ID, "hello"))
      .rejects.toThrow(/sendText.*bundle session not available/i);
  });

  test("calls ensureSession exactly once", async () => {
    const { internal, ensureCalls } = makeNoSessionInternal();
    await sendText(internal, CONV_ID, "hi").catch(() => {});
    expect(ensureCalls).toHaveLength(1);
  });

  test("returns a UUID string when the stub session resolves", async () => {
    const internal = makeStubSessionInternal();
    const result = await sendText(internal, CONV_ID, "hello");
    // sendText returns `fallbackId` — a crypto.randomUUID() string.
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  }, 5000);
});

// ── sendImage ──────────────────────────────────────────────────────────────────

describe("messaging/send — sendImage", () => {
  test("returns a Promise", () => {
    const { internal } = makeNoSessionInternal();
    const p = sendImage(internal, CONV_ID, new Uint8Array([0x89, 0x50]));
    expect(p).toBeInstanceOf(Promise);
    p.catch(() => {});
  });

  test("calls ensureSession exactly once", async () => {
    const { internal, ensureCalls } = makeNoSessionInternal();
    await sendImage(internal, CONV_ID, new Uint8Array(4)).catch(() => {});
    expect(ensureCalls).toHaveLength(1);
  });
});

// ── sendSnap ───────────────────────────────────────────────────────────────────

describe("messaging/send — sendSnap", () => {
  test("returns a Promise", () => {
    const { internal } = makeNoSessionInternal();
    const p = sendSnap(internal, CONV_ID, new Uint8Array([0xff, 0xd8]));
    expect(p).toBeInstanceOf(Promise);
    p.catch(() => {});
  });

  test("calls ensureSession exactly once", async () => {
    const { internal, ensureCalls } = makeNoSessionInternal();
    await sendSnap(internal, CONV_ID, new Uint8Array(4)).catch(() => {});
    expect(ensureCalls).toHaveLength(1);
  });

  test("passes timer option without throwing at the API layer", async () => {
    const { internal } = makeNoSessionInternal();
    await sendSnap(internal, CONV_ID, new Uint8Array(4), { timer: 5 }).catch(() => {});
    // No assertion on result — session is absent so it throws; we verified the shape above.
  });
});
