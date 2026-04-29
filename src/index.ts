/**
 * @snapcap/native — browser-free Snap client.
 *
 * Loads Snap's web JavaScript bundle and WASM modules directly in Node,
 * with shimmed Chrome APIs so the bundle "thinks" it's still running in
 * Chromium. Runs many accounts on a fraction of the resources Playwright
 * would require.
 */
export { SnapcapClient, type SnapcapClientOpts, type FideliusIdentityBlob } from "./client.ts";
export { Conversation, TypingActivity, ConversationViewState, type ConversationKind } from "./api/messaging.ts";
export { User } from "./api/user.ts";
export { FriendAction } from "./api/friending.ts";
export { uuidToBytes, bytesToUuid, uuidToHighLow } from "./transport/proto-encode.ts";

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
