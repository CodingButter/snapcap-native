# @snapcap/native

> A browser-free Snapchat client. Native Node bridge to `web.snapchat.com` — no Playwright, no Frida, no rooted phone.

[![npm](https://img.shields.io/npm/v/@snapcap/native.svg)](https://www.npmjs.com/package/@snapcap/native)
[![docs](https://img.shields.io/badge/docs-codingbutter.github.io-blue)](https://codingbutter.github.io/snapcap-native)
[![license](https://img.shields.io/npm/l/@snapcap/native.svg)](./LICENSE)

## What it is

`@snapcap/native` loads Snap's web JavaScript bundle and 814 KB of WASM directly in Node, with [happy-dom](https://github.com/capricorn86/happy-dom) shimming the Chrome APIs the bundle expects. The result: an idiomatic TypeScript class with methods like `listFriends()`, `sendTextMessage()`, and `postStory()` — running anywhere Node runs, with zero browser at runtime.

## Install

```bash
pnpm add @snapcap/native
# or: npm install @snapcap/native
```

Requires Bun ≥ 1.3 or Node ≥ 22.

## Usage

```ts
import { SnapcapClient } from "@snapcap/native";

const client = await SnapcapClient.fromCredentials({
  credentials: { username: "...", password: "..." },
});

const friends = await client.listFriends();

// Persist the session — login is the slow part (~4s); reload is instant.
import { writeFileSync, readFileSync } from "node:fs";
writeFileSync("auth.json", JSON.stringify(await client.toAuthBlob()));

// Later, in any process:
const blob = JSON.parse(readFileSync("auth.json", "utf8"));
const client = await SnapcapClient.fromAuth({ auth: blob });
```

## Status

| Capability | Status |
|---|---|
| Native login (username + password → cookie + bearer) | ✅ Working |
| `listFriends()` via AtlasGw | ✅ Working |
| `searchUsers()`, `addFriend()`, `sendTextMessage()` | 🚧 Next |
| `sendMediaMessage()`, `postStory()` | 🚧 Planned |
| Receive message *content* (Fidelius E2E gate) | ❌ Blocked |

## Documentation

The full guide and the "how it works" deep-dives live at **[codingbutter.github.io/snapcap-native](https://codingbutter.github.io/snapcap-native)**:

- [Getting started](https://codingbutter.github.io/snapcap-native/guide/getting-started)
- [Auth model](https://codingbutter.github.io/snapcap-native/guide/auth)
- [Architecture](https://codingbutter.github.io/snapcap-native/internals/architecture)
- [The kameleon trick](https://codingbutter.github.io/snapcap-native/internals/kameleon)
- [Webpack runtime patch](https://codingbutter.github.io/snapcap-native/internals/webpack-trick)
- [SSO bearer flow](https://codingbutter.github.io/snapcap-native/internals/sso-flow)

## Development

```bash
git clone https://github.com/codingbutter/snapcap-native.git
cd snapcap-native
pnpm install

# Fetch the Snap bundle (~5 MB JS + 814 KB WASM into vendor/)
pnpm download:bundle

# Run the smoke test against a real account
SNAP_STATE_FILE=./.snapcap-smoke.json bun run scripts/smoke.ts
```

`.snapcap-smoke.json` is a local file with `{ username, password }` for testing — never commit it.

## License

[MIT](./LICENSE)
