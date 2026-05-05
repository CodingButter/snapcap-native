/**
 * Friends manager — domain surface for the social graph.
 *
 * Takes consumer-friendly args (hyphenated UUID strings, named enums)
 * and returns consumer-shape types — never leaks Snap's internal
 * protobuf shapes.
 *
 * @see {@link IFriendsManager}
 * @see {@link Friends}
 * @see {@link SnapcapClient.friends}
 */
import type { ClientContext } from "./_context.ts";
import {
  atlasClient,
  friendActionClient,
  searchUsers,
  subscribeUserSlice,
  userSlice,
  userSliceFrom,
} from "../bundle/register.ts";
import type {
  ChatState,
  IncomingFriendRequestRecord,
  PublicUserRecord,
  SnapchatterPublicInfo,
  UserSlice,
} from "../bundle/types/index.ts";
import { bytesToUuid, extractUserId, makeFriendIdParams, uuidToBytes } from "./_helpers.ts";
import {
  diffGraph,
  type FriendGraphSnapshot,
  isEmptyGraphSnapshot,
  loadGraphCache,
  saveGraphCache,
} from "./_friend_graph_cache.ts";
import { type Subscription, TypedEventBus } from "../lib/typed-event-bus.ts";

// ─── Consumer-shape types ─────────────────────────────────────────────────
//
// These are the public types the SDK surfaces — strings for UUIDs, named
// enums where appropriate, no protobuf-decoded objects leaking through.

/**
 * 16-byte UUID rendered as a hyphenated string.
 *
 * @example
 * ```ts
 * const id: UserId = "eabd1d89-239a-4f7b-bbcc-0ae3b26c5202";
 * ```
 */
export type UserId = string;

/**
 * Thunk returned by subscription methods (e.g.
 * {@link IFriendsManager.onChange}). Calling it cancels the subscription.
 * Idempotent — calling more than once is a no-op.
 */
export type Unsubscribe = () => void;

/**
 * Attribution source for {@link IFriendsManager.sendRequest}.
 *
 * Mirrors the bundle's `J$.source` field on `FriendActionParams` (chat
 * module 10409, offset ~1406050 in `9846a7958a5f0bee7197.js`).
 *
 * @remarks
 * Default for `sendRequest()` is `ADDED_BY_USERNAME` — what the SPA sends
 * from the search-result "Add" button.
 */
export const FriendSource = {
  ADDED_BY_UNKNOWN: 0,
  ADDED_BY_PHONE: 1,
  ADDED_BY_USERNAME: 2,
  ADDED_BY_QR_CODE: 3,
  ADDED_BY_ADDED_ME_BACK: 4,
  ADDED_BY_DEEP_LINK: 8,
  ADDED_BY_MENTION: 21,
  ADDED_BY_SUBSCRIPTION: 22,
  ADDED_FROM_SPOTLIGHT: 25,
  ADDED_FROM_PUBLIC_PROFILE: 26,
  ADDED_BY_CHAT: 28,
  ADDED_BY_SEARCH: 32,
  ADDED_BY_WEB: 33,
} as const;
/**
 * String-keyed enum form of {@link FriendSource} — the type of any value
 * read off the const object.
 */
export type FriendSource = typeof FriendSource[keyof typeof FriendSource];

/**
 * Friend-link state.
 *
 * @remarks
 * Captured codes from the bundle's `friendLinkType` field; `"unknown"`
 * for any other value until labelled.
 */
export type FriendLinkType =
  | "mutual"
  | "added"
  | "added-by-them"
  | "blocked"
  | "self"
  | "unknown";

/**
 * Bitmoji avatar identifiers. Used to render a user's bitmoji via Snap's
 * `images.bitmoji.com` CDN — the avatar id pairs with a sticker / pose
 * id to construct the URL.
 *
 * @remarks
 * All four ids are optional and frequently absent — only users who have
 * created a bitmoji surface any of them, and the scene / background slots
 * are only set when the user has customized those layers.
 *
 * The exact semantic difference between the ids is partially captured
 * from the bundle and partially inferred — treat the inline notes below
 * as best-effort, not authoritative.
 *
 * @see {@link User.bitmojiPublicInfo}
 */
export interface BitmojiPublicInfo {
  /** Primary avatar id — the head/body construction the bitmoji CDN keys off. */
  bitmojiAvatarId?: string;
  /** Selfie pose / expression id — the avatar's face crop used for profile chips. */
  bitmojiSelfieId?: string;
  /** Scene id — full-body pose composition (observed only on richer profiles). */
  bitmojiSceneId?: string;
  /** Background id — the backdrop layer rendered behind the avatar. */
  bitmojiBackgroundId?: string;
  /** Forward-compat for fields Snap adds to the bitmoji envelope. */
  [k: string]: unknown;
}

/**
 * A user surfaced from search / lookup / friends list. Mirrors the shape
 * of Snap's `GetSnapchatterPublicInfo` response — every public field
 * Snap returns is typed here, with the same camel-cased names.
 *
 * @remarks
 * Field availability depends on the **source** of the record:
 *
 * - From {@link IFriendsManager.getUsers} (cache-hit *or* RPC) — the
 *   full envelope: `displayName`, `mutableUsername`, `isOfficial`,
 *   `isPopular`, `snapProId`, `profileTier`, `bitmojiPublicInfo`,
 *   `profileLogo`, `creatorSubscriptionProductsInfo`. Cache-only hits
 *   carry the subset the bundle's `publicUsers` cache stores
 *   ({@link PublicUserRecord}: `username`, `mutableUsername`,
 *   `displayName`); RPC hits carry everything Snap returned.
 * - From {@link IFriendsManager.search} — only `userId`, `username`,
 *   `displayName`. The search index never returns the richer flags.
 * - From {@link IFriendsManager.list} (via {@link Friend}) — populated
 *   from whatever the bundle's `publicUsers` cache happened to hold
 *   when `syncFriends()` ran. `username` may be empty if the friend's
 *   public info hadn't been fetched yet — match by `userId` in that
 *   case and call {@link IFriendsManager.getUsers} to backfill.
 *
 * `notFound` is set ONLY by {@link IFriendsManager.getUsers} when the
 * server explicitly returned no record for the requested `userId` — the
 * account was deleted, blocked the caller, or never existed. It
 * distinguishes "we asked, server said no" from "we just haven't fetched
 * it yet" (the empty-`username` case). Never set by `list()` / `search()`.
 *
 * The `[k: string]: unknown` index keeps consumers forward-compatible
 * with future Snap fields the SDK hasn't typed yet — read them
 * defensively (`(user as any).newField`).
 *
 * @see {@link IFriendsManager.getUsers}
 * @see {@link BitmojiPublicInfo}
 */
