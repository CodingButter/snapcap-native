/**
 * Subscription surface of {@link IFriendsManager} — `onChange` and the
 * typed `on(event, cb)` entry point.
 */
import type { Subscription } from "../../lib/typed-event-bus.ts";
import type { FriendsEvents } from "./events.ts";
import type { FriendsSnapshot, Unsubscribe } from "./types.ts";

/**
 * Subscription methods on {@link IFriendsManager} — full-snapshot
 * `onChange` plus the typed `on(event, cb)` API for the diff-style
 * event surface.
 */
export interface IFriendsSubscriptions {
  /**
   * Fire `cb` whenever any part of the friend graph changes — mutuals,
   * incoming requests, or outgoing requests.
   *
   * The callback receives a full {@link FriendsSnapshot} reflecting the
   * new state. Initial state is NOT replayed — call
   * `snapshot()` once after subscribing if you need a baseline.
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
