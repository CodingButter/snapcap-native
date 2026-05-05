/**
 * `getUsers()` — cache-first userId resolution.
 *
 * Stateless free function over a `ClientContext` getter; the
 * {@link Friends} class trampolines to it.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import { atlasClient, userSlice } from "../../bundle/register/index.ts";
import type { PublicUserRecord } from "../../bundle/types/index.ts";
import { bytesToUuid, uuidToBytes } from "../_helpers.ts";
import { makeUserFromCache, makeUserFromSnapchatter } from "./mappers.ts";
import type { User, UserId } from "./types.ts";

/** {@inheritDoc IFriendsManager.getUsers} */
export async function getUsers(
  getCtx: () => Promise<ClientContext>,
  userIds: UserId[],
  opts?: { refresh?: boolean },
): Promise<User[]> {
  if (userIds.length === 0) return [];
  const ctx = await getCtx();

  // Cache-first split: the bundle's `state.user.publicUsers` Map is
  // populated as a side-effect of search results / SyncFriendData and
  // shared with the SPA. Reading it before the RPC means common cases
  // (e.g. resolving usernames for a freshly-listed friend graph) cost
  // zero network — `GetSnapchatterPublicInfo` only fires for genuine
  // misses. `refresh: true` opts out and re-fetches every id.
  const cached = userSlice(ctx.sandbox).publicUsers ?? new Map<string, PublicUserRecord>();
  const toFetch = opts?.refresh
    ? userIds
    : userIds.filter((id) => !cached.has(id));

  // Per-call result map; populated from the cache (already-known IDs)
  // and from the RPC response (newly-fetched IDs). Keyed by hyphenated
  // UUID so the final input-order projection at the bottom is a
  // single `Map.get` per id.
  const resolved = new Map<UserId, User>();
  for (const id of userIds) {
    if (cached.has(id) && !opts?.refresh) {
      resolved.set(id, makeUserFromCache(id, cached));
    }
  }

  if (toFetch.length > 0) {
    try {
      // AtlasGw's wire shape uses `Uint8Array(16)` for userIds — the
      // hyphenated-string view is purely an SDK-public convenience.
      // `uuidToBytes` round-trips losslessly with `bytesToUuid` below.
      const resp = await atlasClient(ctx.sandbox).GetSnapchatterPublicInfo({
        userIds: toFetch.map((id) => uuidToBytes(id)),
      });
      for (const s of resp.snapchatters ?? []) {
        const id = bytesToUuid(s.userId);
        if (!id) continue;
        resolved.set(id, makeUserFromSnapchatter(id, s));
      }
    } catch {
      // Best-effort: a transport failure on the RPC shouldn't poison
      // the entire call. Cache-hit IDs are already in `resolved` and
      // remain useful; fetch-side IDs that didn't land surface as
      // `notFound: true` via the projection below — same shape
      // consumers handle for "server confirmed no record". Swallowing
      // here keeps the caller contract a single clean `User[]` in
      // input order, with notFound as the universal "couldn't
      // resolve" signal.
    }
  }

  // Project back into input order. Anything still unresolved (cache
  // miss + fetch failure / server omitted the id) becomes a
  // `notFound: true` slot — see {@link User} for the semantics.
  return userIds.map((id) =>
    resolved.get(id) ?? { userId: id, username: "", notFound: true },
  );
}
