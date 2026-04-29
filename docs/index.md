---
layout: home

hero:
  name: snapcap
  text: A browser-free Snapchat client
  tagline: Native Node bridge to web.snapchat.com — no Playwright, no Frida, no rooted phone.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /api/
    - theme: alt
      text: How it works
      link: /internals/architecture

features:
  - title: Pure Node, no browser
    details: |
      Loads Snap's web JavaScript bundle and 814 KB of WASM directly in
      Node, with happy-dom shimming the Chrome APIs the bundle expects.
      No Playwright. No headless Chromium. No emulator.
  - title: Native attestation
    details: |
      Runs Snap's kameleon Emscripten module in Node and generates the
      same attestation token a real browser would. Snap's anti-fraud
      accepts it because it's the actual code path, not a forgery.
  - title: Browser-shaped persistence
    details: |
      Hand the client a <code>DataStore</code> — file, memory, Redis, KMS,
      whatever — and the bundle's cookies, bearer, Fidelius identity, and
      sandboxed local/session/IndexedDB writes all land under stable keys.
      Cold start ~5 s; warm start ~1 ms.
  - title: gRPC-Web for free
    details: |
      Every Snap RPC client and protobuf encoder/decoder is shipped in
      the bundle. snapcap reuses them in-place — no <code>.proto</code>
      files, no codegen, no schema drift.
  - title: One-line API
    details: |
      <code>if (await client.isAuthorized()) await client.listFriends()</code>.
      Login, bearer rotation, cookie jar, and gRPC framing all live under
      the surface.
  - title: Multi-account ready
    details: |
      Kameleon module is shared across SnapcapClient instances. Run many
      accounts in one Node process at a fraction of the memory Playwright
      would burn — each account gets its own DataStore.
---

## What this is

A Node SDK that talks directly to `web.snapchat.com`'s gRPC-Web API the same way the browser does — by running Snap's actual JavaScript bundle in an isolated Node `vm.Context`. You get an idiomatic TypeScript class with methods like `listFriends()`, `sendText()`, and `postStory()`.

```ts
import { SnapcapClient, FileDataStore } from "@snapcap/native";

const client = new SnapcapClient({
  dataStore: new FileDataStore("./auth.json"),
  username: process.env.SNAP_USER,
  password: process.env.SNAP_PASS,
});

if (await client.isAuthorized()) {
  console.log(await client.listFriends());
}
```

## What this is not

- It's **not** a wrapper around an emulator, Frida, or a rooted phone — those approaches were tried and failed against Snap's mobile risk engine.
- It's **not** Snap's official Login Kit or Snap Kit — those don't expose story posting or friend management.
- It's **not** Playwright-driven. There is zero headless browser at runtime.

## Status

| Capability | Status |
|---|---|
| Native login (username + password → cookie + bearer) | Working |
| `listFriends()` / `searchUsers()` / `addFriend()` | Working |
| `getConversations()` + `Conversation.sendText` / `sendImage` | Working |
| `postStory()` (auto-normalises to 1080×1920 RGBA PNG) | Working |
| Persistent duplex WS (real-time presence) | Working |
| Receive message *content* | Blocked on Fidelius E2E |

If you came here to understand **how** all of this works, head to the [Internals](/internals/architecture) section. To dive straight into APIs, see the [Reference](/api/).
