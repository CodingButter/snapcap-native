/**
 * Friends manager — domain surface for the social graph.
 *
 * Tier-2 manager (per the architecture pivot): takes consumer-friendly
 * args (UUID strings, named enums) and bridges to the bundle's
 * closure-private mechanisms via `bundle/register.ts` getters. Does NOT
 * leak bundle shapes (`Uuid64Pair`, `friendId.{highBits,lowBits}`,
 * `mutable_username`, etc.).
 *
 * @remarks
 * Method → mechanism table:
 *
 * | Method | Mechanism |
 * | --- | --- |
 * | `add` / `remove` / `block` / `unblock` / `ignore` | `friendActionClient()` (jz) via private `friendActionMutation` dispatcher |
 * | `list` / `incomingRequests` / `outgoingRequests` / `snapshot` | Zustand state (`userSlice()`), centralized through `#ensureSynced` + `snapshot()` |
 * | `search` | `searchUsers()` (register-composed: codecs + authed POST) |
 * | `onChange` | Single `subscribeUserSlice` with a composite selector covering mutuals + incoming + outgoing |
 * | `acceptRequest` / `rejectRequest` | BLOCKED on `__SNAPCAP_FRIEND_REQUESTS_CLIENT` source-patch — throws an explicit "not yet wired" error |
 *
 * Why a class instead of flat functions: {@link IFriendsManager} carries
 * a subscription method (`onChange`), so it has identity-bearing state
 * — fits the "persistent-subscriber surface" carve-out in
 * `feedback_registry_pattern.md`.
 *
 * @see {@link IFriendsManager}
 * @see {@link Friends}
 * @see {@link SnapcapClient.friends}
 */
import type { ClientContext } from "./_context.ts";
import {
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
  UserSlice,
} from "../bundle/types.ts";
import { bytesToUuid, extractUserId, makeFriendIdParams } from "./_helpers.ts";

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
 * Attribution source for {@link IFriendsManager.add}.
 *
 * Mirrors the bundle's `J$.source` field on `FriendActionParams` (chat
 * module 10409, offset ~1406050 in `9846a7958a5f0bee7197.js`).
 *
 * @remarks
 * Default for `add()` is `ADDED_BY_USERNAME` — what the SPA sends from
 * the search-result "Add" button.
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
 * A user surfaced from search / lookup. Carries no friend-graph metadata
 * (use {@link Friend} for that).
 *
 * @remarks
 * `username` may be empty when the SDK has the userId but hasn't yet
 * back-filled the `state.user.publicUsers` cache for it (e.g.
 * immediately after `syncFriends()` returns ids before public-info is
 * fetched). In that case callers can still match by `userId`.
 */
export interface User {
  /** Hyphenated UUID. */
  userId: UserId;
  /** Snap username (handle). May be empty during initial sync. */
  username: string;
  /** Display name shown in the Snap UI. Optional — not always set. */
  displayName?: string;
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
export interface FriendRequest {
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
export interface OutgoingRequest {
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
 * {@link IFriendsManager.incomingRequests}, and
 * {@link IFriendsManager.outgoingRequests}. The same object shape is
 * delivered to {@link IFriendsManager.onChange} subscribers whenever any
 * of the three slots mutates.
 */
export interface FriendsSnapshot {
  /** All mutually-confirmed friends. */
  mutuals: Friend[];
  /** Pending inbound friend requests (others adding the logged-in user). */
  incoming: FriendRequest[];
  /** Pending outbound friend requests (the logged-in user's adds). */
  outgoing: OutgoingRequest[];
}

// ─── Manager interface ────────────────────────────────────────────────────

/**
 * Friends domain manager — all friend-graph operations live here.
 *
 * All UUIDs are hyphenated string {@link UserId} values. Mutations
 * resolve `void` on success; reads return consumer-shape types
 * ({@link Friend}, {@link User}, {@link FriendRequest},
 * {@link OutgoingRequest}) — never bundle protobuf shapes.
 *
 * @remarks
 * Reads share a single underlying {@link IFriendsManager.snapshot}.
 * {@link IFriendsManager.list}, {@link IFriendsManager.incomingRequests},
 * and {@link IFriendsManager.outgoingRequests} are slim accessors that
 * project the relevant slice. One subscription method
 * ({@link IFriendsManager.onChange}) fires whenever any of the three
 * slots changes; it returns an `Unsubscribe` thunk that's
 * idempotent.
 *
 * Pending-request methods ({@link IFriendsManager.acceptRequest},
 * {@link IFriendsManager.rejectRequest}) are gated on the chat-bundle
 * source-patch surfacing the closure-private `FriendRequests` client
 * (planned global: `__SNAPCAP_FRIEND_REQUESTS_CLIENT`). Until that
 * lands, those methods throw an explicit "not yet wired" error.
 *
 * @see {@link Friends}
 * @see {@link FriendsSnapshot}
 */
export interface IFriendsManager {
  // ── Friend mutations ────────────────────────────────────────────────