export interface User {
  /** Hyphenated UUID (string view of Snap's `userId` bytes). */
  userId: UserId;
  /** Snap username (handle). May be empty when populated from a partial source. */
  username: string;

  /** Display name shown in the Snap UI. */
  displayName?: string;
  /** Current handle when the user has changed it (Snap retains the original `username`). */
  mutableUsername?: string;
  /** `true` for verified Snap-official accounts. */
  isOfficial?: boolean;
  /** `true` for accounts Snap surfaces as popular (high follower count, public profile, etc.). */
  isPopular?: boolean;
  /** Snapchat+ subscription product id; empty string when not subscribed. */
  snapProId?: string;
  /** Profile-tier int; semantics opaque (observed: `1` for typical accounts). */
  profileTier?: number;
  /** Bitmoji avatar identifiers — see {@link BitmojiPublicInfo}. */
  bitmojiPublicInfo?: BitmojiPublicInfo;
  /** Profile-logo envelope; shape varies, kept untyped. */
  profileLogo?: unknown;
  /** Creator-subscription products envelope; shape varies, kept untyped. */
  creatorSubscriptionProductsInfo?: unknown;

  /** Set only by {@link IFriendsManager.getUsers} when the server confirmed no record exists. */
  notFound?: true;

  /** Forward-compat for fields Snap adds to the public-info envelope. */
  [k: string]: unknown;
}

/**
 * A friend in the logged-in user's social graph.
 *
 * Superset of {@link User} with friend-link metadata and (when surfaced
 * by the server) timestamps.
 */
export interface Friend extends User {
  /** Link state — `"mutual"` for entries returned by {@link IFriendsManager.list}. */
  friendType: FriendLinkType;
  /** When the friend was added (server-side ms timestamp surfaced as a Date). */
  addedAt?: Date;
  /** `true` if the logged-in user has muted this friend's story. */
  isStoryMuted?: boolean;
  /** `true` if the friend's account has Snapchat+. */
  isPlusSubscriber?: boolean;
}

/**
 * An inbound friend request — someone has added the logged-in user and is
 * waiting for {@link IFriendsManager.acceptRequest} or
 * {@link IFriendsManager.rejectRequest}.
 */
export interface ReceivedRequest {
  /** Hyphenated UUID of the requester. */
  fromUserId: UserId;
  /** Requester's Snap username (handle). */
  fromUsername: string;
  /** Requester's display name. Optional. */
  fromDisplayName?: string;
  /** Server-side ms timestamp surfaced as a Date. */
  receivedAt?: Date;
  /** Best-effort source attribution (mirrors {@link FriendSource} enum). */
  source?: FriendSource;
}

/**
 * An outbound friend request — the logged-in user has added this account
 * and is waiting for them to accept.
 *
 * @remarks
 * `toUsername` / `toDisplayName` are best-effort: populated only when
 * the recipient is already in the `publicUsers` cache (mutuals lookups,
 * prior search, etc.). Callers can always match on `toUserId`.
 */
export interface SentRequest {
  /** Hyphenated UUID of the recipient. */
  toUserId: UserId;
  /** Recipient's Snap username — only present when the public-users cache holds them. */
  toUsername?: string;
  /** Recipient's display name — only present when the public-users cache holds them. */
  toDisplayName?: string;
}

/**
 * A point-in-time view of the entire friend graph — mutuals + pending
 * requests in both directions.
 *
 * @remarks
 * Returned by {@link IFriendsManager.snapshot} (canonical) and the
 * underlying source for {@link IFriendsManager.list},
 * {@link IFriendsManager.receivedRequests}, and
 * {@link IFriendsManager.sentRequests}. The same object shape is
 * delivered to {@link IFriendsManager.onChange} subscribers whenever any
 * of the three slots mutates.
 */
export interface FriendsSnapshot {
  /** All mutually-confirmed friends. */
  mutuals: Friend[];
  /** Pending inbound friend requests (others adding the logged-in user). */
  received: ReceivedRequest[];
  /** Pending outbound friend requests (the logged-in user's adds). */
  sent: SentRequest[];
}

/**
 * Map of event name → callback signature for {@link IFriendsManager.on}.
 * The callback's argument type narrows automatically per event key via
 * TypeScript's keyof inference.
 *
 * @remarks
 * Event names use a `:` namespace separator — `"request:received"`,
 * `"friend:added"`, etc. — so the keyspace stays organized as the API
 * grows. Friends events centre on graph mutations + inbox transitions.
 *
 * Currently wired:
 * - `request:received` — fires when a NEW entry appears in the bundle's
 *   `state.user.incomingFriendRequests` Map (i.e. someone sent us a
 *   friend request and the next `IncomingFriendSync` poll surfaced it).
 *   Note: poll-driven under the hood — fires after the bundle's periodic
 *   sync, not on a real-time push from Snap.
 * - `request:cancelled` — fires when a sender revokes an inbound
 *   request that was in our `received` slot (the entry disappears from
 *   `incomingFriendRequests` without us having accepted / rejected it).
 * - `request:accepted` — fires when a userId we sent a request to
 *   becomes mutual: it leaves `outgoingFriendRequestIds` and appears in
 *   `mutuallyConfirmedFriendIds` on the same tick. Note: also fires
 *   `friend:added` for the same id — semantics are distinct (this one
 *   is "they accepted my add", `friend:added` is "this id is now in
 *   the mutuals list").
 * - `friend:added` — fires when a userId newly appears in
 *   `mutuallyConfirmedFriendIds`.
 * - `friend:removed` — fires when a userId leaves
 *   `mutuallyConfirmedFriendIds` (unfriend / block).
 * - `change` — fires whenever any of the three friend-graph slots
 *   (mutuals / received / sent) mutates. Same payload as `onChange`.
 *
 * Persistence note: the four diff-style events
 * (`friend:added` / `friend:removed` / `request:received` /
 * `request:cancelled` / `request:accepted`) are powered by a shared
 * watcher that diffs the current friend graph against a persisted
 * snapshot in the `DataStore`. This means deltas that happened while
 * the SDK was offline will REPLAY on the next refresh / state tick
 * after startup — subscribers should be idempotent over redeliveries.
 */
export interface FriendsEvents {
  "request:received": (req: ReceivedRequest) => void;
  "request:cancelled": (userId: UserId) => void;
  "request:accepted": (userId: UserId) => void;
  "friend:added": (friend: Friend) => void;
  "friend:removed": (userId: UserId) => void;
  "change": (snapshot: FriendsSnapshot) => void;
}

