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
  NiChatRpc,
  SearchRequestCodec,
  SearchResponseCodec,
  SendsModule,
  StoryDescModule,
  StoryManager,
  UserInfoClient,
  UserSlice,
} from "./types.ts";

/**
 * Re-export `Unsubscribe` so api files can import the cancel-thunk type
 * from the same module they import the subscriber helpers from. Kept thin
 * (`() => void`) — same shape as Zustand's `unsubscribe` and the api-side
 * `Unsubscribe` aliases.
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

/** TODO: FriendRequests `N` client — chat main byte ~6940000, source-patch __SNAPCAP_FRIEND_REQUESTS */
const G_FRIEND_REQUESTS_CLIENT: string | undefined = undefined;
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

// ─── 3. helpers ──────────────────────────────────────────────────────────

/**
 * Reach a sandbox `globalThis.__SNAPCAP_*` symbol by key. Throws a
 * friendly error when the bundle hasn't loaded, the source-patch site
 * shifted, or the consumer called us before `client.authenticate()`.
 *
 * Accepts `string | undefined` so TODO getters (whose constant mapper
 * is still `undefined`) pass through untouched and produce a uniform
 * "not yet mapped" error at call time.
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

/** Reach a chat-bundle webpack module by id. */
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

// Friend graph mutations — `jz` FriendAction client (chat module 10409).
// Methods: TransferInvites, AddFriends, InviteFriends, InviteOrAddFriendsByPhone,
// BlockFriends, UnblockFriends, RemoveFriends, IgnoreFriends,
// ChangeDisplayNameForFriends, MuteStoryForFriends, UnmuteStoryForFriends,
// SetPostViewEmojiFoFriends, CheckActionEligibility.
export const friendActionClient = (sandbox: Sandbox): JzFriendAction =>
  reach<JzFriendAction>(sandbox, G_FRIEND_ACTION, "friendActionClient");

// Login — accounts module 13150 `WebLoginServiceClientImpl` ctor.
// Construct with `new (loginClient(sandbox))({ unary }).WebLogin(req)`.
export const loginClient = (sandbox: Sandbox): LoginClientCtor =>
  reach<LoginClientCtor>(sandbox, G_LOGIN_CLIENT_IMPL, "loginClient");

// Raw chat-bundle Zustand store — exposes `subscribe`, `getState`,
// `setState`. Chat module 94704. Use this when you need a live
// subscription to state mutations (e.g. friends-list deltas) or to peek
// at slices the registry does not yet expose a getter for. Per Phase 1B
// empirical finding the bundle uses plain Zustand (no `subscribeWithSelector`
// middleware) — `subscribe` is single-arg `(state, prev) => void`.
export const chatStore = (sandbox: Sandbox): ChatStore =>
  reachModule<{ M: ChatStore }>(sandbox, MOD_CHAT_STORE, "chatStore").M;

// Auth slice — Zustand store on chat module 94704; methods: initialize,
// logout, refreshToken, fetchToken (PageLoad-time SPA only).
export const authSlice = (sandbox: Sandbox): AuthSlice =>
  (chatStore(sandbox).getState() as ChatState).auth;

// User slice — Zustand store on chat module 94704; carries the friend
// graph (`mutuallyConfirmedFriendIds`), pending requests
// (`incomingFriendRequests`, `outgoingFriendRequestIds`), and the
// `publicUsers` cache populated by `GetSnapchatterPublicInfo`. Mutated
// in place by Immer drafts; subscribers should use `chatStore().subscribe`
// for delta detection.
export const userSlice = (sandbox: Sandbox): UserSlice =>
  (chatStore(sandbox).getState() as ChatState).user;

// Generic chat-side gRPC escape hatch — `Ni.rpc.unary` for arbitrary
// AtlasGw / friending / etc. calls bypassing the typed registry.
export const chatRpc = (sandbox: Sandbox): NiChatRpc =>
  reach<NiChatRpc>(sandbox, G_CHAT_RPC, "chatRpc");

/**
 * Raw chat-bundle webpack require — escape hatch for code that needs to
 * walk `wreq.m` (the factory map) or call factories directly through a
 * shimmed wreq (priming, cache-cycle rewiring). Most consumers should
 * reach for the typed getters above instead — this is reserved for
 * bundle-plumbing helpers (see `bundle/prime.ts`) that have to bypass
 * webpack's closure-private cache to break factory-time cyclic deps.
 *
 * Re-exported here so api files don't have to import `getChatWreq`
 * directly from `./chat-loader.ts` (the architecture rule's gate point).
 */
