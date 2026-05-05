/**
 * STATE-DRIVEN reference test — `src/api/friends/snapshot-builders.ts` and
 * the registry getter `bundle/register/user.ts:userSlice`.
 *
 * Demonstrates the Phase-5 STATE-DRIVEN pattern:
 *   - construct a fixture {@link UserSlice} via `userSliceFixture(...)`
 *   - wrap into a {@link ChatState} via `chatStateFixture(...)`
 *   - hand to `mockSandbox().withChatStore(...)` so consumer code that
 *     calls `userSlice(sandbox)` reads the fixture state
 *   - exercise the function under test against the mock
 *   - assert on output
 *
 * No real bundle eval, no DOM, no fetch — runs in the same ms-class as a
 * pure test. Two tests in this file cover both the read path
 * (`userSlice` registry getter wired into the mock store) and the
 * snapshot-builder transformation (`buildSnapshot` over the slice).
 */
import { describe, expect, test } from "bun:test";
import { userSlice } from "../../../src/bundle/register/index.ts";
import {
  buildGraphSnapshot,
  buildSnapshot,
  saveGraphCacheGuarded,
} from "../../../src/api/friends/snapshot-builders.ts";
import { loadGraphCache } from "../../../src/api/friends/graph-cache.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  envelopedUserSliceFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";

describe("friends/snapshot-builders — buildSnapshot via userSlice(sandbox)", () => {
  test("empty slice → empty snapshot", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    const slice = userSlice(sandbox);
    const snap = buildSnapshot(slice);

    expect(snap.mutuals).toEqual([]);
    expect(snap.received).toEqual([]);
    expect(snap.sent).toEqual([]);
  });

  test("populated slice → fully-shaped snapshot", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: smallGraphUserSliceFixture() }))
      .build();

    const slice = userSlice(sandbox);
    const snap = buildSnapshot(slice);

    expect(snap.mutuals).toHaveLength(5);
    expect(snap.mutuals[0]?.username).toMatch(/^friend_/);
    expect(snap.mutuals[0]?.friendType).toBe("mutual");

    expect(snap.sent).toHaveLength(2);
    expect(snap.sent[0]?.toUsername).toMatch(/^pending_/);

    expect(snap.received).toHaveLength(1);
    expect(snap.received[0]?.fromUsername).toBe("incoming_alice");
    expect(snap.received[0]?.source).toBe(2);
  });

  test("envelope-shape userIds get unwrapped through the snapshot pipeline", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: envelopedUserSliceFixture() }))
      .build();

    const slice = userSlice(sandbox);
    const snap = buildSnapshot(slice);

    expect(snap.mutuals).toHaveLength(1);
    expect(snap.mutuals[0]?.userId).toBe("99999999-9999-9999-9999-999999999999");
    expect(snap.mutuals[0]?.username).toBe("enveloped_user");
  });
});

describe("friends/snapshot-builders — buildGraphSnapshot id-set projection", () => {
  test("returns the three id-arrays + a wall-clock timestamp", () => {
    const slice = smallGraphUserSliceFixture();
    const before = Date.now();
    const graph = buildGraphSnapshot(slice);
    const after = Date.now();

    expect(graph.mutuals).toHaveLength(5);
    expect(graph.outgoing).toHaveLength(2);
    expect(graph.incoming).toHaveLength(1);
    expect(graph.ts).toBeGreaterThanOrEqual(before);
    expect(graph.ts).toBeLessThanOrEqual(after);
  });

  test("filters out empty unwrapped ids", () => {
    const slice = userSliceFixture({
      // Cast: simulating runtime envelope variation through the typed shape.
      mutuallyConfirmedFriendIds: [
        "11111111-1111-1111-1111-111111111111",
        {} as unknown as string, // unrecognized → unwrapUserId returns ""
        "22222222-2222-2222-2222-222222222222",
      ],
    });
    const graph = buildGraphSnapshot(slice);
    expect(graph.mutuals).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });
});

describe("friends/snapshot-builders — saveGraphCacheGuarded", () => {
  test("saves a non-empty snapshot unconditionally", async () => {
    const ds = new MemoryDataStore();
    const snap = buildGraphSnapshot(smallGraphUserSliceFixture());
    await saveGraphCacheGuarded(ds, snap);

    const loaded = await loadGraphCache(ds);
    expect(loaded?.mutuals).toHaveLength(5);
  });

  test("refuses to clobber a populated cache with an empty snapshot", async () => {
    const ds = new MemoryDataStore();
    // Seed with a populated cache.
    await saveGraphCacheGuarded(
      ds,
      buildGraphSnapshot(smallGraphUserSliceFixture()),
    );

    // Try to overwrite with empty.
    await saveGraphCacheGuarded(
      ds,
      buildGraphSnapshot(userSliceFixture()),
    );

    const loaded = await loadGraphCache(ds);
    // Original cache survives.
    expect(loaded?.mutuals).toHaveLength(5);
  });

  test("saves empty snapshot when no prior cache existed", async () => {
    const ds = new MemoryDataStore();
    const empty = buildGraphSnapshot(userSliceFixture());
    await saveGraphCacheGuarded(ds, empty);

    const loaded = await loadGraphCache(ds);
    expect(loaded?.mutuals).toEqual([]);
    expect(loaded?.outgoing).toEqual([]);
    expect(loaded?.incoming).toEqual([]);
  });
});
