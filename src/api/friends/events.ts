/**
 * Typed event map for {@link IFriendsManager.on}.
 *
 * Lives in its own module so the events surface stays manageable as it
 * grows.
 */
import type {
  Friend,
  FriendsSnapshot,
  ReceivedRequest,
  UserId,
} from "./types.ts";

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
