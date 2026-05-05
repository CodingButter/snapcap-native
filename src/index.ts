/**
 * `@snapcap/native` — browser-free Snapchat client for Node.
 *
 * Loads Snap's web JavaScript bundle and 814 KB of WASM directly inside an
 * isolated Node `vm.Context`, with shimmed Chrome APIs so the bundle "thinks"
 * it's still running in Chromium. No Playwright, no emulator, no rooted phone
 * — many accounts run on a fraction of the resources a browser harness would
 * require.
 *
 * @packageDocumentation
 *
 * @remarks
 * The package is the public surface for the Snap automation runner — a thin
 * facade over Snap's own bundle plus an opt-in observability + throttling
 * layer. Authentication, friends, messaging, stories, presence, and inbox are
 * surfaced via the {@link SnapcapClient} entry point; persistence plugs in via
 * the {@link DataStore} interface.
 *
 * @example
 * Quick start:
 *
 * ```ts
 * import { SnapcapClient, FileDataStore } from "@snapcap/native";
 *
 * const dataStore = new FileDataStore(".tmp/auth/auth.json");
 * const client = new SnapcapClient({
 *   dataStore,
 *   credentials: { username: "...", password: "..." },
 *   browser: {
 *     userAgent:
 *       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
 *   },
 * });
 *
 * await client.authenticate();        // warm-or-cold login, idempotent
 * const friends = await client.friends.list();
 * ```
 *
 * @example
 * Multi-tenant runners should share one throttle gate across clients —
 * see {@link createSharedThrottle} and {@link RECOMMENDED_THROTTLE_RULES}:
 *
 * ```ts
 * import {
 *   SnapcapClient,
 *   createSharedThrottle,
 *   RECOMMENDED_THROTTLE_RULES,
 * } from "@snapcap/native";
 *
 * const gate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
 * const clients = tenants.map(t => new SnapcapClient({ ...t, throttle: gate }));
 * ```
 *
 * @example
 * Opt into structured network observability with {@link setLogger} (or set
 * `SNAP_NETLOG=1` in the environment for the built-in text formatter):
 *
 * ```ts
 * import { setLogger, defaultTextLogger } from "@snapcap/native";
 * setLogger(defaultTextLogger);
 * ```
 *
 * @see {@link SnapcapClient} — the main entry point
 * @see {@link Friends} — friends domain manager
 * @see {@link DataStore} — persistence interface
 * @see {@link ThrottleConfig} — opt-in HTTP throttling
 * @see {@link Logger} — structured network observability
 */
export { SnapcapClient, type SnapcapClientOpts } from "./client.ts";
export type { ISnapcapClient } from "./client.interface.ts";

// Public cross-layer types — credentials + browser-context fingerprint.
// Both are constructor opts on `SnapcapClient`.
export { activeIdentifier, type Credentials, type BrowserContext } from "./types.ts";

// Domain managers — re-exported for typing (`import type { Friends } from "@snapcap/native"`).
// Only `Friends` carries a stub shape today (Phase 1A); the others are
// empty placeholders until each migration starts. Per-domain interfaces
// are designed at migration time, not pre-emptively.
export {
  Friends,
  FriendSource,
  type IFriendsManager,
  type Friend,
  type ReceivedRequest,
  type SentRequest,
  type FriendsSnapshot,
  type FriendLinkType,
  type UserId,
  type Unsubscribe,
  type User as FriendsUser,
  type BitmojiPublicInfo,
  type FriendsEvents,
} from "./api/friends.ts";

// Shared subscription primitive — every domain manager (Friends,
// Messaging today; Stories, Presence ahead) composes this. `Subscription`
// is the consumer-facing live-handle type returned by every `on(...)`.
export { TypedEventBus, type Subscription } from "./lib/typed-event-bus.ts";
export {
  Messaging,
  type MessagingEvents,
  type ConversationSummary,
  type RawEncryptedMessage,
} from "./api/messaging.ts";
export { Presence } from "./api/presence.ts";
export { Stories } from "./api/stories.ts";
export { Media } from "./api/media.ts";
export type { PlaintextMessage } from "./auth/fidelius-decrypt.ts";

export { uuidToBytes, bytesToUuid, uuidToHighLow, highLowToUuid } from "./api/_helpers.ts";

// Sandbox primitives — for consumers that need direct vm.Context access
// (custom bundle eval, advanced introspection). Most users don't need these.
// Construct a fresh `Sandbox` per use site — there's no longer a process
// singleton (`installShims`/`getSandbox`/`uninstallShims` were removed in
// favour of per-instance Sandboxes that fit the multi-tenant model).
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
