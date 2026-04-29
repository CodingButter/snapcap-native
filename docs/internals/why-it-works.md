# Why this works (and what doesn't)

The mobile pivot was abandoned in April 2026 after exhaustive validation — every emulator, every rooted phone, every Frida bridge ran into Snap's Argos / Play Integrity wall and got the universal "your access is temporarily disabled" verdict. snapcap exists because the **web** surface is a different beast, and the asymmetry is structural, not coincidental.

## What changed: sandbox + browser-shim insight

The first cut of snapcap loaded happy-dom via `GlobalRegistrator` and let it install its Window properties straight onto Node's `globalThis`. That worked, but mutated the host process — `globalThis.fetch`, `globalThis.localStorage`, `globalThis.document` all became happy-dom shims for any consumer code that imported the SDK. Non-starter for a public package.

Two things replaced it:

- **Isolated `vm.Context` for the bundle.** `src/shims/sandbox.ts` constructs an empty `vm.Context` (so V8 fills it with `Object` / `Array` / `Promise` / `WebAssembly` / typed-array constructors), then projects every defined own-property of a happy-dom `Window` onto that context's global. Snap's bundle, kameleon WASM, and Fidelius WASMs all run via `sandbox.runInContext(src)` and see that synthesized global as `globalThis` / `window` / `self`. The host realm's `globalThis` is never touched. See [the sandbox chapter](/internals/sandbox).
- **Browser-shaped persistence.** Bundle code that does `localStorage.setItem(...)`, `sessionStorage.getItem(...)`, `indexedDB.open(...)`, or `document.cookie = "..."` lands in a single `DataStore` the consumer passed in. Cookies, bearer, Fidelius identity, and the bundle's own browser-storage writes all share one keyed bytes blob behind stable prefixes. See [the persistence chapter](/internals/persistence).

The fingerprint / cookies-not-tokens / kameleon reasoning below is unchanged — that's the durable bit, and the whole point of running the bundle natively. The sandbox + DataStore changes are about being a well-behaved npm package, not about the protocol.

## What's different about the web

Snap's mobile apps run on a hardware-attested trust model:

- **Argos** verifies the APK's dex CRC against a server-side allowlist.
- **Play Integrity** asks Google to vouch that the device boots a stock Android image with a verified bootloader.
- **Fidelius** key derivation pulls from the device's TEE (Trusted Execution Environment) — a piece of silicon that the OS can't read or forge.

All three are **hardware-anchored**. You can't fake them in software, by definition.

In a browser, none of those exist. Chrome doesn't expose a TEE to JavaScript. There is no Play Integrity API for the web. There is no APK to checksum. So Snap's web anti-fraud is, by necessity, a pure software fingerprint:

- Snap's `kameleon.wasm` reads `navigator`, `screen`, `performance`, etc. and signs a token.
- Snap's server validates the token against a model of "what real Chrome 147 looks like."

Both halves are software. We control the software. So we can do what the software does.

## Why happy-dom is enough

The first surprise in this project was that happy-dom — a relatively boring DOM polyfill for Node — is sufficient to satisfy kameleon's fingerprint reads. We didn't have to forge canvas hashes, fake WebGL renderers, or replicate Chrome's quirky `performance.timing` values. The default happy-dom output passes.

Why? Probably because Snap's web fingerprint model is trained on real Chrome distributions in the wild, and "real Chrome" is enormously diverse. Linux Chrome 147 with a specific UA, no battery API, no `performance.memory`, default screen resolution — all valid. That bucket is large enough that happy-dom + a Chrome-shaped UA fits inside it.

This will eventually change. Snap will roll out a more aggressive model that catches happy-dom defaults. When it does, we'll respond by tightening the shim. But the cost of that escalation is bounded: every fingerprint signal has a concrete shape, a concrete set of valid values. Software vs software, both sides have equal leverage.

## What's still gated: Fidelius decryption

There's one wall snapcap can't talk through cleanly: **Fidelius**, Snap's end-to-end encryption protocol for messaging.

Fidelius isn't a fingerprint check. It's actual cryptography. Message bodies are encrypted by the sender with keys derived from a key-agreement protocol that runs in the messaging WebAssembly. Receiving plaintext requires running that WASM with the recipient's keys.

The chat bundle ships two messaging-related WASMs:

