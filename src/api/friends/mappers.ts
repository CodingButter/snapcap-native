/**
 * Pure per-record projection helpers — bundle slice shapes → consumer-shape
 * types.
 *
 * Stateless: every function takes its inputs as args, returns plain
 * data. Shared between read paths (`reads.ts`), `getUsers`, and the
 * subscription bridges in `subscriptions.ts`.
 *
 * Whole-snapshot builders live in `snapshot-builders.ts` so this file
 * stays focused on per-record materialization.
 *
 * @internal
 */
import type {
  IncomingFriendRequestRecord,
  PublicUserRecord,
  SnapchatterPublicInfo,
} from "../../bundle/types.ts";
import { bytesToUuid } from "../_helpers.ts";
import type {
  Friend,
  FriendSource,
  ReceivedRequest,
  SentRequest,
  User,
  UserId,
} from "./types.ts";

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
export function unwrapUserId(raw: unknown): string {
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
export function makeFriend(userId: unknown, publicUsers: Map<string, PublicUserRecord>): Friend {
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
export function makeUserFromCache(
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
export function makeUserFromSnapchatter(id: UserId, snap: SnapchatterPublicInfo): User {
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
export function makeReceivedRequest(userId: unknown, rec: IncomingFriendRequestRecord): ReceivedRequest {
  return {
    fromUserId: unwrapUserId(userId),
    fromUsername: rec.mutable_username ?? rec.username ?? "",
    fromDisplayName: rec.display_name,
    receivedAt: rec.added_timestamp_ms ? new Date(rec.added_timestamp_ms) : undefined,
    source: rec.added_by as FriendSource | undefined,
  };
}

/** Convert the bundle-side incoming-requests Map into a consumer-shape array. */
export function mapReceivedRequestsMap(
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
export function makeSentRequest(
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
