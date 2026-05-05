/**
 * STATE-DRIVEN tests — `src/api/friends/get-users.ts`.
 *
 * `getUsers` is cache-first: reads `userSlice(sandbox).publicUsers`, then
 * calls `atlasClient(sandbox).GetSnapchatterPublicInfo` only for cache
 * misses (or always when `opts.refresh = true`).
 *
 * We inject a fake AtlasGw client via `mockSandbox().withGlobal("__SNAPCAP_ATLAS", fakeAtlas)`
 * so the RPC path is exercised without real network I/O.
 *
 * Coverage:
 *  - Empty input → empty output.
 *  - All ids cache-hit → no RPC call.
 *  - Cache miss → RPC called; result merged into output.
 *  - Mixed hit/miss → only misses go to RPC.
 *  - `opts.refresh=true` → all ids sent to RPC regardless of cache.
 *  - RPC failure → notFound placeholder (no throw).
 *  - Output preserves input order.
 *  - Server omits an id → notFound placeholder for that id.
 */
import { describe, expect, test } from "bun:test";
import { getUsers } from "../../../src/api/friends/get-users.ts";
import { uuidToBytes } from "../../../src/api/_helpers.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import type { PublicUserRecord } from "../../../src/bundle/types/index.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Fake AtlasGw RPC response entry. */
interface FakeSnapchatter {
  userId: Uint8Array;
  username?: string;
  mutableUsername?: string;
  displayName?: string;
}

/**
 * Build a fake AtlasGw client that records `GetSnapchatterPublicInfo` calls
 * and returns the provided canned snapchatters.
 */
function fakeAtlasClient(snapchatters: FakeSnapchatter[] = []): {
  calls: Array<{ userIds: Uint8Array[] }>;
  client: { GetSnapchatterPublicInfo: (req: { userIds: Uint8Array[] }) => Promise<{ snapchatters: FakeSnapchatter[] }> };
} {
  const calls: Array<{ userIds: Uint8Array[] }> = [];
  return {
    calls,
    client: {
      GetSnapchatterPublicInfo: async (req) => {
        calls.push({ userIds: req.userIds });
        return { snapchatters };
      },
    },
  };
}

/** Build a ClientContext with a populated publicUsers cache and optional Atlas stub. */
function makeCtx(opts: {
  publicUsers?: Map<string, PublicUserRecord>;
  atlasSnapchatters?: FakeSnapchatter[];
  atlasThrows?: boolean;
}): { ctx: ClientContext; atlasCalls: Array<{ userIds: Uint8Array[] }> } {
  const { calls, client } = fakeAtlasClient(opts.atlasSnapchatters ?? []);

  let atlasToInject: typeof client | { GetSnapchatterPublicInfo: () => never };
  if (opts.atlasThrows) {
    atlasToInject = {
      GetSnapchatterPublicInfo: () => { throw new Error("network error"); },
    };
  } else {
    atlasToInject = client;
  }

  const userSlice = userSliceFixture({ publicUsers: opts.publicUsers ?? new Map() });

  const sandbox = mockSandbox()
    .withChatStore(chatStateFixture({ user: userSlice }))
    .withGlobal("__SNAPCAP_ATLAS", atlasToInject)
    .build();

  const ctx = { sandbox, dataStore: new MemoryDataStore() } as unknown as ClientContext;
  return { ctx, atlasCalls: calls };
}

function getCtxThunk(ctx: ClientContext): () => Promise<ClientContext> {
  return () => Promise.resolve(ctx);
}

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ── getUsers ──────────────────────────────────────────────────────────────────

