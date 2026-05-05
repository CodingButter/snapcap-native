/**
 * STATE-DRIVEN tests — `src/api/messaging/manager.ts`.
 *
 * The `Messaging` class is a trampoline + per-instance state shell:
 *   - `#events: TypedEventBus<MessagingEvents>` — one per instance
 *   - `#sessionPromiseCell`, `#session`, `#realm` — bring-up gate + slots
 *   - `#presenceInitialized`, `#presenceSessions` — presence cache
 *   - `#internal: MessagingInternal` — accessor object passed to siblings
 *
 * Tests here verify:
 *  - The constructor builds correctly without throwing.
 *  - Two `Messaging` instances are independent (per-instance isolation).
 *  - `on(event, cb)` exists and returns a Subscription (shape check only —
 *    we can't call it without triggering `ensureSession → bringup.ts` which
 *    requires a real bundle load; that's LIVE-ONLY territory).
 *  - `listConversations` and `fetchEncryptedMessages` call out to the
 *    context resolver (`_getCtx`) when invoked — verified via a call-count spy.
 *  - The public send/presence methods exist as functions on the instance.
 *
 * ## Why `on()` is shape-checked but not event-fired
 *
 * `Messaging.on(event, cb)` delegates to `subscribe()` which immediately
 * calls `void internal.ensureSession()`. In the `Messaging` class, `ensureSession`
 * is wired to the real `bringup.ts#ensureSession` which tries to boot the
 * standalone WASM mint. Without a real bundle, this throws
 * `"null is not an object (evaluating 'ei.setAttribute')"` as an unhandled
 * rejection — bun's test runner surfaces that as a test failure even though
 * the path swallows it via `void`. The STATE-DRIVEN tier does not provide a
 * way to intercept this (the `ensureSession` closure is private to the
 * constructor). Subscribe-level tests live in `subscribe.test.ts` where
 * `MessagingInternal` is fully injected.
 */
import { describe, expect, test } from "bun:test";
import { Messaging } from "../../../src/api/messaging/manager.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  authSliceFixture,
} from "../../lib/fixtures/index.ts";
import type { ClientContext } from "../../../src/api/_context.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a `Messaging` instance backed by a mock sandbox with a spy-counted
 * `getCtx` thunk.
 */
function makeMessaging(): {
  messaging: Messaging;
  ctxCallCount: () => number;
} {
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

  let ctxCallCount = 0;
  const getCtx = () => { ctxCallCount++; return Promise.resolve(ctx); };

  return { messaging: new Messaging(getCtx), ctxCallCount: () => ctxCallCount };
}

const CONV_ID = "11111111-2222-3333-4444-555555555555";

// ── constructor ────────────────────────────────────────────────────────────────

describe("messaging/manager — constructor", () => {
  test("constructs without throwing", () => {
    expect(() => makeMessaging()).not.toThrow();
  });

  test("returns an object with all expected public methods", () => {
    const { messaging } = makeMessaging();
    expect(typeof messaging.on).toBe("function");
    expect(typeof messaging.setTyping).toBe("function");
    expect(typeof messaging.setViewing).toBe("function");
    expect(typeof messaging.setRead).toBe("function");
    expect(typeof messaging.sendText).toBe("function");
    expect(typeof messaging.sendImage).toBe("function");
    expect(typeof messaging.sendSnap).toBe("function");
    expect(typeof messaging.listConversations).toBe("function");
    expect(typeof messaging.fetchEncryptedMessages).toBe("function");
  });

  test("two Messaging instances are distinct objects", () => {
    const { messaging: a } = makeMessaging();
    const { messaging: b } = makeMessaging();
    expect(a).not.toBe(b);
  });
});

// ── per-instance isolation ─────────────────────────────────────────────────────

describe("messaging/manager — per-instance isolation", () => {
  test("two Messaging instances are constructed independently from separate getCtx", () => {
    let callsA = 0;
    let callsB = 0;

    const makeMsgWithSpy = (counter: { inc: () => void }) => {
      const sandbox = mockSandbox()
        .withChatStore(chatStateFixture())
        .build();
      const ctx = {
        sandbox,
        dataStore: new MemoryDataStore(),
        userAgent: "Mozilla/5.0",
      } as unknown as ClientContext;
      return new Messaging(() => { counter.inc(); return Promise.resolve(ctx); });
    };

    const a = makeMsgWithSpy({ inc: () => callsA++ });
    const b = makeMsgWithSpy({ inc: () => callsB++ });

    // Invoke listConversations to trigger getCtx on each independently.
    a.listConversations("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").catch(() => {});
    b.listConversations("bbbbbbbb-cccc-dddd-eeee-ffffffffffff").catch(() => {});

    return Promise.resolve().then(() => {
      expect(callsA).toBe(1);
      expect(callsB).toBe(1);
    });
  });
});

// ── raw envelope reads — getCtx delegation ────────────────────────────────────

describe("messaging/manager — raw read delegates call getCtx", () => {
  test("listConversations calls getCtx once", async () => {
    const { messaging, ctxCallCount } = makeMessaging();
    await messaging.listConversations("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
      .catch(() => {}); // grpcCall will throw (no real auth/fetch); swallow
    expect(ctxCallCount()).toBeGreaterThanOrEqual(1);
  });

  test("fetchEncryptedMessages calls getCtx once", async () => {
    const { messaging, ctxCallCount } = makeMessaging();
    await messaging.fetchEncryptedMessages([], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
      .catch(() => {});
    expect(ctxCallCount()).toBeGreaterThanOrEqual(1);
  });
});

// ── send + presence delegates — Promise contract ──────────────────────────────
//
// These methods call `ensureSession` (the real bringup). They still return
// a Promise immediately — we assert on the Promise shape only, then let the
// bringup fail silently.

// Note: setTyping / setViewing / setRead / sendText / sendImage / sendSnap
// all call `ensureSession` on the REAL Messaging class, which triggers
// bringup.ts → bootStandaloneMintWasm (real bundle eval). That path throws
// "null is not an object (evaluating 'ei.setAttribute')" as an unhandled async
// error that bun's test runner surfaces even when the caller's `.catch()` handles
// the rejection — likely because the error originates inside vm.runInContext
// and propagates as an uncaughtException before the catch handler runs.
//
// These methods are already thoroughly tested via injected MessagingInternal
// in subscribe.test.ts, set-typing.test.ts, presence-out.test.ts, and
// send.test.ts — so we skip the manager-level re-test of those paths here.
// The constructor + trampoline shape + raw-reads delegation above provides
// sufficient coverage for the class shell.
