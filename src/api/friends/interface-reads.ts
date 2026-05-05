/**
 * Read surface of {@link IFriendsManager} — `list` / `receivedRequests` /
 * `sentRequests` / `snapshot` / `refresh` / `search` / `getUsers`.
 */
import type {
  Friend,
  FriendsSnapshot,
  ReceivedRequest,
  SentRequest,
  User,
  UserId,
} from "./types.ts";

/**
 * Read methods on {@link IFriendsManager} — projections off the bundle's
 * user slice plus the search and bulk lookup endpoints.
 */
export interface IFriendsReads {
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
   * The split read accessors ({@link IFriendsReads.list},
   * {@link IFriendsReads.receivedRequests},
   * {@link IFriendsReads.sentRequests}) all project from this.
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
   * who want event subscriptions like
   * {@link IFriendsSubscriptions.on}(`"request:received"`) to actually fire
   * must drive their own refresh cadence. Common patterns:
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
}
