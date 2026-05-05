/**
 * `Friends` — concrete `IFriendsManager` implementation.
 *
 * Slim trampoline class: every public method delegates to a free
 * function in a sibling file (`mutations.ts`, `reads.ts`, `search.ts`,
 * `get-users.ts`, `subscriptions.ts`). The class owns ONLY:
 *   - the per-instance `#events` bus
 *   - the per-instance `#graphDiffInstalled` flag (gates the lazy
 *     graph-diff watcher install)
 *   - the `_getCtx` thunk wired by `SnapcapClient`
 *
 * Bridges import the manager-private state via constructor capture
 * (the `events` bus is passed into the bridge functions); they don't
 * need access to the class itself, so there's no circular import.
 */
import type { ClientContext } from "../_context.ts";
import { type Subscription, TypedEventBus } from "../../lib/typed-event-bus.ts";
import type { FriendsEvents, IFriendsManager } from "./interface.ts";
import {
  acceptFriendRequest,
  blockUser,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  unblockUser,
} from "./mutations.ts";
import {
  listFriends,
  listReceivedRequests,
  listSentRequests,
  refreshFriends,
  snapshotFriends,
} from "./reads.ts";
import { searchFriends } from "./search.ts";
import { getUsers } from "./get-users.ts";
import { bridgeUserSliceToChange, bridgeUserSliceToGraphDiff } from "./subscriptions.ts";
import type {
  Friend,
  FriendSource,
  FriendsSnapshot,
  ReceivedRequest,
  SentRequest,
  Unsubscribe,
  User,
  UserId,
} from "./types.ts";

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
   * Marker — set the moment we kick off the lazy install of the shared
   * graph-diff watcher so concurrent `on()` calls don't all race to
   * spawn redundant bridges. The watcher itself lives for the lifetime
   * of this Friends instance (install-once-per-instance — see
   * {@link Friends.#installGraphDiffBridge} for rationale).
   */
  #graphDiffInstalled = false;

  /**
   * @param _getCtx - Async accessor for the per-instance
   * `ClientContext`. Constructed and supplied by {@link SnapcapClient}
   * — consumers do not call this directly.
   * @internal
   */
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}

  // ── Mutations ───────────────────────────────────────────────────────

  /** {@inheritDoc IFriendsManager.sendRequest} */
  sendRequest(userId: UserId, opts?: { source?: FriendSource }): Promise<void> {
    return sendFriendRequest(this._getCtx, userId, opts);
  }

  /** {@inheritDoc IFriendsManager.remove} */
  remove(userId: UserId): Promise<void> {
    return removeFriend(this._getCtx, userId);
  }

  /** {@inheritDoc IFriendsManager.block} */
  block(userId: UserId): Promise<void> {
    return blockUser(this._getCtx, userId);
  }

  /** {@inheritDoc IFriendsManager.unblock} */
  unblock(userId: UserId): Promise<void> {
    return unblockUser(this._getCtx, userId);
  }

  /** {@inheritDoc IFriendsManager.acceptRequest} */
  acceptRequest(userId: UserId): Promise<void> {
    return acceptFriendRequest(this._getCtx, userId);
  }

  /** {@inheritDoc IFriendsManager.rejectRequest} */
  rejectRequest(userId: UserId): Promise<void> {
    return rejectFriendRequest(this._getCtx, userId);
  }

  // ── Reads ───────────────────────────────────────────────────────────

  /** {@inheritDoc IFriendsManager.snapshot} */
  snapshot(): Promise<FriendsSnapshot> {
    return snapshotFriends(this._getCtx);
  }

  /** {@inheritDoc IFriendsManager.refresh} */
  refresh(): Promise<void> {
    return refreshFriends(this._getCtx);
  }

  /** {@inheritDoc IFriendsManager.list} */
  list(): Promise<Friend[]> {
    return listFriends(this._getCtx);
  }

  /** {@inheritDoc IFriendsManager.receivedRequests} */
  receivedRequests(): Promise<ReceivedRequest[]> {
    return listReceivedRequests(this._getCtx);
  }

  /** {@inheritDoc IFriendsManager.sentRequests} */
  sentRequests(): Promise<SentRequest[]> {
    return listSentRequests(this._getCtx);
  }

  /** {@inheritDoc IFriendsManager.getUsers} */
  getUsers(userIds: UserId[], opts?: { refresh?: boolean }): Promise<User[]> {
    return getUsers(this._getCtx, userIds, opts);
  }

  /** {@inheritDoc IFriendsManager.search} */
  search(query: string): Promise<User[]> {
    return searchFriends(this._getCtx, query);
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
   * `bridgeUserSliceToChange(signal)` task — `sub.signal` is the
   * combined-lifetime signal the bridge listens on for teardown.
   */
  #installChangeBridge(
    cb: FriendsEvents["change"],
    opts?: { signal?: AbortSignal },
  ): Subscription {
    const sub = this.#events.on("change", cb, opts);
    void bridgeUserSliceToChange(this._getCtx, this.#events, sub.signal);
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
      void bridgeUserSliceToGraphDiff(this._getCtx, this.#events);
    }
    return sub;
  }
}
