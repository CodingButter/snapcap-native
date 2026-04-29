# Architecture

## The mental model

Every Snap web app — chat, stories, the calling experience — is the same `web.snapchat.com` gRPC-Web API behind a different React frontend. The gRPC clients, the protobuf encoders, the auth flow, all of it is shipped to the browser as JavaScript and WebAssembly. snapcap loads that bundle in Node and uses the same code paths from server-side TypeScript.

```
┌──────────────────────────────────────────────────────────┐
│ your Node app                                            │
│                                                          │
│   import { SnapcapClient } from "@snapcap/native"        │
│                                                          │
│   const client = await SnapcapClient.fromCredentials({…})│
│   await client.listFriends()                             │
│                                                          │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│ @snapcap/native                                          │
│                                                          │
│  ┌──────────────────┐    ┌──────────────────────────┐    │
│  │ kameleon WASM    │    │ Snap's JS bundle         │    │
│  │ (Emscripten)     │    │ — webpack chunks         │    │
│  │                  │    │ — gRPC-Web clients       │    │
│  │ generates        │    │ — protobuf codecs        │    │
│  │ attestation      │    │ — auth state machines    │    │
│  └──────────────────┘    └──────────────────────────┘    │
│              │                       │                   │
│              ▼                       ▼                   │
│  ┌──────────────────────────────────────────────────┐    │
│  │ happy-dom shims (navigator, document, screen,    │    │
│  │ window, performance, …)                          │    │
│  └──────────────────────────────────────────────────┘    │
│                          │                               │
└──────────────────────────┼───────────────────────────────┘
                           ▼
                  fetch + cookies + WASM
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Snap                                                     │
│                                                          │
│  accounts.snapchat.com → WebLoginService (gRPC-Web)      │
│  session.snapchat.com  → WebAttestationService           │
│  web.snapchat.com      → AtlasGw, MessagingCore, …       │
│  cf-st.sc-cdn.net      → media uploads                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## What runs where

There are three pieces of foreign code running inside `@snapcap/native`:

1. **Snap's accounts bundle** — about 5 MB of webpacked JavaScript loaded from `static.snapchat.com`. Contains the WebLoginService gRPC client, the protobuf encoders/decoders for every Janus auth message, and the loader for `kameleon.wasm`.
2. **The kameleon WebAssembly module** — 814 KB of Emscripten-compiled C++ + Embind glue. This is what generates the attestation token Snap's server uses to decide whether the client is a legitimate browser. Reading every JS global it touches is documented in [the kameleon chapter](/internals/kameleon).
3. **The chat bundle** — about 1.5 MB more from `cf-st.sc-cdn.net`. Contains the AtlasGw client (friend list, search, presence), MessagingCoreService (DMs and stories), and the upload-flow helpers. Loaded lazily the first time you call an API method that needs it.

snapcap loads all three through a small set of trampolines:

- A **runtime shim** (`src/shims/runtime.ts`) installs `globalThis.window`, `document`, `navigator`, etc. via [happy-dom](https://github.com/capricorn86/happy-dom).
- A **webpack capture** (`src/shims/webpack-capture.ts`) hooks the bundle's chunk-array push so we can address modules by id from outside the bundle.
- A **runtime patch** in the webpack IIFE source rewrites one line so the closure-private `__webpack_require__` leaks to globalThis. See [the webpack-trick chapter](/internals/webpack-trick).

## The auth flow

The auth state machine has three phases. The diagram below skips telemetry beacons (`graphene/web`, `web-blizzard`, `gcp.api.snapchat.com/web/metrics`) — they're cosmetic and snapcap ignores them.

```
1. attestation
   ───────────
   kameleon.wasm reads navigator + screen + performance
   → AttestationSession.instance().finalize(username)
   → 1032-char base64 token

2. WebLogin (2-step)
   ──────────────────
   POST WebLogin { username + attestation }
   ← challengeData.passwordChallenge + sessionPayload

   POST WebLogin { sessionPayload + password }
   ← bootstrapDataBrowser
   ← Set-Cookie: __Host-sc-a-auth-session  ← long-lived

3. SSO bearer mint
   ────────────────
   GET /accounts/sso?client_id=…
   ← 303 Location: https://www.snapchat.com/web#ticket=<bearer>

   GET https://www.snapchat.com/web (follow redirect)
   ← Set-Cookie: sc-a-nonce, _scid, sc_at  ← parent-domain
```

After phase 3, the cookie jar holds one host-scoped cookie that authorizes refreshes (`__Host-sc-a-auth-session`), three parent-domain cookies that gate web.snapchat.com gRPC calls, and a Bearer string that pretends to be the access token. From there, every API call is the same shape: framed gRPC-Web POST with `Authorization: Bearer …` and the cookie header riding along.

## What's deferred

Two things you might expect to find here aren't:

- **Receiving message content.** Snap encrypts message bodies with [Fidelius](https://eng.snap.com/fidelius), an end-to-end protocol whose key material is locked behind the messaging WASMs. We can decrypt a message body only by running the messaging worker, and that worker's WASM is itself encrypted at rest. Cracking that is a separate project. Receiving message *metadata* (who sent what when, conversation list, presence) works fine — that path doesn't need Fidelius.
- **Real-time push.** Snap pushes events over a WebSocket at `aws.duplex.snapchat.com`. snapcap doesn't connect to it yet because most of what it carries is message-body data we can't decrypt anyway. Polling with `SyncFriendData` covers everything else.

## Why this is more durable than the alternatives

The mobile-emulator approach (BlueStacks / redroid / rooted Pixel + Frida) was the original snapcap thesis. It was abandoned after exhaustive testing — Snap's mobile risk engine treats every emulator as a flagged device, and even hardware-attested rooted phones depend on monthly Magisk keybox rotations that Google is actively closing off in the 2026 RKP rollout.

Web Snap's anti-fraud is different. There is no hardware attestation in a browser, only a fingerprinted JavaScript blob. Snap can — and does — make the kameleon attestation arbitrarily complex, but they can't anchor it to a TEE, because there is no TEE. The same `perdyjamie` test account that mobile risk silently rejected logged in on the web first try.

That asymmetry is what makes this approach durable. A breaking change on Snap's side means rebuilding the attestation, not the entire trust model.
