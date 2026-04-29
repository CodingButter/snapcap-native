# Architecture

## The mental model

Every Snap web app — chat, stories, the calling experience — is the same `web.snapchat.com` gRPC-Web API behind a different React frontend. The gRPC clients, the protobuf encoders, the auth flow, all of it is shipped to the browser as JavaScript and WebAssembly. snapcap loads that bundle in Node and uses the same code paths from server-side TypeScript — but isolates them in a `vm.Context` so the consumer's `globalThis` is never touched.

```
┌────────────────────────────────────────────────────────────────────┐
│ Host Node realm                                                    │
│                                                                    │
│   import { SnapcapClient, FileDataStore } from "@snapcap/native"   │
│                                                                    │
│   const client = new SnapcapClient({ dataStore, username, … })     │
│   if (await client.isAuthorized()) await client.listFriends()      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ SDK orchestration (src/api, src/auth, src/transport)         │  │
│  │  • transport/native-fetch.ts   → host-realm `fetch`          │  │
│  │  • transport/cookies.ts        → tough-cookie jar attach     │  │
│  │  • transport/grpc-web.ts       → framing + 401 retry         │  │
│  └─────────────┬───────────────────────────────────┬────────────┘  │
│                │                                   │               │
│  ┌─────────────▼─────────────────┐    ┌────────────▼────────────┐  │
│  │ DataStore (one of)            │    │ vm.Context (Sandbox)    │  │
│  │  FileDataStore / Memory / BYO │◄──►│  ┌───────────────────┐  │  │
│  │  ─────────────────────────    │    │  │ V8 built-ins      │  │  │
│  │  cookie_jar                   │    │  │ (Object/Array/    │  │  │
│  │  session_snapcap_bearer       │    │  │  Promise/WASM/…)  │  │  │
│  │  local_snapcap_self           │    │  ├───────────────────┤  │  │
│  │  indexdb_snapcap__fidelius__… │    │  │ happy-dom Window  │  │  │
│  │  + bundle-owned local_/       │    │  │ props projected   │  │  │
│  │    session_/indexdb_ keys     │    │  ├───────────────────┤  │  │
│  └───────────────────────────────┘    │  │ DataStore-backed  │  │  │
│                                       │  │  localStorage     │  │  │
│                                       │  │  sessionStorage   │  │  │
│                                       │  │  indexedDB        │  │  │
│                                       │  │  document.cookie  │  │  │
│                                       │  ├───────────────────┤  │  │
│                                       │  │ Snap accounts JS  │  │  │
│                                       │  │ + chat bundle JS  │  │  │
│                                       │  │ + kameleon WASM   │  │  │
│                                       │  │ + Fidelius WASMs  │  │  │
│                                       │  └───────────────────┘  │  │
│                                       └─────────────────────────┘  │
└──────────┬─────────────────────────────────────────────────────────┘
           │  fetch (host-realm) + cookie jar + bearer
           ▼
┌────────────────────────────────────────────────────────────┐
│ Snap                                                       │
│  accounts.snapchat.com → WebLoginService (gRPC-Web)        │
│  session.snapchat.com  → WebAttestationService             │
│  web.snapchat.com      → AtlasGw, MessagingCore, Fidelius… │
│  cf-st.sc-cdn.net      → media uploads                     │
└────────────────────────────────────────────────────────────┘
```

Two boundaries to keep in mind reading the rest of these docs:

- **Foreign code runs in the vm.Context.** Snap's bundle JS, the kameleon WASM, the Fidelius WASMs — none of them touch the host realm. They see a `globalThis` that's a synthesized vm-realm global with happy-dom Window properties projected onto it. Consumer code is unaffected.
- **Real network I/O does not.** `transport/native-fetch.ts` snapshots Node's `fetch` at module load. Outgoing requests go straight to Node, with cookies attached by `transport/cookies.ts` and bearer by `transport/grpc-web.ts`. The bundle's own `fetch` is happy-dom's, scoped to the sandbox, and never used for real traffic — it's only there because the bundle won't run without a `fetch` global.

See [the sandbox chapter](/internals/sandbox) for the isolation mechanics, and [the persistence chapter](/internals/persistence) for how DataStore-backed state lands.

## What runs where

Three pieces of foreign code execute inside `@snapcap/native`'s vm.Context:

