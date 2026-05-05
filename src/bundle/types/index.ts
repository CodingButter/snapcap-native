/**
 * Bundle wire-format types — public barrel.
 *
 * Each sibling file owns a single Snap-bundle domain (friends, messaging,
 * presence, …). Consumers import from this directory by name; internal
 * cross-references between sibling files use direct relative paths so
 * the dependency graph stays explicit.
 *
 * Explicit named re-exports (not `export *`) keep the public surface
 * predictable and surface accidental exports at review time.
 *
 * What lives here:
 *   - Entity interfaces — the live class / module shapes (`JzFriendAction`,
 *     `NiChatRpc`, `FiUpload`, `SendsModule`, `AuthSlice`, `LoginClientCtor`,
 *     `AtlasGwClassCtor`, etc.). Each method on these interfaces declares
 *     its request envelope inline (or via a named request type below).
 *   - The bundle's request envelopes (e.g. `AddFriendsRequest` with
 *     `Uuid64Pair` `friendId` fields, exactly as the bundle's `jz`
 *     FriendAction client expects).
 *   - Bundle-realm primitives (`ConversationRef`, `Uuid64Pair`, `UnaryFn`).
 *   - The bundle's resolve shapes (`FetchConversationWithMessagesResult`).
 *   - WebLoginService request / response — the bundle ts-proto
 *     `fromPartial` / decoded surfaces.
 *
 * What does NOT live here:
 *   - Consumer-friendly request shapes (UUID-string args, plain numbers
 *     instead of bytes16 envelopes, Date instead of bigint timestamps).
 *     Those live in the api file that owns the verb.
 *   - Snap's internal class shapes that don't appear in the registry's
 *     export signatures. Those stay closure-private to the registry's
 *     local interface declarations.
 *   - Webpack module IDs in any type name.
 *
 * Conventions:
 *   - ts-proto `oneof` → discriminated union with `$case`.
 *   - UUIDs in friending payloads travel as `{highBits, lowBits}` 64-bit
 *     pairs; the bundle's codecs accept `bigint | string`.
 *   - Response fields the SDK doesn't currently read are typed as
 *     `unknown` so consumers don't accidentally rely on speculative
 *     shapes.
 */

export type {
  ConversationRef,
  GrpcMethodDesc,
  UnaryFn,
  Uuid64Pair,
} from "./shared.ts";

export type {
  CapturedSnap,
  DestinationsModule,
  SnapDestinations,
  StoryDescModule,
  StoryManager,
} from "./snap.ts";

export type {
  AddFriendParams,
  AddFriendsRequest,
  CheckActionEligibilityRequest,
  FriendMutationRequest,
  FriendRequestsClient,
  InviteFriendsRequest,
  InviteOrAddFriendsByPhoneRequest,
  JzFriendAction,
  MuteStoryForFriendsRequest,
  SetPostViewEmojiForFriendsRequest,
  TransferInvitesRequest,
} from "./friends.ts";

export type { FetchConversationWithMessagesResult } from "./conversations.ts";

export type { SendsModule, Session } from "./messaging.ts";

export type { FiUpload } from "./media.ts";

export type {
  AtlasGwClassCtor,
  AtlasGwClient,
  DefaultAuthedFetchModule,
  HostModule,
  NiChatRpc,
  UserInfoClient,
} from "./rpc.ts";

export type {
  AuthSlice,
  ChatState,
  ChatStore,
  IncomingFriendRequestRecord,
  MessagingSlice,
  PublicUserRecord,
  SnapchatterPublicInfo,
  UserSlice,
} from "./chat-store.ts";

export type { BundlePresenceSession, PresenceSlice } from "./presence.ts";

export type { LoginClientCtor, WebLoginRequest, WebLoginResponse } from "./login.ts";

export type {
  DecodedSearchResponse,
  DecodedSearchSection,
  DecodedSearchUserResult,
  SearchRequestCodec,
  SearchResponseCodec,
} from "./search.ts";
