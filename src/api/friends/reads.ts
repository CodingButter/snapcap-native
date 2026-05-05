/**
 * Friend-graph reads — `snapshot` / `list` / `receivedRequests` /
 * `sentRequests` / `refresh`, plus the shared sync gate.
 *
 * Stateless free functions over a `ClientContext` getter. The split
 * accessors (`list`, `receivedRequests`, `sentRequests`) all project
 * off `snapshotFriends` so the read-side sync gap is instrumentable in
 * exactly one place.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import { userSlice } from "../../bundle/register.ts";
import type { UserSlice } from "../../bundle/types.ts";
import { buildGraphSnapshot, buildSnapshot, saveGraphCacheGuarded } from "./snapshot-builders.ts";
import type { Friend, FriendsSnapshot, ReceivedRequest, SentRequest } from "./types.ts";

/**
 * Single sync gate. Triggers `userSlice().syncFriends()` once when the
 * mutuals slot is empty. Idempotent and best-effort: failures are
 * swallowed so reads can still surface whatever is already in state.
 *
 * NOTE: behavior intentionally preserved from the previous split
 * implementation — the read-sync gap is a separate debug task.
 *
 * @internal
 */
export async function ensureSynced(
  getCtx: () => Promise<ClientContext>,
): Promise<UserSlice> {
  const ctx = await getCtx();
  let user = userSlice(ctx.sandbox);
  if (
    typeof user.syncFriends === "function" &&
    (!Array.isArray(user.mutuallyConfirmedFriendIds) || user.mutuallyConfirmedFriendIds.length === 0)
  ) {
    try { await user.syncFriends(); }
    catch { /* best-effort — readers can still return whatever's in state */ }
    user = userSlice(ctx.sandbox);
  }
  return user;
}

/**
 * Build the id-set snapshot from a live `UserSlice` and persist it
 * into the per-instance DataStore under the graph-cache key.
 *
 * Best-effort, fire-and-forget: the underlying `saveGraphCache`
 * swallows persistence errors so a failing flush never poisons the
 * read or the live event fan-out. Shared between the snapshot read
 * path and the diff-bridge tick path so both code routes write the
 * same shape under the same key.
 *
 * @internal
 */
export async function persistGraphSnapshotFrom(
  getCtx: () => Promise<ClientContext>,
  user: UserSlice,
): Promise<void> {
  try {
    const ctx = await getCtx();
    await saveGraphCacheGuarded(ctx.dataStore, buildGraphSnapshot(user));
  } catch {
    /* persistence failures shouldn't poison the read */
  }
}

/** {@inheritDoc IFriendsManager.snapshot} */
export async function snapshotFriends(
  getCtx: () => Promise<ClientContext>,
): Promise<FriendsSnapshot> {
  const user = await ensureSynced(getCtx);
  // Persist the id-set cache on every snapshot read. The diff-style
  // event bridge below also writes this key on every selector tick,
  // but bridges only run when someone has subscribed — without this
  // call, a consumer that ONLY uses `list()` / `snapshot()` would
  // never seed the persisted graph cache, and a future subscriber
  // would have nothing to replay deltas against. Routing every read
  // through the same DataStore key keeps single-source-of-truth and
  // ensures cold-start consumers find a populated cache.
  //
  // Awaited (not fire-and-forget) so consumers that immediately
  // `process.exit()` after a single `list()` / `snapshot()` still
  // see the cache key flushed to disk. The FileDataStore flush is a
  // synchronous `writeFileSync` under one `await`, matching every
  // other DataStore write the SDK does — bounded cost.
  await persistGraphSnapshotFrom(getCtx, user);
  return buildSnapshot(user);
}

/** {@inheritDoc IFriendsManager.refresh} */
export async function refreshFriends(
  getCtx: () => Promise<ClientContext>,
): Promise<void> {
  const ctx = await getCtx();
  const slice = userSlice(ctx.sandbox);

  // ONE explicit call drives BOTH endpoints. The bundle's `syncFriends`
  // (which fires `SyncFriendData` for mutuals + outgoing) cascades
  // internally into `IncomingFriendSync` via a state-listener — verified
  // empirically. Calling `IncomingFriendSync` ourselves on top of this
  // is redundant: it adds a wire call AND races the bundle's delta-token
  // bookkeeping (forcing full syncs instead of token-bearing deltas).
  if (typeof slice.syncFriends === "function") {
    try { await slice.syncFriends(); }
    catch { /* best-effort — readers fall back to whatever's in cache */ }
  }
}

/** {@inheritDoc IFriendsManager.list} */
export async function listFriends(
  getCtx: () => Promise<ClientContext>,
): Promise<Friend[]> {
  return (await snapshotFriends(getCtx)).mutuals;
}

/** {@inheritDoc IFriendsManager.receivedRequests} */
export async function listReceivedRequests(
  getCtx: () => Promise<ClientContext>,
): Promise<ReceivedRequest[]> {
  return (await snapshotFriends(getCtx)).received;
}

/** {@inheritDoc IFriendsManager.sentRequests} */
export async function listSentRequests(
  getCtx: () => Promise<ClientContext>,
): Promise<SentRequest[]> {
  return (await snapshotFriends(getCtx)).sent;
}
