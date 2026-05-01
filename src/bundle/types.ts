/**
 * Bundle-shaped types — what Snap's webpack methods expect as input and
 * return as output. The manager-getter exports in `./register.ts` return
 * live instances typed against the entity interfaces declared here; the
 * api layer (`../api/*.ts`) calls methods on those instances directly,
 * converting between bundle and consumer shapes via helpers in
 * `../api/_helpers.ts`.
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
// ─── Shared primitives ───────────────────────────────────────────────────

/**
 * Snap's bundle ships every gRPC method as a "descriptor" — an object with
 * `methodName`, `service.serviceName`, `requestType.serializeBinary`, and
 * `responseType.decode` (newer ts-proto modules) or
 * `responseType.deserializeBinary` (older protoc-gen-grpc-web modules,
 * AtlasGw etc.). Both have `requestType.serializeBinary`; only the
 * response side differs.
 *
 * Lives in the bundle/types module because it's the bundle's wire-shape
 * descriptor — every api file that builds one is producing input the
 * bundle's transport accepts. The runtime helper that consumes it
 * (`callRpc`) still lives in `transport/grpc-web.ts`.
 */
export type GrpcMethodDesc<Req, Resp> = {
  methodName: string;
  service: { serviceName: string };
  requestType: { serializeBinary: (this: Req) => Uint8Array };
  responseType:
    | { decode: (b: Uint8Array) => Resp }
    | { deserializeBinary: (b: Uint8Array) => Resp };
};

/**
 * UUID encoded as a 64-bit high/low bigint pair — the convention used by
 * Snap's friending protos. The bundle's ts-proto codecs accept both
 * stringified and `bigint` inputs at `fromPartial` time.
 */
export type Uuid64Pair = { highBits: bigint | string; lowBits: bigint | string };

/**
 * Generic gRPC unary fn shape — same structural type as
 * `Ni.rpc.unary` and `LoginClient`'s constructor argument. Re-exported
 * here so consumers passing a custom transport into `submitLogin` etc.
 * have a public type to satisfy.
 */
export type UnaryFn = <TReq, TResp>(
  desc: GrpcMethodDesc<TReq, TResp>,
  req: TReq,
  metadata?: unknown,
) => Promise<TResp>;

/**
 * Conversation reference envelope used by every send-side bundle method —
 * `{id: bytes16, str: hyphenated-uuid}`. The api layer builds these via
 * `makeConversationRef` (in `../api/_helpers.ts`); the registry exports
 * accept this shape directly without doing any UUID parsing themselves.
 */
export type ConversationRef = { id: Uint8Array; str: string };

// ─── Snap send payload ──────────────────────────────────────────────────

/**
 * Destinations envelope returned by the bundle's `Ju` builder (module 79028)
 * and consumed by `sendSnap`. `conversations` are `ConversationRef`s
 * (bytes16-wrapped); `stories` / `phoneNumbers` / `massSnaps` are
 * bundle-internal struct shapes the SDK passes through opaquely.
 */
export type SnapDestinations = {
  conversations: ConversationRef[];
  stories: unknown[];
  phoneNumbers: unknown[];
  massSnaps: unknown[];
};

/** Captured-media payload accepted by the bundle's `sendSnap` entry. */
export type CapturedSnap = {
  mediaType: number;
  media: unknown;
  overlayMedia?: unknown;
  hasAudio?: boolean;
  loopPlayback?: boolean;
  width?: number;
  height?: number;
  durationInSec?: number;
};

// ─── Friend graph mutation requests ─────────────────────────────────────

/** One entry of an `AddFriends` request. */
export type AddFriendParams = {
  friendId: Uuid64Pair;
  /** `FriendSource` enum value — see `api/friends.ts#FriendSource`. */
  source: number;
};

export type AddFriendsRequest = {
  /** Origin label — Snap surfaces the source so analytics can attribute. */
  page?: string;
  params: AddFriendParams[];
};

/** All other friend-mutation methods accept the same envelope. */
export type FriendMutationRequest = {
  page?: string;
  params: Array<{ friendId: Uuid64Pair }>;
};

/**
 * `TransferInvites` request. Captured shape unconfirmed — placeholder
 * until a recon HAR lands.
 *
 * TODO: refine — search `methodName:"TransferInvites"` in the chat main
 * bundle and trace the codec (`hz` from the FriendAction declaration site
 * around byte 1430000) to fill in the slot list.
 */