  /**
   * Send a friend request / add a user to the friend list.
   *
   * Resolves once the server acknowledges. `source` defaults to
   * {@link FriendSource}`.ADDED_BY_USERNAME`.
   *
   * @param userId - Hyphenated UUID of the user to add.
   * @param source - Attribution context; defaults to
   * `ADDED_BY_USERNAME`. See {@link FriendSource}.
   *
   * @example
   * ```ts
   * await client.friends.add("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202");
   * ```
   * @example
   * ```ts
   * import { FriendSource } from "@snapcap/native";
   * await client.friends.add(userId, FriendSource.ADDED_BY_SEARCH);
   * ```
   */
  add(userId: UserId, source?: FriendSource): Promise<void>;

  /**
   * Remove a friend from the social graph.
   *
   * @param userId - Hyphenated UUID of the friend to remove.
   *
   * @remarks
   * Snap unfriend is asymmetric — the recipient unfriending the sender
   * doesn't sever the link from the sender's side. Subsequent
   * {@link IFriendsManager.add} calls against an account that still sees
   * the caller as mutual become silent no-ops.
   *
   * @example
   * ```ts
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
   * Ignore an incoming friend request without explicitly rejecting.
   *
   * @param userId - Hyphenated UUID of the requester to ignore.
   */
  ignore(userId: UserId): Promise<void>;

  /**
   * Accept an incoming friend request.
   *
   * @param userId - Hyphenated UUID of the requester whose request to
   * accept.
   * @throws Currently always throws — gated on the
   * `__SNAPCAP_FRIEND_REQUESTS_CLIENT` source-patch landing in
   * `register.ts`.
   */
  acceptRequest(userId: UserId): Promise<void>;

  /**
   * Reject an incoming friend request.
   *
   * @param userId - Hyphenated UUID of the requester whose request to
   * reject.
   * @throws Currently always throws — gated on the
   * `__SNAPCAP_FRIEND_REQUESTS_CLIENT` source-patch landing in
   * `register.ts`.
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
   * All pending incoming friend requests.
   *
   * @returns Inbound {@link FriendRequest} records waiting for accept /
   * reject / ignore.
   */
  incomingRequests(): Promise<FriendRequest[]>;

  /**
   * All pending outgoing friend requests (the logged-in user's adds
   * waiting for the recipient to accept).
   *
   * @returns Outbound {@link OutgoingRequest} records.
   */
  outgoingRequests(): Promise<OutgoingRequest[]>;

  /**
   * Canonical point-in-time view of the friend graph — mutuals + pending
   * requests in both directions.
   *
   * @returns A {@link FriendsSnapshot} with all three slots populated.
   *
   * @remarks
   * The split read accessors ({@link IFriendsManager.list},
   * {@link IFriendsManager.incomingRequests},
   * {@link IFriendsManager.outgoingRequests}) all project from this.
   */
  snapshot(): Promise<FriendsSnapshot>;

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
 * malformed `Friend`/`FriendRequest`/`OutgoingRequest` to consumers.
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

/** Materialize a consumer-shape `FriendRequest` from the bundle record. */
function makeFriendRequest(userId: unknown, rec: IncomingFriendRequestRecord): FriendRequest {
  return {
    fromUserId: unwrapUserId(userId),
    fromUsername: rec.mutable_username ?? rec.username ?? "",
    fromDisplayName: rec.display_name,
    receivedAt: rec.added_timestamp_ms ? new Date(rec.added_timestamp_ms) : undefined,
    source: rec.added_by as FriendSource | undefined,
  };
}

/** Convert the bundle-side incoming-requests Map into a consumer-shape array. */
function mapFriendRequestsMap(
  map: Map<string, IncomingFriendRequestRecord> | undefined,
): FriendRequest[] {
  if (!map || typeof map.entries !== "function") return [];
  const out: FriendRequest[] = [];
  for (const [userId, rec] of map.entries()) {
    out.push(makeFriendRequest(userId, rec));
  }
  return out;
}

/**
 * Materialize an `OutgoingRequest` from a userId + the publicUsers cache.
 * When the recipient hasn't been resolved yet (cache miss), returns just
 * the `toUserId` and omits the username/display-name fields rather than
 * surfacing empty strings — keeps consumer presence-checks simple.
 *
 * `userId` arg may be a hyphenated string OR a `{id, str}` envelope from
 * the bundle slice — same rationale as `makeFriend`.
 */
function makeOutgoingRequest(
  userId: unknown,
  publicUsers: Map<string, PublicUserRecord>,
): OutgoingRequest {
  const id = unwrapUserId(userId);
  const rec = publicUsers.get(id);
  if (!rec) return { toUserId: id };
  const out: OutgoingRequest = { toUserId: id };
  const username = rec.mutable_username ?? rec.username;
  if (username) out.toUsername = username;
  if (rec.display_name) out.toDisplayName = rec.display_name;
  return out;
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
    incoming: mapFriendRequestsMap(user.incomingFriendRequests),
    outgoing: outgoingIds.map((id) => makeOutgoingRequest(id, publicUsers)),
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
 * @remarks
 * Why a `() => Promise<ClientContext>` provider instead of a bare
 * `ClientContext`: the SDK's context is built asynchronously (cookie
 * jar load, etc.), but the `client.friends` field needs to exist
 * synchronously off `new SnapcapClient(...)`. The provider defers
 * resolution until the first method call — which is when
 * `authenticate()` has typically already been called and the context
 * is warm.
 *
 * @see {@link IFriendsManager}
 */
export class Friends implements IFriendsManager {
  /**
   * @param _getCtx - Async accessor for the per-instance
   * `ClientContext`. Constructed and supplied by {@link SnapcapClient}
   * — consumers do not call this directly.
   * @internal
   */
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}

