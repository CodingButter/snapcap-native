/**
 * Bundle method registry — single source of truth for the Snap-bundle
 * managers and classes our SDK reaches. Each export is a late-bound
 * getter that takes a `Sandbox` and returns the live Snap manager (or
 * webpack module export); api files (`../api/*.ts`) call methods on it
 * directly.
 *
 * Pattern: one `reach()` (or `reachModule()`) helper, one constant
 * mapper per entity, one zero-argument-after-sandbox getter per entity.
 * The getter returns the live class instance / module export — no shape
 * work, no UUID parsing, no compositions live here. The api layer owns
 * those.
 *
 * Sandbox-explicit: every export takes `sandbox: Sandbox` as its first
 * arg. This makes per-instance isolation possible — two `SnapcapClient`s
 * each pass their own Sandbox in, and the registry has zero shared
 * mutable state. The api layer threads `ctx.sandbox` through.
 *
 * If Snap renames a class, only one getter body changes; consumer api
 * code stays untouched.
 *
 * # Gap-fill conventions
 *
 * Two kinds of entries exist:
 *   - WIRED — constant mapper has a confirmed value; the getter resolves
 *     a real bundle entity at call time.
 *   - TODO — constant mapper is `undefined`; the getter throws an
 *     explicit "not yet mapped" error at call time. The TODO comment
 *     above the constant says exactly what to look for and where, so a
 *     follow-up hunt agent can fill in the value without re-deriving
 *     the search.
 *
 * Do NOT guess at __SNAPCAP_* names or webpack module IDs. If neither
 * has been confirmed by reading vendor/snap-bundle/cf-st.sc-cdn.net/dw
 * with byte-offset evidence, leave the constant `undefined` and write
 * a TODO.
 */
import { Sandbox } from "../shims/sandbox.ts";
import { getChatWreq } from "./chat-loader.ts";
import type {
  AtlasGwClassCtor,
  AtlasGwClient,
  AuthSlice,
  ChatState,
  ChatStore,
  DecodedSearchResponse,
  DefaultAuthedFetchModule,
  DestinationsModule,
  FiUpload,
  FriendRequestsClient,
  HostModule,
  JzFriendAction,
  LoginClientCtor,
  MessagingSlice,
  NiChatRpc,
  PresenceSlice,
  SearchRequestCodec,
  SearchResponseCodec,
  SendsModule,
  StoryDescModule,
  StoryManager,
  UserInfoClient,
  UserSlice,
} from "./types/index.ts";

/**
 * Presence-state enum — chat module 46471 exports this as `O`. Backs the
 * presence slice's `awayState` slot. Confirmed members + values from the
 * factory body (`{Present: 0, Away: 1, AwaitingReactivate: 2}`).
 *
 * The bundle's gate on `broadcastTypingActivity` compares
 * `state.presence.awayState === O.Present`, so anything that suppresses
 * typing pulses across the wire flows from this enum.
 *
 * Lives here (not in `bundle/types.ts`) because the only consumers are
 * the registry getter `presenceStateEnum()` below and `client.ts`'s
 * `setStatus`/`getStatus` mapping — keeping the type co-located with its
 * one bundle-side getter avoids a cross-file rename when Snap changes
 * the enum shape.
 *
 * @internal Bundle wire-format type.
 */
export interface PresenceStateEnum {
  /** Active / present — typing-pulse + presence broadcasts are gated open. */
  Present: number;
  /** Idle / away — bundle suppresses typing pulses. */
  Away: number;
  /** Transitional — awaiting client-side reactivation, rare. */
  AwaitingReactivate: number;
}

/**
 * Cancel-thunk type for store / event subscriptions — same shape as
 * Zustand's `unsubscribe`.
 *
 * Re-exported here so api files can import the cancel-thunk type from
 * the same module they import the subscriber helpers from. Kept thin
 * (`() => void`) — matches the api-side `Unsubscribe` aliases.
 *
 * @internal Bundle-layer type alias; consumers receive this shape from
 * public subscribe APIs without needing to import it directly.
 */
export type Unsubscribe = () => void;

// ─── 1. globalThis source-patch keys ─────────────────────────────────────

