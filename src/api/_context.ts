/**
 * Shared `ClientContext` — first arg passed to every tier-2 api function.
 *
 * Holds the bag of per-client instance state every domain function might
 * need to reach: the sandbox (for source-patched bundle globals), the
 * cookie jar (for SDK-side network round-trips that play "the browser"),
 * and the DataStore (for persistence). Plus a handful of mutable markers
 * the bundle-driven flows use to make idempotent bring-ups cheap on
 * repeat calls.
 *
 * @remarks
 * This is the substitute for "method on a class" — passing a small
 * context bag keeps each api function a stateless export, which fits the
 * registry pattern: `register.ts` exports flat verbs, `api/<domain>.ts`
 * composes them on top of a context. The classes-vs-functions split was
 * settled per `feedback_registry_pattern.md`: stateless surfaces stay
 * functions; only persistent-subscriber surfaces (none yet) become
 * classes.
 *
 * Lives in its own file (not co-located with `auth.ts`) because every
 * future api file (`messaging.ts`, `friends.ts` migrations, …) will
 * import the same shape — and circular import risk goes up if it's
 * embedded in the first consumer.
 *
 * @internal
 */
import type { Sandbox } from "../shims/sandbox.ts";
import type { CookieJarStore } from "../storage/cookie-store.ts";
import type { DataStore } from "../storage/data-store.ts";

/**
 * Per-instance state bag threaded through every api-layer function.
 *
 * Constructed once by {@link SnapcapClient} via `makeContext` (see
 * `api/auth.ts`) and re-used across every call. Not part of the public
 * consumer surface — exposed as an exported type only because the
 * api-layer functions accept it as their first parameter.
 *
 * @internal
 */
export interface ClientContext {
  /** Sandbox (vm.Context + happy-dom Window) — same instance shimmed at construction. */
  sandbox: Sandbox;
  /** Tough-cookie jar wrapper backed by `dataStore`. */
  jar: CookieJarStore;
  /** Persistence backbone — cookies, bundle storage, snapcap-side blobs. */
  dataStore: DataStore;
  /** UA fingerprint — used as the user-agent header on SDK-side fetches. */
  userAgent: string;
  /**
   * Idempotency marker for `bringUp(ctx)`. Set to `true` once the chat
   * bundle + accounts bundle have both been loaded. Re-calls of `bringUp`
   * short-circuit on this — bundle eval is process-wide singleton state,
   * but the per-context marker spares us re-checking the (relatively
   * expensive) sandbox global probes.
   */
  _bundlesLoaded?: boolean;
}