export type TransferInvitesRequest = {
  page?: string;
  [k: string]: unknown;
};

/** `InviteFriends` request. Same TODO posture as `TransferInvitesRequest`. */
export type InviteFriendsRequest = {
  page?: string;
  params: Array<{ friendId?: Uuid64Pair; phoneNumber?: string }>;
};

/** `InviteOrAddFriendsByPhone` request. Same TODO posture. */
export type InviteOrAddFriendsByPhoneRequest = {
  page?: string;
  phoneNumbers: string[];
};

/** `MuteStoryForFriends` / `UnmuteStoryForFriends` request. */
export type MuteStoryForFriendsRequest = {
  page?: string;
  params: Array<{ friendId: Uuid64Pair }>;
};

/** `SetPostViewEmojiFoFriends` request — note the typo in the bundle's method name. */
export type SetPostViewEmojiForFriendsRequest = {
  page?: string;
  params: Array<{ friendId: Uuid64Pair; emoji?: string }>;
};

/**
 * `CheckActionEligibility` request — friend-graph precondition probe.
 * The bundle accepts `{params: [{friendId}]}`, same `Uuid64Pair` shape as
 * the mutation envelopes.
 */
export type CheckActionEligibilityRequest = {
  params: Array<{ friendId: Uuid64Pair }>;
};

// ─── Bundle entity client shapes (consumed by register.ts) ──────────────

/**
 * `jz` FriendAction client (chat module 10409). Methods listed match the
 * full surface the bundle declares — declaration site at byte 1432651
 * in chat main, beginning `new class{rpc;constructor(e){this.rpc=e,
 * this.TransferInvites=this.TransferInvites.bind(this)...}`.
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

// ─── WASM messaging session shape ──────────────────────────────────────

/** Bundle-realm WASM messaging session — keys are method names, values are Embind functions. */
export type Session = Record<string, Function>;

/**
 * Module 56639 sends/receives surface (chat main byte 4928786) — the
 * bundle-private letter pair exports for every send / fetch / lifecycle /
 * snap-interaction verb the SDK wraps.
 */
export interface SendsModule {
  pn(s: Session, c: ConversationRef, t: string, q?: unknown, a?: unknown, b?: boolean): Promise<void>;
  E$(s: Session, c: ConversationRef[], m: unknown[], o?: unknown): Promise<void>;
  HM(s: Session, d: SnapDestinations, c: CapturedSnap, o?: unknown, q?: unknown, i?: unknown[]): Promise<void>;
  Sd(s: Session, c: ConversationRef, m: bigint, d: number): Promise<void>;
  Mw(s: Session, c: ConversationRef, conversationType: number): Promise<void>;
  ON(s: Session, c: ConversationRef, conversationType: number): Promise<void>;
  zM(s: Session, c: ConversationRef): Promise<void>;
  H7(s: Session, c: ConversationRef): Promise<void>;
  zA(s: Session, c: ConversationRef): Promise<void>;
  eh(s: Session, c: ConversationRef, participants: unknown): Promise<void>;
  cK(s: Session, a: unknown, b: unknown, c: unknown, d: unknown): Promise<unknown>;
  wh(s: Session, c: ConversationRef): Promise<unknown>;
  ik(s: Session, c: ConversationRef): Promise<unknown>;
  QL(s: Session, c: ConversationRef): Promise<unknown>;
  NB(s: Session, participantIds: unknown): Promise<unknown[]>;
  Kz(s: Session, ident: unknown, type: number, minVersion: unknown, ...rest: unknown[]): Promise<unknown>;
  CK(s: Session, triggerType: number): Promise<void>;
  Gx(s: Session, x: unknown, n: unknown): Promise<unknown>;
  V4(s: Session): Promise<unknown>;
  uk(s: Session, c: ConversationRef): Promise<FetchConversationWithMessagesResult>;
  Gq(s: Session, c: ConversationRef, before: unknown): Promise<FetchConversationWithMessagesResult>;
  A_(s: Session, c: ConversationRef, messageId: bigint): Promise<unknown>;
  cr(s: Session, c: ConversationRef, messageIds: unknown[]): Promise<void>;
  Io(s: Session, c: ConversationRef, messageId: unknown): Promise<void>;
  nc(s: Session, c: ConversationRef, messageId: unknown, content: unknown): Promise<void>;
  QJ(s: Session, c: ConversationRef, messageId: unknown, reactionIntent: unknown, reactionId: unknown): Promise<void>;
  et(s: Session, c: ConversationRef, messageId: unknown, reactionId: unknown): Promise<void>;
  CS(s: Session, c: ConversationRef, settings: unknown): Promise<void>;
  yU(s: Session, c: ConversationRef, retentionMode: unknown, retentionDuration: unknown): Promise<void>;
  xJ(s: Session, c: ConversationRef, title: string): Promise<void>;
  oS(s: Session, c: ConversationRef, callInfo: unknown, quoted?: unknown, analytics?: unknown): Promise<void>;
  wb(s: Session, c: ConversationRef, compositeStoryId: unknown, analytics?: unknown): Promise<void>;
  K7(s: Session, c: ConversationRef, text: string, originalSnapdoc: unknown, snapStoryId?: unknown, analytics?: unknown): Promise<void>;
  kW(s: Session, userIds: unknown): Promise<Map<unknown, unknown>>;
  pI(s: Session, snapId: unknown, conversationId: ConversationRef): Promise<void>;
  _z(s: Session, snapId: unknown, conversationId: ConversationRef): Promise<void>;
  iE(s: Session, snapId: unknown): Promise<void>;
  ST(s: Session, snapId: unknown, conversationId: ConversationRef): Promise<void>;
  fb(s: Session, snapId: unknown, downloadStatus: unknown, conversationId: ConversationRef): Promise<void>;
}

