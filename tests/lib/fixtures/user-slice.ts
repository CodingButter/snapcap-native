/**
 * Fixture builders for the chat-bundle `state.user` slice.
 *
 * Covers the friend-graph topologies the SDK reads:
 *   - empty (cold-fresh login)
 *   - small graph (5-10 mutuals, no pending)
 *   - large graph (200 mutuals, mixed publicUsers cache hits)
 *   - with-pending (incoming + outgoing requests)
 *
 * Every export is a function — fresh objects per call so tests that mutate
 * Maps/Arrays in-place don't bleed.
 *
 * Pair with {@link mockSandbox} from `../mock-sandbox.ts`.
 */
import type {
  IncomingFriendRequestRecord,
  PublicUserRecord,
  UserSlice,
} from "../../../src/bundle/types/index.ts";

/**
 * Default empty user slice — no friends, no pending requests, empty cache.
 * Matches the bundle's state immediately after construction (before
 * `syncFriends` returns).
 *
 * @param overrides - shape to merge onto the default.
 * @returns A fresh user slice.
 */
export function userSliceFixture(overrides: Partial<UserSlice> = {}): UserSlice {
  return {
    mutuallyConfirmedFriendIds: [],
    outgoingFriendRequestIds: [],
    incomingFriendRequests: new Map<string, IncomingFriendRequestRecord>(),
    publicUsers: new Map<string, PublicUserRecord>(),
    syncFriends: async () => {},
    ...overrides,
  };
}

/**
 * Small friend graph — 5 mutuals + 2 outgoing + 1 incoming + matching
 * publicUsers cache entries so consumer code sees fully-resolved
 * usernames / display names.
 *
 * Useful for tests of `snapshot-builders.ts`, `mappers.ts`, and the
 * `friends/manager.ts` surface.
 *
 * @param overrides - shape to merge onto the populated default.
 */
export function smallGraphUserSliceFixture(
  overrides: Partial<UserSlice> = {},
): UserSlice {
  const mutualIds = [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
    "44444444-4444-4444-4444-444444444444",
    "55555555-5555-5555-5555-555555555555",
  ];
  const outgoing = [
    "66666666-6666-6666-6666-666666666666",
    "77777777-7777-7777-7777-777777777777",
  ];
  const incomingId = "88888888-8888-8888-8888-888888888888";

  const publicUsers = new Map<string, PublicUserRecord>();
  for (const id of mutualIds) {
    publicUsers.set(id, {
      user_id: id,
      username: `friend_${id.slice(0, 4)}`,
      display_name: `Friend ${id.slice(0, 4)}`,
      mutable_username: `friend_${id.slice(0, 4)}`,
    });
  }
  for (const id of outgoing) {
    publicUsers.set(id, {
      user_id: id,
      username: `pending_${id.slice(0, 4)}`,
      display_name: `Pending ${id.slice(0, 4)}`,
    });
  }

  const incoming = new Map<string, IncomingFriendRequestRecord>([
    [incomingId, {
      user_id: incomingId,
      username: "incoming_alice",
      display_name: "Alice Incoming",
      added_timestamp_ms: 1_700_000_000_000,
      added_by: 2, // ADDED_BY_USERNAME
    }],
  ]);

  return {
    mutuallyConfirmedFriendIds: mutualIds,
    outgoingFriendRequestIds: outgoing,
    incomingFriendRequests: incoming,
    publicUsers,
    syncFriends: async () => {},
    ...overrides,
  };
}

/**
 * Large friend graph — 200 mutuals, with HALF cache-hits in `publicUsers`
 * (so half the resulting `Friend` objects have empty `username`). Useful
 * for stressing snapshot builders + `getUsers` cache-miss fallthrough.
 *
 * @param overrides - shape to merge.
 */
export function largeGraphUserSliceFixture(
  overrides: Partial<UserSlice> = {},
): UserSlice {
  const mutualIds: string[] = [];
  const publicUsers = new Map<string, PublicUserRecord>();
  for (let i = 0; i < 200; i++) {
    const id = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;
    mutualIds.push(id);
    if (i % 2 === 0) {
      publicUsers.set(id, {
        user_id: id,
        username: `bulk_${i}`,
        display_name: `Bulk ${i}`,
        mutable_username: `bulk_${i}`,
      });
    }
  }
  return {
    mutuallyConfirmedFriendIds: mutualIds,
    outgoingFriendRequestIds: [],
    incomingFriendRequests: new Map(),
    publicUsers,
    syncFriends: async () => {},
    ...overrides,
  };
}

/**
 * Friend slice projected through the `{id, str}` envelope variant — the
 * bundle sometimes leaves UUIDs in their wire shape rather than a flat
 * string. Tests of `unwrapUserId` and the snapshot builders' tolerance
 * for that variation can use this fixture.
 *
 * @param overrides - shape to merge.
 */
export function envelopedUserSliceFixture(
  overrides: Partial<UserSlice> = {},
): UserSlice {
  const id = "99999999-9999-9999-9999-999999999999";
  // Cast: real bundle slice typed as `string[]` but at runtime sometimes
  // carries `{id: Uint8Array, str: string}` envelopes — the fixture
  // preserves that runtime variation behind the typed shape.
  const enveloped = [
    { id: new Uint8Array(16), str: id },
  ] as unknown as string[];

  return {
    mutuallyConfirmedFriendIds: enveloped,
    outgoingFriendRequestIds: [],
    incomingFriendRequests: new Map(),
    publicUsers: new Map([
      [id, {
        user_id: id,
        username: "enveloped_user",
        display_name: "Enveloped User",
      }],
    ]),
    syncFriends: async () => {},
    ...overrides,
  };
}
