/**
 * Sandbox shim primitives — abstract base + shared install context.
 *
 * The Sandbox constructor builds a single `ShimContext` per sandbox and
 * iterates the canonical `SDK_SHIMS` array (see `./index.ts`), calling
 * `.install(sandbox, ctx)` on each in declaration order. Order matters
 * because some shims populate context state (e.g. the cookie jar) that
 * later shims read — `SDK_SHIMS` documents the ordering invariant.
 *
 * Adding a new shim is a 3-line change: a new file with `class FooShim
 * extends Shim`, an import in `index.ts`, and an entry in the array.
 */
import type { CookieJar } from "tough-cookie";
import type { DataStore } from "../storage/data-store.ts";
import type { Sandbox } from "./sandbox.ts";

/**
 * Per-sandbox state passed to every shim's `install`.
 *
 * @internal
 */
export interface ShimContext {
  /**
   * Persistent backing for storage shims; absent implies skip install.
   *
   * @internal
   */
  dataStore: DataStore;
  /**
   * UA string the WebSocket/fetch shims attach to outgoing requests.
   *
   * @internal
   */
  userAgent: string;
  /**
   * Shared tough-cookie jar — populated synchronously by
   * {@link getOrCreateJar} and consumed by the {@link DocumentCookieShim},
   * {@link CookieContainerShim}, and {@link WebSocketShim}. Cached per-DataStore
   * so all three shims observe each other's writes.
   *
   * @internal
   */
  jar: CookieJar;
}

/**
 * Single sandbox shim. Each subclass owns one I/O-boundary override
 * (cookies, WebSocket, Web Storage, IndexedDB, …) and is responsible for
 * its own idempotency.
 *
 * @internal
 */
export abstract class Shim {
  /**
   * Short human-readable id, used for trace logging.
   *
   * @internal
   */
  abstract readonly name: string;
  /**
   * Install this shim onto the given sandbox. Must be synchronous —
   * pre-bind any async-resolved state into closures inside the install,
   * not as await points. The Sandbox constructor cannot await.
   *
   * @internal
   * @param sandbox - target {@link Sandbox} whose realm receives the shim
   * @param ctx - shared per-sandbox install state
   */
  abstract install(sandbox: Sandbox, ctx: ShimContext): void;
}
