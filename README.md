# @snapcap/native

> Unofficial TypeScript SDK for Snapchat Web. Runs Snap's own JavaScript bundle and WASM modules inside an isolated Node `vm.Context` — no Playwright, no Puppeteer, no Selenium, no Frida, no emulator, no rooted phone.

[![npm](https://img.shields.io/npm/v/@snapcap/native.svg)](https://www.npmjs.com/package/@snapcap/native)
[![docs](https://img.shields.io/badge/docs-codingbutter.github.io-blue)](https://codingbutter.github.io/snapcap-native)
[![license](https://img.shields.io/npm/l/@snapcap/native.svg)](./LICENSE)

`@snapcap/native` is a browser-free Snapchat client for Node. It rehosts Snap's web bundle (the same JS Chromium downloads when you visit `web.snapchat.com`) and Snap's own WebAssembly modules — kameleon attestation, the chat session, Fidelius E2E — inside an isolated Node `vm.Context`. happy-dom shims the Chrome APIs the bundle expects; native `fetch` carries gRPC-Web outbound. The result is a typed TypeScript SDK with per-domain managers (`client.friends`, `client.messaging`, …) that runs anywhere Node runs.

Multiple accounts run in one process — each `SnapcapClient` owns its own sandbox at the V8 realm boundary. Persistence is pluggable through a small `DataStore` interface (file, memory, or your own Redis / Postgres / KMS-wrapped backend).

> **Status:** unofficial research / developer tooling. Not affiliated with Snap Inc. See [Safety & risk](#safety--risk) before pointing this at production accounts.

## Install

```bash
pnpm add @snapcap/native
# or: npm install @snapcap/native
```

Requires **Node ≥ 22** or **Bun ≥ 1.3** (for `vm.Context` global-builtins behaviour and the bundle's top-level `await`).

## Quickstart

```ts
import { SnapcapClient, FileDataStore } from "@snapcap/native";

const client = new SnapcapClient({
  dataStore: new FileDataStore("./auth.json"),
  credentials: {
    username: process.env.SNAP_USER!,
    password: process.env.SNAP_PASS!,
  },
  browser: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  },
});

await client.authenticate();                  // cold ~5s, warm ~100ms
const friends = await client.friends.list();
console.log(`${friends.length} mutuals`);

// Live decrypted inbound DMs (lazily brings up the bundle session).
const sub = client.messaging.on("message", (msg) => {
  console.log(msg.isSender ? "->" : "<-", new TextDecoder().decode(msg.content));
});

// Send a text DM through Snap's own bundle send path.
await client.messaging.sendText(conversationId, "hello from snapcap");

// Tear down the subscription when done.
sub();
```

`FileDataStore` keeps cookies + bundle storage on disk; swap in `MemoryDataStore` for ephemeral tests, or implement the [`DataStore`](https://codingbutter.github.io/snapcap-native/docs/api/interfaces/DataStore) interface for Redis / Postgres / KMS-wrapped persistence. See the [Quickstart guide](https://codingbutter.github.io/snapcap-native/docs/guide/getting-started) for the full bring-up.

## Why this is different

Most Snapchat automation projects fall into one of these buckets. `@snapcap/native` deliberately doesn't.

| Approach | Cost / shape | Trade-offs |
|---|---|---|
| **Playwright / Puppeteer / Selenium** | Full Chromium per account; minutes-per-tenant cold start; high RAM/CPU; visible to fingerprinting | Heavy, slow, easier to detect, fragile to UI changes |
| **Frida / rooted Android / iOS** | Native Snap binary + instrumentation | Snap's mobile risk engine is aggressive — repeatedly tried, repeatedly bricked; not durable |
| **Old "private API" wrappers** | Hand-rolled protobuf calls; reverse-engineered endpoints | Break on every Snap rebuild; no E2E support; usually abandoned |
| **Snap Kit / Login Kit** | Official, sanctioned | Too narrow — no friend graph, no message send, no story posting; not the same surface |
| **Userscripts / browser extensions** | Sit inside one already-open Chrome tab | Single-account, single-tab, no headless, no multi-tenant |

`@snapcap/native` runs Snap's actual web JavaScript and Snap's actual WASM — including the kameleon attestation primitive, the chat session, and the Fidelius E2E layer — inside an isolated Node `vm.Context`. We don't reimplement Snap's protocols; we drive Snap's own implementations. When Snap re-minifies their bundle, the shapes shift but the behaviour is the same — there's a re-mapping pass, not a rewrite.

Per-instance isolation is a first-class property: every `SnapcapClient` constructs a fresh `vm.Context`, a fresh happy-dom Window, and a fresh shimmed I/O layer. Two clients in the same process never share Zustand state, bearer tokens, or webpack runtime caches. Multi-tenant is the supported pattern, not an afterthought.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  SnapcapClient   (public TypeScript SDK — friends, messaging, ...)  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┴──────────────────────────┐
        │                                                    │
┌───────▼────────────────────────────┐      ┌────────────────▼──────────┐
│  Sandbox (per-instance vm.Context) │      │  Native transport layer   │
│   ─ happy-dom Window projection    │      │   ─ Node fetch + cookie   │
│   ─ Patched webpack runtime        │      │     jar (tough-cookie)    │
│   ─ Snap's chat + accounts JS      │      │   ─ TypedEventBus         │
│   ─ Snap's WASM modules            │      │   ─ Throttle gates        │
│       · kameleon attestation       │      │   ─ Structured logging    │
│       · Fidelius E2E (~12 MB)      │      │                           │
│       · chat-session worker        │      │  Bypasses the sandbox.    │
│   ─ Browser API shims:             │      │  Outbound traffic is      │
│       fetch / XHR / WebSocket /    │      │  observable from the host │
│       localStorage / sessionStorage│      │  realm.                   │
│       / IndexedDB / cookies        │      └────────────────┬──────────┘
│   ─ DataStore-backed persistence   │                       │
└────────────────────────────────────┘                       │
                                                             ▼
                                          gRPC-Web → web.snapchat.com
                                                     accounts.snapchat.com
                                                     aws.duplex.snapchat.com
                                                     cf-st.sc-cdn.net (media)
```

Each layer:

- **`SnapcapClient`** — public typed SDK. Per-domain managers (`friends`, `messaging`, `presence`, `stories`, `media`) compose flat verbs from the bundle registry.
- **Per-instance Sandbox** — fresh `vm.Context` per `SnapcapClient`. happy-dom's `Window` properties are projected onto the realm's global; Snap's webpack runtime is source-patched to leak `__webpack_require__` so we can address modules by id. Snap's JS + WASM run unmodified inside.
- **Browser API shims** — `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `IndexedDB`, and `document.cookie` are shimmed at every I/O boundary so the bundle's own cookie / storage / network code routes through the SDK's persistence and observability layers.
- **DataStore** — stable-keyed key/value store. `FileDataStore` and `MemoryDataStore` ship; consumers plug in any backend that matches the small interface (Redis, Postgres, encrypted at rest, …).
- **Native transport** — outbound gRPC-Web doesn't go through the sandbox. Node's `fetch` + a tough-cookie-backed jar carries the bundle's traffic, with optional throttling and structured logging.

For the long-form architecture story see [docs → Architecture overview](https://codingbutter.github.io/snapcap-native/docs/architecture) and the [Internals chapters](https://codingbutter.github.io/snapcap-native/docs/internals/architecture).

## Capability matrix

| Capability | Status | API / module | Notes |
|---|---|---|---|
| Construct `SnapcapClient`, `authenticate()`, `logout()`, `refreshAuthToken()` | Working | `SnapcapClient` | Cold ~5s; warm ~100ms; idempotent |
| Friends — `list` / `search` / `getUsers` / `snapshot` / `refresh` | Working | `client.friends` | AtlasGw + bundle-driven |
| Friends — `sendRequest` / `acceptRequest` / `rejectRequest` / `block` / `unblock` | Working | `client.friends` | |
| Friends events — `friend:added` / `friend:removed` / `request:*` / `change` | Working | `client.friends.on(...)` | Offline replay supported |
| Messaging — `listConversations()`, `fetchEncryptedMessages()` | Working | `client.messaging` | Direct gRPC-Web, no decrypt |
| Messaging — `on("message", cb)` live decrypted inbound | Working | `client.messaging` | History pump on first subscribe; live push partial |
| Messaging — `sendText(convId, text)` outbound text DM | Working | `client.messaging.sendText` | Routes through Snap's own send pipeline |
| Messaging — `sendImage(...)` / `sendSnap(...)` | Experimental | `client.messaging` | Compiles + brings up session; not wire-tested |
| Stories — `client.stories.post(media)` | Experimental | `client.stories` | Scaffolded via bundle send path; not wire-tested |
| Messaging — `setTyping` / `setViewing` | Planned | `client.messaging` | Resolves after duration; outbound WS frame not yet wired |
| Messaging — `on("typing" / "viewing" / "read", cb)` | Planned | `client.messaging.on(...)` | Subscribable; bundle delegate slots not yet mapped |
| Fidelius identity mint + register | Working | internal — `auth/fidelius-mint.ts` | Per-instance, isolated |
| Persistent duplex WebSocket (kept open for inbound) | Partial | internal — `transport/duplex.ts` | Frames received; full hook reception inconsistent |
| Per-instance isolation (multi-account in one process) | Working | `SnapcapClient` | Verified by `scripts/test-isolation.ts` |
| `DataStore` persistence (`FileDataStore`, `MemoryDataStore`, custom) | Working | `DataStore` | Cookies + bundle storage routed through it |
| Per-instance proxy / outbound IP rotation | Planned | TODO — `BrowserContext.httpAgent` reserved | undici Dispatcher pluggable |
| Throttling — per-instance + shared gates | Working | `createSharedThrottle`, `RECOMMENDED_THROTTLE_RULES` | Multi-tenant aggregate-rate control |
| Network observability — per-request logger | Working | `setLogger`, `defaultTextLogger`, `SNAP_NETLOG=1` | Bodies never logged; only sizes |

## Safety & risk

`@snapcap/native` is **unofficial** and **not affiliated with Snap Inc.** It is research and developer tooling, surfaced for people who need a programmatic interface to their own Snap accounts.

- **ToS.** Automating Snapchat may violate Snapchat's Terms of Service. You are responsible for compliance.
- **Account risk.** Accounts driven by automation can be **rate-limited, locked, or banned**. Snap's anti-fraud signals are opaque and can shift. Use throwaway or test accounts when possible; assume anything you build can lose access without warning.
- **Fingerprint hygiene.** `BrowserContext.userAgent` is required and must be varied per tenant in multi-tenant deployments. Identical UAs across many accounts is itself a fingerprint. See [Multi-tenant](https://codingbutter.github.io/snapcap-native/docs/guide/multi-tenant).
- **Throttling.** The default is no throttle. Production deployments should opt into `RECOMMENDED_THROTTLE_RULES` and a shared gate for N > 1.

This project must not be used for:

- Spam, mass-DM, mass-friend-add, or unsolicited outreach.
- Harassment, doxxing, or targeting individuals.
- Scraping at scale, account takeover, or credential theft.
- Ban evasion, impersonation, or automation against accounts the operator does not own or have explicit consent to operate.

If you use this for any of the above, you are on your own. The maintainers will not help you, and bug reports tied to abuse will be closed without comment.

## Documentation

The full guide and the implementation deep-dives live at **[codingbutter.github.io/snapcap-native](https://codingbutter.github.io/snapcap-native)**:

- [Getting started](https://codingbutter.github.io/snapcap-native/docs/guide/getting-started)
- [Architecture overview](https://codingbutter.github.io/snapcap-native/docs/architecture)
- [Safety & risk](https://codingbutter.github.io/snapcap-native/docs/safety)
- [Auth model](https://codingbutter.github.io/snapcap-native/docs/guide/auth)
- [Friends](https://codingbutter.github.io/snapcap-native/docs/guide/friends)
- [Messaging](https://codingbutter.github.io/snapcap-native/docs/guide/messaging)
- [Multi-tenant](https://codingbutter.github.io/snapcap-native/docs/guide/multi-tenant)
- [Throttling](https://codingbutter.github.io/snapcap-native/docs/guide/throttle)
- [Internals — sandbox, kameleon, SSO, Fidelius, bundle session](https://codingbutter.github.io/snapcap-native/docs/internals/architecture)
- [API reference](https://codingbutter.github.io/snapcap-native/docs/api)

## Development

```bash
git clone https://github.com/codingbutter/snapcap-native.git
cd snapcap-native
pnpm install

# Fetch Snap's JS bundle + WASM into vendor/ (gitignored).
pnpm download:bundle

# Run the smoke test against a real account.
SNAP_STATE_FILE=./.snapcap-smoke.json bun run scripts/smoke.ts
```

`.snapcap-smoke.json` is a local file containing `{ "username": "...", "password": "..." }` — local-only, never commit. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide, including the bundle-remap story and how the API surface evolves.

## Keywords

Snapchat Web SDK · Node Snapchat client · TypeScript Snapchat SDK · browser-free Snapchat automation · unofficial Snapchat client · Snapchat Web API client · Snapchat WASM · gRPC-Web Snapchat · multi-account Snapchat Node

## License

[MIT](./LICENSE)
