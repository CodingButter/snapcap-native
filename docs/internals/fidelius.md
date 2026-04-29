# Fidelius — Snap's E2E encryption layer

Fidelius is the end-to-end encryption protocol that gates **sending snaps** (disappearing image messages, destination kind 122) and **reading inbound message bodies** of any kind. The same WASM binary — `e4fa90570c4c2d9e59c1.wasm` (~12 MB) in the chat bundle — implements both directions.

The earlier "encrypted WASM that needs decrypting first" framing was wrong: the file looked high-entropy because the CDN serves it with `Content-Encoding: br` and our download script wasn't passing `--compressed`. Decompressed, it's plain WebAssembly. `scripts/download-bundle.sh` now passes `--compressed` so re-pulls get plaintext.

## What's working today

**Identity mint.** `auth/fidelius-mint.ts:69-83` boots the chat-bundle WASM (~250ms), grabs `e2ee_E2EEKeyManager.generateKeyInitializationRequest(1)`, and gets a fresh identity:

```ts
{
  keyInfo: {
    identity: {
      cleartextPrivateKey: Uint8Array(32),   // P-256 private key
      cleartextPublicKey:  Uint8Array(65),   // 0x04 prefix → SEC1 uncompressed P-256
      identityKeyId:       { data: Uint8Array(32) },
      version: 10                             // "TEN"
    },
    rwk: { data: Uint8Array(16) }            // root wrapping key
  },
  request: Uint8Array                         // serialized InitializeWebKeyRequest proto
}
```

The mint is local — the WASM uses its own CSPRNG, not anything we feed it. After mint, `client.ts` posts the `request` bytes to `/snapchat.fidelius.FideliusIdentityService/InitializeWebKey` to register the public half with Snap, and serializes the keypair + RWK + identityKeyId to the DataStore at `indexdb_snapcap__fidelius__identity` (hex-encoded JSON via the IDB shim).

That's the cold-start half. On warm boot, `loadFideliusIfPresent` (`src/client.ts:592`) reads the same key back through `idbGet` and skips the WASM entirely.

**The 267 Embind classes are reachable.** Once `onRuntimeInitialized` fires, every class is on the Module object. Notable ones:

- `e2ee_E2EEKeyManager` — `constructPostLogin`, `constructWithKey`, `createSharedSecretKeys`, `generateKeyInitializationRequest`
- `e2ee_KeyPersistentStorageDelegate`, `e2ee_SessionScopedStorageDelegate` — the storage interfaces the WASM expects JS to provide
- `e2ee_KeyProvider`, `e2ee_BlizzardEventDelegate`
- `messaging_StatelessSession` — `sendMessageWithContent`, `extractMessage`
- `messaging_Session.create`, `grpc_GrpcManager.registerWebFactory`, `shims_Platform.init`, `config_ConfigurationRegistry`

## Wire format (recovered from chat-bundle protos)

```proto
message FideliusEncryption {
  bytes snapKey = 1;                    // wrapped content key (CEK)
  bytes snapIv = 2;                     // IV for the wrapped CEK
  bool retried = 3;
  uint32 version = 4;
  bytes senderOutBeta = 5;
  repeated FideliusRecipientInfo fideliusRecipientInfo = 6;
}

message FideliusRecipientInfo {
  bytes recipientKey = 1;               // identifier of recipient device key
  bytes na = 2;                         // nonce-A (per-recipient salt)
  bytes phi = 3;                        // ECDH-wrapped CEK ("PHI envelope")
  bytes tag = 4;                        // AEAD auth tag
  UserId senderUserId = 5;
  UserId recipientUserId = 6;
  uint32 recipientVersion = 7;
}

message PHI {
  bytes nonce = 1;
  bytes senderPublicKeyIdentifier = 2;
  bytes cekPlaintext = 16;              // the unwrapped CEK after decryption
}

message MediaKey { bytes mediaKey = 1; bytes mediaIv = 2; }
message CEK      { bytes cekIv = 1;     bytes cek = 2; }
```

The C++ symbols `FIDELIUS_SNAP_PHI` (encrypt) and `FIDELIUS_SNAP_INVERSE_PHI` (decrypt) implement the per-recipient envelope.

## What we know about the primitives

Observable — not speculative:

