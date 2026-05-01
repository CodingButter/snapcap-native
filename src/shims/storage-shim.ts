/**
 * Sandbox `Shim` wrappers that install DataStore-backed `localStorage`
 * and `sessionStorage` onto the sandbox global.
 *
 * The actual Web Storage implementation (a class implementing the W3C
 * `Storage` interface) lives in `../storage/storage-shim.ts` and is
 * re-exported as part of the SDK's public API. These wrappers exist so
 * the storage installs participate in the standard `SDK_SHIMS` pipeline
 * — same `Shim.install(sandbox, ctx)` contract as the cookie / IDB / WS
 * shims.
 *
 * Two separate classes (instead of one combined "StorageShim") because:
 *   - The name `StorageShim` is already taken by the public storage class.
 *   - Each is independently reusable / disable-able if a future consumer
 *     wants only one of the two areas backed by a DataStore.
 */
import { StorageShim as WebStorageShim } from "../storage/storage-shim.ts";
import { Shim, type ShimContext } from "./types.ts";
import type { Sandbox } from "./sandbox.ts";

/**
 * Installs `localStorage` over `local_*` keys in the DataStore.
 *
 * @internal
 */
export class LocalStorageShim extends Shim {
  /** @internal */
  readonly name = "local-storage";
  /** @internal */
  install(sandbox: Sandbox, ctx: ShimContext): void {
    sandbox.window.localStorage = new WebStorageShim(ctx.dataStore, "local_");
  }
}

/**
 * Installs `sessionStorage` over `session_*` keys in the DataStore.
 *
 * @internal
 */
export class SessionStorageShim extends Shim {
  /** @internal */
  readonly name = "session-storage";
  /** @internal */
  install(sandbox: Sandbox, ctx: ShimContext): void {
    sandbox.window.sessionStorage = new WebStorageShim(ctx.dataStore, "session_");
  }
}
