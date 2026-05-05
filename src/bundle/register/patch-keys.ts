/**
 * `globalThis.__SNAPCAP_*` source-patch keys.
 *
 * These are the keys `bundle/chat-loader.ts` source-patches into the
 * minified bundle so we can read closure-private clients/codecs back via
 * `sandbox.getGlobal(KEY)`. When Snap renames the underlying minified
 * variables, ONLY this file (plus the matching `chat-loader.ts` patch
 * site) needs updating — the consumer getters in this directory keep
 * resolving correctly.
 *
 * Each constant is an immutable string at module scope (per the
 * lint allowlist for source-patch keys).
 */

/** `jz` FriendAction client instance — chat module 10409. */
export const G_FRIEND_ACTION = "__SNAPCAP_JZ";

/** Chat-side gRPC client whose `.rpc.unary` we rebind during messaging-session bring-up. */
export const G_CHAT_RPC = "__SNAPCAP_NI";

/** WebLoginServiceClientImpl ctor — accounts module 13150. */
export const G_LOGIN_CLIENT_IMPL = "__SNAPCAP_LOGIN_CLIENT_IMPL";

/** Closure-private `Fi` mediaUploadDelegate — chat module 76877. */
export const G_FI_UPLOAD = "__SNAPCAP_FI";

/**
 * `HY` SearchRequest codec (chat module ~10409, alongside FriendAction).
 * Source-patched in `chat-loader.ts`. Encoded request body for the
 * `/search/search` POST.
 */
export const G_SEARCH_REQ_CODEC = "__SNAPCAP_HY";

/**
 * `JY` SearchResponse codec (chat module ~10409). Decodes the
 * `/search/search` POST response.
 */
export const G_SEARCH_RESP_CODEC = "__SNAPCAP_JY";

/**
 * FriendRequests `N` client — chat main byte ~6940668. Methods: `Process`
 * (accept/reject/cancel via a oneof action) and
 * `IncomingFriendSync({syncToken?})` (paginated incoming-requests pull).
 * Source-patched in `chat-loader.ts` from
 * `N=new class{rpc;constructor(e){…}` →
 * `N=globalThis.__SNAPCAP_FRIEND_REQUESTS=new class{rpc;constructor(e){…}`.
 */
export const G_FRIEND_REQUESTS_CLIENT: string | undefined = "__SNAPCAP_FRIEND_REQUESTS";

/** AtlasGw client instance `A` (chat main byte ~6940575). Methods on the
 * `Ie` class declared at chat main ~6263000 (SyncFriendData,
 * GetSnapchatterPublicInfo, GetUserIdByUsername, GetFollowers, etc.).
 * Source-patched in `chat-loader.ts` from
 * `const A=new a.p$({unary:(0,I.Z)()})` →
 * `const A=globalThis.__SNAPCAP_ATLAS=new a.p$({unary:(0,I.Z)()})`. */
export const G_ATLAS_CLIENT = "__SNAPCAP_ATLAS";

/** TODO: UserInfo/Self client — no dedicated RPC located yet; investigate AtlasGw `GetSnapchatterPublicInfo` */
export const G_USER_INFO_CLIENT: string | undefined = undefined;

/** TODO: StoryManager accessor on the WASM session — chat main `getStoryManager`; source-patch __SNAPCAP_STORY_MANAGER */
export const G_STORY_MANAGER: string | undefined = undefined;