- **P-256 ECDH** for the per-recipient key wrap. Public keys are 65 bytes with the `0x04` SEC1-uncompressed prefix; private keys are 32 bytes.
- **Some KDF** (HKDF-SHA-256 is the obvious candidate but unconfirmed) for deriving the AEAD key from the ECDH shared secret + per-message salt (`na`).
- **AES-GCM** as the AEAD over the CEK — the `tag` field in `FideliusRecipientInfo` is GCM-tag-shaped (16 bytes typical), and `messaging_StatelessSession` calls into `crypto.subtle.encrypt`/`decrypt` shaped paths in the bundle.
- **Two WASMs in the chat bundle.** `e4fa…wasm` (~12 MB) is the one with the 267 Embind classes — the messaging E2E module. `ab45…wasm` (~814 KB) is the smaller sibling and we haven't booted it as fully; it appears to handle a narrower subset of crypto.

Still open:

- The exact KDF (HKDF? SHA-2 vs SHA-3? salt/info bytes?). The C++ side feeds Snap-specific constants in. Resolving this is what unblocks a from-scratch TS reimplementation.
- Whether sender and recipient code paths use the same primitive (likely yes — `FIDELIUS_SNAP_PHI` and `FIDELIUS_SNAP_INVERSE_PHI` are mirror operations) or whether outbound has additional authentication layers we haven't seen.

## Driving the WASM from outside

Two boundaries we've mapped:

1. **Djinni proxy mechanism.** Snap layers Djinni-style cross-language bindings on top of Embind. When the WASM gets a JS object that should satisfy a C++ interface, it probes:
    - `"_djinni_native_ref" in obj` (is this C++-backed?)
    - `"_djinni_js_proxy_id" in obj` (existing JS proxy?)

   If both miss, the WASM auto-wraps via `Module.callJsProxyMethod`. Plain JS objects work — the gotcha is that `key in primitiveValue` throws "is not an Object", so passing a string where the WASM expected a config object surfaces as the same error.

2. **Bundle init order.** Before `e2ee_E2EEKeyManager.constructPostLogin` succeeds, the WASM needs:
    - `shims_Platform.init({assertionMode, minLogLevel}, {logTimedEvent, log})`
    - `installErrorReporter`, `installNonFatalReporter`
    - `config_ConfigurationRegistry.set{CircumstanceEngine, CompositeConfig, Experiments, ServerConfig, Tweaks, UserPrefs}` (empty Uint8Array OK)
    - `grpc_GrpcManager.registerWebFactory({createClient: cfg => client})`

   With those done, `constructPostLogin(grpcCfg, persistentStorageDelegate, sessionScopedStorageDelegate, sessionCfg, 1, 1)` runs without throwing. It still returns `undefined` because it needs an actual stored identity and a working gRPC factory — both currently stubbed.

## Persistence delegate shape

The WASM expects two storage delegates: `e2ee_KeyPersistentStorageDelegate` (RWK-wrapped long-lived key material) and `e2ee_SessionScopedStorageDelegate` (per-process ephemeral state). Both are async-callback-shaped on the JS side — the C++ vtable methods take a key/value plus a completion handler.

That shape maps cleanly to the `IDBRequestShim` in `src/shims/indexed-db.ts`. The plan once `constructPostLogin` is unblocked is to wire the WASM's persist callbacks straight to `indexedDB.open("snapcap", 1).objectStore("fidelius-keys").put(...)` calls, which land in the DataStore at sibling `indexdb_snapcap__fidelius-keys__*` keys without consumer-visible change.

We don't need a *real* IndexedDB implementation — the WASM's contract is just "give me a key, return me the bytes asynchronously" / "store these bytes under this key, signal me when done". The shim's queueMicrotask-based `onsuccess` semantics are sufficient.

## Open work

- **Auth scope for FideliusIdentityService.** When we tested `InitializeWebKey` with the AtlasGw bearer earlier, we got 401 (not 400 — bytes were well-formed). The current `client.ts:initializeWebKey` flow includes a `stripOriginReferer` header transform and uses the same bearer; whether that sticks in production across all account types is something we'll know once mint is exercised at scale.

- **`extractMessage` end-to-end.** The decryption path (inbound message body → cleartext bytes) needs `e2ee_E2EEKeyManager.constructPostLogin` to return a usable manager, which needs the gRPC factory and the storage delegates wired correctly. Today the gRPC stub crashes the WASM with an out-of-bounds function-table indirect call — the C++ vtable expected a fully-conforming Djinni JS proxy with method pointers we haven't installed.

- **Manual TS reimplementation as fallback.** With the proto wire format known and the algorithm shape narrowed (P-256 ECDH → KDF → AES-GCM AEAD per recipient), `FIDELIUS_SNAP_INVERSE_PHI` could be implemented in TypeScript on top of `node:crypto`. The unblock is the Snap-specific KDF salt/info bytes — getting them out of the WASM (e.g. by tracing the `crypto.subtle.deriveBits` import from JS while the WASM encrypts a known plaintext) is the durable path.

Treat everything below "Identity mint works" as *known shape, not yet observed working end-to-end*.