/** `jz` FriendAction client instance — chat module 10409. */
const G_FRIEND_ACTION = "__SNAPCAP_JZ";
/** Chat-side gRPC client whose `.rpc.unary` we rebind during messaging-session bring-up. */
const G_CHAT_RPC = "__SNAPCAP_NI";
/** WebLoginServiceClientImpl ctor — accounts module 13150. */
const G_LOGIN_CLIENT_IMPL = "__SNAPCAP_LOGIN_CLIENT_IMPL";
/** Closure-private `Fi` mediaUploadDelegate — chat module 76877. */
const G_FI_UPLOAD = "__SNAPCAP_FI";
/**
 * `HY` SearchRequest codec (chat module ~10409, alongside FriendAction).
 * Source-patched in `chat-loader.ts`. Encoded request body for the
 * `/search/search` POST.
 */
const G_SEARCH_REQ_CODEC = "__SNAPCAP_HY";
/**
 * `JY` SearchResponse codec (chat module ~10409). Decodes the
 * `/search/search` POST response.
 */
const G_SEARCH_RESP_CODEC = "__SNAPCAP_JY";

/**
 * FriendRequests `N` client — chat main byte ~6940668. Methods: `Process`
 * (accept/reject/cancel via a oneof action) and
 * `IncomingFriendSync({syncToken?})` (paginated incoming-requests pull).
 * Source-patched in `chat-loader.ts` from
 * `N=new class{rpc;constructor(e){…}` →
 * `N=globalThis.__SNAPCAP_FRIEND_REQUESTS=new class{rpc;constructor(e){…}`.
 */
const G_FRIEND_REQUESTS_CLIENT: string | undefined = "__SNAPCAP_FRIEND_REQUESTS";
/** AtlasGw client instance `A` (chat main byte ~6940575). Methods on the
 * `Ie` class declared at chat main ~6263000 (SyncFriendData,
 * GetSnapchatterPublicInfo, GetUserIdByUsername, GetFollowers, etc.).
 * Source-patched in `chat-loader.ts` from
 * `const A=new a.p$({unary:(0,I.Z)()})` →
 * `const A=globalThis.__SNAPCAP_ATLAS=new a.p$({unary:(0,I.Z)()})`. */
const G_ATLAS_CLIENT = "__SNAPCAP_ATLAS";
/** TODO: UserInfo/Self client — no dedicated RPC located yet; investigate AtlasGw `GetSnapchatterPublicInfo` */
const G_USER_INFO_CLIENT: string | undefined = undefined;
/** TODO: StoryManager accessor on the WASM session — chat main `getStoryManager`; source-patch __SNAPCAP_STORY_MANAGER */
const G_STORY_MANAGER: string | undefined = undefined;

// ─── 2. webpack module IDs ───────────────────────────────────────────────

/** Bundle-native send entries (text / image / snap / mark-viewed / lifecycle / fetch). */
const MOD_SENDS = "56639";
/**
 * Zustand store hosting the WHOLE chat-bundle state (auth + user + presence
 * + talk + more). Despite the historical name, module 94704 is not just the
 * auth slice — `getState()` returns every chat-side slice.
 */
const MOD_CHAT_STORE = "94704";
/** Destinations builder + descriptor helpers (used by sendSnap / postStory). */
const MOD_DESTINATIONS = "79028";
/** Story descriptor helpers (`R9` MY_STORY descriptor; `ge` server-destination conversion). */
const MOD_STORY_DESC = "74762";
/** AtlasGw class (chat-bundle) — `SyncFriendData`, `GetSnapchatterPublicInfo`, etc. */
const MOD_ATLAS_CLASS = "74052";
/** Host constants — `r5` is `https://web.snapchat.com`. */
const MOD_HOST = "41359";
/**
 * Default-authed fetch factory — `s` is the bundle's same-origin POST
 * helper that attaches the bearer + cookies the way the SPA does.
 * Friends.search() routes through it for the `/search/search` POST.
 */
const MOD_DEFAULT_AUTHED_FETCH = "34010";
/**
 * Presence-state enum module — exports `O` as
 * `{Present: 0, Away: 1, AwaitingReactivate: 2}`. The presence slice's
 * `awayState` slot stores one of these numeric values; the slice's own
 * `broadcastTypingActivity` is gated on `awayState === O.Present`.
 *
 * Confirmed at chat main byte ~4318612 — the factory body is a single
 * line: `n.d(t,{O:()=>i});var i={Present:0,Away:1,AwaitingReactivate:2}`.
 */
