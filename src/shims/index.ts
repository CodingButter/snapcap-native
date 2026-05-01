/**
 * Canonical sandbox shim list.
 *
 * The Sandbox constructor builds a `ShimContext` and iterates this array
 * in declaration order, calling `.install(this, ctx)` on each shim.
 * Adding a new I/O-boundary override is a 3-step change:
 *   1. Drop a new `class FooShim extends Shim` file in this directory.
 *   2. Import it below.
 *   3. Append an entry to `SDK_SHIMS`.
 *
 * Order matters:
 *   - `CookieContainerShim` MUST run first. It patches happy-dom's
 *     CookieContainer prototype and seeds the shared tough-cookie jar
 *     into `ShimContext.jar`.
 *   - `DocumentCookieShim` and `WebSocketShim` both consume that jar and
 *     therefore depend on the CookieContainer install having run.
 *   - `LocalStorageShim` / `SessionStorageShim` / `IndexedDbShim` are
 *     storage-side and independent of the cookie pipeline; their
 *     ordering relative to each other is incidental.
 */
import { CookieContainerShim } from "./cookie-container.ts";
import { DocumentCookieShim } from "./document-cookie.ts";
import { WebSocketShim } from "./websocket.ts";
import { XmlHttpRequestShim } from "./xml-http-request.ts";
import { FetchShim } from "./fetch.ts";
import { LocalStorageShim, SessionStorageShim } from "./storage-shim.ts";
import { IndexedDbShim } from "./indexed-db.ts";
import { CacheStorageShim } from "./cache-storage.ts";
import { Shim } from "./types.ts";

/**
 * Single source of truth for which shims the Sandbox installs and in
 * what order. Iterated by {@link Sandbox} in its constructor.
 *
 * @internal
 */
export const SDK_SHIMS: readonly Shim[] = [
  // Cookie pipeline — must come first; later shims read ctx.jar.
  new CookieContainerShim(),
  new DocumentCookieShim(),
  new WebSocketShim(),
  // I/O override — replaces happy-dom's XMLHttpRequest with a streaming
  // binary-capable wrapper around Node fetch. Independent of WS but reads
  // ctx.jar for `withCredentials`, so logically grouped here.
  new XmlHttpRequestShim(),
  // I/O override — replaces happy-dom's fetch (which enforces hard CORS,
  // blocks mixed content, and ignores our cookie jar) with a Node-fetch
  // wrapper that rides ctx.jar + returns sandbox-realm Responses. Same
  // grouping rationale as XHR.
  new FetchShim(),
  // Storage area shims — independent of cookies.
  new LocalStorageShim(),
  new SessionStorageShim(),
  new IndexedDbShim(),
  // Cache Storage API — DataStore-backed. Independent of all of the above;
  // ordering against the storage shims is incidental.
  new CacheStorageShim(),
];

export { Shim, type ShimContext } from "./types.ts";
