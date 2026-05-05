/**
 * Friend-graph mutations — the five `*Friends` verbs the bundle's
 * `FriendAction` client exposes.
 *
 * Stateless free functions: every entry takes a `ClientContext` getter
 * (the trampoline pattern) so the {@link Friends} class can delegate to
 * a one-line method without leaking its private fields.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import { friendActionClient } from "../../bundle/register.ts";
import { makeFriendIdParams } from "../_helpers.ts";
import { FriendSource, type UserId } from "./types.ts";

/**
 * Verb dispatcher for the `jz` FriendAction client. Every mutation verb
 * accepts the same `{params: Array<{friendId: Uuid64Pair, source?}>}`
 * envelope; the only thing that varies is the method name. Centralizing
 * the dispatch keeps each public mutation a one-liner.
 *
 * `source` is only consumed by `Add`; the other verbs ignore it (and
 * `makeFriendIdParams` omits the field when `source === undefined`).
 *
 * `page` (origin / source-context label) — Snap's anti-spam silently drops
 * `AddFriends` requests that lack a recognized `page` string. Verified
 * empirically: bundle `AddFriends({page:"dweb_add_friend",params:[...]})`
 * call site at byte ~1447100 in chat main; SDK requests without it round-
 * tripped 200/grpc-status:0 but never delivered server-side. The literal
 * `dweb_add_friend` is the ONLY `dweb_*` mutation context string that
 * exists in the chat bundle — `Remove`/`Block`/`Unblock`/`Ignore` are not
 * called from this bundle with any `page` value, so they continue to omit
 * it. (The web SPA appears not to surface those verbs at all currently.)
 */
type FriendActionVerb = "Add" | "Remove" | "Block" | "Unblock" | "Ignore";

const FRIEND_ACTION_PAGE: Partial<Record<FriendActionVerb, string>> = {
  Add: "dweb_add_friend",
};

async function friendActionMutation(
  ctx: ClientContext,
  verb: FriendActionVerb,
  ids: UserId[],
  source?: number,
): Promise<void> {
  const params = makeFriendIdParams(ids, source);
  // String-keyed dispatch — TS can't statically prove the method exists
  // for every `${verb}Friends` form, hence the cast. The compile-time
  // surface is constrained by the `FriendActionVerb` union, and the
  // bundle's `JzFriendAction` interface lists every matching method.
  const client = friendActionClient(ctx.sandbox) as unknown as Record<
    string,
    (req: { params: unknown; page?: string }) => Promise<unknown>
  >;
  const page = FRIEND_ACTION_PAGE[verb];
  const req: { params: unknown; page?: string } = page === undefined
    ? { params }
    : { params, page };
  await client[`${verb}Friends`]!(req);
}

/** {@inheritDoc IFriendsManager.sendRequest} */
export async function sendFriendRequest(
  getCtx: () => Promise<ClientContext>,
  userId: UserId,
  opts?: { source?: FriendSource },
): Promise<void> {
  const ctx = await getCtx();
  return friendActionMutation(ctx, "Add", [userId], opts?.source ?? FriendSource.ADDED_BY_USERNAME);
}

/** {@inheritDoc IFriendsManager.remove} */
export async function removeFriend(
  getCtx: () => Promise<ClientContext>,
  userId: UserId,
): Promise<void> {
  const ctx = await getCtx();
  return friendActionMutation(ctx, "Remove", [userId]);
}

/** {@inheritDoc IFriendsManager.block} */
export async function blockUser(
  getCtx: () => Promise<ClientContext>,
  userId: UserId,
): Promise<void> {
  const ctx = await getCtx();
  return friendActionMutation(ctx, "Block", [userId]);
}

/** {@inheritDoc IFriendsManager.unblock} */
export async function unblockUser(
  getCtx: () => Promise<ClientContext>,
  userId: UserId,
): Promise<void> {
  const ctx = await getCtx();
  return friendActionMutation(ctx, "Unblock", [userId]);
}

/** {@inheritDoc IFriendsManager.acceptRequest} */
export async function acceptFriendRequest(
  getCtx: () => Promise<ClientContext>,
  userId: UserId,
): Promise<void> {
  const ctx = await getCtx();
  return friendActionMutation(ctx, "Add", [userId], FriendSource.ADDED_BY_ADDED_ME_BACK);
}

/** {@inheritDoc IFriendsManager.rejectRequest} */
export async function rejectFriendRequest(
  getCtx: () => Promise<ClientContext>,
  userId: UserId,
): Promise<void> {
  const ctx = await getCtx();
  return friendActionMutation(ctx, "Ignore", [userId]);
}
