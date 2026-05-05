/**
 * Friend-graph bundle accessors — `jz` FriendAction client and the
 * `N` FriendRequests client.
 *
 * Mutations to the social graph (add / remove / block / accept / reject)
 * route through these two getters from the api layer.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { FriendRequestsClient, JzFriendAction } from "../types/index.ts";
import { G_FRIEND_ACTION, G_FRIEND_REQUESTS_CLIENT } from "./patch-keys.ts";
import { reach } from "./reach.ts";

/**
 * Friend graph mutations — `jz` FriendAction client (chat module 10409).
 *
 * Methods: `TransferInvites`, `AddFriends`, `InviteFriends`,
 * `InviteOrAddFriendsByPhone`, `BlockFriends`, `UnblockFriends`,
 * `RemoveFriends`, `IgnoreFriends`, `ChangeDisplayNameForFriends`,
 * `MuteStoryForFriends`, `UnmuteStoryForFriends`,
 * `SetPostViewEmojiFoFriends`, `CheckActionEligibility`. See
 * {@link JzFriendAction} for the full surface.
 *
 * @internal Bundle-layer accessor. Public consumers reach friend ops via
 * the api layer (see `src/api/friends.ts` / `src/api/friending.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `jz` FriendAction client instance
 */
export const friendActionClient = (sandbox: Sandbox): JzFriendAction =>
  reach<JzFriendAction>(sandbox, G_FRIEND_ACTION, "friendActionClient");

/**
 * FriendRequests `N` client — chat main byte ~6940668. Methods: `Process`
 * (accept/reject/cancel via a oneof action) and `IncomingFriendSync`
 * (paginated incoming-requests pull; populates
 * `state.user.incomingFriendRequests`). Source-patched in `chat-loader.ts`
 * as `__SNAPCAP_FRIEND_REQUESTS`.
 *
 * @internal Bundle-layer accessor. Public consumers reach this surface via
 * `src/api/friends.ts` ({@link Friends.refresh} and the
 * `request:received` event bridge).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live FriendRequests `N` client instance
 */
export const friendRequestsClient = (sandbox: Sandbox): FriendRequestsClient =>
  reach<FriendRequestsClient>(sandbox, G_FRIEND_REQUESTS_CLIENT, "friendRequestsClient");