// ─── Manager interface ────────────────────────────────────────────────────

/**
 * Friends domain manager — all friend-graph operations live here.
 *
 * All UUIDs are hyphenated string {@link UserId} values. Mutations
 * resolve `void` on success; reads return consumer-shape types
 * ({@link Friend}, {@link User}, {@link ReceivedRequest},
 * {@link SentRequest}) — never bundle protobuf shapes.
 *
 * @remarks
 * Reads share a single underlying {@link IFriendsManager.snapshot}.
 * {@link IFriendsManager.list}, {@link IFriendsManager.receivedRequests},
 * and {@link IFriendsManager.sentRequests} are slim accessors that
 * project the relevant slice. One subscription method
 * ({@link IFriendsManager.onChange}) fires whenever any of the three
 * slots changes; it returns an `Unsubscribe` thunk that's
 * idempotent.
 *
 * Pending-request methods ({@link IFriendsManager.acceptRequest},
 * {@link IFriendsManager.rejectRequest}) are not yet wired and currently
 * throw.
 *
 * @see {@link Friends}
 * @see {@link FriendsSnapshot}
 */
export interface IFriendsManager {
  // ── Friend mutations ────────────────────────────────────────────────

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
   * **What does work:** {@link IFriendsManager.sendRequest} (web supports
   * AddFriends), {@link IFriendsManager.acceptRequest},
   * {@link IFriendsManager.rejectRequest}.
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
   * Equivalent on the wire to {@link IFriendsManager.sendRequest} with
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
   * {@link IFriendsManager.receivedRequests}.
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

  // ── Reads ───────────────────────────────────────────────────────────

  /**
   * All friends in the logged-in user's social graph (excluding self).
   *
   * @returns Mutually-confirmed friends as {@link Friend} records.
   *
   * @example
   * ```ts
   * const friends = await client.friends.list();
   * for (const f of friends) console.log(f.username);
   * ```
   */
  list(): Promise<Friend[]>;

  /**
   * All pending received friend requests.
   *
   * @returns Inbound {@link ReceivedRequest} records waiting for accept /
   * reject / ignore.
   */
  receivedRequests(): Promise<ReceivedRequest[]>;

  /**
   * All pending sent friend requests (the logged-in user's adds
   * waiting for the recipient to accept).
   *
   * @returns Outbound {@link SentRequest} records.
   */
  sentRequests(): Promise<SentRequest[]>;

  /**
   * Canonical point-in-time view of the friend graph — mutuals + pending
   * requests in both directions.
   *
   * @returns A {@link FriendsSnapshot} with all three slots populated.
   *
   * @remarks
   * The split read accessors ({@link IFriendsManager.list},
   * {@link IFriendsManager.receivedRequests},
   * {@link IFriendsManager.sentRequests}) all project from this.
   */
  snapshot(): Promise<FriendsSnapshot>;

  /**
   * Force an explicit re-sync from the server — pulls the latest mutuals
   * + outgoing requests (via `SyncFriendData`) AND incoming requests (via
   * `IncomingFriendSync`).
   *
   * @remarks
   * The bundle does NOT auto-poll for fresh state — the SPA's React layer
   * normally drives that cadence, and we don't load React. So consumers
   * who want event subscriptions like {@link IFriendsManager.on}(`"request:received"`)
   * to actually fire must drive their own refresh cadence. Common patterns:
   *
   * - Call `refresh()` in a `setInterval` (every 10–30s for inbox-style
   *   monitoring, every 60s+ for less time-sensitive use cases).
   * - Call `refresh()` on demand right before a snapshot read.
   *
   * Best-effort — failures are swallowed (the existing `userSlice.syncFriends`
   * pattern). Subsequent reads return whatever is in cache.
   *
   * @example
   * ```ts
   * setInterval(() => client.friends.refresh(), 30_000);
   * client.friends.on("request:received", (req) => { ... });
   * ```
   */
  refresh(): Promise<void>;

  /**
   * Search Snap's user index by username / display-name fragment.
   *
   * @param query - Free-text query — Snap's "Add Friends" search box
   * matches both usernames and display names, with prefix and substring
   * weighting.
   * @returns A list of matching {@link User} records. Empty when `query`
   * is empty or no users match.
   *
   * @example
   * ```ts
   * const users = await client.friends.search("alice");
   * ```
   */
  search(query: string): Promise<User[]>;

  /**
   * Resolve a list of user IDs to {@link User} records (username +
   * display name).
   *
   * Cache-first: each ID is looked up in the bundle's
   * `state.user.publicUsers` cache; only IDs that miss are sent to Snap's
   * `GetSnapchatterPublicInfo`. Pass `{ refresh: true }` to force a
   * fresh RPC for every ID.
   *
   * @param userIds - Hyphenated UUIDs to resolve.
   * @param opts - `refresh: true` re-fetches all IDs, ignoring the
   * cache. Defaults to cache-first.
   * @returns Resolved {@link User} records in the same order as `userIds`.
   * IDs the server returned no record for (deleted accounts, blocks)
   * appear with `notFound: true`.
   *
   * @example
   * Look up a single ID via array destructuring:
   * ```ts
   * const [user] = await client.friends.getUsers([id]);
   * if (user?.notFound) console.log("account is gone");
   * ```
   *
   * @example
   * Backfill usernames from a freshly-synced friends list:
   * ```ts
   * const friends = await client.friends.list();
   * const users = await client.friends.getUsers(friends.map((f) => f.userId));
   * ```
   */
  getUsers(userIds: UserId[], opts?: { refresh?: boolean }): Promise<User[]>;

  // ── Subscriptions ───────────────────────────────────────────────────

  /**
   * Fire `cb` whenever any part of the friend graph changes — mutuals,
   * incoming requests, or outgoing requests.
   *
   * The callback receives a full {@link FriendsSnapshot} reflecting the
   * new state. Initial state is NOT replayed — call
   * {@link IFriendsManager.snapshot} once after subscribing if you need
   * a baseline.
   *
   * @param cb - Subscriber invoked with the latest snapshot on every
   * relevant change.
   * @returns An `Unsubscribe` thunk; idempotent on repeat calls.
   *
   * @example
   * ```ts
   * const unsub = client.friends.onChange((snap) => {
   *   console.log(`mutuals=${snap.mutuals.length}`);
   * });
   * // ...later
   * unsub();
   * ```
   */
  onChange(cb: (snap: FriendsSnapshot) => void): Unsubscribe;

