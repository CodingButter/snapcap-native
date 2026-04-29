# SnapSDK — `@snapcap/native`

Public, MIT-licensed Node SDK that talks to `web.snapchat.com` natively. Sibling project `SnapAutomate/` (private) consumes this as a dependency.

> **Pre-read:** the parent `~/snapcap/CLAUDE.md` summarizes the layout. The `docs/internals/` chapters are the long-form story of how everything works (architecture, kameleon, webpack-trick, sso-flow, why-it-works).

## What works today

- `SnapcapClient.fromCredentials({ credentials })` — full native login → cookie + bearer (~4s first time)
- `SnapcapClient.fromAuth({ auth })` — instant restore from a 2 KB blob
- `client.listFriends()` / `searchUsers()` / `addFriend()`
- `client.getConversations()` / `Conversation.sendText` / `sendImage` / `sendImageWithCaption`
- `client.postStory(bytes)` — auto-normalizes to 1080×1920 RGBA PNG, posts to MY_STORY
- Persistent duplex WS for real-time presence (typing / viewing) with kick detection
- `client.toAuthBlob()` — serialize cookie jar + bearer for persistence

End-to-end smoke test: `bun run scripts/smoke.ts` (needs `.snapcap-smoke.json` with `{username, password}` — local file, not committed).

## Layout

```
src/
  client.ts              ← SnapcapClient (public entry point)
  index.ts               ← public exports
  api/
    friends.ts           ← AtlasGw/SyncFriendData
    friending.ts         ← addFriend / friendRequest
    fidelius.ts          ← Fidelius identity register/lookup
    fidelius-encrypt.ts  ← Fidelius envelope encrypt (outbound DMs/snaps)
    inbox.ts             ← QueryMessages
    media.ts             ← upload-location + content endpoints
    messaging.ts         ← Conversation, sendText/sendImage
    presence.ts          ← typing/viewing state
    search.ts            ← user search
    user.ts              ← User type + factories
  auth/
    chat-bundle.ts       ← loads cf-st.sc-cdn.net/dw bundle into the sandbox
    ensure-bundle.ts     ← downloads vendor/snap-bundle on first use
    fidelius-mint.ts     ← boots Fidelius WASM, mints E2E identity
    kameleon.ts          ← cached singleton; boots once per process
    login.ts             ← WebLoginService 2-step
    sso.ts               ← SSO bearer mint + refresh
  transport/
    cookies.ts           ← jar-aware fetch wrapper
    duplex.ts            ← persistent WS to aws.duplex.snapchat.com
    grpc-web.ts          ← framing + 401-retry; supports decode and deserializeBinary
    native-fetch.ts      ← Node fetch ref (sandbox does NOT touch globalThis.fetch)
    proto-encode.ts      ← uuid + protobuf helpers
  shims/
    sandbox.ts           ← isolated vm.Context wrapping happy-dom Window
    runtime.ts           ← installShims() / getSandbox() singletons
    webpack-capture.ts   ← chunk-array hook + factory wrap (lands on sandbox)
  storage/
    data-store.ts        ← DataStore interface, FileDataStore, MemoryDataStore
    storage-shim.ts      ← Web Storage API over a DataStore (local/session prefix)
    cookie-store.ts      ← DataStore-backed CookieJar wrapper
    data-store-fetch.ts  ← cookie-only fetch wrapper (no bearer attach)
scripts/
  smoke.ts               ← end-to-end test
  mint-attestation.ts    ← mint a kameleon token from CLI
  try-*.ts               ← scratch scripts kept as live examples
  download-bundle.sh     ← refetches Snap's JS + WASM into vendor/
docs/                    ← VitePress site (deploys to GitHub Pages)
vendor/                  ← gitignored; populated by download-bundle.sh
```

## Sandbox model

Bundle JS and WASM run in an isolated Node `vm.Context`, not on Node's globalThis. The shape:

- `shims/sandbox.ts` constructs an empty `vm.Context` (so V8 fills the new realm with `Object`/`Array`/`Promise`/`WebAssembly`/…), then projects every defined own-property of a happy-dom `Window` onto that context's global. happy-dom is *not* installed via GlobalRegistrator — it never touches Node's globalThis.
- `shims/runtime.ts` exposes `installShims(opts)` (constructs the singleton Sandbox) and `getSandbox()` (reads it back). Bundle loaders (`auth/chat-bundle.ts`, `auth/kameleon.ts`) eval source via `sandbox.runInContext(src, "<filename>")`. Inside, `globalThis`/`self`/`window` all resolve to the synthesized vm-realm global.
- Storage in the sandbox can be backed by a `DataStore` — pass `dataStore: …` in the shim opts and `localStorage` / `sessionStorage` become DataStore-backed `StorageShim`s. With no DataStore, happy-dom's in-memory defaults apply.
- Real network traffic (login, gRPC, media uploads) does **not** go through the sandbox. `transport/cookies.ts` + `transport/grpc-web.ts` use `transport/native-fetch.ts` (Node fetch) with the SDK's own cookie jar + bearer, so request behavior is observable from the host realm.

## Critical invariants

These are easy to break and hard to debug — read these before touching the relevant areas.

- **Project ALL of happy-dom Window's own props onto the sandbox.** A curated allow-list is tempting but silently leaves out things the WASM expects (e.g. `requestAnimationFrame`, `BroadcastChannel`, `MessageChannel`). When kameleon's WASM coroutines suspend on a Promise gated by a missing global, you get a busy-loop on `emscripten_get_now` (~10M calls/sec) instead of a clean error.
- **Bundle source must be IIFE-wrapped with `\n` around the source.** Snap's bundles end in a `//# sourceMappingURL=…` line comment with no trailing newline; a bare `})(…)` continuation appended to it gets eaten by the comment. Use `(function(module, exports, require) {\n` + src + `\n})(…)`.
- **Webpack runtime IIFE must be source-patched.** The runtime keeps `__webpack_require__` (`p`) closure-private. Replace `p.m=s,p.amdO={}` → `globalThis.__snapcap_p=p,p.m=s,p.amdO={}` before eval — inside the sandbox `globalThis` is the vm-realm global, so `getSandbox().getGlobal("__snapcap_p")` reads it back. Without the patch we can't address modules by id.
- **Kameleon Module needs Graphene/page/version/UAParserInstance/webAttestationServiceClientInstance set on it before instance().** The bundle's `createModule` wrapper attaches these post-factory; we replicate it manually because we call the factory directly. Missing any one → `Cannot pass non-string to std::string` at instance() time.
- **AtlasGw responseType uses `deserializeBinary`, not `decode`.** Older grpc-web style. WebLoginService (newer ts-proto style) has `decode`. `transport/grpc-web.ts:decodeRespBytes` handles both.
- **AtlasGw needs parent-domain cookies plus bearer.** Bearer alone returns 401. The SSO redirect to `www.snapchat.com/web` is what seeds `sc-a-nonce`, `_scid`, `sc_at` into the jar. Don't skip the GET-after-redirect step in `mintBearer`.

## What's still gated

- **Snaps (disappearing image messages, destination kind 122)** and **receiving message body content** — both gated on the same Fidelius E2E layer. The relevant primitives live in two WASMs in the chat bundle (`e4fa…wasm` ~12 MB, `ab45…wasm` ~814 KB). They are *not* encrypted — earlier we mistook Brotli content-encoding for ciphertext. They're plain WebAssembly, ready for Embind-trace reversal like kameleon. `download-bundle.sh` now passes `--compressed` so re-pulls get plaintext WASM; old vendor/ checkouts may have garbage bytes.
- **Receiving real-time push payloads** on `aws.duplex.snapchat.com`. Same Fidelius gate — once we have the primitives, the duplex WS becomes useful for inbound message bodies.

## Adding an API method (pattern)

1. Find descriptor in chat bundle (module 74052) or accounts bundle. Grep for `methodName:"<X>"`.
2. New file `src/api/<area>.ts`. Take an `rpc.unary`-shaped param. Call the method via the AtlasGw class (or whichever client class). Return typed result.
3. Add a method on `SnapcapClient` that calls into your new file via `this.makeRpc()`.
4. Document in `docs/api/`.