  // ── Mutations ───────────────────────────────────────────────────────

  /** {@inheritDoc IFriendsManager.add} */
  async add(userId: UserId, source: FriendSource = FriendSource.ADDED_BY_USERNAME): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Add", [userId], source);
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

  /** {@inheritDoc IFriendsManager.ignore} */
  async ignore(userId: UserId): Promise<void> {
    const ctx = await this._getCtx();
    return friendActionMutation(ctx, "Ignore", [userId]);
  }

  /** {@inheritDoc IFriendsManager.acceptRequest} */
  async acceptRequest(_userId: UserId): Promise<void> {
    throw new Error(
      "Friends.acceptRequest: not yet wired — needs __SNAPCAP_FRIEND_REQUESTS_CLIENT source-patch (see register.ts G_FRIEND_REQUESTS_CLIENT TODO)",
    );
  }

  /** {@inheritDoc IFriendsManager.rejectRequest} */
  async rejectRequest(_userId: UserId): Promise<void> {
    throw new Error(
      "Friends.rejectRequest: not yet wired — needs __SNAPCAP_FRIEND_REQUESTS_CLIENT source-patch (see register.ts G_FRIEND_REQUESTS_CLIENT TODO)",
    );
  }

  // ── Reads ───────────────────────────────────────────────────────────
  //
  // Single sync gate: `#ensureSynced()` is called by `snapshot()` only.
  // The split readers (`list`, `incomingRequests`, `outgoingRequests`)
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
    return buildSnapshot(await this.#ensureSynced());
  }

  /** {@inheritDoc IFriendsManager.list} */
  async list(): Promise<Friend[]> {
    return (await this.snapshot()).mutuals;
  }

  /** {@inheritDoc IFriendsManager.incomingRequests} */
  async incomingRequests(): Promise<FriendRequest[]> {
    return (await this.snapshot()).incoming;
  }

  /** {@inheritDoc IFriendsManager.outgoingRequests} */
  async outgoingRequests(): Promise<OutgoingRequest[]> {
    return (await this.snapshot()).outgoing;
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

  /** {@inheritDoc IFriendsManager.onChange} */
  onChange(cb: (snap: FriendsSnapshot) => void): Unsubscribe {
    // Composite selector — one subscription, three watched slots. The
    // `equals` is intentionally coarse (identity + size) rather than a
    // deep diff: the bundle mutates the user slice in-place via Immer,
    // but the array/Map references themselves flip when entries are
    // added or removed, and size catches in-place mutations. False
    // positives just mean an extra `cb` call with the same snapshot —
    // cheaper than a deep diff on every store tick.
    type Composite = {
      m: string[] | undefined;
      i: Map<string, IncomingFriendRequestRecord> | undefined;
      o: string[] | undefined;
    };

    // `_getCtx()` is async (sandbox may not be ready until authenticate
    // resolves), but the onChange contract is sync. Defer the actual
    // subscribe until ctx lands; return an Unsubscribe that cancels both
    // the in-flight wait and the eventual real subscription.
    let realUnsub: Unsubscribe | null = null;
    let cancelled = false;
    void (async () => {
      const ctx = await this._getCtx();
      if (cancelled) return;
      realUnsub = subscribeUserSlice<Composite>(
        ctx.sandbox,
        (u: UserSlice) => ({
          m: u.mutuallyConfirmedFriendIds,
          i: u.incomingFriendRequests,
          o: u.outgoingFriendRequestIds,
        }),
        (a: Composite, b: Composite) => {
          // Equal iff every slot is reference-identical AND size-identical.
          // Immer mutates in-place, so size catches additions/removals; a
          // reference flip implies a fresh slice replacement (also a change).
          if (a.m !== b.m) return false;
          if (a.i !== b.i) return false;
          if (a.o !== b.o) return false;
          if ((a.m?.length ?? 0) !== (b.m?.length ?? 0)) return false;
          if ((a.i?.size ?? 0) !== (b.i?.size ?? 0)) return false;
          if ((a.o?.length ?? 0) !== (b.o?.length ?? 0)) return false;
          return true;
        },
        (_curr: Composite, _prev: Composite, state: ChatState) => {
          cb(buildSnapshot(userSliceFrom(state)));
        },
      );
    })();
    return () => {
      cancelled = true;
      realUnsub?.();
    };
  }
}