// ─── Destinations + story descriptor modules ───────────────────────────

/** Module 79028 — `Ju` builds a `SnapDestinations` envelope from a partial. */
export interface DestinationsModule {
  Ju(input: { conversations?: ConversationRef[]; stories?: unknown[]; massSnaps?: unknown[]; phoneNumbers?: unknown[] }): SnapDestinations;
}

/**
 * Module 74762 — `R9` returns the single-element MY_STORY descriptor
 * array; `ge` converts each descriptor to its server-side destination
 * shape.
 */
export interface StoryDescModule {
  R9(friendsOnly?: boolean): unknown[];
  ge(descriptor: unknown): unknown;
}

// ─── Media uploads ─────────────────────────────────────────────────────

/**
 * `Fi` mediaUploadDelegate (chat module 76877). Surfaced by the
 * chat-bundle source-patch as `__SNAPCAP_FI`. The snap-vs-image
 * distinction lives in the `contentType` field on the CreateContentMessage
 * envelope, not in the upload pipeline — there is no separate
 * `uploadSnapMedia`.
 */
export interface FiUpload {
  uploadMedia: (ctx: unknown, blob: unknown, meta: unknown) => Promise<unknown>;
  uploadMediaReferences: (ctx: unknown, refs: unknown) => Promise<unknown>;
}

/**
 * Chat-side gRPC client (`Ni`) — `.rpc.unary` is rebound during
 * messaging-session bring-up so any AtlasGw / friending / etc. call can
 * route through the SDK's transport. Surfaced by the chat-bundle
 * source-patch as `__SNAPCAP_NI`.
 */
export interface NiChatRpc {
  rpc: { unary: UnaryFn };
}

/**
 * AtlasGw class constructor (chat module 74052). Takes an `{unary}` rpc
 * transport; instances expose `SyncFriendData`, `GetSnapchatterPublicInfo`,
 * etc. The natural closure-private instance `A` (chat main byte ~6940575)
 * is surfaced as `__SNAPCAP_ATLAS` — see `atlasClient()` in `register.ts`.
 */
export type AtlasGwClassCtor = new (rpc: { unary: UnaryFn }) => Record<string, Function>;

/**
 * Live AtlasGw client instance (chat main byte ~6940575, source-patched as
 * `__SNAPCAP_ATLAS`). Methods enumerated from the `Ie` class declaration at
 * chat main byte ~6263000. The bundle does NOT expose a fuzzy user-search
 * method on AtlasGw — search rides `/search/search` REST POST via the
 * closure-private `HY`/`jY` codecs (see `friends.search()`).
 *
 * Methods are typed as `Function` until consumers wire concrete request /
 * response shapes; that's the same TODO posture as `JzFriendAction`'s
 * speculative envelopes — refine when the api layer actually calls them.
 */