```
cf-st.sc-cdn.net/dw/e4fa90570c4c2d9e59c1.wasm   ~12 MB
cf-st.sc-cdn.net/dw/ab45430efaecdac9411e.wasm   ~814 KB
```

These are **plain WebAssembly**, not encrypted at rest. (An earlier draft of this doc claimed otherwise; that was a misread of `Content-Encoding: br` from the CDN. `scripts/download-bundle.sh` now passes `--compressed`.) The 12 MB one boots cleanly in ~250ms and exposes 267 Embind classes — `e2ee_E2EEKeyManager`, `messaging_StatelessSession`, `e2ee_KeyPersistentStorageDelegate`, the lot. See [the Fidelius chapter](/internals/fidelius) for the full state.

Identity mint **works today**: `auth/fidelius-mint.ts` boots the WASM, calls `e2ee_E2EEKeyManager.generateKeyInitializationRequest(1)`, and gets a P-256 keypair + RWK + identityKeyId out the other side. The serialized blob lands in the DataStore at `indexdb_snapcap__fidelius__identity` and registers with Snap's Fidelius service.

Decryption — `messaging_StatelessSession.extractMessage` driven from outside — is the next R&D target. The blockers are observable and bounded: Djinni proxy semantics for the JS-side gRPC and storage delegates, and the Snap-specific KDF salt/info bytes that the C++ side feeds into AES-GCM. Both are tractable; neither is currently working.

In the meantime, we can do everything that doesn't require reading message bodies:

- Send messages (text, photo, video) ✅ — Fidelius encrypts on the sender side; we drive that path
- Send stories ✅ — same encryption path, recipient is the magic MY_STORY UUID
- Manage friends ✅ — AtlasGw isn't Fidelius-gated
- Search ✅ — same
- Receive metadata ✅ — who sent what when, conversation list, presence indicators, typing
- **Receive message bodies ❌** — that's the Fidelius decryption gate

So snapcap is "send-only + read-graph" until `extractMessage` lands.

## Why mobile pivot was the right call

For posterity, here's the litany of mobile approaches that didn't work and why they were rejected:

| Approach | Why it failed |
|---|---|
| BlueStacks / Nox / MEmu / LDPlayer | Snap's risk engine flags every emulator with the "your access is temporarily disabled" verdict regardless of build-prop spoofing |
| AVD / redroid / Waydroid / Anbox / Cuttlefish | Same flag. Custom-ROM users get the same string as emulator users |
| Real rooted Pixel + Magisk + Shamiko + PIF + TrickyStore + Frida | Works today but requires per-device hardware and weekly Magisk keybox rotations as Google revokes them. RKP rollout in 2026 closes this entirely |
| APK repackaging / re-signing | Argos verifies dex CRC server-side. Modifying the APK breaks attestation regardless of how cleanly client-side checks are patched |
| Re-implementing Snap's auth in pure TS without their endpoints | Defeats the point. Still need to talk to Snap's servers, which means following their protocol |
| Snap Kit / Login Kit (official OAuth) | Too narrow. No story posting. No programmatic friend management |
| Argos / Play Integrity / TEE key extraction | STRONG attestation is hardware-anchored. No public extraction since CVE-2022-20233 patched mid-2022. RKP closes the keybox-leak path in 2026 |

Every one of those was driven by a real need to verify before pivoting. The web is the only surface where the trust model itself is software.

## What durability looks like

The two ways snapcap could break:

1. **Snap rotates the bundle.** Hashes change, file paths change, module ids might shift. The downloader (`scripts/download-bundle.sh` + `extract-chunk-urls.py`) is built to rerun against a fresh bundle. Expect ~10 minutes of fixup the first time a major rotation happens.
2. **Snap tightens the kameleon model.** Our happy-dom defaults stop passing. Fix is shim-side: read what real Chrome reports for the field that broke, hardcode it. Each round of escalation is an evening, not a project.

Neither is catastrophic. Compare to the mobile path, where every rotation of Google's keybox revocation list could take you offline for a week.

The right way to think about this: **snapcap is browser code running outside a browser**. Anything Snap does to harden it has to also work for real browsers, which constrains how aggressive they can be. The tighter the fingerprint model, the more false positives Snap takes from legitimate users. There's a built-in equilibrium.
