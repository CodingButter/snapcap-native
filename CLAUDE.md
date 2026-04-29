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
  auth/
    kameleon.ts          ← cached singleton; boots once per process
    login.ts             ← WebLoginService 2-step
    sso.ts               ← SSO bearer mint + refresh
  transport/
    cookies.ts           ← jar-aware fetch wrapper
    grpc-web.ts          ← framing + 401-retry; supports decode and deserializeBinary
    native-fetch.ts      ← captures Bun fetch before shims load
  shims/
    runtime.ts           ← happy-dom + chrome stub
    webpack-capture.ts   ← chunk-array hook + factory wrap
scripts/
  smoke.ts               ← end-to-end test
  mint-attestation.ts    ← mint a kameleon token from CLI
  try-*.ts               ← scratch scripts kept as live examples
  download-bundle.sh     ← refetches Snap's JS + WASM into vendor/
docs/                    ← VitePress site (deploys to GitHub Pages)
vendor/                  ← gitignored; populated by download-bundle.sh
```

## Critical invariants

These are easy to break and hard to debug — read these before touching the relevant areas.

- **Native fetch must be captured before installShims runs.** happy-dom replaces `globalThis.fetch` with a version that strips Set-Cookie headers (cookies live on document instead). `transport/native-fetch.ts` snapshots the original at module load time. Don't import shim-installing modules first.
- **Webpack runtime IIFE must be source-patched.** The runtime keeps `__webpack_require__` (`p`) closure-private. We replace `p.m=s,p.amdO={}` → `globalThis.__snapcap_p=p,p.m=s,p.amdO={}` before eval. Without that we can't address modules by id.
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
