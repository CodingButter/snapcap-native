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
  - title: Tiny session blob
    details: |
      Log in once with username + password, save a 2 KB auth blob, and
      every subsequent process starts in a single millisecond. Reuse
      across servers, persist to disk, ship with credentials.
  - title: gRPC-Web for free
    details: |
      Every Snap RPC client and protobuf encoder/decoder is shipped in
      the bundle. snapcap reuses them in-place — no <code>.proto</code>
      files, no codegen, no schema drift.
  - title: One-line API
    details: |
      <code>const friends = await client.listFriends()</code>. The whole
      auth dance, bearer rotation, cookie jar, and gRPC framing live
      under the surface.
  - title: Multi-account ready
    details: |
      Kameleon module is shared across SnapcapClient instances. Run
      hundreds of accounts in one Node process at a fraction of the
      memory Playwright would burn.
---

## What this is

A Node SDK that talks directly to `web.snapchat.com`'s gRPC-Web API the same way the browser does — by running Snap's actual JavaScript bundle. You get an idiomatic TypeScript class with methods like `listFriends()`, `sendTextMessage()`, and `postStory()`.

## What this is not

- It's **not** a wrapper around an emulator, Frida, or a rooted phone — those approaches were tried and failed against Snap's mobile risk engine.
- It's **not** Snap's official Login Kit or Snap Kit — those don't expose story posting or friend management.
- It's **not** Playwright-driven. There is zero headless browser at runtime.

## Status

| Capability | Status |
|---|---|
| Native login (username + password → cookie + bearer) | ✅ Working |
| `listFriends()` via AtlasGw | ✅ Working |
| Search users, add friend, send text DM | 🚧 Next |
| Send media DM, post story | 🚧 Planned |
| Receive message *content* | ❌ Blocked on Fidelius E2E |

If you came here to understand **how** all of this works, head to the [Internals](/internals/architecture) section.
