/**
 * STATE-DRIVEN tests — `src/api/messaging/subscribe.ts`.
 *
 * `subscribe(internal, event, cb, opts?)` bridges a consumer call into the
 * per-instance `TypedEventBus` and lazy-triggers the bundle session
 * bring-up. The tests here verify:
 *
 *  - Subscribing returns a callable `Subscription` with a `.signal`.
 *  - The event-bus wires correctly: the callback fires when the bus emits.
 *  - Calling the returned subscription tears it down (no further callbacks).
 *  - `opts.signal` abort also tears down the subscription.
 *  - `ensureSession` is called once per `subscribe` call.
 *  - Two `subscribe` calls on different events both wire correctly.
 */
import { describe, expect, test } from "bun:test";
import { subscribe } from "../../../src/api/messaging/subscribe.ts";
import { TypedEventBus } from "../../../src/lib/typed-event-bus.ts";
import type { MessagingInternal } from "../../../src/api/messaging/internal.ts";
import type { MessagingEvents } from "../../../src/api/messaging/interface.ts";
import type { ClientContext } from "../../../src/api/_context.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal `MessagingInternal` with a real `TypedEventBus` and a
 * spy-tracked `ensureSession`. Returns the internal object alongside a
 * reference to the bus (for driving `emit`) and a call-count accessor.
 */
function makeInternal(): {
  internal: MessagingInternal;
  bus: TypedEventBus<MessagingEvents>;
  ensureCount: () => number;
} {
  const bus = new TypedEventBus<MessagingEvents>();
  let ensureCount = 0;

  const internal: MessagingInternal = {
    ctx: () => Promise.resolve({} as ClientContext),
    events: bus,
    ensureSession: async () => { ensureCount++; },
    session: { get: () => undefined, set: () => {} },
    realm: { get: () => undefined, set: () => {} },
    presenceInitialized: { value: false },
    presenceSessions: new Map(),
  };

  return { internal, bus, ensureCount: () => ensureCount };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("messaging/subscribe — Subscription shape", () => {
  test("returns a callable function", () => {
    const { internal } = makeInternal();
    const sub = subscribe(internal, "typing", () => {});
    expect(typeof sub).toBe("function");
  });

  test("returned subscription has a .signal AbortSignal", () => {
    const { internal } = makeInternal();
    const sub = subscribe(internal, "typing", () => {});
    expect(sub.signal instanceof AbortSignal).toBe(true);
  });

  test("calling the subscription does not throw", () => {
    const { internal } = makeInternal();
    const sub = subscribe(internal, "typing", () => {});
    expect(() => sub()).not.toThrow();
  });

  test("two distinct subscribe calls return distinct subscriptions", () => {
    const { internal } = makeInternal();
    const a = subscribe(internal, "typing", () => {});
    const b = subscribe(internal, "typing", () => {});
    expect(a).not.toBe(b);
  });
});

describe("messaging/subscribe — event-bus wiring", () => {
  test("callback fires when the bus emits the subscribed event", () => {
    const { internal, bus } = makeInternal();
    const received: unknown[] = [];
    subscribe(internal, "typing", (ev) => received.push(ev));

    bus.emit("typing", { convId: "conv-1", userId: "user-1", until: 9999 });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ convId: "conv-1", userId: "user-1", until: 9999 });
  });

  test("callback does NOT fire after subscription is torn down", () => {
    const { internal, bus } = makeInternal();
    const received: unknown[] = [];
    const sub = subscribe(internal, "typing", (ev) => received.push(ev));

    sub(); // unsubscribe
    bus.emit("typing", { convId: "conv-2", userId: "user-2", until: 0 });
    expect(received).toHaveLength(0);
  });

  test("opts.signal abort tears down the subscription", () => {
    const { internal, bus } = makeInternal();
    const ctrl = new AbortController();
    const received: unknown[] = [];
    subscribe(internal, "typing", (ev) => received.push(ev), { signal: ctrl.signal });

    bus.emit("typing", { convId: "c", userId: "u", until: 1 });
    expect(received).toHaveLength(1);

    ctrl.abort(); // should unsubscribe
    bus.emit("typing", { convId: "c", userId: "u", until: 2 });
    expect(received).toHaveLength(1); // no second event
  });

  test("subscribing to 'viewing' wires the correct event slot", () => {
    const { internal, bus } = makeInternal();
    const received: unknown[] = [];
    subscribe(internal, "viewing", (ev) => received.push(ev));

    bus.emit("viewing", { convId: "v-conv", userId: "v-user", until: 5000 });
    expect(received).toHaveLength(1);
    expect((received[0] as { convId: string }).convId).toBe("v-conv");
  });

  test("subscribing to 'read' wires the correct event slot", () => {
    const { internal, bus } = makeInternal();
    const received: unknown[] = [];
    subscribe(internal, "read", (ev) => received.push(ev));

    const payload = { convId: "r-conv", userId: "r-user", messageId: "msg-1", at: 12345 };
    bus.emit("read", payload);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });
});

describe("messaging/subscribe — ensureSession side-effect", () => {
  test("ensureSession is called once per subscribe call", () => {
    const { internal, ensureCount } = makeInternal();
    subscribe(internal, "typing", () => {});
    // ensureSession is called but NOT awaited (fire-and-forget void);
    // the count is synchronously incremented inside the async stub.
    // One call → count should reach 1 in the same microtask turn.
    return Promise.resolve().then(() => {
      expect(ensureCount()).toBe(1);
    });
  });

  test("two subscribe calls each trigger ensureSession", () => {
    const { internal, ensureCount } = makeInternal();
    subscribe(internal, "typing", () => {});
    subscribe(internal, "viewing", () => {});
    return Promise.resolve().then(() => {
      expect(ensureCount()).toBe(2);
    });
  });
});