  /**
   * Subscribe to a typed friends event. Returns a {@link Subscription}
   * — call it to unsubscribe, or use `sub.signal` to tie the
   * subscription's life to anything that takes an `AbortSignal`.
   *
   * @param event - Event name from {@link FriendsEvents}.
   * @param cb - Callback fired with the event payload (type narrows on
   * `event`).
   * @param opts - Optional `signal` — when the passed `AbortSignal`
   * aborts, the subscription is torn down automatically. The returned
   * `sub.signal` reflects the combined lifetime (fires on either path).
   * @returns A {@link Subscription} — a callable unsubscribe thunk with
   * `.signal` attached.
   *
   * @example
   * ```ts
   * const sub = client.friends.on("request:received", (req) => {
   *   console.log(`new request from ${req.fromUsername}`);
   * });
   * // ...later
   * sub();
   * ```
   *
   * @example
   * Tie multiple subscriptions to one external `AbortController`:
   * ```ts
   * const ctrl = new AbortController();
   * client.friends.on("request:received", onReq, { signal: ctrl.signal });
   * client.friends.on("change", onChange, { signal: ctrl.signal });
   * ctrl.abort();   // tears down both
   * ```
   */
  on<K extends keyof FriendsEvents>(
    event: K,
    cb: FriendsEvents[K],
    opts?: { signal?: AbortSignal },
  ): Subscription;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

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

/**
 * Normalize the various userId shapes the bundle slice may surface into a
 * hyphenated UUID string. The slice's `mutuallyConfirmedFriendIds`,
 * `outgoingFriendRequestIds`, and incoming-request keys are typed as
 * `string` in `bundle/types.ts`, but at runtime can be either:
 *   - a hyphenated UUID string (post-codec friendly form), OR
 *   - a `{ id: Uint8Array(16), str: string }` envelope (the wire shape
 *     that some codecs leave as-is when ts-proto's `decode` doesn't
 *     unwrap the inner Uuid message).
 *
 * Returns `""` when neither form is recognizable — callers should treat
 * empty as "couldn't unwrap" and skip the entry rather than emit a
 * malformed `Friend`/`ReceivedRequest`/`SentRequest` to consumers.
 */
function unwrapUserId(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const r = raw as { str?: unknown; id?: unknown };
    if (typeof r.str === "string") return r.str;
    if (r.id instanceof Uint8Array && r.id.byteLength === 16) {
      return bytesToUuid(r.id);
    }
  }
  return "";
}

/**
 * Materialize a `Friend` from a bundle-side userId + the publicUsers cache.
 * Falls back to empty `username` when the cache hasn't been populated yet
 * (e.g. immediately after `syncFriends()` returns ids before public-info
 * is fetched). Callers can still match by `userId` in that case.
 *
 * `userId` arg may be a hyphenated string OR a `{id, str}` envelope from
 * the bundle slice — we normalize via `unwrapUserId` so the public
 * `Friend.userId` is always a string and the `publicUsers` lookup uses
 * the same string key the cache is keyed by.
 */
function makeFriend(userId: unknown, publicUsers: Map<string, PublicUserRecord>): Friend {
  const id = unwrapUserId(userId);
  const rec = publicUsers.get(id);
  return {
    userId: id,
    username: rec?.mutable_username ?? rec?.username ?? "",
    displayName: rec?.display_name,
    // Membership in `mutuallyConfirmedFriendIds` is the proof of mutual link.
    friendType: "mutual",
  };
}

/**
 * Materialize a `User` from the snake-cased {@link PublicUserRecord} the
 * bundle stores in `state.user.publicUsers`. Used by `getUsers` for
 * cache-hit IDs. The cache only surfaces username + display name —
 * richer fields (bitmoji, tier, profile flags) come from
 * {@link makeUserFromSnapchatter} on the RPC path.
 *
 * When the cache has no record for the id, returns a `notFound: true`
 * slot so consumers can distinguish "server explicitly returned no
 * record" from "cache was never populated for this id" — same semantic
 * as the cache-miss branch in `getUsers`.
 *
 * @internal
 */
function makeUserFromCache(
  id: UserId,
  publicUsers: Map<string, PublicUserRecord>,
): User {
  const rec = publicUsers.get(id);
  if (!rec) return { userId: id, username: "", notFound: true };
  const out: User = {
    userId: id,
    username: rec.mutable_username ?? rec.username ?? "",
  };
  if (rec.display_name) out.displayName = rec.display_name;
  if (rec.mutable_username) out.mutableUsername = rec.mutable_username;
  return out;
}

/**
 * Materialize a `User` from the camel-cased {@link SnapchatterPublicInfo}
 * record returned by `GetSnapchatterPublicInfo`. Copies every typed
 * field plus any extras Snap returned (forward-compat via the
 * {@link User} index signature).
 *
 * @internal
 */
function makeUserFromSnapchatter(id: UserId, snap: SnapchatterPublicInfo): User {
  // Strip `userId` from the spread — on `snap` it's a `Uint8Array(16)`
  // (the bundle wire shape), and we restore it from `id` as a hyphenated
  // string. Spread `rest` FIRST so our derived `userId` / `username`
  // overrides win even if Snap added a colliding key.
  //
  // Cast (`rest as Partial<User>`): SnapchatterPublicInfo intentionally
  // types nested envelopes (`bitmojiPublicInfo`, `profileLogo`,
  // `creatorSubscriptionProductsInfo`) as `unknown` at the bundle layer
  // — the bundle types stay loose so schema drift surfaces as a typed
  // `unknown` rather than a stale concrete shape. At runtime the values
  // match the {@link User}-side types; the cast just bridges the layers.
  const { userId: _drop, ...rest } = snap;
  return {
    ...(rest as Partial<User>),
    userId: id,
    // Prefer mutable handle (current display) over the original `username`
    // (Snap retains the original immutable handle in `username`).
    username: snap.mutableUsername || snap.username || "",
  };
}

/** Materialize a consumer-shape `ReceivedRequest` from the bundle record. */
function makeReceivedRequest(userId: unknown, rec: IncomingFriendRequestRecord): ReceivedRequest {
  return {
    fromUserId: unwrapUserId(userId),
    fromUsername: rec.mutable_username ?? rec.username ?? "",
    fromDisplayName: rec.display_name,
    receivedAt: rec.added_timestamp_ms ? new Date(rec.added_timestamp_ms) : undefined,
    source: rec.added_by as FriendSource | undefined,
  };
}