export interface AtlasGwClient {
  /** Pull/sync the friend graph; outgoing-side delta sync. */
  SyncFriendData: (req: unknown, metadata?: unknown) => Promise<unknown>;
  /** Look up public info (display name, bitmoji, etc.) for a list of userIds. */
  GetSnapchatterPublicInfo: (req: { userIds: string[] }, metadata?: unknown) => Promise<unknown>;
  /** Resolve a username to a userId — exact match only, NOT fuzzy search. */
  GetUserIdByUsername: (req: { username: string }, metadata?: unknown) => Promise<unknown>;
  /** Followers list (paginated). */
  GetFollowers: (req: { cursor?: string }, metadata?: unknown) => Promise<unknown>;
  /** Recently-active timestamps for a list of friends. */
  GetUserRecentlyActive: (req: unknown, metadata?: unknown) => Promise<unknown>;
  /** Per-friend "score" payload. */
  GetFriendsUserScore: (req: unknown, metadata?: unknown) => Promise<unknown>;
  /** Per-friend metadata bundle. */
  GetFriendsUserMetadata: (req: unknown, metadata?: unknown) => Promise<unknown>;
  GetUserSaturnMetadata: (req: unknown, metadata?: unknown) => Promise<unknown>;
  GetFriendsSaturnMetadata: (req: unknown, metadata?: unknown) => Promise<unknown>;
  InitializeMerlin: (req: unknown, metadata?: unknown) => Promise<unknown>;
  AcceptTermsOfUse: (req: unknown, metadata?: unknown) => Promise<unknown>;
  SetUserDisplayName: (req: unknown, metadata?: unknown) => Promise<unknown>;
  UpdateUserDeviceInformation: (req: unknown, metadata?: unknown) => Promise<unknown>;
}

/**
 * UserInfo / Self client — placeholder. No dedicated RPC has been
 * located yet; `GetSnapchatterPublicInfo` on AtlasGw is the leading
 * candidate for `getUserProfile`.
 */
export interface UserInfoClient {
  GetSelfUser?: () => Promise<unknown>;
  GetSnapchatterPublicInfo?: (req: { userIds: string[] }) => Promise<unknown>;
}

/**
 * StoryManager — placeholder. Lives on the WASM messaging session as
 * `getStoryManager()`. Needs an Embind trace plus a source-patch to
 * surface as `__SNAPCAP_STORY_MANAGER`.
 */
export interface StoryManager {
  getMyStorySnaps?: () => Promise<unknown>;
  viewStory?: (storyId: unknown, snapId?: unknown) => Promise<unknown>;
}

// ─── Chat-bundle Zustand store (chat module 94704) ─────────────────────

/**
 * Raw Zustand store shape — module 94704 hosts the WHOLE chat-bundle state
 * (auth + user + presence + talk + more). Per Phase 1B empirical finding the
 * bundle uses plain Zustand v4 (no `subscribeWithSelector` middleware), so
 * `subscribe` is a single-argument listener of the form
 * `(state, prev) => void`. Returns an unsubscribe thunk.
 *
 * `T` defaults to `ChatState` — the slice union the SDK currently reads.
 * Callers that need a slice not in `ChatState` can re-parameterize.
 */
export interface ChatStore<T = ChatState> {
  getState(): T;
  setState(updater: ((s: T) => Partial<T>) | Partial<T>): void;
  subscribe(listener: (state: T, prev: T) => void): () => void;
  destroy?(): void;
}

/**
 * Slice union the SDK currently reads off the chat-bundle Zustand store.
 * Add slices here only when an api file actually needs them — speculative
 * keys hide schema drift.
 */
export interface ChatState {
  auth: AuthSlice;
  user: UserSlice;
}

/** `state.auth` slice on the bundle's Zustand store — module 94704. */
export interface AuthSlice {
  initialize(loc: { hash: string; search: string }): Promise<void>;
  logout(force?: boolean): Promise<void>;
  refreshToken(reason: string, attestation?: string): Promise<void>;
  /** `state.auth.fetchToken({reason})` — used by the SPA's PageLoad path. */
  fetchToken?: (opts: { reason: string }) => Promise<unknown>;
}

