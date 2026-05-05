/**
 * STATE-DRIVEN tests — `src/api/friends/subscriptions.ts`.
 *
 * Exercises both bridge families:
 *
 *  - `bridgeUserSliceToChange` — subscribes to the user slice and emits a
 *    `"change"` event via the TypedEventBus whenever the composite selector
 *    returns a different value. Verified by driving `_chatStore.setState()`
 *    after the bridge is wired and asserting that the bus fires.
 *
 *  - `bridgeUserSliceToGraphDiff` — loads (or seeds) the persisted cache,
 *    diffs against the live slice, fans out per-id events, and subscribes
 *    for future ticks. Verified by seeding a cache with known prior state,
 *    then driving a state change that should produce specific diff events.
 *
 * Uses MockSandbox + slice fixtures + a real MemoryDataStore for cache ops.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bridgeUserSliceToChange,
  bridgeUserSliceToGraphDiff,
} from "../../../src/api/friends/subscriptions.ts";
import {
  saveGraphCache,
  type FriendGraphSnapshot,
} from "../../../src/api/friends/graph-cache.ts";
import { TypedEventBus } from "../../../src/lib/typed-event-bus.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox, type MockChatStore } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";
import type { FriendsEvents } from "../../../src/api/friends/events.ts";
import type { ClientContext } from "../../../src/api/_context.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock ClientContext backed by a MemoryDataStore. Returns the context,
 * the DataStore, and the mock chat store handle for driving state changes.
 */
function makeBridgeCtx(initialPopulated = false) {
  const ds = new MemoryDataStore();
  const userSlice = initialPopulated ? smallGraphUserSliceFixture() : userSliceFixture();
  const builder = mockSandbox().withChatStore(chatStateFixture({ user: userSlice }));
  const sandbox = builder.build();
  const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;
  return { ctx, ds, store: sandbox._chatStore! };
}

function getCtxThunk(ctx: ClientContext): () => Promise<ClientContext> {
  return () => Promise.resolve(ctx);
}

/** Build a FriendsEvents bus. */
function makeBus(): TypedEventBus<FriendsEvents> {
  return new TypedEventBus<FriendsEvents>();
}

// ── bridgeUserSliceToChange ───────────────────────────────────────────────────

describe("friends/subscriptions — bridgeUserSliceToChange", () => {
  test("fires 'change' event when mutuals array reference changes", async () => {
    const { ctx, store } = makeBridgeCtx();
    const bus = makeBus();
    const emitted: unknown[] = [];
    bus.on("change", (snap) => emitted.push(snap));

    // Create an AbortController to serve as the subscription lifetime signal.
    const ac = new AbortController();
    await bridgeUserSliceToChange(getCtxThunk(ctx), bus, ac.signal);

    // Drive a state change — add a mutual to trigger the composite selector.
    store.setState({
      user: smallGraphUserSliceFixture(),
    });

    // Wait one microtask tick for the subscriber to fire.
    await Promise.resolve();
    expect(emitted.length).toBeGreaterThanOrEqual(1);

    ac.abort();
  });

  test("does not fire after the signal is aborted", async () => {
    const { ctx, store } = makeBridgeCtx();
    const bus = makeBus();
    const emitted: unknown[] = [];
    bus.on("change", (snap) => emitted.push(snap));

    const ac = new AbortController();
    await bridgeUserSliceToChange(getCtxThunk(ctx), bus, ac.signal);

    ac.abort();
    const beforeCount = emitted.length;

    // State change after abort should NOT fire the bridge.
    store.setState({ user: smallGraphUserSliceFixture() });
    await Promise.resolve();

    expect(emitted.length).toBe(beforeCount);
  });

  test("does not fire when signal is already aborted before ctx resolves", async () => {
    const { ctx } = makeBridgeCtx();
    const bus = makeBus();
    const emitted: unknown[] = [];
    bus.on("change", (snap) => emitted.push(snap));

    const ac = new AbortController();
    ac.abort(); // pre-abort

    await bridgeUserSliceToChange(getCtxThunk(ctx), bus, ac.signal);

    // No listeners wired; emitted should remain empty.
    expect(emitted).toHaveLength(0);
  });

});

// ── bridgeUserSliceToGraphDiff — initial fan-out ──────────────────────────────

