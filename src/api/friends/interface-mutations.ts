/**
 * Mutation surface of {@link IFriendsManager} — every verb that changes
 * the friend graph server-side.
 */
import type { FriendSource, UserId } from "./types.ts";

/**
 * Mutation methods on {@link IFriendsManager} — the `*Friends` verbs the
 * bundle's `FriendAction` client exposes.
 */
export interface IFriendsMutations {
  /**
   * Send a friend request / add a user to the friend list.
   *
   * Resolves once the server acknowledges.
   *
   * @param userId - Hyphenated UUID of the user to add.
   * @param opts - Advanced overrides; ignore for the common case. The
   * one knob is `source` — anti-spam attribution context (mirrors what
   * the SPA stamps on the request to identify which UI surface
   * triggered the add). Defaults to {@link FriendSource}`.ADDED_BY_USERNAME`.
   * Override only if you're explicitly mimicking a different UX flow
   * (QR-code add, deep-link add, etc.).
   *
   * @example
   * ```ts
   * await client.friends.sendRequest("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202");
   * ```
   * @example
   * Override the attribution source:
   * ```ts
   * import { FriendSource } from "@snapcap/native";
   * await client.friends.sendRequest(userId, { source: FriendSource.ADDED_BY_SEARCH });
   * ```
   */
  sendRequest(userId: UserId, opts?: { source?: FriendSource }): Promise<void>;

  /**
   * Remove a friend from the social graph.
   *
   * @deprecated Snap's web backend silently rejects this RPC. The call
   * goes through (HTTP 200, gRPC status 0), but the friendship is NOT
   * actually severed server-side. Calling this is a no-op from `web.snapchat.com`.
   * Kept on the interface for API symmetry and future mobile-emulation
   * support; do not depend on it for production logic today.
   *
   * @param userId - Hyphenated UUID of the friend to remove.
   *
   * @remarks
   * **Why this doesn't work:** Snap's web SPA itself doesn't expose
   * "Remove Friend" anywhere in its UI — friend mutations like remove,
   * block, and unblock are restricted to the mobile clients (iOS / Android)
   * and the server enforces this at the policy layer. We verified empirically:
   *
   * - The request reaches the server: `RemoveFriends → 200 grpc=0`.
   * - The body encodes correctly (we tested with empty `pageSessionId`,
   *   a random UUID, and the real `sc-a-nonce` session cookie value —
   *   all yield the same outcome).
   * - The bundle's chat module never calls `RemoveFriends` from any
   *   code path — the SPA's right-click menu on a friend chat shows
   *   only `Message Notifications`, `Delete Chats`, `Clear from Chat Feed`.
   * - After the call, `friends.list()` still returns the supposedly-removed
   *   account as mutual on both sides (we tested symmetric removes too).
   *
   * **What does work:** {@link IFriendsMutations.sendRequest} (web supports
   * AddFriends), {@link IFriendsMutations.acceptRequest},
   * {@link IFriendsMutations.rejectRequest}.
   *
   * **Workarounds:** none from web. To actually unfriend an account, the
   * user must do it from the official mobile app.
   *
   * @example
   * ```ts
   * // This will resolve without throwing, but the friendship persists:
   * await client.friends.remove(userId);
   * ```
   */
  remove(userId: UserId): Promise<void>;

  /**
   * Block a user — also removes any existing friend link.
   *
   * @param userId - Hyphenated UUID of the user to block.
   *
   * @example
   * ```ts
   * await client.friends.block(userId);
   * ```
   */
  block(userId: UserId): Promise<void>;

  /**
   * Unblock a previously-blocked user.
   *
   * @param userId - Hyphenated UUID of the user to unblock.
   */
  unblock(userId: UserId): Promise<void>;

  /**
   * Accept an incoming friend request.
   *
   * Equivalent on the wire to {@link IFriendsMutations.sendRequest} with
   * `source: ADDED_BY_ADDED_ME_BACK` — the SPA path. Surfaced as a named
   * verb because the inbox flow has its own consumer mental model;
   * `acceptRequest(req.fromUserId)` reads more clearly than
   * `sendRequest(req.fromUserId, { source: 4 })`.
   *
   * @param userId - Hyphenated UUID of the requester whose request to
   * accept (the `fromUserId` field on a {@link ReceivedRequest}).
   *
   * @example
   * ```ts
   * for (const req of await client.friends.receivedRequests()) {
   *   await client.friends.acceptRequest(req.fromUserId);
   * }
   * ```
   */
  acceptRequest(userId: UserId): Promise<void>;

  /**
   * Reject (ignore) an incoming friend request.
   *
   * Maps to Snap's `IgnoreFriends` RPC — the same path the SPA's
   * "Ignore" button uses. Once rejected, the request disappears from
   * {@link IFriendsReads.receivedRequests}.
   *
   * @param userId - Hyphenated UUID of the requester whose request to
   * reject (the `fromUserId` field on a {@link ReceivedRequest}).
   *
   * @example
   * ```ts
   * await client.friends.rejectRequest(req.fromUserId);
   * ```
   */
  rejectRequest(userId: UserId): Promise<void>;
}
