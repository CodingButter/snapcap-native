/**
 * STATE-DRIVEN tests — `src/api/friends/reads.ts`.
 *
 * Exercises:
 *  - `ensureSynced` — calls syncFriends when mutuals array is empty, skips
 *    when populated; returns the current UserSlice either way.
 *  - `snapshotFriends` — returns a well-shaped FriendsSnapshot and persists
 *    the graph cache into the DataStore.
 *  - `listFriends` — returns the mutuals slice of a snapshot.
 *  - `listReceivedRequests` / `listSentRequests` — projection off snapshot.
 *  - `persistGraphSnapshotFrom` — writes the graph cache without throwing.
 *  - `refreshFriends` — calls syncFriends if present, no-ops if absent.
 *
 * Uses `mockSandbox` + slice fixtures to avoid booting real bundle WASM.
 */
import { describe, expect, test } from "bun:test";
import {
  ensureSynced,
  listFriends,
  listReceivedRequests,
  listSentRequests,
  refreshFriends,
  snapshotFriends,
} from "../../../src/api/friends/reads.ts";
import { loadGraphCache } from "../../../src/api/friends/graph-cache.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";
import type { ClientContext } from "../../../src/api/_context.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock `ClientContext` from a sandbox + a MemoryDataStore.
 * All other fields are left undefined — only sandbox + dataStore are used
 * by `reads.ts`.
 */
function makeCtx(opts: {
  syncFriendsCalled?: { flag: boolean };
  populated?: boolean;
}): { ctx: ClientContext; ds: MemoryDataStore } {
  const ds = new MemoryDataStore();

  let syncFriendsCalled = false;
  const userSlice = opts.populated ? smallGraphUserSliceFixture() : userSliceFixture({
    syncFriends: async () => { syncFriendsCalled = true; if (opts.syncFriendsCalled) opts.syncFriendsCalled.flag = true; },
  });
  if (!opts.populated && opts.syncFriendsCalled) {
    userSlice.syncFriends = async () => { opts.syncFriendsCalled!.flag = true; };
  }

  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({ user: userSlice }))
    .build();

  const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;
  return { ctx, ds };
}

/** Wrap a context into a `getCtx` thunk. */
function getCtxThunk(ctx: ClientContext): () => Promise<ClientContext> {
  return () => Promise.resolve(ctx);
}

// ── ensureSynced ──────────────────────────────────────────────────────────────

describe("friends/reads — ensureSynced", () => {
  test("calls syncFriends when mutuallyConfirmedFriendIds is empty", async () => {
    const callFlag = { flag: false };
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({
        user: userSliceFixture({ syncFriends: async () => { callFlag.flag = true; } }),
      }))
      .build();
    const ds = new MemoryDataStore();
    const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;

    await ensureSynced(getCtxThunk(ctx));
    expect(callFlag.flag).toBe(true);
  });

  test("does NOT call syncFriends when mutuals are already populated", async () => {
    const callFlag = { flag: false };
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({
        user: smallGraphUserSliceFixture({
          syncFriends: async () => { callFlag.flag = true; },
        }),
      }))
      .build();
    const ds = new MemoryDataStore();
    const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;

    await ensureSynced(getCtxThunk(ctx));
    expect(callFlag.flag).toBe(false);
  });

  test("does not throw when syncFriends rejects (best-effort)", async () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({
        user: userSliceFixture({ syncFriends: async () => { throw new Error("network fail"); } }),
      }))
      .build();
    const ds = new MemoryDataStore();
    const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;

    // Should resolve without throwing.
    await expect(ensureSynced(getCtxThunk(ctx))).resolves.toBeDefined();
  });
});

// ── snapshotFriends ───────────────────────────────────────────────────────────

