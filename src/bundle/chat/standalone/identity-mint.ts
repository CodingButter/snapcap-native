/**
 * Mint a fresh Fidelius identity off the standalone chat WASM.
 *
 * The boot orchestration lives in {@link ./realm.ts}; this file is just
 * the thin wrapper that calls
 * `e2ee_E2EEKeyManager.generateKeyInitializationRequest(1)` against the
 * cached `KeyManagerStatics` and copies the bytes out of the
 * Embind-managed objects before they can be GC'd.
 *
 * @internal Auth-layer; called from `kickoffMessagingSession` in
 * `api/auth/kickoff-messaging.ts`.
 */
import type { Sandbox } from "../../../shims/sandbox.ts";
import type { FideliusIdentity } from "../../../api/fidelius.ts";
import { getOrBootKeyManager } from "./realm.ts";

/**
 * Produce a fresh {@link FideliusIdentity} from a fresh-realm WASM
 * instance. Lazy-boots the standalone WASM on first call; subsequent
 * calls on the same {@link Sandbox} reuse the cached instance.
 *
 * @param sandbox - per-instance Sandbox; the boot promise is cached on
 *   `sandbox.fideliusMintBoot` so each `SnapcapClient` mints its own
 *   identity in its own realm.
 * @throws if the WASM boot fails (missing bundle files, factory shape
 *   shifted, runtime init timeout) or the mint call aborts.
 */
export async function mintFideliusIdentity(sandbox: Sandbox): Promise<FideliusIdentity> {
  const { km } = await getOrBootKeyManager(sandbox);
  // Algorithm 1 = "TEN" (v10) — matches what browsers send at first
  // login. Older algorithm 0 (v9) shape produces a request without the
  // wrapped RWK and Snap's server still accepts it but we standardise
  // on the current protocol.
  const result = km.generateKeyInitializationRequest(1);
  return {
    cleartextPublicKey: toBytes(result.keyInfo.identity.cleartextPublicKey),
    cleartextPrivateKey: toBytes(result.keyInfo.identity.cleartextPrivateKey),
    identityKeyId: toBytes(result.keyInfo.identity.identityKeyId.data),
    rwk: toBytes(result.keyInfo.rwk.data),
    version: result.keyInfo.identity.version,
  };
}

/**
 * Coerce the WASM's bytes-like return shapes into a plain `Uint8Array`.
 *
 * Embind hands these back as either:
 *   - already-typed `Uint8Array`
 *   - plain `number[]` (Embind's default for `std::vector<uint8_t>` in
 *     some build configs)
 *   - dictionary-like `{0:n, 1:n, …, length:n}` (older Embind)
 */
function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  if (x && typeof x === "object") {
    const values = Object.values(x as Record<string, number>).filter(
      (v) => typeof v === "number",
    );
    return new Uint8Array(values);
  }
  throw new Error("identity-mint.toBytes: expected bytes-like, got " + typeof x);
}
