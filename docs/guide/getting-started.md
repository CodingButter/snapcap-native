# Getting started

`@snapcap/native` is a single TypeScript class. You give it credentials (or a saved auth blob), it gives you methods.

## Install

```bash
pnpm add @snapcap/native
```

Requires Bun 1.3+ or Node 22+ (the bundle uses top-level `await` and the WASM imports lean on modern fetch).

## First call

```ts
import { SnapcapClient } from "@snapcap/native";

const client = await SnapcapClient.fromCredentials({
  credentials: {
    username: "your_username",
    password: "your_password",
  },
});

const friends = await client.listFriends();
console.log(friends);
```

The first call takes about 4 seconds. Most of that is the kameleon WASM Module booting; the actual login round-trip is sub-second.

## Persist the session

Logging in every process start is wasteful. Save the auth blob:

```ts
import { writeFileSync, readFileSync } from "node:fs";

// Once:
const client = await SnapcapClient.fromCredentials({ credentials });
writeFileSync("auth.json", JSON.stringify(await client.toAuthBlob()));

// Every other time:
const blob = JSON.parse(readFileSync("auth.json", "utf8"));
const client = await SnapcapClient.fromAuth({ auth: blob });
```

`fromAuth` is instant. The blob is about 2 KB.

The bearer in the blob is short-lived, but the cookie jar holds a long-lived `__Host-sc-a-auth-session` cookie. When a call returns 401, the client transparently re-mints a fresh bearer from the cookie and retries — you never see the rotation.

## Multi-account

Multiple `SnapcapClient` instances share the same kameleon Module under the hood, so multi-account is cheap:

```ts
const accounts = await Promise.all(
  credentialsList.map((credentials) =>
    SnapcapClient.fromCredentials({ credentials }),
  ),
);

const allFriends = await Promise.all(accounts.map((c) => c.listFriends()));
```

Memory cost per extra account is roughly the size of the cookie jar (~2 KB) plus the bearer string (~300 chars).

## What's next

Head to the [Internals](/internals/architecture) section for the full story of how the bundle is loaded, how kameleon is run in Node, and how the SSO bearer dance actually works. If you just want to use the SDK, the API surface lives in [the auth guide](/guide/auth) and the method-level docs.