/**
 * Snake-cased record stored in `state.user.publicUsers`. Populated by
 * `GetSnapchatterPublicInfo`; the bundle keeps the wire shape (snake-case)
 * so the api layer is responsible for camel-casing for consumer surfaces.
 */
export interface PublicUserRecord {
  user_id?: string;
  username?: string;
  display_name?: string;
  mutable_username?: string;
}

/**
 * Snake-cased record stored in `state.user.incomingFriendRequests`.
 * Populated by `IncomingFriendSync`. Same snake-case rationale as
 * `PublicUserRecord`.
 */
export interface IncomingFriendRequestRecord {
  user_id?: string;
  username?: string;
  display_name?: string;
  mutable_username?: string;
  /** Server-side ms timestamp; bundle stores as number. */
  added_timestamp_ms?: number;
  /** Source attribution — int matching the FriendSource enum. */
  added_by?: number;
}

/**
 * `state.user` slice on the bundle's Zustand store — module 94704.
 *
 * Carries the friend graph (`mutuallyConfirmedFriendIds`), pending requests
 * (`incomingFriendRequests`, `outgoingFriendRequestIds`), and the
 * `publicUsers` cache populated by `GetSnapchatterPublicInfo`. Mutated in
 * place by Immer drafts.
 *
 * Only the fields the SDK currently reads are typed; `[k: string]: unknown`
 * is intentionally omitted so a typo on the consumer side surfaces at
 * compile time rather than silently returning `undefined`.
 */
export interface UserSlice {
  /** Hyphenated UUIDs of mutual friends (excludes self). */
  mutuallyConfirmedFriendIds: string[];
  /** Hyphenated UUIDs of pending outgoing friend requests. */
  outgoingFriendRequestIds: string[];
  /** `Map<userId, FriendRequestRecord>` — populated by `IncomingFriendSync`. */
  incomingFriendRequests: Map<string, IncomingFriendRequestRecord>;
  /** `Map<userId, PublicUserRecord>` — populated by `GetSnapchatterPublicInfo`. */
  publicUsers?: Map<string, PublicUserRecord>;
  /** Bundle thunk: refresh the friends graph from the server. */
  syncFriends?: () => Promise<void>;
}

// ─── Login client constructor ──────────────────────────────────────────

/**
 * `WebLoginServiceClientImpl` constructor — accounts module 13150.
 * Takes an `{unary}` rpc transport and exposes a `WebLogin` method.
 */
export type LoginClientCtor = new (rpc: { unary: UnaryFn }) => {
  WebLogin(req: WebLoginRequest): Promise<WebLoginResponse>;
};

// ─── Host module (chat module 41359) ───────────────────────────────────

/** Host constants module — `r5` is `https://web.snapchat.com`. */
export interface HostModule {
  /** `https://web.snapchat.com` — base for every same-origin POST. */
  r5: string;
  /** `web.snapchat.com` — bare host. */
  O_: () => boolean;
  hm: (env: string) => unknown;
  rM: unknown;
}

// ─── Default-authed fetch module (chat module 34010) ───────────────────

/**
 * `default-authed-fetch` module — `s` is the bundle's same-origin POST
 * helper that attaches the bearer + cookies the way the SPA does.
 * Used by `Friends.search()` for the `/search/search` POST.
 */
export interface DefaultAuthedFetchModule {
  s: (url: string, opts: unknown) => Promise<Response>;
}

// ─── Search codec shapes (closure-private chat-bundle protos) ──────────

/**
 * `__SNAPCAP_HY` — the bundle's `SearchRequest` ts-proto message codec.
 * Lives in chat module ~10409 alongside the FriendAction client. Source-
 * patched via `chat-loader.ts`. Produces the request envelope POSTed to
 * `/search/search`.
 */
export interface SearchRequestCodec {
  fromPartial(p: Record<string, unknown>): unknown;
  encode(req: unknown): { finish(): Uint8Array };
}

/**
 * `__SNAPCAP_JY` — the bundle's `SearchResponse` ts-proto message codec.
 * Decodes the `/search/search` POST response into `DecodedSearchResponse`.
 */
export interface SearchResponseCodec {
  decode(b: Uint8Array): DecodedSearchResponse;
}

