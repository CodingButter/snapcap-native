/**
 * Snapshot builders — pure functions that turn a live `UserSlice` into
 * either the consumer-shape {@link FriendsSnapshot} or the persisted
 * id-set {@link FriendGraphSnapshot}.
 *
 * Plus the `saveGraphCacheGuarded` write helper that protects a
 * populated cache from being clobbered by an empty interim snapshot.
 *
 * @internal
 */
import type { PublicUserRecord, UserSlice } from "../../bundle/types/index.ts";
import type { DataStore } from "../../storage/data-store.ts";
import {
  type FriendGraphSnapshot,
  isEmptyGraphSnapshot,
  loadGraphCache,
  saveGraphCache,
} from "./graph-cache.ts";
import { makeFriend, makeSentRequest, mapReceivedRequestsMap, unwrapUserId } from "./mappers.ts";
import type { FriendsSnapshot } from "./types.ts";

/**
 * Build the id-set view of the friend graph used by the persistent
 * cache + diff machinery.
 *
 * Pure projection: no sync, no DataStore access. Materialization (rich
 * `Friend` / `ReceivedRequest` shapes) lives in {@link buildSnapshot};
 * this returns ONLY the three id-sets the {@link FriendGraphSnapshot}
 * persists, plus a wall-clock timestamp.
 *
 * Shared between the snapshot read path (which persists on every read
 * so single-call consumers seed the cache) and the diff-bridge tick
 * path (which persists after each fan-out so subsequent ticks diff
 * against the latest).
 *
 * @internal
 */
export function buildGraphSnapshot(user: UserSlice): FriendGraphSnapshot {
  return {
    mutuals: Array.isArray(user.mutuallyConfirmedFriendIds)
      ? user.mutuallyConfirmedFriendIds.map(unwrapUserId).filter((id) => id !== "")
      : [],
    outgoing: Array.isArray(user.outgoingFriendRequestIds)
      ? user.outgoingFriendRequestIds.map(unwrapUserId).filter((id) => id !== "")
      : [],
    incoming: user.incomingFriendRequests
      ? Array.from(user.incomingFriendRequests.keys())
          .map(unwrapUserId)
          .filter((id) => id !== "")
      : [],
    ts: Date.now(),
  };
}

/**
 * Persist `snap` only if doing so wouldn't clobber a previously-good
 * cache with an empty snapshot. The bundle's `state.user` slice can
 * legitimately project as `{mutuals:[], outgoing:[], incoming:[]}` during
 * boot before the first `SyncFriendData` lands; writing that over a
 * populated cache wipes the offline-replay baseline between SDK runs.
 *
 * Falls through to {@link saveGraphCache} when `snap` is non-empty OR
 * when no prior populated cache exists. Best-effort: failures are
 * swallowed (matches the underlying `saveGraphCache` contract).
 *
 * @internal
 */
export async function saveGraphCacheGuarded(
  ds: DataStore,
  snap: FriendGraphSnapshot,
): Promise<void> {
  if (isEmptyGraphSnapshot(snap)) {
    try {
      const prior = await loadGraphCache(ds);
      if (prior && !isEmptyGraphSnapshot(prior)) return;
    } catch { /* fall through to save attempt */ }
  }
  await saveGraphCache(ds, snap);
}

/**
 * Build a full `FriendsSnapshot` from a `UserSlice`. Pure — no sync, no
 * side effects. The single source of truth for snapshot shape; both the
 * top-level `snapshot()` accessor and the `onChange` subscriber path
 * funnel through here.
 *
 * @internal
 */
export function buildSnapshot(user: UserSlice): FriendsSnapshot {
  const publicUsers = user.publicUsers ?? new Map<string, PublicUserRecord>();
  const mutualIds = Array.isArray(user.mutuallyConfirmedFriendIds)
    ? user.mutuallyConfirmedFriendIds
    : [];
  const outgoingIds = Array.isArray(user.outgoingFriendRequestIds)
    ? user.outgoingFriendRequestIds
    : [];
  return {
    mutuals: mutualIds.map((id) => makeFriend(id, publicUsers)),
    received: mapReceivedRequestsMap(user.incomingFriendRequests),
    sent: outgoingIds.map((id) => makeSentRequest(id, publicUsers)),
  };
}
