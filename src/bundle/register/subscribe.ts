/**
 * Slice-subscription helpers — currently the `user` slice. Wraps the
 * raw chat-bundle Zustand `subscribe` with a consumer-supplied
 * projection + equality predicate, matching the api-side subscriber
 * idiom used by `friends.ts`.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { ChatState, UserSlice } from "../types/index.ts";
import { chatStore } from "./chat.ts";
import type { Unsubscribe } from "./reach.ts";
import { userSliceFrom } from "./user.ts";

/**
 * Subscribe to a projection of `state.user` with consumer-supplied
 * equality. The `select` projection is recomputed on every store tick;
 * `cb` fires only when `equals(curr, prev)` returns false.
 *
 * Why `equals` is explicit (not defaulted to `===`): the bundle mutates
 * the user slice in-place via Immer drafts, so reference equality flips
 * arbitrarily. Each consumer picks its own diff strategy — array length +
 * per-element check for friend ids, Map.size for incoming requests, etc.
 *
 * The first invocation primes `prev` from the initial selector value and
 * does NOT fire `cb` — same no-replay semantics as the manual subscribers
 * in `friends.ts`. Returns an {@link Unsubscribe} thunk that's idempotent
 * and never throws (Zustand's own unsubscribe is safe to call twice; we
 * swallow consumer errors inside the listener so a misbehaving callback
 * doesn't tear down the subscription).
 *
 * @internal Bundle-layer subscription helper. Public consumers reach
 * subscriptions via the api layer's `subscribeFriends` etc.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param select - projection from {@link UserSlice} to a comparable value
 * @param equals - equality predicate over the projected value
 * @param cb - listener fired with `(curr, prev, fullState)` on each change
 * @returns an idempotent {@link Unsubscribe} thunk
 */
export const subscribeUserSlice = <T>(
  sandbox: Sandbox,
  select: (u: UserSlice) => T,
  equals: (a: T, b: T) => boolean,
  cb: (curr: T, prev: T, fullState: ChatState) => void,
): Unsubscribe => {
  let prev: T | undefined;
  let cancelled = false;
  let unsub: (() => void) | undefined;
  try {
    const store = chatStore(sandbox);
    prev = select(userSliceFrom(store.getState() as ChatState));
    unsub = store.subscribe((state) => {
      const curr = select(userSliceFrom(state));
      const oldPrev = prev as T;
      if (equals(curr, oldPrev)) return;
      prev = curr;
      try { cb(curr, oldPrev, state); }
      catch { /* swallow consumer errors so the subscription survives */ }
    });
  } catch {
    // Bundle not loaded yet — return a no-op unsub. Consumers should
    // resubscribe after `client.authenticate()` if they need real events.
  }
  return () => {
    if (cancelled) return;
    cancelled = true;
    try { unsub?.(); } catch { /* ignore */ }
  };
};