const MOD_PRESENCE_STATE_ENUM = "46471";

// ─── 3. helpers ──────────────────────────────────────────────────────────

/**
 * Reach a sandbox `globalThis.__SNAPCAP_*` symbol by key. Throws a
 * friendly error when the bundle hasn't loaded, the source-patch site
 * shifted, or the consumer called us before `client.authenticate()`.
 *
 * Accepts `string | undefined` so TODO getters (whose constant mapper
 * is still `undefined`) pass through untouched and produce a uniform
 * "not yet mapped" error at call time.
 *
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param globalKey - source-patched `__SNAPCAP_*` key, or `undefined` for TODO getters
 * @param name - human-readable getter name used in error messages
 * @returns the live bundle entity at `globalThis[globalKey]`
 * @throws when `globalKey` is undefined (TODO getter), when the bundle
 *   hasn't been loaded yet, or when the source-patch site shifted
 */
function reach<T>(sandbox: Sandbox, globalKey: string | undefined, name: string): T {
  if (!globalKey) {
    throw new Error(`${name}: bundle export not yet mapped — see TODO in register.ts`);
  }
  const inst = sandbox.getGlobal<T>(globalKey);
  if (!inst) {
    throw new Error(
      `${name}: bundle entity not available — did you call client.authenticate() first? ` +
      `(looked for globalThis.${globalKey})`,
    );
  }
  return inst;
}

/**
 * Reach a chat-bundle webpack module by id.
 *
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param moduleId - webpack module id (string)
 * @param name - human-readable getter name used in error messages
 * @returns the module export object
 * @throws when the chat wreq lookup fails for `moduleId`
 */