export const chatWreq = (sandbox: Sandbox): ((id: string) => unknown) & { m: Record<string, Function> } =>
  getChatWreq(sandbox);

// Media upload delegate — `Fi` (chat module 76877). `uploadMedia` /
// `uploadMediaReferences` for direct upload control; sends/snaps usually
// drive uploads as a side-effect.
export const uploadDelegate = (sandbox: Sandbox): FiUpload =>
  reach<FiUpload>(sandbox, G_FI_UPLOAD, "uploadDelegate");

// Messaging sends + reads + lifecycle — chat module 56639. Exposes the
// bundle-private letter pairs (pn, E$, HM, Sd, Mw, ON, etc.) that hang
// off `getConversationManager()` / `getFeedManager()` / `getSnapManager()`
// on the WASM session. See `SendsModule` interface in `./types.ts` for
// the full export map.
export const messagingSends = (sandbox: Sandbox): SendsModule =>
  reachModule<SendsModule>(sandbox, MOD_SENDS, "messagingSends");

// Destinations builder — chat module 79028 `Ju` builds a
// `SnapDestinations` envelope from a partial.
export const destinationsModule = (sandbox: Sandbox): DestinationsModule =>
  reachModule<DestinationsModule>(sandbox, MOD_DESTINATIONS, "destinationsModule");

// Story descriptor helpers — chat module 74762 (`R9` MY_STORY descriptor,
// `ge` server-destination conversion).
export const storyDescModule = (sandbox: Sandbox): StoryDescModule =>
  reachModule<StoryDescModule>(sandbox, MOD_STORY_DESC, "storyDescModule");

// Host constants — chat module 41359 (`r5` is `https://web.snapchat.com`).
export const hostModule = (sandbox: Sandbox): HostModule =>
  reachModule<HostModule>(sandbox, MOD_HOST, "hostModule");

// Default-authed fetch helper — chat module 34010. `s(url, opts)` is the
// bundle's same-origin POST helper with bearer + cookies attached the way
// the SPA does. Friends.search routes the `/search/search` POST through it.
export const defaultAuthedFetch = (sandbox: Sandbox): DefaultAuthedFetchModule => {
  const mod = reachModule<Partial<DefaultAuthedFetchModule>>(sandbox, MOD_DEFAULT_AUTHED_FETCH, "defaultAuthedFetch");
  if (!mod || typeof mod.s !== "function") {
    throw new Error(`defaultAuthedFetch: chat module ${MOD_DEFAULT_AUTHED_FETCH} shape shifted`);
  }
  return mod as DefaultAuthedFetchModule;
};

// AtlasGw class — chat module 74052; consumers wrap with their own
// `{unary}` rpc transport. Walks the module's exports to find the class
// whose prototype has `SyncFriendData`. Switch to the natural instance
// once `__SNAPCAP_ATLAS` lands (see `atlasClient` below).
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

// TODO: FriendRequests `N` client — chat main byte ~6939950 (Process,
// IncomingFriendSync). SDK currently routes around via api/friending.ts.
export const friendRequestsClient = (sandbox: Sandbox): FriendRequestsClient =>
  reach<FriendRequestsClient>(sandbox, G_FRIEND_REQUESTS_CLIENT, "friendRequestsClient");

// TODO: UserInfo/Self client — no dedicated RPC located yet; investigate
// AtlasGw `GetSnapchatterPublicInfo` and any `GetSelf` candidate.
export const userInfoClient = (sandbox: Sandbox): UserInfoClient =>
  reach<UserInfoClient>(sandbox, G_USER_INFO_CLIENT, "userInfoClient");

// TODO: StoryManager — `getStoryManager()` on the WASM session; needs an
// Embind trace + a source-patch to surface as `__SNAPCAP_STORY_MANAGER`.
export const storyManager = (sandbox: Sandbox): StoryManager =>
  reach<StoryManager>(sandbox, G_STORY_MANAGER, "storyManager");