describe("friends/get-users — getUsers", () => {
  test("returns empty array for empty input (no RPC call)", async () => {
    const { ctx, atlasCalls } = makeCtx({});
    const result = await getUsers(getCtxThunk(ctx), []);
    expect(result).toEqual([]);
    expect(atlasCalls).toHaveLength(0);
  });

  test("returns cache-hit users without calling RPC", async () => {
    const { ctx, atlasCalls } = makeCtx({
      publicUsers: new Map([
        [ID_A, { username: "alice", mutable_username: "alice_x", display_name: "Alice" }],
      ]),
    });
    const result = await getUsers(getCtxThunk(ctx), [ID_A]);
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe(ID_A);
    expect(result[0]?.username).toBe("alice_x");
    expect(atlasCalls).toHaveLength(0);
  });

  test("calls RPC for cache-miss ids", async () => {
    const { ctx, atlasCalls } = makeCtx({
      atlasSnapchatters: [
        { userId: uuidToBytes(ID_A), username: "bob", mutableUsername: "bob_x" },
      ],
    });
    const result = await getUsers(getCtxThunk(ctx), [ID_A]);
    expect(atlasCalls).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.username).toBe("bob_x");
  });

  test("only sends cache-miss ids to RPC when some are cached", async () => {
    const { ctx, atlasCalls } = makeCtx({
      publicUsers: new Map([
        [ID_A, { username: "alice", mutable_username: "alice_x" }],
      ]),
      atlasSnapchatters: [
        { userId: uuidToBytes(ID_B), username: "bob" },
      ],
    });
    const result = await getUsers(getCtxThunk(ctx), [ID_A, ID_B]);
    // Only ID_B should have been sent to the RPC.
    expect(atlasCalls).toHaveLength(1);
    expect(atlasCalls[0]?.userIds).toHaveLength(1);
    expect(result).toHaveLength(2);
    expect(result[0]?.username).toBe("alice_x");
    expect(result[1]?.username).toBe("bob");
  });

  test("opts.refresh=true sends ALL ids to RPC even if cached", async () => {
    const { ctx, atlasCalls } = makeCtx({
      publicUsers: new Map([
        [ID_A, { username: "old_alice" }],
      ]),
      atlasSnapchatters: [
        { userId: uuidToBytes(ID_A), username: "new_alice" },
      ],
    });
    const result = await getUsers(getCtxThunk(ctx), [ID_A], { refresh: true });
    expect(atlasCalls).toHaveLength(1);
    expect(atlasCalls[0]?.userIds).toHaveLength(1);
    // Refreshed result from RPC.
    expect(result[0]?.username).toBe("new_alice");
  });

  test("RPC failure returns notFound placeholder without throwing", async () => {
    const { ctx } = makeCtx({ atlasThrows: true });
    const result = await getUsers(getCtxThunk(ctx), [ID_A]);
    expect(result).toHaveLength(1);
    expect(result[0]?.notFound).toBe(true);
    expect(result[0]?.userId).toBe(ID_A);
  });

  test("server omitting an id in response → notFound placeholder for that id", async () => {
    const { ctx } = makeCtx({
      atlasSnapchatters: [
        // Server returns only ID_B; ID_A is omitted.
        { userId: uuidToBytes(ID_B), username: "bob" },
      ],
    });
    const result = await getUsers(getCtxThunk(ctx), [ID_A, ID_B]);
    expect(result).toHaveLength(2);
    // Input order preserved.
    expect(result[0]?.userId).toBe(ID_A);
    expect(result[0]?.notFound).toBe(true);
    expect(result[1]?.userId).toBe(ID_B);
    expect(result[1]?.notFound).toBeUndefined();
  });

  test("output preserves input order regardless of RPC response order", async () => {
    const { ctx } = makeCtx({
      atlasSnapchatters: [
        // Return in reverse order.
        { userId: uuidToBytes(ID_C), username: "carol" },
        { userId: uuidToBytes(ID_A), username: "alice" },
        { userId: uuidToBytes(ID_B), username: "bob" },
      ],
    });
    const result = await getUsers(getCtxThunk(ctx), [ID_A, ID_B, ID_C]);
    expect(result[0]?.userId).toBe(ID_A);
    expect(result[1]?.userId).toBe(ID_B);
    expect(result[2]?.userId).toBe(ID_C);
  });
});