describe("friends/reads — snapshotFriends", () => {
  test("returns a well-shaped FriendsSnapshot from an empty slice", async () => {
    const { ctx } = makeCtx({});
    const snap = await snapshotFriends(getCtxThunk(ctx));
    expect(Array.isArray(snap.mutuals)).toBe(true);
    expect(Array.isArray(snap.received)).toBe(true);
    expect(Array.isArray(snap.sent)).toBe(true);
  });

  test("returns populated mutuals when user slice has friends", async () => {
    const { ctx } = makeCtx({ populated: true });
    const snap = await snapshotFriends(getCtxThunk(ctx));
    expect(snap.mutuals).toHaveLength(5);
    expect(snap.mutuals[0]?.friendType).toBe("mutual");
  });

  test("returns received requests from incoming map", async () => {
    const { ctx } = makeCtx({ populated: true });
    const snap = await snapshotFriends(getCtxThunk(ctx));
    expect(snap.received).toHaveLength(1);
    expect(snap.received[0]?.fromUsername).toBe("incoming_alice");
  });

  test("returns sent requests from outgoing ids", async () => {
    const { ctx } = makeCtx({ populated: true });
    const snap = await snapshotFriends(getCtxThunk(ctx));
    expect(snap.sent).toHaveLength(2);
  });

  test("persists the graph cache into the DataStore after snapshot", async () => {
    const { ctx, ds } = makeCtx({ populated: true });
    await snapshotFriends(getCtxThunk(ctx));

    const cached = await loadGraphCache(ds);
    expect(cached).not.toBeUndefined();
    expect(cached!.mutuals).toHaveLength(5);
  });
});

// ── listFriends ───────────────────────────────────────────────────────────────

describe("friends/reads — listFriends", () => {
  test("returns mutuals array (subset of snapshot)", async () => {
    const { ctx } = makeCtx({ populated: true });
    const friends = await listFriends(getCtxThunk(ctx));
    expect(friends).toHaveLength(5);
    for (const f of friends) {
      expect(f.friendType).toBe("mutual");
      expect(typeof f.userId).toBe("string");
    }
  });

  test("returns empty array when user has no friends", async () => {
    const { ctx } = makeCtx({});
    expect(await listFriends(getCtxThunk(ctx))).toEqual([]);
  });
});

// ── listReceivedRequests ──────────────────────────────────────────────────────

describe("friends/reads — listReceivedRequests", () => {
  test("returns received requests from populated slice", async () => {
    const { ctx } = makeCtx({ populated: true });
    const received = await listReceivedRequests(getCtxThunk(ctx));
    expect(received).toHaveLength(1);
    expect(received[0]?.fromUsername).toBe("incoming_alice");
  });

  test("returns empty array for empty slice", async () => {
    const { ctx } = makeCtx({});
    expect(await listReceivedRequests(getCtxThunk(ctx))).toEqual([]);
  });
});

// ── listSentRequests ──────────────────────────────────────────────────────────

describe("friends/reads — listSentRequests", () => {
  test("returns sent requests from populated slice", async () => {
    const { ctx } = makeCtx({ populated: true });
    const sent = await listSentRequests(getCtxThunk(ctx));
    expect(sent).toHaveLength(2);
    expect(typeof sent[0]?.toUserId).toBe("string");
  });

  test("returns empty array for empty slice", async () => {
    const { ctx } = makeCtx({});
    expect(await listSentRequests(getCtxThunk(ctx))).toEqual([]);
  });
});

// ── refreshFriends ────────────────────────────────────────────────────────────

describe("friends/reads — refreshFriends", () => {
  test("calls syncFriends on the user slice", async () => {
    const callFlag = { flag: false };
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({
        user: userSliceFixture({ syncFriends: async () => { callFlag.flag = true; } }),
      }))
      .build();
    const ds = new MemoryDataStore();
    const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;

    await refreshFriends(getCtxThunk(ctx));
    expect(callFlag.flag).toBe(true);
  });

  test("resolves without throwing when syncFriends is missing", async () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({
        user: userSliceFixture({ syncFriends: undefined }),
      }))
      .build();
    const ds = new MemoryDataStore();
    const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;

    await expect(refreshFriends(getCtxThunk(ctx))).resolves.toBeUndefined();
  });

  test("resolves without throwing when syncFriends rejects (best-effort)", async () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({
        user: userSliceFixture({ syncFriends: async () => { throw new Error("timeout"); } }),
      }))
      .build();
    const ds = new MemoryDataStore();
    const ctx = { sandbox, dataStore: ds } as unknown as ClientContext;

    await expect(refreshFriends(getCtxThunk(ctx))).resolves.toBeUndefined();
  });
});
