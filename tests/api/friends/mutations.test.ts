/**
 * NETWORK tests — `src/api/friends/mutations.ts`.
 *
 * `mutations.ts` dispatches string-keyed methods on the `jz` FriendAction
 * client that comes from the bundle registry (`friendActionClient(sandbox)`).
 * Rather than stubbing `globalThis.fetch`, we inject a fake client object
 * directly via `mockSandbox().withGlobal("__SNAPCAP_JZ", fakeClient)`.
 *
 * Each test asserts that the correct method was called and that the
 * request payload has the expected shape (page string for Add, no page
 * for other verbs, correct source value).
 */
import { describe, expect, test } from "bun:test";
import {
  acceptFriendRequest,
  blockUser,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  unblockUser,
} from "../../../src/api/friends/mutations.ts";
import { FriendSource } from "../../../src/api/friends/types.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, userSliceFixture } from "../../lib/fixtures/index.ts";
import type { ClientContext } from "../../../src/api/_context.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Captured call from the fake FriendAction client. */
interface FakeCall {
  method: string;
  req: { params?: unknown; page?: string };
}

/**
 * Build a fake FriendAction client that records calls and resolves immediately.
 * Returns the call log and the client object. Inject via
 * `withGlobal("__SNAPCAP_JZ", fakeFriendActionClient())`.
 */
function fakeFriendActionClient(): { calls: FakeCall[]; client: Record<string, (req: unknown) => Promise<void>> } {
  const calls: FakeCall[] = [];
  const client: Record<string, (req: unknown) => Promise<void>> = new Proxy({}, {
    get: (_t, prop) => async (req: unknown) => {
      calls.push({ method: String(prop), req: req as FakeCall["req"] });
    },
  }) as Record<string, (req: unknown) => Promise<void>>;
  return { calls, client };
}

const SAMPLE_ID = "11111111-2222-3333-4444-555555555555";

/**
 * Build a ClientContext whose sandbox has the fake FriendAction client
 * stubbed under `__SNAPCAP_JZ`.
 */
function makeCtxWithFake(fakeClient: Record<string, (req: unknown) => Promise<void>>): ClientContext {
  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({ user: userSliceFixture() }))
    .withGlobal("__SNAPCAP_JZ", fakeClient)
    .build();
  const ds = new MemoryDataStore();
  return { sandbox, dataStore: ds } as unknown as ClientContext;
}

function getCtxThunk(ctx: ClientContext): () => Promise<ClientContext> {
  return () => Promise.resolve(ctx);
}

// ── sendFriendRequest ─────────────────────────────────────────────────────────

describe("friends/mutations — sendFriendRequest", () => {
  test("calls AddFriends with page='dweb_add_friend' and source=ADDED_BY_USERNAME", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await sendFriendRequest(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("AddFriends");
    expect(calls[0]?.req.page).toBe("dweb_add_friend");
    const params = calls[0]?.req.params as Array<{ friendId: unknown; source?: number }>;
    expect(Array.isArray(params)).toBe(true);
    expect(params).toHaveLength(1);
    expect(params[0]?.source).toBe(FriendSource.ADDED_BY_USERNAME);
  });

  test("respects an explicit source override", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await sendFriendRequest(getCtxThunk(ctx), SAMPLE_ID, { source: FriendSource.ADDED_BY_SEARCH });

    const params = calls[0]?.req.params as Array<{ source?: number }>;
    expect(params[0]?.source).toBe(FriendSource.ADDED_BY_SEARCH);
  });

  test("friendId param has highBits and lowBits fields", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await sendFriendRequest(getCtxThunk(ctx), SAMPLE_ID);

    const params = calls[0]?.req.params as Array<{ friendId: { highBits: string; lowBits: string } }>;
    expect(typeof params[0]?.friendId.highBits).toBe("string");
    expect(typeof params[0]?.friendId.lowBits).toBe("string");
  });
});

// ── removeFriend ──────────────────────────────────────────────────────────────

describe("friends/mutations — removeFriend", () => {
  test("calls RemoveFriends without a page field", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await removeFriend(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls[0]?.method).toBe("RemoveFriends");
    expect(calls[0]?.req.page).toBeUndefined();
  });

  test("does not include a source field in params", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await removeFriend(getCtxThunk(ctx), SAMPLE_ID);

    const params = calls[0]?.req.params as Array<{ source?: number }>;
    expect(params[0]?.source).toBeUndefined();
  });
});

// ── blockUser ─────────────────────────────────────────────────────────────────

describe("friends/mutations — blockUser", () => {
  test("calls BlockFriends without page or source", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await blockUser(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls[0]?.method).toBe("BlockFriends");
    expect(calls[0]?.req.page).toBeUndefined();
    const params = calls[0]?.req.params as Array<{ source?: number }>;
    expect(params[0]?.source).toBeUndefined();
  });
});

// ── unblockUser ───────────────────────────────────────────────────────────────

describe("friends/mutations — unblockUser", () => {
  test("calls UnblockFriends without page or source", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await unblockUser(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls[0]?.method).toBe("UnblockFriends");
    expect(calls[0]?.req.page).toBeUndefined();
  });
});

// ── acceptFriendRequest ───────────────────────────────────────────────────────

describe("friends/mutations — acceptFriendRequest", () => {
  test("calls AddFriends with source=ADDED_BY_ADDED_ME_BACK", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await acceptFriendRequest(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls[0]?.method).toBe("AddFriends");
    const params = calls[0]?.req.params as Array<{ source?: number }>;
    expect(params[0]?.source).toBe(FriendSource.ADDED_BY_ADDED_ME_BACK);
  });

  test("includes page='dweb_add_friend' (same code path as sendFriendRequest)", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await acceptFriendRequest(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls[0]?.req.page).toBe("dweb_add_friend");
  });
});

// ── rejectFriendRequest ───────────────────────────────────────────────────────

describe("friends/mutations — rejectFriendRequest", () => {
  test("calls IgnoreFriends without page or source", async () => {
    const { calls, client } = fakeFriendActionClient();
    const ctx = makeCtxWithFake(client);

    await rejectFriendRequest(getCtxThunk(ctx), SAMPLE_ID);

    expect(calls[0]?.method).toBe("IgnoreFriends");
    expect(calls[0]?.req.page).toBeUndefined();
    const params = calls[0]?.req.params as Array<{ source?: number }>;
    expect(params[0]?.source).toBeUndefined();
  });
});