// AtlasGw natural instance — chat main byte ~6940575 closure-private `A`,
// source-patched as `__SNAPCAP_ATLAS`. Prefer this over `atlasGwClass()` —
// it's the same per-bundle `A` instance the SPA uses, with `rpc.unary`
// wired to the bundle's own `default-authed-fetch` (so bearer + cookies
// are attached the way the SPA does).
//
// NOTE: AtlasGw has no fuzzy user-search method. `friends.search()`
// continues to use the closure-private `HY/jY` codecs + `defaultAuthedFetch`
// because the bundle's own search path (`Yz`, byte ~1435000) is REST POST
// to `/search/search`, not a gRPC call on AtlasGw.
export const atlasClient = (sandbox: Sandbox): AtlasGwClient =>
  reach<AtlasGwClient>(sandbox, G_ATLAS_CLIENT, "atlasClient");

// ─── 6. search codec getters + cross-realm helpers ──────────────────────

/**
 * Bundle's `SearchRequest` ts-proto codec — `HY` in chat module ~10409.
 * Returns the live codec object; consumers call `.fromPartial(...)` and
 * `.encode(msg).finish()` to build the request body for the
 * `/search/search` POST.
 */
export const searchRequestCodec = (sandbox: Sandbox): SearchRequestCodec =>
  reach<SearchRequestCodec>(sandbox, G_SEARCH_REQ_CODEC, "searchRequestCodec");

/**
 * Bundle's `SearchResponse` ts-proto codec — `JY` in chat module ~10409.
 * Returns the live codec object; consumers call `.decode(bytes)` to parse
 * the `/search/search` POST response.
 */
export const searchResponseCodec = (sandbox: Sandbox): SearchResponseCodec =>
  reach<SearchResponseCodec>(sandbox, G_SEARCH_RESP_CODEC, "searchResponseCodec");

/**
 * Wrap a host-realm `Uint8Array` (or `ArrayBuffer`) with the SANDBOX
 * realm's `Uint8Array` constructor. The bundle's protobuf reader (chat
 * main ~byte 2840000) does an `e instanceof Uint8Array` check before
 * constructing a Reader; cross-realm `Uint8Array`s fail that check
 * because the sandbox `vm.Context` has its own constructor (see
 * `shims/sandbox.ts`).
 *
 * Falls back to host `Uint8Array` if the sandbox isn't initialized — the
 * resulting buffer will fail bundle decode, but that surfaces as a
 * cleaner error at call-site than throwing here.
 */
export const toVmU8 = (sandbox: Sandbox, src: Uint8Array | ArrayBuffer): Uint8Array => {
  const SU8 = sandbox.getGlobal<typeof Uint8Array>("Uint8Array") ?? Uint8Array;
  return new SU8(src as ArrayBufferLike);
};

/**
 * Generate a UUID using the SANDBOX realm's `crypto.randomUUID`. Returns
 * `""` (not undefined) when the sandbox `crypto` global is missing — the
 * bundle's search request accepts an empty `sessionId` and a string
 * fallback keeps consumer types simple.
 */
export const sandboxRandomUUID = (sandbox: Sandbox): string =>
  sandbox.getGlobal<{ randomUUID?: () => string }>("crypto")?.randomUUID?.() ?? "";

/**
 * Compound search operation — encodes the request, POSTs through the
 * bundle's `default-authed-fetch`, and decodes the response. The api
 * layer adapts the result into consumer-shape `User[]`.
 *
 * Lives here (not in api/) because it composes three register-internal
 * primitives (codecs + `defaultAuthedFetch` + `hostModule`) and the api
 * rule forbids reaching for those directly. Returns the raw decoded
 * shape so the api layer owns the field-mapping decisions.
 *
 * `sectionType` defaults to 2 (`SECTION_TYPE_ADD_FRIENDS`); `origin`
 * defaults to 21 (`ORIGIN_DWEB`); `numToReturn` defaults to 20 — all
 * matching what the SPA sends from its search-bar code path.
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
 * Project the `user` slice out of a chat-bundle `ChatState`. Pure thunk —
 * exists so subscribers don't have to reach for `state.user.*` directly
 * (and so the per-slice diffing API stays uniform across api files).
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
 * in `friends.ts`. Returns an `Unsubscribe` thunk that's idempotent and
 * never throws (Zustand's own unsubscribe is safe to call twice; we
 * swallow consumer errors inside the listener so a misbehaving callback
 * doesn't tear down the subscription).
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