/** Convert the bundle-side incoming-requests Map into a consumer-shape array. */
function mapReceivedRequestsMap(
  map: Map<string, IncomingFriendRequestRecord> | undefined,
): ReceivedRequest[] {
  if (!map || typeof map.entries !== "function") return [];
  const out: ReceivedRequest[] = [];
  for (const [userId, rec] of map.entries()) {
    out.push(makeReceivedRequest(userId, rec));
  }
  return out;
}

/**
 * Materialize a `SentRequest` from a userId + the publicUsers cache.
 * When the recipient hasn't been resolved yet (cache miss), returns just
 * the `toUserId` and omits the username/display-name fields rather than
 * surfacing empty strings — keeps consumer presence-checks simple.
 *
 * `userId` arg may be a hyphenated string OR a `{id, str}` envelope from
 * the bundle slice — same rationale as `makeFriend`.
 */
function makeSentRequest(
  userId: unknown,
  publicUsers: Map<string, PublicUserRecord>,
): SentRequest {
  const id = unwrapUserId(userId);
  const rec = publicUsers.get(id);
  if (!rec) return { toUserId: id };
  const out: SentRequest = { toUserId: id };
  const username = rec.mutable_username ?? rec.username;
  if (username) out.toUsername = username;
  if (rec.display_name) out.toDisplayName = rec.display_name;
  return out;
}

/**
 * Build the id-set view of the friend graph used by the persistent
 * cache + diff machinery.
 *
 * Pure projection: no sync, no DataStore access. Materialization (rich
 * `Friend` / `ReceivedRequest` shapes) lives in {@link buildSnapshot};
 * this returns ONLY the three id-sets the {@link FriendGraphSnapshot}
 * persists, plus a wall-clock timestamp.
 *
 * Shared between the snapshot read path (which persists on every read
 * so single-call consumers seed the cache) and the diff-bridge tick
 * path (which persists after each fan-out so subsequent ticks diff
 * against the latest).
 *
 * @internal
 */
function buildGraphSnapshot(user: UserSlice): FriendGraphSnapshot {
  return {
    mutuals: Array.isArray(user.mutuallyConfirmedFriendIds)
      ? user.mutuallyConfirmedFriendIds.map(unwrapUserId).filter((id) => id !== "")
      : [],
    outgoing: Array.isArray(user.outgoingFriendRequestIds)
      ? user.outgoingFriendRequestIds.map(unwrapUserId).filter((id) => id !== "")
      : [],
    incoming: user.incomingFriendRequests
      ? Array.from(user.incomingFriendRequests.keys())
          .map(unwrapUserId)
          .filter((id) => id !== "")
      : [],
    ts: Date.now(),
  };
}

/**
 * Persist `snap` only if doing so wouldn't clobber a previously-good
 * cache with an empty snapshot. The bundle's `state.user` slice can
 * legitimately project as `{mutuals:[], outgoing:[], incoming:[]}` during
 * boot before the first `SyncFriendData` lands; writing that over a
 * populated cache wipes the offline-replay baseline between SDK runs.
 *
 * Falls through to {@link saveGraphCache} when `snap` is non-empty OR
 * when no prior populated cache exists. Best-effort: failures are
 * swallowed (matches the underlying `saveGraphCache` contract).
 *
 * @internal
 */
async function saveGraphCacheGuarded(
  ds: import("../storage/data-store.ts").DataStore,
  snap: FriendGraphSnapshot,
): Promise<void> {
  if (isEmptyGraphSnapshot(snap)) {
    try {
      const prior = await loadGraphCache(ds);
      if (prior && !isEmptyGraphSnapshot(prior)) return;
    } catch { /* fall through to save attempt */ }
  }
  await saveGraphCache(ds, snap);
}

/**
 * Build a full `FriendsSnapshot` from a `UserSlice`. Pure — no sync, no
 * side effects. The single source of truth for snapshot shape; both the
 * top-level `snapshot()` accessor and the `onChange` subscriber path
 * funnel through here.
 */
function buildSnapshot(user: UserSlice): FriendsSnapshot {
  const publicUsers = user.publicUsers ?? new Map<string, PublicUserRecord>();
  const mutualIds = Array.isArray(user.mutuallyConfirmedFriendIds)
    ? user.mutuallyConfirmedFriendIds
    : [];
  const outgoingIds = Array.isArray(user.outgoingFriendRequestIds)
    ? user.outgoingFriendRequestIds
    : [];
  return {
    mutuals: mutualIds.map((id) => makeFriend(id, publicUsers)),
    received: mapReceivedRequestsMap(user.incomingFriendRequests),
    sent: outgoingIds.map((id) => makeSentRequest(id, publicUsers)),
  };
}

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Concrete {@link IFriendsManager} implementation.
 *
 * Constructed once per {@link SnapcapClient} and held as
 * {@link SnapcapClient.friends}. See {@link IFriendsManager} for the
 * full method-level documentation.
 *
 * @see {@link IFriendsManager}
 */
export class Friends implements IFriendsManager {
  /**
   * Per-instance event bus. All public subscriptions (`on`, `onChange`)
   * funnel through this — bundle-side bridges (user-slice subscribers)
   * call `this.#events.emit(...)` and the bus fans out to every live
   * listener for that key.
   *
   * Kept private so consumers can't fake events from outside.
   */
  readonly #events = new TypedEventBus<FriendsEvents>();

