/**
 * PURE reference test — `src/api/friends/mappers.ts`.
 *
 * Demonstrates the Phase-5 PURE pattern:
 *   - import the function under test directly from `src/`
 *   - construct a literal input + a literal cache
 *   - assert the function's return value is exactly what you expect
 *   - no `Sandbox`, no `mockSandbox`, no fixtures, no fetch
 *
 * Each `mappers.ts` export is a stateless input → output function over a
 * `Map<string, PublicUserRecord>` cache. The whole file fits this pattern.
 *
 * If the function under test had no I/O AND no bundle dependency, this is
 * the template to follow. See `tests/PATTERNS.md` for the decision tree.
 */
import { describe, expect, test } from "bun:test";
import {
  makeFriend,
  makeReceivedRequest,
  makeSentRequest,
  makeUserFromCache,
  mapReceivedRequestsMap,
  unwrapUserId,
} from "../../../src/api/friends/mappers.ts";
import type {
  IncomingFriendRequestRecord,
  PublicUserRecord,
} from "../../../src/bundle/types/index.ts";

const SAMPLE_ID = "11111111-2222-3333-4444-555555555555";

describe("friends/mappers — unwrapUserId", () => {
  test("returns string input unchanged", () => {
    expect(unwrapUserId(SAMPLE_ID)).toBe(SAMPLE_ID);
  });

  test("unwraps `{str}` envelope shape", () => {
    expect(unwrapUserId({ str: SAMPLE_ID })).toBe(SAMPLE_ID);
  });

  test("unwraps `{id: Uint8Array(16)}` envelope shape via bytesToUuid", () => {
    const bytes = new Uint8Array([
      0x11, 0x11, 0x11, 0x11,
      0x22, 0x22, 0x33, 0x33,
      0x44, 0x44, 0x55, 0x55,
      0x55, 0x55, 0x55, 0x55,
    ]);
    expect(unwrapUserId({ id: bytes })).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("returns empty string for unrecognized inputs", () => {
    expect(unwrapUserId(undefined)).toBe("");
    expect(unwrapUserId(null)).toBe("");
    expect(unwrapUserId({})).toBe("");
    expect(unwrapUserId({ id: new Uint8Array(8) })).toBe(""); // wrong byte length
    expect(unwrapUserId(42)).toBe("");
  });
});

describe("friends/mappers — makeFriend", () => {
  test("populates username/displayName from publicUsers cache when present", () => {
    const cache = new Map<string, PublicUserRecord>([
      [SAMPLE_ID, {
        user_id: SAMPLE_ID,
        username: "alice",
        display_name: "Alice A",
        mutable_username: "alice_2",
      }],
    ]);
    const friend = makeFriend(SAMPLE_ID, cache);
    expect(friend.userId).toBe(SAMPLE_ID);
    expect(friend.username).toBe("alice_2"); // mutable_username preferred
    expect(friend.displayName).toBe("Alice A");
    expect(friend.friendType).toBe("mutual");
  });

  test("falls back to empty username on cache miss (no throw)", () => {
    const friend = makeFriend(SAMPLE_ID, new Map());
    expect(friend.userId).toBe(SAMPLE_ID);
    expect(friend.username).toBe("");
    expect(friend.friendType).toBe("mutual");
  });

  test("accepts envelope-shape userId and unwraps it", () => {
    const cache = new Map<string, PublicUserRecord>([
      [SAMPLE_ID, { username: "bob" }],
    ]);
    const friend = makeFriend({ str: SAMPLE_ID }, cache);
    expect(friend.userId).toBe(SAMPLE_ID);
    expect(friend.username).toBe("bob");
  });
});

describe("friends/mappers — makeUserFromCache", () => {
  test("returns notFound when cache has no record", () => {
    const user = makeUserFromCache(SAMPLE_ID, new Map());
    expect(user.userId).toBe(SAMPLE_ID);
    expect(user.notFound).toBe(true);
    expect(user.username).toBe("");
  });

  test("populates username from mutable_username when both present", () => {
    const cache = new Map<string, PublicUserRecord>([
      [SAMPLE_ID, {
        username: "old_handle",
        mutable_username: "new_handle",
        display_name: "Display",
      }],
    ]);
    const user = makeUserFromCache(SAMPLE_ID, cache);
    expect(user.username).toBe("new_handle");
    expect(user.displayName).toBe("Display");
    expect(user.mutableUsername).toBe("new_handle");
    expect(user.notFound).toBeUndefined();
  });
});

describe("friends/mappers — makeReceivedRequest", () => {
  test("translates record to consumer shape", () => {
    const rec: IncomingFriendRequestRecord = {
      user_id: SAMPLE_ID,
      username: "carol",
      display_name: "Carol C",
      added_timestamp_ms: 1_700_000_000_000,
      added_by: 2,
    };
    const r = makeReceivedRequest(SAMPLE_ID, rec);
    expect(r.fromUserId).toBe(SAMPLE_ID);
    expect(r.fromUsername).toBe("carol");
    expect(r.fromDisplayName).toBe("Carol C");
    expect(r.receivedAt?.getTime()).toBe(1_700_000_000_000);
    expect(r.source).toBe(2);
  });
});

describe("friends/mappers — mapReceivedRequestsMap", () => {
  test("returns empty array on undefined / non-Map input", () => {
    expect(mapReceivedRequestsMap(undefined)).toEqual([]);
    // Cast: function defensively checks .entries is callable.
    expect(mapReceivedRequestsMap({} as unknown as Map<string, IncomingFriendRequestRecord>)).toEqual([]);
  });

  test("converts Map entries to ReceivedRequest array preserving order", () => {
    const map = new Map<string, IncomingFriendRequestRecord>([
      ["aaa", { username: "a" }],
      ["bbb", { username: "b" }],
    ]);
    const out = mapReceivedRequestsMap(map);
    expect(out).toHaveLength(2);
    expect(out[0]?.fromUserId).toBe("aaa");
    expect(out[1]?.fromUserId).toBe("bbb");
  });
});

describe("friends/mappers — makeSentRequest", () => {
  test("returns just toUserId on cache miss", () => {
    const r = makeSentRequest(SAMPLE_ID, new Map());
    expect(r).toEqual({ toUserId: SAMPLE_ID });
  });

  test("populates toUsername / toDisplayName when cache hit", () => {
    const cache = new Map<string, PublicUserRecord>([
      [SAMPLE_ID, { username: "dave", display_name: "Dave D", mutable_username: "dave_x" }],
    ]);
    const r = makeSentRequest(SAMPLE_ID, cache);
    expect(r.toUserId).toBe(SAMPLE_ID);
    expect(r.toUsername).toBe("dave_x");
    expect(r.toDisplayName).toBe("Dave D");
  });
});
