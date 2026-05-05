/**
 * Standalone-realm messaging-session barrel.
 *
 * Public surface:
 *   - {@link setupBundleSession}: brings the bundle's messaging session
 *     up inside the standalone WASM realm and streams plaintext to the
 *     consumer's `onPlaintext` callback.
 *
 * Implementation files (see siblings):
 *   - `setup.ts` — the `setupBundleSession` orchestration body.
 *   - `realm-globals.ts` — top up the standalone realm with
 *     `CustomEvent` / `EventTarget` / `BroadcastChannel` etc.
 *   - `ws-shim.ts` — Node-`ws`-backed `WebSocket` with cookie pre-bind.
 *   - `import-scripts.ts` — `importScripts` polyfill for sibling chunks.
 *   - `chunk-patch.ts` — source-patch the f16f14e3 worker chunk to
 *     expose `__SNAPCAP_EN`/`__SNAPCAP_UN`/`__SNAPCAP_PN`.
 *   - `register-duplex-trace.ts` — diagnostic wrapper for
 *     `En.registerDuplexHandler` (removable in one commit).
 *   - `wrap-session-create.ts` — slot-9 messagingDelegate hook.
 *   - `push-handler.ts` — live-push body fetch + dedupe.
 *   - `deliver-plaintext.ts` — cross-realm bytes → SDK shape.
 *   - `wasm-services-init.ts` — Platform + ConfigurationRegistry init.
 *   - `grpc-web-factory.ts` — `GrpcManager.registerWebFactory` wiring.
 *   - `session-args.ts` — build the 18-slot `createMessagingSession`
 *     arg array.
 *   - `inbox-pump.ts` — enter conversations + fetch history.
 *   - `id-coercion.ts` — UUID ↔ realm-Uint8Array helpers.
 *   - `utils.ts` — `safeStringifyVal` + `bigintReplacer`.
 *   - `types.ts` — public type surface (`PlaintextMessage`,
 *     `SetupBundleSessionOpts`, etc.).
 *
 * @internal
 */
export { setupBundleSession } from "./setup.ts";
export type {
  PlaintextMessage,
  SetupBundleSessionOpts,
  BundleSessionDisposer,
  BundleMessagingSession,
} from "./types.ts";