/**
 * One result row inside a `DecodedSearchResponse` section. The bundle's
 * search codec emits `id` as a hyphenated UUID string but be tolerant of
 * `Uuid64Pair` and 16-byte buffer fallbacks too — earlier traces showed
 * both shapes depending on origin/sectionType.
 */
export interface DecodedSearchUserResult {
  id?: string | Uint8Array | { highBits?: bigint | string; lowBits?: bigint | string };
  userId?: string;
  username?: string;
  mutableUsername?: string;
  displayName?: string;
}

/**
 * Section envelope inside `DecodedSearchResponse`. `sectionType` mirrors
 * the bundle's `SearchSectionType` enum (2 = `SECTION_TYPE_ADD_FRIENDS`).
 * The user payload is a oneof — `result.$case === "user"` carries the
 * `DecodedSearchUserResult`.
 */
export interface DecodedSearchSection {
  sectionType?: number;
  results?: Array<{
    result?: { $case?: string; user?: DecodedSearchUserResult; [k: string]: unknown };
  }>;
  /** Convenience flat list — present on some section variants. */
  users?: DecodedSearchUserResult[];
}

/**
 * Decoded `/search/search` response — what `SearchResponseCodec.decode`
 * yields. Sections array is flat; consumers pick the section they care
 * about by `sectionType`.
 */
export interface DecodedSearchResponse {
  sections: DecodedSearchSection[];
}

// ─── Conversation creation + message ops ───────────────────────────────

// CreateConversationParams moved to src/api/messaging.ts — the bundle's
// `cK` wrapper takes 4 positional args (recipients/type/metadata/options)
// and the consumer-friendly bag belongs in the api layer.
//
// ReactToMessageRequest moved to src/api/messaging.ts — the bundle's
// `QJ` wrapper takes (session, conversationRef, messageId, intent, id)
// positional, so the consumer-friendly `{conversationId: string, ...}`
// envelope lives api-side.

/**
 * Result shape of `fetchConversationWithMessages` /
 * `fetchConversationWithMessagesPaginated`. Mirrors the bundle wrapper's
 * resolve shape (chat main byte ~4931600).
 */
export type FetchConversationWithMessagesResult = {
  /** Bundle-realm `Map<MessageId, MessageRecord>` of messages in the conversation. */
  messages: unknown;
  /** Bundle-realm `Conversation` record (metadata, last activity, participants). */
  conversation: unknown;
  /** True when older pages are available — call the paginated sibling to walk them. */
  hasMoreMessages: boolean;
};

// ─── WebLoginService request / response ─────────────────────────────────

/**
 * `WebLoginRequest` partial — accepted by the bundle's ts-proto
 * `WebLoginRequest.fromPartial`. The two real call sites (login step 1 vs
 * step 2) populate disjoint subsets of the optional fields, so everything
 * past `webLoginHeaderBrowser` is `?`.
 */
export type WebLoginRequest = {
  webLoginHeaderBrowser: {
    authenticationSessionPayload: Uint8Array;
    attestationPayload: Uint8Array;
    arkoseToken: string;
    ssoClientId: string;
    continueParam: string;
    multiUser: boolean;
    captchaPayload: { provider: number; payload: string; errorMessage: string };
  };
  /** Step-1 only: ts-proto oneof {`username` | `email` | `phone`}. */
  loginIdentifier?:
    | { $case: "username"; username: string }
    | { $case: "email"; email: string }
    | { $case: "phone"; phone: string };
  /** Step-2 only: nested challenge answer wrapper. */
  challengeAnswer?: {
    challengeAnswer: {
      $case: "passwordChallengeAnswer";
      passwordChallengeAnswer: { password: string };
    };
  };
};

/**
 * `WebLoginResponse` decoded shape — only the fields the SDK reads on the
 * success / step-1-challenge paths are typed; the rest stays `unknown`.
 */
export type WebLoginResponse = {
  /** 1 = success on step 2; other values flag protocol-level failures. */
  statusCode?: number;
  /** Echoed back unchanged on step 2. */
  authenticationSessionPayload?: Uint8Array;
  /** ts-proto oneof — `errorData` | `challengeData` | (other future cases). */
  payload?:
    | {
        $case: "challengeData";
        challengeData?: {
          challenge?: { $case: string; [k: string]: unknown };
        };
      }
    | { $case: "errorData"; errorData?: unknown }
    | { $case?: string; [k: string]: unknown };
  [k: string]: unknown;
};
