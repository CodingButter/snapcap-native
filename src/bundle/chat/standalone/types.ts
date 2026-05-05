/**
 * Shared types for the standalone chat realm.
 *
 * Exposed via `../index.ts` so other directories (`shims/sandbox.ts`,
 * `bundle/presence-bridge.ts`, the session subdir's helpers) can type
 * the boot promise + the moduleEnv shape without re-declaring it.
 *
 * Why these types live here, not in `bundle/types/`: that directory holds
 * the bundle's wire-format protos (request envelopes, gRPC method
 * descriptors). The shapes below are bring-up handles (a vm.Context, an
 * Embind class registry, a leaked `__webpack_require__`) — runtime, not
 * wire.
 */

import type vm from "node:vm";

/**
 * Static handle to the standalone Fidelius `e2ee_E2EEKeyManager` Embind
 * class. Exposed so per-Sandbox bring-up caches in {@link Sandbox} can
 * type the resolved boot promise without re-declaring the shape.
 *
 * @internal
 */
export type KeyManagerStatics = {
  generateKeyInitializationRequest: (algorithm: number) => GenerationResult;
};

/**
 * Output shape of `e2ee_E2EEKeyManager.generateKeyInitializationRequest`.
 * Embind hands these object slots back as opaque `object` (Embind manages
 * lifetime); `identity-mint.ts` copies the bytes out via `toBytes` before
 * the WASM-owned objects can be GC'd.
 *
 * @internal
 */
export type GenerationResult = {
  keyInfo: {
    identity: {
      cleartextPublicKey: object;
      cleartextPrivateKey: object;
      identityKeyId: { data: object };
      version: number;
    };
    rwk: { data: object };
  };
  request: object;
};

/**
 * Embind class registry handed back as `moduleEnv` once the standalone
 * mint WASM finishes init. The exact set of classes is broad (~74 Embind
 * classes); this is intentionally loose-typed because consumers
 * (`session/setup.ts`) reach by name and probe shapes empirically.
 *
 * @internal
 */
export type StandaloneChatModule = Record<string, unknown> & {
  e2ee_E2EEKeyManager: KeyManagerStatics & Record<string, Function>;
};

/**
 * Webpack `__webpack_require__` shape, leaked onto the mint realm's global
 * as `__snapcap_p` by the runtime source-patch in `bootStandaloneMintWasm`.
 * Exposed via {@link StandaloneChatRealm} so consumers (`session/setup.ts`)
 * can address modules by id from the host realm.
 *
 * @internal
 */
export type StandaloneChatWreq = ((id: string) => unknown) & {
  m: Record<string, Function>;
};

/**
 * Full mint-realm bring-up payload — the cached vm.Context that hosts the
 * standalone chat WASM, the moduleEnv with all 74 Embind classes, and the
 * webpack require leaked onto that context's global. Returned by
 * `getStandaloneChatRealm` so `session/setup.ts` can run the worker chunk
 * in the SAME realm that owns the WASM, source-patching it to inject our
 * pre-built Module instead of having the chunk boot a second one.
 *
 * @internal
 */
export type StandaloneChatRealm = {
  moduleEnv: StandaloneChatModule;
  context: vm.Context;
  wreq: StandaloneChatWreq;
};