describe("friends/subscriptions — bridgeUserSliceToGraphDiff (initial replay)", () => {
  test("emits 'friend:added' for mutuals present in live slice but absent from persisted cache", async () => {
    const { ctx, ds } = makeBridgeCtx(/* empty */ false);
    const bus = makeBus();
    const addedFriends: string[] = [];
    bus.on("friend:added", (f) => addedFriends.push(f.userId));

    // Seed cache with an empty snapshot — live slice has smallGraph friends.
    // First, set the sandbox to have a small graph.
    const ctxPopulated: ClientContext = {
      sandbox: mockSandbox().withChatStore(chatStateFixture({ user: smallGraphUserSliceFixture() })).build(),
      dataStore: ds,
    } as unknown as ClientContext;

    // Persist an empty cache so the bridge replays the deltas.
    const emptyCache: FriendGraphSnapshot = { mutuals: [], outgoing: [], incoming: [], ts: Date.now() - 10000 };
    await saveGraphCache(ds, emptyCache);

    await bridgeUserSliceToGraphDiff(getCtxThunk(ctxPopulated), bus);
    await Promise.resolve();

    // The initial fan-out should have fired friend:added for the 5 mutuals.
    expect(addedFriends.length).toBeGreaterThanOrEqual(5);
  });

  test("does NOT emit 'friend:added' when cache matches live slice (no delta)", async () => {
    const slice = smallGraphUserSliceFixture();
    const { ds } = makeBridgeCtx(false);

    // Seed cache with the SAME mutuals as the live slice.
    const matchingCache: FriendGraphSnapshot = {
      mutuals: slice.mutuallyConfirmedFriendIds as string[],
      outgoing: slice.outgoingFriendRequestIds as string[],
      incoming: Array.from((slice.incomingFriendRequests as Map<string, unknown>).keys()),
      ts: Date.now() - 5000,
    };
    await saveGraphCache(ds, matchingCache);

    const ctxPopulated: ClientContext = {
      sandbox: mockSandbox().withChatStore(chatStateFixture({ user: slice })).build(),
      dataStore: ds,
    } as unknown as ClientContext;

    const bus = makeBus();
    const addedFriends: string[] = [];
    bus.on("friend:added", (f) => addedFriends.push(f.userId));

    await bridgeUserSliceToGraphDiff(getCtxThunk(ctxPopulated), bus);
    await Promise.resolve();

    expect(addedFriends).toHaveLength(0);
  });

  test("emits 'friend:removed' for ids in persisted cache but absent from live slice", async () => {
    const { ds } = makeBridgeCtx(false);

    // Cache has a mutual that is NOT in the live slice (was removed).
    const removedId = "dead0000-dead-dead-dead-deaddeaddead";
    await saveGraphCache(ds, {
      mutuals: [removedId],
      outgoing: [],
      incoming: [],
      ts: Date.now() - 5000,
    });

    const emptyCtx: ClientContext = {
      sandbox: mockSandbox().withChatStore(chatStateFixture({ user: userSliceFixture() })).build(),
      dataStore: ds,
    } as unknown as ClientContext;

    const bus = makeBus();
    const removedIds: string[] = [];
    bus.on("friend:removed", (id) => removedIds.push(id));

    await bridgeUserSliceToGraphDiff(getCtxThunk(emptyCtx), bus);
    await Promise.resolve();

    expect(removedIds).toContain(removedId);
  });

  test("emits 'request:received' for incoming ids in live slice but absent from cache", async () => {
    const slice = smallGraphUserSliceFixture();
    const { ds } = makeBridgeCtx(false);

    // Cache has no incoming requests; live slice has one.
    await saveGraphCache(ds, {
      mutuals: slice.mutuallyConfirmedFriendIds as string[],
      outgoing: slice.outgoingFriendRequestIds as string[],
      incoming: [], // deliberately empty
      ts: Date.now() - 5000,
    });

    const ctxPopulated: ClientContext = {
      sandbox: mockSandbox().withChatStore(chatStateFixture({ user: slice })).build(),
      dataStore: ds,
    } as unknown as ClientContext;

    const bus = makeBus();
    const received: string[] = [];
    bus.on("request:received", (r) => received.push(r.fromUserId));

    await bridgeUserSliceToGraphDiff(getCtxThunk(ctxPopulated), bus);
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("88888888-8888-8888-8888-888888888888");
  });

  test("seeds the DataStore cache when none existed (first-ever run)", async () => {
    const { ds } = makeBridgeCtx(false);
    const ctxEmpty: ClientContext = {
      sandbox: mockSandbox().withChatStore(chatStateFixture({ user: userSliceFixture() })).build(),
      dataStore: ds,
    } as unknown as ClientContext;

    const bus = makeBus();
    await bridgeUserSliceToGraphDiff(getCtxThunk(ctxEmpty), bus);
    await Promise.resolve();

    const { loadGraphCache } = await import("../../../src/api/friends/graph-cache.ts");
    const cached = await loadGraphCache(ds);
    expect(cached).not.toBeUndefined();
  });
});

