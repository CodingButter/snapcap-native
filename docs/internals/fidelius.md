# Fidelius — Snap's E2E encryption layer

Fidelius is the end-to-end encryption protocol that gates **sending snaps**
(disappearing image messages, destination kind 122) and **reading inbound
message bodies** of any kind. The same WASM binary — `e4fa90570c4c2d9e59c1.wasm`
in the chat bundle — implements both directions.

The earlier "encrypted WASM that needs decrypting first" framing in CLAUDE.md
was wrong: the file looked high-entropy because the CDN serves it with
`Content-Encoding: br` and our download script wasn't passing `--compressed`.
Decompressed, it's plain WebAssembly.

## What we've validated

Bootable. `scripts/try-fidelius.ts` reaches `onRuntimeInitialized` in ~225ms
and gets all 267 Embind classes accessible:

- `e2ee_E2EEKeyManager` (with `constructPostLogin`, `constructWithKey`,
  `createSharedSecretKeys`, `generateKeyInitializationRequest` static methods)
- `e2ee_KeyPersistentStorageDelegate`, `e2ee_SessionScopedStorageDelegate`,
  `e2ee_KeyProvider`, `e2ee_BlizzardEventDelegate`
- `messaging_StatelessSession` (with `sendMessageWithContent`, `extractMessage`)
- `messaging_Session.create`, `grpc_GrpcManager.registerWebFactory`,
  `shims_Platform.init`, `config_ConfigurationRegistry`, etc.

`generateKeyInitializationRequest(0)` returns:

```ts
{
  keyInfo: {
    identity: {
      cleartextPrivateKey: Uint8Array(32),   // P-256 private key
      cleartextPublicKey:  Uint8Array(65),   // 0x04 prefix → SEC1 uncompressed P-256
      identityKeyId:       { data: Uint8Array(32) },
      version: 9 | 10
    },
    rwk: { data: Uint8Array(16) }            // root wrapping key
  },
  request: Uint8Array(105)                   // serialized InitializeWebKeyRequest proto
}
```

Posting `request` to
`/snapchat.fidelius.FideliusIdentityService/InitializeWebKey` returns 401
(not 400), confirming the bytes are well-formed; only the bearer scope is
unauthorized at the moment.

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

The C++ symbols `FIDELIUS_SNAP_PHI` (encrypt) and `FIDELIUS_SNAP_INVERSE_PHI`
(decrypt) implement the per-recipient envelope.

## Driving the WASM from outside

Two boundaries we mapped:

1. **Djinni proxy mechanism.** Snap layers Djinni-style cross-language
   bindings on top of Embind. When the WASM gets a JS object that
   should satisfy a C++ interface, it probes:
     - `"_djinni_native_ref" in obj` (is this C++-backed?)
     - `"_djinni_js_proxy_id" in obj` (existing JS proxy?)
   If both miss, the WASM auto-wraps via `Module.callJsProxyMethod`.
   Plain JS objects work — the gotcha is that `key in primitiveValue`
   throws "is not an Object", so passing a string where the WASM expected
   a config object surfaces as the same error.

2. **Bundle init order.** Before `e2ee_E2EEKeyManager.constructPostLogin`
   succeeds, the WASM needs:
     - `shims_Platform.init({assertionMode, minLogLevel}, {logTimedEvent, log})`
     - `installErrorReporter`, `installNonFatalReporter`
     - `config_ConfigurationRegistry.set{CircumstanceEngine, CompositeConfig,
        Experiments, ServerConfig, Tweaks, UserPrefs}` (empty Uint8Array OK)
     - `grpc_GrpcManager.registerWebFactory({createClient: cfg => client})`

   With those done, `constructPostLogin(grpcCfg, persistentStorageDelegate,
   sessionScopedStorageDelegate, sessionCfg, 1, 1)` runs without throwing.
   It still returns `undefined` because it needs an actual stored identity
   (or to call into the gRPC factory to register one), and our gRPC stub
   crashes the WASM with an out-of-bounds function-table indirect call —
   the C++ vtable expected a fully-conforming Djinni JS proxy with method
   pointers we haven't installed.

## Open work

- **Auth scope for FideliusIdentityService.** The bearer that drives
  AtlasGw + MessagingCore returns 401 against
  `/snapchat.fidelius.FideliusIdentityService/InitializeWebKey`. Browsers
  apparently mint Fidelius identities once and reuse them; we may need
  to either (a) hit a different mint endpoint, or (b) attach a kameleon
  attestation header that turns the bearer into Fidelius-eligible.

- **Real gRPC bridge for the WASM's createClient.** The WASM's C++ side
  expects the returned client to be a fully-typed Djinni proxy. A no-op
  JS object passes the `_djinni_js_proxy_id` check but the subsequent
  vtable dispatch indirects through an empty function-table slot. Either
  we wrap the client with `DjinniCppProxy` properly, or we hand-build
  routing through `Module.callJsProxyMethod`.

- **Manual TS reimplementation.** Now that we have the proto wire
  format and the algorithm shape (P-256 ECDH → KDF → AES-GCM AEAD per
  recipient), `FIDELIUS_SNAP_PHI` could be implemented in TypeScript on
  top of `node:crypto`. Snap-specific KDF salt/info bytes are still
  unknown — getting them out of the WASM (e.g. by tracing imports while
  encrypting a known plaintext) is the unblock.
