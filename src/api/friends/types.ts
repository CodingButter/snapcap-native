/**
 * Consumer-shape types for the Friends domain.
 *
 * These are the public types the SDK surfaces — strings for UUIDs, named
 * enums where appropriate, no protobuf-decoded objects leaking through.
 *
 * @see {@link IFriendsManager}
 */

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