1. **Snap's accounts bundle** — about 5 MB of webpacked JavaScript loaded from `static.snapchat.com`. Contains the WebLoginService gRPC client, the protobuf encoders/decoders for every Janus auth message, and the loader for `kameleon.wasm`.
2. **The kameleon WebAssembly module** — 814 KB of Emscripten-compiled C++ + Embind glue. This is what generates the attestation token Snap's server uses to decide whether the client is a legitimate browser. Reading every JS global it touches is documented in [the kameleon chapter](/internals/kameleon).
3. **The chat bundle** — about 1.5 MB more from `cf-st.sc-cdn.net`, plus the 12 MB Fidelius WASM (`e4fa90570c4c2d9e59c1.wasm`) and an 814 KB sibling (`ab45430efaecdac9411e.wasm`). Contains the AtlasGw client (friend list, search, presence), MessagingCoreService (DMs and stories), the upload-flow helpers, and the E2E key-management primitives. Loaded lazily the first time you call an API method that needs it.

snapcap loads all three through a small set of trampolines:

- The **sandbox** (`src/shims/sandbox.ts`) wraps a `vm.Context` with happy-dom Window properties and DataStore-backed Storage / IndexedDB / `document.cookie` shims.
- The **runtime singleton** (`src/shims/runtime.ts`) exposes `installShims()` / `getSandbox()`. Bundle loaders eval source via `sandbox.runInContext(src)`.
- The **webpack capture** (`src/shims/webpack-capture.ts`) hooks the bundle's chunk-array push so we can address modules by id from outside the bundle. Lands on the sandbox global, not host globalThis.
- A **runtime patch** in the webpack IIFE source rewrites one line so the closure-private `__webpack_require__` leaks to (sandbox-realm) `globalThis`. See [the webpack-trick chapter](/internals/webpack-trick).

## The auth flow

The auth state machine has three phases. The diagram below skips telemetry beacons (`graphene/web`, `web-blizzard`, `gcp.api.snapchat.com/web/metrics`) — they're cosmetic and snapcap ignores them.

```
1. attestation
   ───────────
   kameleon.wasm reads navigator + screen + performance (in vm realm)
   → AttestationSession.instance().finalize(username)
   → 1032-char base64 token

2. WebLogin (2-step)
   ──────────────────
   POST WebLogin { username + attestation }    ← native-fetch + jar
   ← challengeData.passwordChallenge + sessionPayload

   POST WebLogin { sessionPayload + password }
   ← bootstrapDataBrowser
   ← Set-Cookie: __Host-sc-a-auth-session  ← long-lived, → cookie_jar

3. SSO bearer mint
   ────────────────
   GET /accounts/sso?client_id=…
   ← 303 Location: https://www.snapchat.com/web#ticket=<bearer>

   GET https://www.snapchat.com/web (follow redirect)
   ← Set-Cookie: sc-a-nonce, _scid, sc_at  ← parent-domain, → cookie_jar
   bearer    → session_snapcap_bearer
```

After phase 3, the cookie jar holds one host-scoped cookie that authorizes refreshes (`__Host-sc-a-auth-session`), three parent-domain cookies that gate web.snapchat.com gRPC calls, and a Bearer string that pretends to be the access token. From there, every API call is the same shape: framed gRPC-Web POST with `Authorization: Bearer …` and the cookie header riding along. All of it goes through the host-realm `fetch` (`transport/native-fetch.ts`), not the sandbox's.

## What's deferred

Two things you might expect to find here aren't:

- **Receiving message content.** Snap encrypts message bodies with [Fidelius](https://eng.snap.com/fidelius), an end-to-end protocol whose key material is locked behind the messaging WASMs. Identity mint works (`auth/fidelius-mint.ts` boots the 12 MB WASM, generates a P-256 keypair + RWK locally, and registers with Snap's Fidelius service). Decryption — `messaging_StatelessSession.extractMessage` — is the next R&D target. See [the Fidelius chapter](/internals/fidelius).
- **Real-time push.** Snap pushes events over a WebSocket at `aws.duplex.snapchat.com`. snapcap connects for outbound presence/typing today, but inbound message-body push waits on the same Fidelius gate.

## Why this is more durable than the alternatives

The mobile-emulator approach (BlueStacks / redroid / rooted Pixel + Frida) was the original snapcap thesis. It was abandoned after exhaustive testing — Snap's mobile risk engine treats every emulator as a flagged device, and even hardware-attested rooted phones depend on monthly Magisk keybox rotations that Google is actively closing off in the 2026 RKP rollout.

Web Snap's anti-fraud is different. There is no hardware attestation in a browser, only a fingerprinted JavaScript blob. Snap can — and does — make the kameleon attestation arbitrarily complex, but they can't anchor it to a TEE, because there is no TEE. The same `perdyjamie` test account that mobile risk silently rejected logged in on the web first try.

That asymmetry is what makes this approach durable. A breaking change on Snap's side means rebuilding the attestation, not the entire trust model.
