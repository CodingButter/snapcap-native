/**
 * `IFriendsManager` interface — the public contract the {@link Friends}
 * class implements.
 *
 * Composed from three thematic sub-interfaces (mutations / reads /
 * subscriptions) that each live in their own file. Consumers only need
 * to reference `IFriendsManager`; the sub-interfaces are an
 * organizational seam, not a public surface split.
 *
 * `FriendsEvents` (the typed event map) lives in `./events.ts` and is
 * re-exported here so consumers continue to see `FriendsEvents` on the
 * same import path.
 */
import type { IFriendsMutations } from "./interface-mutations.ts";
import type { IFriendsReads } from "./interface-reads.ts";
import type { IFriendsSubscriptions } from "./interface-subscriptions.ts";

export type { FriendsEvents } from "./events.ts";

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
 * The interface is composed from three thematic groupings:
 *
 *   - {@link IFriendsMutations} — `sendRequest`, `remove`, `block`,
 *     `unblock`, `acceptRequest`, `rejectRequest`.
 *   - {@link IFriendsReads} — `list`, `receivedRequests`,
 *     `sentRequests`, `snapshot`, `refresh`, `search`, `getUsers`.
 *   - {@link IFriendsSubscriptions} — `onChange`, `on`.
 *
 * @see {@link Friends}
 * @see {@link FriendsSnapshot}
 */
export interface IFriendsManager
  extends IFriendsMutations, IFriendsReads, IFriendsSubscriptions {}