  /**
   * @param _getCtx - Async accessor for the per-instance
   * `ClientContext`. Constructed and supplied by {@link SnapcapClient}
   * — consumers do not call this directly.
   * @internal
   */
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}

  // ── Mutations ───────────────────────────────────────────────────────

  /** {@inheritDoc IFriendsManager.sendRequest} */
  async sendRequest(userId: UserId, opts?: { source?: FriendSource }): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Add", [userId], opts?.source ?? FriendSource.ADDED_BY_USERNAME);
  }

  /** {@inheritDoc IFriendsManager.remove} */
  async remove(userId: UserId): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Remove", [userId]);
  }

  /** {@inheritDoc IFriendsManager.block} */
  async block(userId: UserId): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Block", [userId]);
  }

  /** {@inheritDoc IFriendsManager.unblock} */
  async unblock(userId: UserId): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Unblock", [userId]);
  }

  /** {@inheritDoc IFriendsManager.acceptRequest} */
  async acceptRequest(userId: UserId): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Add", [userId], FriendSource.ADDED_BY_ADDED_ME_BACK);
  }

  /** {@inheritDoc IFriendsManager.rejectRequest} */
  async rejectRequest(userId: UserId): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Ignore", [userId]);
  }

  // ── Reads ───────────────────────────────────────────────────────────
  //
  // Single sync gate: `#ensureSynced()` is called by `snapshot()` only.
  // The split readers (`list`, `receivedRequests`, `sentRequests`)
  // are one-line projections off `snapshot()` — that way the read-side
  // sync gap (next debug phase) is instrumentable in exactly one place.

  /**
   * Single sync gate. Triggers `userSlice().syncFriends()` once when the
   * mutuals slot is empty. Idempotent and best-effort: failures are
   * swallowed so reads can still surface whatever is already in state.
   *
   * NOTE: behavior intentionally preserved from the previous split
   * implementation — the read-sync gap is a separate debug task.
   */
  async #ensureSynced(): Promise<UserSlice> {
    const ctx = await this._getCtx();
    let user = userSlice(ctx.sandbox);
    if (
      typeof user.syncFriends === "function" &&
      (!Array.isArray(user.mutuallyConfirmedFriendIds) || user.mutuallyConfirmedFriendIds.length === 0)
    ) {
      try { await user.syncFriends(); }
      catch { /* best-effort — readers can still return whatever's in state */ }
      user = userSlice(ctx.sandbox);
    }
    return user;
  }

  /** {@inheritDoc IFriendsManager.snapshot} */
  async snapshot(): Promise<FriendsSnapshot> {
    const user = await this.#ensureSynced();
    // Persist the id-set cache on every snapshot read. The diff-style
    // event bridge below also writes this key on every selector tick,
    // but bridges only run when someone has subscribed — without this
    // call, a consumer that ONLY uses `list()` / `snapshot()` would
    // never seed the persisted graph cache, and a future subscriber
    // would have nothing to replay deltas against. Routing every read
    // through the same DataStore key keeps single-source-of-truth and
    // ensures cold-start consumers find a populated cache.
    //
    // Awaited (not fire-and-forget) so consumers that immediately
    // `process.exit()` after a single `list()` / `snapshot()` still
    // see the cache key flushed to disk. The FileDataStore flush is a
    // synchronous `writeFileSync` under one `await`, matching every
    // other DataStore write the SDK does — bounded cost.
    await this.#persistGraphSnapshotFrom(user);
    return buildSnapshot(user);
  }

  /**
   * Build the id-set snapshot from a live `UserSlice` and persist it
   * into the per-instance DataStore under {@link FRIEND_GRAPH_CACHE_KEY}.
   *
   * Best-effort, fire-and-forget: the underlying `saveGraphCache`
   * swallows persistence errors so a failing flush never poisons the
   * read or the live event fan-out. Shared between the snapshot read
   * path and the diff-bridge tick path so both code routes write the
   * same shape under the same key.
   *
   * @internal
   */
  async #persistGraphSnapshotFrom(user: UserSlice): Promise<void> {
    try {
      const ctx = await this._getCtx();
      await saveGraphCacheGuarded(ctx.dataStore, buildGraphSnapshot(user));
    } catch {
      /* persistence failures shouldn't poison the read */
    }
  }

  /** {@inheritDoc IFriendsManager.refresh} */
  async refresh(): Promise<void> {
    const ctx = await this._getCtx();
    const slice = userSlice(ctx.sandbox);

    // ONE explicit call drives BOTH endpoints. The bundle's `syncFriends`
    // (which fires `SyncFriendData` for mutuals + outgoing) cascades
    // internally into `IncomingFriendSync` via a state-listener — verified
    // empirically. Calling `IncomingFriendSync` ourselves on top of this
    // is redundant: it adds a wire call AND races the bundle's delta-token
    // bookkeeping (forcing full syncs instead of token-bearing deltas).
    if (typeof slice.syncFriends === "function") {
      try { await slice.syncFriends(); }
      catch { /* best-effort — readers fall back to whatever's in cache */ }
    }
  }

  /** {@inheritDoc IFriendsManager.list} */
  async list(): Promise<Friend[]> {
    return (await this.snapshot()).mutuals;
  }

  /** {@inheritDoc IFriendsManager.receivedRequests} */
  async receivedRequests(): Promise<ReceivedRequest[]> {
    return (await this.snapshot()).received;
  }

  /** {@inheritDoc IFriendsManager.sentRequests} */
  async sentRequests(): Promise<SentRequest[]> {
    return (await this.snapshot()).sent;
  }

  /** {@inheritDoc IFriendsManager.getUsers} */
  async getUsers(
    userIds: UserId[],
    opts?: { refresh?: boolean },
  ): Promise<User[]> {
    if (userIds.length === 0) return [];
    const ctx = await this._getCtx();

    // Cache-first split: the bundle's `state.user.publicUsers` Map is
    // populated as a side-effect of search results / SyncFriendData and
    // shared with the SPA. Reading it before the RPC means common cases
    // (e.g. resolving usernames for a freshly-listed friend graph) cost
    // zero network — `GetSnapchatterPublicInfo` only fires for genuine
    // misses. `refresh: true` opts out and re-fetches every id.
    const cached = userSlice(ctx.sandbox).publicUsers ?? new Map<string, PublicUserRecord>();
    const toFetch = opts?.refresh
      ? userIds
      : userIds.filter((id) => !cached.has(id));

    // Per-call result map; populated from the cache (already-known IDs)
    // and from the RPC response (newly-fetched IDs). Keyed by hyphenated
    // UUID so the final input-order projection at the bottom is a
    // single `Map.get` per id.
    const resolved = new Map<UserId, User>();
    for (const id of userIds) {
      if (cached.has(id) && !opts?.refresh) {
        resolved.set(id, makeUserFromCache(id, cached));
      }
    }

    if (toFetch.length > 0) {
      try {
        // AtlasGw's wire shape uses `Uint8Array(16)` for userIds — the
        // hyphenated-string view is purely an SDK-public convenience.
        // `uuidToBytes` round-trips losslessly with `bytesToUuid` below.
        const resp = await atlasClient(ctx.sandbox).GetSnapchatterPublicInfo({
          userIds: toFetch.map((id) => uuidToBytes(id)),
        });
        for (const s of resp.snapchatters ?? []) {
          const id = bytesToUuid(s.userId);
          if (!id) continue;
          resolved.set(id, makeUserFromSnapchatter(id, s));
        }
      } catch {
        // Best-effort: a transport failure on the RPC shouldn't poison
        // the entire call. Cache-hit IDs are already in `resolved` and
        // remain useful; fetch-side IDs that didn't land surface as
        // `notFound: true` via the projection below — same shape
        // consumers handle for "server confirmed no record". Swallowing
        // here keeps the caller contract a single clean `User[]` in
        // input order, with notFound as the universal "couldn't
        // resolve" signal.
      }
    }

    // Project back into input order. Anything still unresolved (cache
    // miss + fetch failure / server omitted the id) becomes a
    // `notFound: true` slot — see {@link User} for the semantics.
    return userIds.map((id) =>
      resolved.get(id) ?? { userId: id, username: "", notFound: true },
    );
  }

  /** {@inheritDoc IFriendsManager.search} */
  async search(query: string): Promise<User[]> {
    const ctx = await this._getCtx();
    if (!query) return [];
    // SECTION_TYPE_ADD_FRIENDS = 2 (verified against bundle/9846…js at
    // offsets 1304870/1435000). `searchUsers` defaults to that section.
    const SECTION_TYPE_ADD_FRIENDS = 2;
    const decoded = await searchUsers(ctx.sandbox, query);
    const section = decoded.sections?.find((s) => s.sectionType === SECTION_TYPE_ADD_FRIENDS);
    const results = section?.results ?? [];
    const out: User[] = [];
    for (const r of results) {
      // Result is a oneof — `result.$case === "user"` carries the user payload.
      const inner = r.result;
      if (!inner || inner.$case !== "user" || !inner.user) continue;
      const u = inner.user;
      const userId = extractUserId(u);
      if (!userId) continue;
      const username = u.mutableUsername ?? u.username ?? "";
      if (!username) continue;
      out.push({ userId, username, displayName: u.displayName });
    }
    return out;
  }

  // ── Subscriptions ───────────────────────────────────────────────────

  /**
   * {@inheritDoc IFriendsManager.onChange}
   *
   * Additive shim — forwards to `this.on("change", cb)` so the legacy
   * `Unsubscribe`-shaped surface keeps working while the typed event
   * bus is the single source of truth for fan-out.
   */
  onChange(cb: (snap: FriendsSnapshot) => void): Unsubscribe {
    return this.on("change", cb);
  }

  /**
   * Marker — set the moment we kick off the lazy install of the shared
   * graph-diff watcher so concurrent `on()` calls don't all race to
   * spawn redundant bridges. The watcher itself lives for the lifetime
   * of this Friends instance (install-once-per-instance — see
   * {@link Friends.#installGraphDiffBridge} for rationale).
   */
  #graphDiffInstalled = false;

  /** {@inheritDoc IFriendsManager.on} */
  on<K extends keyof FriendsEvents>(
    event: K,
    cb: FriendsEvents[K],
    opts?: { signal?: AbortSignal },
  ): Subscription {
    // Two bridge families:
    //   - `change` — full-snapshot fan-out, distinct shape, owns its own
    //     bridge. Per-subscriber install (matches existing semantics).
    //   - The five diff-style events — share ONE persistent watcher per
    //     Friends instance via `#installGraphDiffBridge`. Subscribing
    //     just registers on the bus; the watcher (lazily spun up on the
    //     first such subscription) does the diff + multi-event fan-out.
    switch (event) {
      case "change":
        return this.#installChangeBridge(cb as FriendsEvents["change"], opts);
      case "request:received":
      case "request:cancelled":
      case "request:accepted":
      case "friend:added":
      case "friend:removed":
        return this.#installGraphDiffBridge(event, cb, opts);
      default: {
        const _exhaustive: never = event;
        throw new Error(`Friends.on: unknown event ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Install (per-subscriber) the user-slice → `change` bridge and return
   * the live subscription. The async ctx-acquisition + sync subscription
   * contract is preserved by deferring the actual bridge into a
   * `#bridgeUserSliceToChange(signal)` task — `sub.signal` is the
   * combined-lifetime signal the bridge listens on for teardown.
   */
  #installChangeBridge(
    cb: FriendsEvents["change"],
    opts?: { signal?: AbortSignal },
  ): Subscription {
    const sub = this.#events.on("change", cb, opts);
    void this.#bridgeUserSliceToChange(sub.signal);
    return sub;
  }

  /**
   * Subscribe to one of the five diff-style events and ensure the
   * shared graph-diff watcher is running on this Friends instance.
   *
   * @remarks
   * **Tear-down strategy: install-once-per-instance, no refcount.** The
   * watcher lives from the first subscription on any of the five
   * diff-style events for the rest of the Friends instance's lifetime
   * — even if every subscriber tears down. This is intentional:
   *
   *   1. Per-tick cost is genuinely tiny — one selector projection,
   *      three Set-builds, one JSON-encode + DataStore write per
   *      friend-graph mutation. Friend-graph mutations are rare
   *      (sub-Hz) compared to e.g. typing-indicator chatter.
   *   2. With no subscribers, the watcher only does the persist step
   *      — keeping the persisted snapshot fresh so a future subscriber
   *      doesn't replay the entire interim window as "new" deltas.
   *      That's an actual feature: matches consumer mental model that
   *      `on()` only fires for state changes that happened AFTER the
   *      subscription went live (modulo the offline-replay window).
   *   3. Refcount + reinstall on next subscriber is more code, more
   *      bugs (race between teardown + new subscriber on the same
   *      tick), and would defeat the offline-replay design.
   */
  #installGraphDiffBridge<K extends keyof FriendsEvents>(
    event: K,
    cb: FriendsEvents[K],
    opts?: { signal?: AbortSignal },
  ): Subscription {
    const sub = this.#events.on(event, cb, opts);
    if (!this.#graphDiffInstalled) {
      this.#graphDiffInstalled = true;
      void this.#bridgeUserSliceToGraphDiff();
    }
    return sub;
  }

  /**
   * Bridge — subscribe to the user slice and emit a `change` event on
   * every selector tick. Composite selector watches mutuals, incoming
   * requests, and outgoing requests; coarse identity-and-size equality
   * (the bundle mutates the user slice in-place via Immer, so size
   * catches in-place mutations and a reference flip implies a fresh
   * slice replacement).
   *
   * Bails if `signal.aborted` after ctx lands; otherwise wires the
   * slice-side unsubscribe to fire on `signal.abort` so the bridge tears
   * down when the subscription dies.
   */
  async #bridgeUserSliceToChange(signal: AbortSignal): Promise<void> {
    type Composite = {
      m: string[] | undefined;
      i: Map<string, IncomingFriendRequestRecord> | undefined;
      o: string[] | undefined;
    };
    const ctx = await this._getCtx();
    if (signal.aborted) return;
    const unsub = subscribeUserSlice<Composite>(
      ctx.sandbox,
      (u: UserSlice) => ({
        m: u.mutuallyConfirmedFriendIds,
        i: u.incomingFriendRequests,
        o: u.outgoingFriendRequestIds,
      }),
      (a: Composite, b: Composite) => {
        // Equal iff every slot is reference-identical AND size-identical.
        if (a.m !== b.m) return false;
        if (a.i !== b.i) return false;
        if (a.o !== b.o) return false;
        if ((a.m?.length ?? 0) !== (b.m?.length ?? 0)) return false;
        if ((a.i?.size ?? 0) !== (b.i?.size ?? 0)) return false;
        if ((a.o?.length ?? 0) !== (b.o?.length ?? 0)) return false;
        return true;
      },
      (_curr: Composite, _prev: Composite, state: ChatState) => {
        this.#events.emit("change", buildSnapshot(userSliceFrom(state)));
      },
    );
    signal.addEventListener("abort", unsub, { once: true });
  }

  /**
   * Bridge — the unified graph-diff watcher behind the five diff-style
   * events (`friend:added`, `friend:removed`, `request:received`,
   * `request:cancelled`, `request:accepted`).
   *
   * Lifecycle:
   *   1. Loads the persisted snapshot from `ctx.dataStore`. If present,
   *      use it as `prior` so the first tick replays any deltas that
   *      occurred while the SDK was offline. If absent (first-ever
   *      run), seed `prior` from the current slice — no replay, just
   *      establish a baseline.
   *   2. Subscribes to the composite slot via `subscribeUserSlice`.
   *   3. On every selector tick: build `current`, diff against `prior`,
   *      fan out per-id events, persist `current`, advance `prior`.
   *
   * Lives for the lifetime of the Friends instance — see
   * {@link Friends.#installGraphDiffBridge} for the rationale.
   */
  async #bridgeUserSliceToGraphDiff(): Promise<void> {
    type Composite = {
      m: string[] | undefined;
      i: Map<string, IncomingFriendRequestRecord> | undefined;
      o: string[] | undefined;
    };

    const ctx = await this._getCtx();

    // Snapshot shape comes from the module-level `buildGraphSnapshot`
    // helper — same projection used by the read-path persistence
    // (`#persistGraphSnapshotFrom`). Materialization (publicUsers /
    // IncomingFriendRequestRecord lookups) happens at emit time using
    // the live slice values, NOT the persisted snapshot.

    // Seed prior. Cache hit → replay offline deltas. Cache miss →
    // establish baseline silently (first-ever run, no replay).
    const cached = await loadGraphCache(ctx.dataStore);
    let prior: FriendGraphSnapshot;
    if (cached) {
      prior = cached;
    } else {
      prior = buildGraphSnapshot(userSlice(ctx.sandbox));
      // Persist the baseline so a crash before the first real tick
      // doesn't lose it; subsequent runs will diff against this rather
      // than treating the whole graph as "new".
      await saveGraphCacheGuarded(ctx.dataStore, prior);
    }

    // Run the first diff synchronously so offline-window deltas fan
    // out immediately rather than waiting for the next bundle tick
    // (which may never come if no `refresh()` is called).
    const fanOut = (current: FriendGraphSnapshot, liveSlice: UserSlice): void => {
      const { added, removed, acceptedRequests } = diffGraph(prior, current);
      const publicUsers = liveSlice.publicUsers ?? new Map<string, PublicUserRecord>();
      const incomingMap = liveSlice.incomingFriendRequests ??
        new Map<string, IncomingFriendRequestRecord>();

      // Fan out one event per id per slot. Wrap each emit in try/catch
      // so a misbehaving consumer of any one event doesn't tear down
      // the watcher or starve siblings.
      for (const id of added.mutuals) {
        try { this.#events.emit("friend:added", makeFriend(id, publicUsers)); }
        catch { /* swallow consumer errors */ }
      }
      for (const id of removed.mutuals) {
        try { this.#events.emit("friend:removed", id); }
        catch { /* swallow consumer errors */ }
      }
      for (const id of added.incoming) {
        const rec = incomingMap.get(id);
        if (!rec) continue;
        try { this.#events.emit("request:received", makeReceivedRequest(id, rec)); }
        catch { /* swallow consumer errors */ }
      }
      for (const id of removed.incoming) {
        try { this.#events.emit("request:cancelled", id); }
        catch { /* swallow consumer errors */ }
      }
      for (const id of acceptedRequests) {
        try { this.#events.emit("request:accepted", id); }
        catch { /* swallow consumer errors */ }
      }
    };

    // Initial replay against the persisted snapshot (no-op when cache
    // was missing — `prior` was just seeded from the live slice, diff
    // is empty by construction).
    {
      const liveSlice = userSlice(ctx.sandbox);
      const initial = buildGraphSnapshot(liveSlice);
      fanOut(initial, liveSlice);
      prior = initial;
      await saveGraphCacheGuarded(ctx.dataStore, prior);
    }

    subscribeUserSlice<Composite>(
      ctx.sandbox,
      (u: UserSlice) => ({
        m: u.mutuallyConfirmedFriendIds,
        i: u.incomingFriendRequests,
        o: u.outgoingFriendRequestIds,
      }),
      (a: Composite, b: Composite) => {
        // Coarse identity-and-size equality — same rationale as the
        // change bridge. Immer mutates in place; size catches the
        // common cases without forcing a per-id walk on every tick.
        if (a.m !== b.m) return false;
        if (a.i !== b.i) return false;
        if (a.o !== b.o) return false;
        if ((a.m?.length ?? 0) !== (b.m?.length ?? 0)) return false;
        if ((a.i?.size ?? 0) !== (b.i?.size ?? 0)) return false;
        if ((a.o?.length ?? 0) !== (b.o?.length ?? 0)) return false;
        return true;
      },
      (_curr, _prev, state: ChatState) => {
        const liveSlice = userSliceFrom(state);
        const current = buildGraphSnapshot(liveSlice);
        fanOut(current, liveSlice);
        prior = current;
        // Fire-and-forget; persistence failures are swallowed inside
        // saveGraphCache so they can't break the live emit fan-out.
        // Guarded variant avoids clobbering a populated cache with an
        // empty snapshot during an interim user-slice tick.
        void saveGraphCacheGuarded(ctx.dataStore, current);
      },
    );
    // Note: install-once-per-instance — no signal-based teardown. The
    // watcher lives for the Friends instance's lifetime by design (see
    // `#installGraphDiffBridge` doc).
  }
}
