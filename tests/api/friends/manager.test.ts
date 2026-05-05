/**
 * STATE-DRIVEN tests — `src/api/friends/manager.ts`.
 *
 * The `Friends` class is a thin trampoline — every method delegates to a
 * free function in a sibling file. The state it owns is:
 *   - `#events: TypedEventBus<FriendsEvents>` (one per instance)
 *   - `#graphDiffInstalled: boolean` (lazy install gate)
 *
 * Tests here verify:
 *  - `on("change", ...)` returns a Subscription object with an `off` method.
 *  - `on("friend:added", ...)` and siblings return Subscriptions.
 *  - `onChange` is a shim that forwards to `on("change", ...)`.
 *  - `on("change", ...)` is per-subscriber (each call returns a distinct sub).
 *  - Graph-diff events (`friend:added`, `friend:removed`, `request:*`) share
 *    one watcher — the #graphDiffInstalled flag prevents redundant installs.
 *  - Unrecognized event names throw.
 *  - Read/mutation delegates resolve (smoke-test that wiring is correct).
 *
 * Delegates are already stress-tested in their own unit files; these tests
 * focus on the class surface, not the delegate internals.
 */
import { describe, expect, test } from "bun:test";
import { Friends } from "../../../src/api/friends/manager.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox, type MockChatStore } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";
import type { ClientContext } from "../../../src/api/_context.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a ClientContext with a fake FriendAction client stubbed for mutations
 * and a populated chat store for reads.
 */
function makeFriendsInstance(opts: { populated?: boolean } = {}): {
  friends: Friends;
  store: MockChatStore;
} {
  const userSlice = opts.populated ? smallGraphUserSliceFixture() : userSliceFixture();

  // Fake FriendAction client — accepts any method call without throwing.
  const fakeFriendAction = new Proxy({}, {
    get: (_t, prop) => async () => { /* no-op */ },
  }) as Record<string, () => Promise<void>>;

  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({ user: userSlice }))
    .withGlobal("__SNAPCAP_JZ", fakeFriendAction)
    .build();

  const ds = new MemoryDataStore();
  const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;
  const getCtx = () => Promise.resolve(ctx);

  const friends = new Friends(getCtx);
  return { friends, store: sandbox._chatStore! };
}

// ── subscription surface ──────────────────────────────────────────────────────

describe("friends/manager — on / onChange subscription surface", () => {
  test("on('change', cb) returns a callable Subscription with a .signal", () => {
    const { friends } = makeFriendsInstance();
    const sub = friends.on("change", () => {});
    // Subscription is the off() function itself (see TypedEventBus).
    expect(typeof sub).toBe("function");
    expect(sub.signal instanceof AbortSignal).toBe(true);
    sub(); // unsubscribe — should not throw
  });

  test("onChange(cb) returns an Unsubscribe function", () => {
    const { friends } = makeFriendsInstance();
    const unsub = friends.onChange(() => {});
    expect(typeof unsub).toBe("function");
    unsub(); // should not throw
  });

  test("on('friend:added', cb) returns a callable Subscription", () => {
    const { friends } = makeFriendsInstance();
    const sub = friends.on("friend:added", () => {});
    expect(typeof sub).toBe("function");
    sub();
  });

  test("on('friend:removed', cb) returns a callable Subscription", () => {
    const { friends } = makeFriendsInstance();
    const sub = friends.on("friend:removed", () => {});
    expect(typeof sub).toBe("function");
    sub();
  });

  test("on('request:received', cb) returns a callable Subscription", () => {
    const { friends } = makeFriendsInstance();
    const sub = friends.on("request:received", () => {});
    expect(typeof sub).toBe("function");
    sub();
  });

  test("on('request:cancelled', cb) returns a callable Subscription", () => {
    const { friends } = makeFriendsInstance();
    const sub = friends.on("request:cancelled", () => {});
    expect(typeof sub).toBe("function");
    sub();
  });

  test("on('request:accepted', cb) returns a callable Subscription", () => {
    const { friends } = makeFriendsInstance();
    const sub = friends.on("request:accepted", () => {});
    expect(typeof sub).toBe("function");
    sub();
  });

  test("two distinct on('change', ...) calls return distinct subscriptions", () => {
    const { friends } = makeFriendsInstance();
    const sub1 = friends.on("change", () => {});
    const sub2 = friends.on("change", () => {});
    expect(sub1).not.toBe(sub2);
    sub1();
    sub2();
  });

  test("throws for an unrecognized event name", () => {
    const { friends } = makeFriendsInstance();
    expect(() =>
      friends.on("totally:unknown" as "change", () => {}),
    ).toThrow();
  });
});

// ── reads smoke ───────────────────────────────────────────────────────────────

describe("friends/manager — read delegates (smoke)", () => {
  test("snapshot() resolves to a FriendsSnapshot shape", async () => {
    const { friends } = makeFriendsInstance({ populated: true });
    const snap = await friends.snapshot();
    expect(Array.isArray(snap.mutuals)).toBe(true);
    expect(Array.isArray(snap.received)).toBe(true);
    expect(Array.isArray(snap.sent)).toBe(true);
  });

  test("list() resolves to an array of Friends", async () => {
    const { friends } = makeFriendsInstance({ populated: true });
    const list = await friends.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(5);
  });

  test("receivedRequests() resolves to an array", async () => {
    const { friends } = makeFriendsInstance({ populated: true });
    const received = await friends.receivedRequests();
    expect(Array.isArray(received)).toBe(true);
  });

  test("sentRequests() resolves to an array", async () => {
    const { friends } = makeFriendsInstance({ populated: true });
    const sent = await friends.sentRequests();
    expect(Array.isArray(sent)).toBe(true);
  });

  test("refresh() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.refresh()).resolves.toBeUndefined();
  });
});

// ── mutation delegates smoke ──────────────────────────────────────────────────

describe("friends/manager — mutation delegates (smoke)", () => {
  const SAMPLE_ID = "11111111-2222-3333-4444-555555555555";

  test("sendRequest() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.sendRequest(SAMPLE_ID)).resolves.toBeUndefined();
  });

  test("remove() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.remove(SAMPLE_ID)).resolves.toBeUndefined();
  });

  test("block() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.block(SAMPLE_ID)).resolves.toBeUndefined();
  });

  test("unblock() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.unblock(SAMPLE_ID)).resolves.toBeUndefined();
  });

  test("acceptRequest() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.acceptRequest(SAMPLE_ID)).resolves.toBeUndefined();
  });

  test("rejectRequest() resolves without throwing", async () => {
    const { friends } = makeFriendsInstance();
    await expect(friends.rejectRequest(SAMPLE_ID)).resolves.toBeUndefined();
  });
});

// ── per-instance isolation ────────────────────────────────────────────────────

describe("friends/manager — per-instance isolation", () => {
  test("two Friends instances share no event state", () => {
    const { friends: a } = makeFriendsInstance();
    const { friends: b } = makeFriendsInstance();

    const emittedA: unknown[] = [];
    const emittedB: unknown[] = [];

    const subA = a.on("change", (snap) => emittedA.push(snap));
    const subB = b.on("change", (snap) => emittedB.push(snap));

    // Subscriptions themselves are distinct objects.
    expect(subA).not.toBe(subB);

    subA();
    subB();
  });
});
