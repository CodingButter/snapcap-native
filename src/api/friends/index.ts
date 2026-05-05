/**
 * Friends domain — public barrel.
 *
 * Tier-2 api feature directory: composes the per-concern files
 * (`manager`, `mutations`, `reads`, `search`, `get-users`,
 * `subscriptions`, `mappers`, `graph-cache`) into a single
 * consumer-facing entry point. Re-exports the same public surface the
 * old `api/friends.ts` monolith exposed — consumers import from
 * `./api/friends` (TS module resolution picks up this `index.ts`).
 *
 * @remarks
 * Architecture:
 *
 * The {@link Friends} class is a thin trampoline — every public method
 * delegates to a stateless free function in a sibling file. The
 * trampoline pattern lets each concern live in its own ~100-LOC file
 * while keeping the per-instance state (`#events` bus,
 * `#graphDiffInstalled` flag) hidden on the class itself. Bridges
 * receive the events bus by argument; they don't import the manager,
 * so no circular imports.
 *
 * `graph-cache.ts` (formerly `api/_friend_graph_cache.ts`) lives inside
 * this directory because no consumer outside Friends touches it — the
 * leading-underscore convention has been replaced by feature-folder
 * encapsulation.
 *
 * @see {@link IFriendsManager}
 * @see {@link Friends}
 */

export { Friends } from "./manager.ts";

export type { IFriendsManager, FriendsEvents } from "./interface.ts";

export {
  FriendSource,
  type BitmojiPublicInfo,
  type Friend,
  type FriendLinkType,
  type FriendsSnapshot,
  type ReceivedRequest,
  type SentRequest,
  type Unsubscribe,
  type User,
  type UserId,
} from "./types.ts";
