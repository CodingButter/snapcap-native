# Why this works (and what doesn't)

The mobile pivot was abandoned in April 2026 after exhaustive validation — every emulator, every rooted phone, every Frida bridge ran into Snap's Argos / Play Integrity wall and got the universal "your access is temporarily disabled" verdict. snapcap exists because the **web** surface is a different beast, and the asymmetry is structural, not coincidental.

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

## What's still gated: Fidelius

There's one wall snapcap can't talk through: **Fidelius**, Snap's end-to-end encryption protocol for messaging.

Fidelius isn't a fingerprint check. It's actual cryptography. Message bodies are encrypted by the sender with keys derived from a key-agreement protocol that runs in the messaging WebAssembly worker. Receiving plaintext requires running that worker with the recipient's keys — which means we have to run the messaging WASM in Node.

The chat bundle ships two messaging-related WASMs:

```
cf-st.sc-cdn.net/dw/e4fa90570c4c2d9e59c1.wasm  (encrypted at rest)
cf-st.sc-cdn.net/dw/ab45430efaecdac9411e.wasm  (encrypted at rest)
```

The "encrypted at rest" part is the key. Both files have non-WASM magic bytes (one starts with `cbffff3fff877ffc`, the other with `5ba76cbc02ca89e8`). They're not loadable as-is. The chat bundle's `f16f14e3b729db223348.chunk.js` contains the JavaScript that decrypts them at load time. Cracking that decryption is its own multi-week project — same Embind-trace technique we used for kameleon, applied to a different module — and is the next meaningful unlock for snapcap.

In the meantime, we can do everything that doesn't require reading message bodies:

- Send messages (text, photo, video) ✅ — Fidelius encrypts on the sender side; we control sending
- Send stories ✅ — same encryption path, recipient is the magic MY_STORY UUID
- Manage friends ✅ — AtlasGw isn't gated
- Search ✅ — same
- Receive metadata ✅ — who sent what when, conversation list, presence indicators, typing
- **Receive message bodies ❌** — that's the Fidelius gate

So snapcap is "send-only + read-graph" until the Fidelius decryption lands.

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
