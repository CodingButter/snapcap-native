/**
 * Bundle gRPC client / transport shapes — the chat-side rpc bag (`Ni`),
 * the AtlasGw class constructor + live instance, the placeholder
 * `UserInfoClient` (no dedicated RPC yet), the `host` constants module,
 * and the `default-authed-fetch` helper used by `Friends.search()`.
 *
 * `SnapchatterPublicInfo` (the response shape of
 * `GetSnapchatterPublicInfo`) lives next to its writer in
 * `./chat-store.ts`; the `AtlasGwClient` interface here imports it so
 * the response type is concrete at the call site.
 */
import type { UnaryFn } from "./shared.ts";
import type { SnapchatterPublicInfo } from "./chat-store.ts";

/**
 * Chat-side gRPC client (`Ni`) — `.rpc.unary` is rebound during
 * messaging-session bring-up so any AtlasGw / friending / etc. call can
 * route through the SDK's transport. Surfaced by the chat-bundle
 * source-patch as `__SNAPCAP_NI`.
 *
 * @internal Bundle wire-format type.
 */
export interface NiChatRpc {
  rpc: { unary: UnaryFn };
}

/**
 * AtlasGw class constructor (chat module 74052). Takes an `{unary}` rpc
 * transport; instances expose `SyncFriendData`, `GetSnapchatterPublicInfo`,
 * etc. The natural closure-private instance `A` (chat main byte ~6940575)
 * is surfaced as `__SNAPCAP_ATLAS` — see `atlasClient()` in `register.ts`.
 *
 * @internal Bundle wire-format type.
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
 *
 * @internal Bundle wire-format type.
 */
export interface AtlasGwClient {
  /** Pull/sync the friend graph; outgoing-side delta sync. */
  SyncFriendData: (req: unknown, metadata?: unknown) => Promise<unknown>;
  /**
   * Look up public info (username, display name, bitmoji, profile flags)
   * for a list of userIds. Each userId is the raw 16-byte UUID, NOT a
   * hyphenated string — pass `Uint8Array` values via `uuidToBytes`.
   * `source` is an optional Snap-side enum (`a.MW.*`); the SPA passes
   * `MW.CHAT` from chat-bundle call sites and omits it elsewhere.
   *
   * Response shape: `{ snapchatters: Array<Snapchatter> }` with each
   * `snapchatter.userId` likewise as `Uint8Array(16)` and string fields
   * camelCased (`userId, username, displayName, mutableUsername,
   * isOfficial, isPopular, snapProId, profileTier, bitmojiPublicInfo,
   * profileLogo, creatorSubscriptionProductsInfo`).
   */
  GetSnapchatterPublicInfo: (
    req: { userIds: Uint8Array[]; source?: number },
    metadata?: unknown,
  ) => Promise<{ snapchatters: SnapchatterPublicInfo[] }>;
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
 *
 * @internal Bundle wire-format type (TODO).
 */
export interface UserInfoClient {
  GetSelfUser?: () => Promise<unknown>;
  GetSnapchatterPublicInfo?: (req: { userIds: string[] }) => Promise<unknown>;
}

/**
 * Host constants module — `r5` is `https://web.snapchat.com`.
 *
 * @internal Bundle wire-format type.
 */
export interface HostModule {
  /** `https://web.snapchat.com` — base for every same-origin POST. */
  r5: string;
  /** `web.snapchat.com` — bare host. */
  O_: () => boolean;
  hm: (env: string) => unknown;
  rM: unknown;
}

/**
 * `default-authed-fetch` module — `s` is the bundle's same-origin POST
 * helper that attaches the bearer + cookies the way the SPA does.
 * Used by `Friends.search()` for the `/search/search` POST.
 *
 * @internal Bundle wire-format type.
 */
export interface DefaultAuthedFetchModule {
  s: (url: string, opts: unknown) => Promise<Response>;
}
