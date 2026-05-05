/**
 * `subscribe` — implementation of `Messaging.on(...)`.
 *
 * Bridges a consumer's `(event, cb, opts)` call into the per-instance
 * event bus, and lazy-fires the bundle session bring-up on first
 * subscription.
 *
 * @internal
 */
import type { Subscription } from "../../lib/typed-event-bus.ts";
import type { MessagingInternal } from "./internal.ts";
import type { MessagingEvents } from "./interface.ts";

/**
 * Subscribe to a messaging event. First subscription triggers the
 * bundle session bring-up (~3s cold; subsequent subscriptions are free).
 *
 * @param event - One of {@link MessagingEvents}.
 * @param cb - Callback invoked with the event payload.
 * @param opts - Optional `signal`; aborting it unsubscribes.
 *
 * @internal
 */
export function subscribe<K extends keyof MessagingEvents>(
  internal: MessagingInternal,
  event: K,
  cb: MessagingEvents[K],
  opts?: { signal?: AbortSignal },
): Subscription {
  const sub = internal.events.on(event, cb, opts);
  // Lazy: kick off bring-up on the first subscription. Best-effort —
  // failures surface via diagnostic stderr inside setupBundleSession.
  void internal.ensureSession();
  return sub;
}