function reachModule<T>(sandbox: Sandbox, moduleId: string, name: string): T {
  try {
    return getChatWreq(sandbox)(moduleId) as T;
  } catch (err) {
    throw new Error(
      `${name}: chat wreq lookup of module ${moduleId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── 4. manager-getter exports ───────────────────────────────────────────

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
 * Login client constructor — accounts module 13150
 * `WebLoginServiceClientImpl`.
 *
 * Construct with `new (loginClient(sandbox))({ unary }).WebLogin(req)`.
 * See {@link LoginClientCtor}.
 *
 * @internal Bundle-layer accessor. Public consumers reach login via
 * `SnapcapClient.authenticate()` (see `src/auth/login.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `WebLoginServiceClientImpl` constructor
 */
export const loginClient = (sandbox: Sandbox): LoginClientCtor =>
  reach<LoginClientCtor>(sandbox, G_LOGIN_CLIENT_IMPL, "loginClient");

/**
 * Raw chat-bundle Zustand store — exposes `subscribe`, `getState`,
 * `setState`. Chat module 94704.
 *
 * Use this when you need a live subscription to state mutations (e.g.
 * friends-list deltas) or to peek at slices the registry does not yet
 * expose a getter for. Per Phase 1B empirical finding the bundle uses
 * plain Zustand (no `subscribeWithSelector` middleware) — `subscribe`
 * is single-arg `(state, prev) => void`.
 *
 * @internal Bundle-layer accessor. Public consumers receive shaped
 * slices via the api layer rather than touching the raw store.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live Zustand {@link ChatStore}
 */
export const chatStore = (sandbox: Sandbox): ChatStore =>
  reachModule<{ M: ChatStore }>(sandbox, MOD_CHAT_STORE, "chatStore").M;

/**
 * Auth slice — Zustand store on chat module 94704.
 *
 * Methods: `initialize`, `logout`, `refreshToken`, `fetchToken`
 * (PageLoad-time SPA only). See {@link AuthSlice}.
 *
 * @internal Bundle-layer accessor. Public consumers reach auth via
 * `SnapcapClient` methods (see `src/client.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `auth` slice from the chat-bundle state
 */
export const authSlice = (sandbox: Sandbox): AuthSlice =>
  (chatStore(sandbox).getState() as ChatState).auth;

/**
 * User slice — Zustand store on chat module 94704.
 *
 * Carries the friend graph (`mutuallyConfirmedFriendIds`), pending
 * requests (`incomingFriendRequests`, `outgoingFriendRequestIds`), and
 * the `publicUsers` cache populated by `GetSnapchatterPublicInfo`.
 * Mutated in place by Immer drafts; subscribers should use
 * {@link chatStore}().subscribe for delta detection.
 *
 * See {@link UserSlice}.
 *
 * @internal Bundle-layer accessor. Public consumers reach friend / user
 * data via the api layer.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `user` slice from the chat-bundle state
 */
export const userSlice = (sandbox: Sandbox): UserSlice =>
  (chatStore(sandbox).getState() as ChatState).user;

/**
 * Presence slice — Zustand store on chat module 94704 (factory `Zn(set,get)`
 * at chat main byte ~8310100).
 *
 * Drives the presence-layer surface the bundle's modern chat clients gate
 * typing / viewing indicators on. The sister convMgr path
 * (`convMgr.sendTypingNotification` etc.) leaves a WS frame on the wire
 * but the recipient's UI ignores it unless the presence session has been
 * primed via `createPresenceSession(convId)` + `presenceSession.onUserAction
 * ({type: "chatVisible"})`.
 *
 * Methods:
 *   - {@link PresenceSlice.initializePresenceServiceTs} — one-shot init
 *     with our duplex bridge (see `bundle/presence-bridge.ts`).
 *   - {@link PresenceSlice.createPresenceSession} — per-conv session;
 *     populates `state.presence.presenceSession` (single-slot).
 *   - {@link PresenceSlice.broadcastTypingActivity} — broadcasts a
 *     "typing" pulse on the active session.
 *   - {@link PresenceSlice.setAwayState} — Present / Away enum value.
 *
 * @internal Bundle-layer accessor. Public consumers reach presence via
 * `Messaging.setTyping` / `Messaging.setViewing` (see `src/api/messaging.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `presence` slice from the chat-bundle state
 */
export const presenceSlice = (sandbox: Sandbox): PresenceSlice =>
  (chatStore(sandbox).getState() as ChatState).presence;

/**
 * Presence-state enum — chat module 46471, exporting `O` as
 * `{Present: 0, Away: 1, AwaitingReactivate: 2}`.
 *
 * The numeric values back the presence slice's `awayState` slot: the
 * slice initializes from `document.hasFocus() ? O.Present : O.Away` at
 * factory time, and subsequent reads/writes (`presenceSlice.setAwayState`,
 * the `broadcastTypingActivity` gate) compare against these enum values.
 *
 * Reaching the enum live (rather than hardcoding the integers in
 * consumer-side code) means the SDK keeps working if Snap renumbers the
 * enum members in a future bundle build — only this one constant mapper
 * needs verification on remap.
 *
 * @internal Bundle-layer accessor. Public consumers reach presence state
 * via `SnapcapClient.setStatus` / `getStatus` (see `src/client.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `O` enum object from chat module 46471
 */
export const presenceStateEnum = (sandbox: Sandbox): PresenceStateEnum =>
  reachModule<{ O: PresenceStateEnum }>(sandbox, MOD_PRESENCE_STATE_ENUM, "presenceStateEnum").O;

/**
 * Messaging slice — Zustand store on chat module 94704 (factory in chat
 * main byte ~6604846, beginning `messaging:{client:void 0,initializeClient:…`).
 *
 * Critical for presence bring-up. The presence slice's
 * `createPresenceSession(envelope)` action awaits
 * `firstValueFrom(observeConversationParticipants$)` inside
 * `PresenceServiceImpl`; that observable only emits when the target conv
 * is present in `state.messaging.conversations[convIdStr]`. Without
 * React running the bundle's normal feed-pump, the slice is empty, the
 * observable never emits, and `createPresenceSession` hangs forever —
 * see the long writeup on {@link MessagingSlice}.
 *
 * The fix is to call `messagingSlice(sandbox).fetchConversation(envelope)`
 * BEFORE `createPresenceSession`. The action drives
 * `S.ik(session, convRef)` (`convMgr.fetchConversation`) and writes
 * the result into the slice via `(0,fr.wD)(r, conversations)`, which
 * populates the `participants` payload the presence selector waits on.
 *
 * @internal Bundle-layer accessor. Public consumers reach this via
 * `Messaging.setTyping` / `Messaging.setViewing` (see `src/api/messaging.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `messaging` slice from the chat-bundle state
 */
export const messagingSlice = (sandbox: Sandbox): MessagingSlice =>
  (chatStore(sandbox).getState() as ChatState).messaging;

/**
 * Generic chat-side gRPC escape hatch — `Ni.rpc.unary` for arbitrary
 * AtlasGw / friending / etc. calls bypassing the typed registry.
 *
 * See {@link NiChatRpc}.
 *
 * @internal Bundle-layer accessor for one-off RPCs the typed registry
 * doesn't yet cover. Public consumers should not depend on this.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `Ni` chat RPC client
 */
export const chatRpc = (sandbox: Sandbox): NiChatRpc =>
  reach<NiChatRpc>(sandbox, G_CHAT_RPC, "chatRpc");

/**
 * Raw chat-bundle webpack require — escape hatch for code that needs to
 * walk `wreq.m` (the factory map) or call factories directly through a
 * shimmed wreq (priming, cache-cycle rewiring).
 *
 * Most consumers should reach for the typed getters above instead — this
 * is reserved for bundle-plumbing helpers (see `bundle/prime.ts`) that
 * have to bypass webpack's closure-private cache to break factory-time
 * cyclic deps.
 *
 * Re-exported here so api files don't have to import `getChatWreq`
 * directly from `./chat-loader.ts` (the architecture rule's gate point).
 *
 * @internal Bundle-plumbing escape hatch. Public consumers should never
 * touch the raw webpack require.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the chat-bundle webpack require with its `m` factory map
 */
export const chatWreq = (sandbox: Sandbox): ((id: string) => unknown) & { m: Record<string, Function> } =>
  getChatWreq(sandbox);

/**
 * Media upload delegate — `Fi` (chat module 76877).
 *
 * `uploadMedia` / `uploadMediaReferences` for direct upload control;
 * sends/snaps usually drive uploads as a side-effect. See {@link FiUpload}.
 *
 * @internal Bundle-layer accessor. Public consumers reach uploads via
 * higher-level send APIs (see `src/api/messaging.ts`, `src/api/media.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `Fi` mediaUploadDelegate
 */
export const uploadDelegate = (sandbox: Sandbox): FiUpload =>
  reach<FiUpload>(sandbox, G_FI_UPLOAD, "uploadDelegate");

/**
 * Messaging sends + reads + lifecycle — chat module 56639.
 *
 * Exposes the bundle-private letter pairs (pn, E$, HM, Sd, Mw, ON, etc.)
 * that hang off `getConversationManager()` / `getFeedManager()` /
 * `getSnapManager()` on the WASM session. See {@link SendsModule} for
 * the full export map.
 *
 * @internal Bundle-layer accessor. Public consumers reach sends via
 * `Conversation.sendText` / `sendImage` / etc. (see `src/api/messaging.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-56639 export
 */
export const messagingSends = (sandbox: Sandbox): SendsModule =>
  reachModule<SendsModule>(sandbox, MOD_SENDS, "messagingSends");

/**
 * Destinations builder — chat module 79028 `Ju` builds a
 * `SnapDestinations` envelope from a partial.
 *
 * See {@link DestinationsModule}.
 *
 * @internal Bundle-layer accessor. Used by the api layer when building
 * `sendSnap` / `postStory` destinations.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-79028 export
 */
export const destinationsModule = (sandbox: Sandbox): DestinationsModule =>
  reachModule<DestinationsModule>(sandbox, MOD_DESTINATIONS, "destinationsModule");

/**
 * Story descriptor helpers — chat module 74762.
 *
 * `R9` returns the single-element MY_STORY descriptor array; `ge`
 * converts each descriptor to its server-side destination shape. See
 * {@link StoryDescModule}.
 *
 * @internal Bundle-layer accessor. Used by the api layer's `postStory`
 * pipeline.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-74762 export
 */
export const storyDescModule = (sandbox: Sandbox): StoryDescModule =>
  reachModule<StoryDescModule>(sandbox, MOD_STORY_DESC, "storyDescModule");

/**
 * Host constants — chat module 41359 (`r5` is `https://web.snapchat.com`).
 *
 * See {@link HostModule}.
 *
 * @internal Bundle-layer accessor. Used by the api layer when building
 * same-origin URLs.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-41359 export
 */
export const hostModule = (sandbox: Sandbox): HostModule =>
  reachModule<HostModule>(sandbox, MOD_HOST, "hostModule");

/**
 * Default-authed fetch helper — chat module 34010.
 *
 * `s(url, opts)` is the bundle's same-origin POST helper with bearer +
 * cookies attached the way the SPA does. `Friends.search` routes the
 * `/search/search` POST through it. See {@link DefaultAuthedFetchModule}.
 *
 * @internal Bundle-layer accessor. Public consumers should not call the
 * bundle's authed-fetch directly — the api layer wraps it.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-34010 export with its `s` POST helper
 * @throws when the module's shape has shifted (no `s` function present)
 */
export const defaultAuthedFetch = (sandbox: Sandbox): DefaultAuthedFetchModule => {
  const mod = reachModule<Partial<DefaultAuthedFetchModule>>(sandbox, MOD_DEFAULT_AUTHED_FETCH, "defaultAuthedFetch");
  if (!mod || typeof mod.s !== "function") {
    throw new Error(`defaultAuthedFetch: chat module ${MOD_DEFAULT_AUTHED_FETCH} shape shifted`);
  }
  return mod as DefaultAuthedFetchModule;
};

/**
 * AtlasGw class — chat module 74052.
 *
 * Consumers wrap with their own `{unary}` rpc transport. Walks the
 * module's exports to find the class whose prototype has
 * `SyncFriendData`. Switch to the natural instance once `__SNAPCAP_ATLAS`
 * lands (see {@link atlasClient}).
 *
 * @internal Bundle-layer accessor. Prefer {@link atlasClient} for the
 * natural per-bundle instance.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live AtlasGw class constructor
 * @throws when the AtlasGw class can't be located in module 74052
 *   (export shape may have shifted)
 */
export const atlasGwClass = (sandbox: Sandbox): AtlasGwClassCtor => {
  const exp = reachModule<Record<string, unknown>>(sandbox, MOD_ATLAS_CLASS, "atlasGwClass");
  for (const k of Object.keys(exp)) {
    const v = exp[k];
    if (typeof v !== "function") continue;
    const proto = (v as { prototype?: Record<string, unknown> }).prototype;
    if (proto && typeof proto.SyncFriendData === "function") {
      return v as AtlasGwClassCtor;
    }
  }
  throw new Error("atlasGwClass: AtlasGw class not found in module 74052 (export shape may have shifted)");
};

// ─── 5. TODO getters — constant mappers undefined; throw at call time ───

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

/**
 * UserInfo / Self client — placeholder.
 *
 * @remarks TODO — no dedicated RPC located yet; investigate AtlasGw
 * `GetSnapchatterPublicInfo` and any `GetSelf` candidate.
 *
 * @internal Bundle-layer accessor (TODO).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live UserInfo client (when mapped)
 * @throws always, until the source-patch lands
 */
export const userInfoClient = (sandbox: Sandbox): UserInfoClient =>
  reach<UserInfoClient>(sandbox, G_USER_INFO_CLIENT, "userInfoClient");

/**
 * StoryManager — `getStoryManager()` on the WASM session.
 *
 * @remarks TODO — needs an Embind trace + a source-patch to surface as
 * `__SNAPCAP_STORY_MANAGER`.
 *
 * @internal Bundle-layer accessor (TODO).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live StoryManager (when mapped)
 * @throws always, until the source-patch lands
 */
export const storyManager = (sandbox: Sandbox): StoryManager =>
  reach<StoryManager>(sandbox, G_STORY_MANAGER, "storyManager");

/**
 * AtlasGw natural instance — chat main byte ~6940575 closure-private `A`,
 * source-patched as `__SNAPCAP_ATLAS`.
 *
 * Prefer this over {@link atlasGwClass} — it's the same per-bundle `A`
 * instance the SPA uses, with `rpc.unary` wired to the bundle's own
 * `default-authed-fetch` (so bearer + cookies are attached the way the
 * SPA does).
 *
 * @remarks AtlasGw has no fuzzy user-search method. `friends.search()`
 * continues to use the closure-private `HY/jY` codecs +
 * {@link defaultAuthedFetch} because the bundle's own search path
 * (`Yz`, byte ~1435000) is REST POST to `/search/search`, not a gRPC
 * call on AtlasGw.
 *
 * @internal Bundle-layer accessor. Public consumers reach AtlasGw
 * methods via `src/api/friends.ts`.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `A` AtlasGw client instance
 */
export const atlasClient = (sandbox: Sandbox): AtlasGwClient =>
  reach<AtlasGwClient>(sandbox, G_ATLAS_CLIENT, "atlasClient");

// ─── 6. search codec getters + cross-realm helpers ──────────────────────

/**
 * Bundle's `SearchRequest` ts-proto codec — `HY` in chat module ~10409.
 *
 * Returns the live codec object; consumers call `.fromPartial(...)` and
 * `.encode(msg).finish()` to build the request body for the
 * `/search/search` POST. See {@link SearchRequestCodec}.
 *
 * @internal Bundle-layer accessor. Used by {@link searchUsers} below.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `HY` codec
 */
export const searchRequestCodec = (sandbox: Sandbox): SearchRequestCodec =>
  reach<SearchRequestCodec>(sandbox, G_SEARCH_REQ_CODEC, "searchRequestCodec");

/**
 * Bundle's `SearchResponse` ts-proto codec — `JY` in chat module ~10409.
 *
 * Returns the live codec object; consumers call `.decode(bytes)` to
 * parse the `/search/search` POST response. See {@link SearchResponseCodec}.
 *
 * @internal Bundle-layer accessor. Used by {@link searchUsers} below.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `JY` codec
 */
export const searchResponseCodec = (sandbox: Sandbox): SearchResponseCodec =>
  reach<SearchResponseCodec>(sandbox, G_SEARCH_RESP_CODEC, "searchResponseCodec");

/**
 * Wrap a host-realm `Uint8Array` (or `ArrayBuffer`) with the SANDBOX
 * realm's `Uint8Array` constructor.
 *
 * The bundle's protobuf reader (chat main ~byte 2840000) does an
 * `e instanceof Uint8Array` check before constructing a Reader;
 * cross-realm `Uint8Array`s fail that check because the sandbox
 * `vm.Context` has its own constructor (see `shims/sandbox.ts`).
 *
 * Falls back to host `Uint8Array` if the sandbox isn't initialized — the
 * resulting buffer will fail bundle decode, but that surfaces as a
 * cleaner error at call-site than throwing here.
 *
 * @internal Cross-realm helper for bundle-bound byte buffers.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param src - host-realm `Uint8Array` or `ArrayBuffer`
 * @returns a sandbox-realm `Uint8Array` over the same bytes
 */
export const toVmU8 = (sandbox: Sandbox, src: Uint8Array | ArrayBuffer): Uint8Array => {
  const SU8 = sandbox.getGlobal<typeof Uint8Array>("Uint8Array") ?? Uint8Array;
  return new SU8(src as ArrayBufferLike);
};

/**
 * Generate a UUID using the SANDBOX realm's `crypto.randomUUID`.
 *
 * Returns `""` (not undefined) when the sandbox `crypto` global is
 * missing — the bundle's search request accepts an empty `sessionId`
 * and a string fallback keeps consumer types simple.
 *
 * @internal Cross-realm helper used when seeding bundle-bound request
 * envelopes with a sessionId.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns a hyphenated UUID string, or `""` when `crypto` is absent
 */
export const sandboxRandomUUID = (sandbox: Sandbox): string =>
  sandbox.getGlobal<{ randomUUID?: () => string }>("crypto")?.randomUUID?.() ?? "";

/**
 * Compound search operation — encodes the request, POSTs through the
 * bundle's `default-authed-fetch`, and decodes the response. The api
 * layer adapts the result into consumer-shape `User[]`.
 *
 * Lives here (not in api/) because it composes three register-internal
 * primitives (codecs + {@link defaultAuthedFetch} + {@link hostModule})
 * and the api rule forbids reaching for those directly. Returns the raw
 * decoded shape so the api layer owns the field-mapping decisions.
 *
 * `sectionType` defaults to 2 (`SECTION_TYPE_ADD_FRIENDS`); `origin`
 * defaults to 21 (`ORIGIN_DWEB`); `numToReturn` defaults to 20 — all
 * matching what the SPA sends from its search-bar code path.
 *
 * @internal Bundle-layer composition. Public consumers reach search via
 * `SnapcapClient.searchUsers()` (see `src/api/search.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param query - free-form search string (username / display-name fragment)
 * @param opts - optional overrides for `sectionType` / `numToReturn` / `origin`
 * @returns the raw decoded {@link DecodedSearchResponse}
 */
export const searchUsers = async (
  sandbox: Sandbox,
  query: string,
  opts: { sectionType?: number; numToReturn?: number; origin?: number } = {},
): Promise<DecodedSearchResponse> => {
  const HY = searchRequestCodec(sandbox);
  const JY = searchResponseCodec(sandbox);
  const sectionType = opts.sectionType ?? 2; // SECTION_TYPE_ADD_FRIENDS
  const reqMsg = HY.fromPartial({
    queryString: query,
    origin: opts.origin ?? 21, // ORIGIN_DWEB
    requestOptions: {
      sectionsToReturn: [sectionType],
      numToReturn: opts.numToReturn ?? 20,
    },
    sessionId: sandboxRandomUUID(sandbox),
  });
  const body = toVmU8(sandbox, HY.encode(reqMsg).finish());
  const url = `${hostModule(sandbox).r5}/search/search`;
  const resp = await defaultAuthedFetch(sandbox).s(url, { method: "POST", body });
  if (!resp.ok) return { sections: [] };
  return JY.decode(toVmU8(sandbox, await resp.arrayBuffer()));
};

// ─── 7. slice-from-state + subscription helpers ─────────────────────────

/**
 * Project the `user` slice out of a chat-bundle `ChatState`.
 *
 * Pure thunk — exists so subscribers don't have to reach for
 * `state.user.*` directly (and so the per-slice diffing API stays
 * uniform across api files).
 *
 * @internal Bundle-layer projection helper.
 * @param state - a {@link ChatState} snapshot from the chat-bundle store
 * @returns the `user` slice of `state`
 */
export const userSliceFrom = (state: ChatState): UserSlice => state.user;

/**
 * Subscribe to a projection of `state.user` with consumer-supplied
 * equality. The `select` projection is recomputed on every store tick;
 * `cb` fires only when `equals(curr, prev)` returns false.
 *
 * Why `equals` is explicit (not defaulted to `===`): the bundle mutates
 * the user slice in-place via Immer drafts, so reference equality flips
 * arbitrarily. Each consumer picks its own diff strategy — array length +
 * per-element check for friend ids, Map.size for incoming requests, etc.
 *
 * The first invocation primes `prev` from the initial selector value and
 * does NOT fire `cb` — same no-replay semantics as the manual subscribers
 * in `friends.ts`. Returns an {@link Unsubscribe} thunk that's idempotent
 * and never throws (Zustand's own unsubscribe is safe to call twice; we
 * swallow consumer errors inside the listener so a misbehaving callback
 * doesn't tear down the subscription).
 *
 * @internal Bundle-layer subscription helper. Public consumers reach
 * subscriptions via the api layer's `subscribeFriends` etc.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param select - projection from {@link UserSlice} to a comparable value
 * @param equals - equality predicate over the projected value
 * @param cb - listener fired with `(curr, prev, fullState)` on each change
 * @returns an idempotent {@link Unsubscribe} thunk
 */
export const subscribeUserSlice = <T>(
  sandbox: Sandbox,
  select: (u: UserSlice) => T,
  equals: (a: T, b: T) => boolean,
  cb: (curr: T, prev: T, fullState: ChatState) => void,
): Unsubscribe => {
  let prev: T | undefined;
  let cancelled = false;
  let unsub: (() => void) | undefined;
  try {
    const store = chatStore(sandbox);
    prev = select(userSliceFrom(store.getState() as ChatState));
    unsub = store.subscribe((state) => {
      const curr = select(userSliceFrom(state));
      const oldPrev = prev as T;
      if (equals(curr, oldPrev)) return;
      prev = curr;
      try { cb(curr, oldPrev, state); }
      catch { /* swallow consumer errors so the subscription survives */ }
    });
  } catch {
    // Bundle not loaded yet — return a no-op unsub. Consumers should
    // resubscribe after `client.authenticate()` if they need real events.
  }
  return () => {
    if (cancelled) return;
    cancelled = true;
    try { unsub?.(); } catch { /* ignore */ }
  };
};
