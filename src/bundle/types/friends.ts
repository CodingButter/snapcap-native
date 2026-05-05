/**
 * Friend-graph wire shapes — every `jz` FriendAction request envelope
 * the bundle's chat module 10409 accepts, plus the two client interfaces
 * (`JzFriendAction` for the bound action client, `FriendRequestsClient`
 * for the inbound-request `Process` / sync surface).
 *
 * Each request envelope is the verbatim shape the bundle's ts-proto
 * codecs expect at `fromPartial` time — `Uuid64Pair` for friend ids,
 * `params` arrays for batch operations.
 */
import type { Uuid64Pair } from "./shared.ts";

/**
 * One entry of an `AddFriends` request.
 *
 * @internal Bundle wire-format type.
 */
export type AddFriendParams = {
  friendId: Uuid64Pair;
  /** `FriendSource` enum value — see `api/friends.ts#FriendSource`. */
  source: number;
};

/**
 * `AddFriends` request envelope accepted by the `jz` FriendAction client.
 *
 * @internal Bundle wire-format type.
 */
export type AddFriendsRequest = {
  /** Origin label — Snap surfaces the source so analytics can attribute. */
  page?: string;
  params: AddFriendParams[];
};

/**
 * Friend-mutation request envelope shared by `RemoveFriends`,
 * `BlockFriends`, `UnblockFriends`, `IgnoreFriends`, and friends.
 *
 * @internal Bundle wire-format type.
 */
export type FriendMutationRequest = {
  page?: string;
  params: Array<{ friendId: Uuid64Pair }>;
};

/**
 * `TransferInvites` request. Captured shape unconfirmed — placeholder
 * until a recon HAR lands.
 *
 * @remarks TODO — refine: search `methodName:"TransferInvites"` in the
 * chat main bundle and trace the codec (`hz` from the FriendAction
 * declaration site around byte 1430000) to fill in the slot list.
 *
 * @internal Bundle wire-format type.
 */
export type TransferInvitesRequest = {
  page?: string;
  [k: string]: unknown;
};

/**
 * `InviteFriends` request. Same TODO posture as
 * {@link TransferInvitesRequest}.
 *
 * @internal Bundle wire-format type.
 */
export type InviteFriendsRequest = {
  page?: string;
  params: Array<{ friendId?: Uuid64Pair; phoneNumber?: string }>;
};

/**
 * `InviteOrAddFriendsByPhone` request. Same TODO posture.
 *
 * @internal Bundle wire-format type.
 */
export type InviteOrAddFriendsByPhoneRequest = {
  page?: string;
  phoneNumbers: string[];
};

/**
 * `MuteStoryForFriends` / `UnmuteStoryForFriends` request.
 *
 * @internal Bundle wire-format type.
 */
export type MuteStoryForFriendsRequest = {
  page?: string;
  params: Array<{ friendId: Uuid64Pair }>;
};

/**
 * `SetPostViewEmojiFoFriends` request — note the typo in the bundle's
 * method name.
 *
 * @internal Bundle wire-format type.
 */
export type SetPostViewEmojiForFriendsRequest = {
  page?: string;
  params: Array<{ friendId: Uuid64Pair; emoji?: string }>;
};

/**
 * `CheckActionEligibility` request — friend-graph precondition probe.
 * The bundle accepts `{params: [{friendId}]}`, same `Uuid64Pair` shape as
 * the mutation envelopes.
 *
 * @internal Bundle wire-format type.
 */
export type CheckActionEligibilityRequest = {
  params: Array<{ friendId: Uuid64Pair }>;
};

/**
 * `jz` FriendAction client (chat module 10409). Methods listed match the
 * full surface the bundle declares — declaration site at byte 1432651
 * in chat main, beginning `new class{rpc;constructor(e){this.rpc=e,
 * this.TransferInvites=this.TransferInvites.bind(this)...}`.
 *
 * @internal Bundle wire-format type.
 */
export interface JzFriendAction {
  TransferInvites(req: TransferInvitesRequest): Promise<unknown>;
  AddFriends(req: AddFriendsRequest): Promise<unknown>;
  InviteFriends(req: InviteFriendsRequest): Promise<unknown>;
  InviteOrAddFriendsByPhone(req: InviteOrAddFriendsByPhoneRequest): Promise<unknown>;
  RemoveFriends(req: FriendMutationRequest): Promise<unknown>;
  BlockFriends(req: FriendMutationRequest): Promise<unknown>;
  UnblockFriends(req: FriendMutationRequest): Promise<unknown>;
  IgnoreFriends(req: FriendMutationRequest): Promise<unknown>;
  ChangeDisplayNameForFriends(req: FriendMutationRequest & { displayName?: string }): Promise<unknown>;
  MuteStoryForFriends(req: MuteStoryForFriendsRequest): Promise<unknown>;
  UnmuteStoryForFriends(req: MuteStoryForFriendsRequest): Promise<unknown>;
  SetPostViewEmojiFoFriends(req: SetPostViewEmojiForFriendsRequest): Promise<unknown>;
  CheckActionEligibility(req: CheckActionEligibilityRequest): Promise<unknown>;
}

/**
 * `N` FriendRequests client (chat main byte ~6939950). Closure-private
 * inside the chat bundle; needs a source-patch to surface — see the
 * `G_FRIEND_REQUESTS_CLIENT` TODO in register.ts.
 *
 * @internal Bundle wire-format type.
 */
export interface FriendRequestsClient {
  /**
   * Process a single friend-request action — accept / reject / cancel.
   * The request body is a oneof'd discriminated union; the bundle's
   * codec `u` (closure-private to the same module) handles `fromPartial`.
   */
  Process: (req: { action?: { $case: string; [k: string]: unknown } }) => Promise<unknown>;
  /** Paginated list of incoming requests. `syncToken` opts in to delta sync. */
  IncomingFriendSync: (req: { syncToken?: string }) => Promise<unknown>;
}
