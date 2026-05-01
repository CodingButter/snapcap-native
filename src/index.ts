/**
 * @snapcap/native — browser-free Snap client.
 *
 * Loads Snap's web JavaScript bundle and WASM modules directly in Node,
 * with shimmed Chrome APIs so the bundle "thinks" it's still running in
 * Chromium. Runs many accounts on a fraction of the resources Playwright
 * would require.
 */
export { SnapcapClient, type SnapcapClientOpts } from "./client.ts";
export type { ISnapcapClient } from "./client.interface.ts";

// Domain managers — re-exported for typing (`import type { Friends } from "@snapcap/native"`).
// Only `Friends` carries a stub shape today (Phase 1A); the others are
// empty placeholders until each migration starts. Per-domain interfaces
// are designed at migration time, not pre-emptively.
export {
  Friends,
  FriendSource,
  type IFriendsManager,
  type Friend,
  type FriendRequest,
  type OutgoingRequest,
  type FriendsSnapshot,
  type FriendLinkType,
  type UserId,
  type User as FriendsUser,
} from "./api/friends.ts";
export { Messaging } from "./api/messaging.ts";
export { Presence } from "./api/presence.ts";
export { Stories } from "./api/stories.ts";
export { Inbox } from "./api/inbox.ts";
export { Media } from "./api/media.ts";

export { uuidToBytes, bytesToUuid, uuidToHighLow, highLowToUuid } from "./api/_helpers.ts";

// Sandbox primitives — for consumers that need direct vm.Context access
// (custom bundle eval, advanced introspection). Most users don't need these.
export { installShims, getSandbox, isShimInstalled, type InstallShimOpts } from "./shims/runtime.ts";
export { Sandbox, type SandboxOpts } from "./shims/sandbox.ts";

// Storage backing — implement DataStore to plug Redis/KMS/IndexedDB
// into the sandbox's localStorage / sessionStorage / cookie jar.
export { type DataStore, FileDataStore, MemoryDataStore } from "./storage/data-store.ts";
export { StorageShim } from "./storage/storage-shim.ts";
export { CookieJarStore } from "./storage/cookie-store.ts";

// Promise-friendly IndexedDB helpers — for SDK code (and consumers who
// want to share the same indexdb_* persistence namespace as Snap's bundle).
export { idbGet, idbPut, idbDelete } from "./storage/idb-utils.ts";

// Network observability — opt-in structured logging of every XHR/fetch the
// SDK and the bundle inside the sandbox issue. Off by default; enable by
// setting `SNAP_NETLOG=1` (default text formatter) or by calling
// `setLogger(fn)` with a custom handler. Bodies are NEVER logged — only
// sizes — so it's safe to leave on in production.
export { setLogger, defaultTextLogger } from "./logging.ts";
export type { Logger, LogEvent } from "./logging.ts";

// Opt-in HTTP throttling — pass via `new SnapcapClient({ throttle: ... })`.
// Off by default (no overhead). `RECOMMENDED_THROTTLE_RULES` is the curated
// starter set tuned for Snap's anti-spam thresholds.
//
// Two modes — see `transport/throttle.ts` doc for the trade-offs:
//   - Per-instance: pass a `ThrottleConfig` object; each client throttles
//     independently. Aggregate rate = N × per-instance-rate.
//   - Shared (multi-tenant): build a `ThrottleGate` via
//     `createSharedThrottle(config)`, pass the SAME gate into every client.
//     Aggregate rate stays constant in N. Recommended for N > 2.
export type { ThrottleConfig, ThrottleRule, ThrottleGate } from "./transport/throttle.ts";
export { RECOMMENDED_THROTTLE_RULES, createSharedThrottle } from "./transport/throttle.ts";
