# Getting started

`@snapcap/native` is a single TypeScript class. You give it a `DataStore` (and, on first run, credentials); it gives you methods.

## Install

```bash
pnpm add @snapcap/native
```

Requires **Bun 1.3+** or **Node 22+** — the bundle uses top-level `await`, the WASM imports lean on modern `fetch`, and the SDK relies on Node's `vm.Context` global-builtins behaviour that landed in those versions.

## First call

```ts
import { SnapcapClient, FileDataStore } from "@snapcap/native";

const client = new SnapcapClient({
  dataStore: new FileDataStore("./auth.json"),
  username: process.env.SNAP_USER,
  password: process.env.SNAP_PASS,
});

if (await client.isAuthorized()) {
  const friends = await client.listFriends();
  console.log(friends);
} else {
  console.error("login rejected");
}
```

That's the whole pattern. The constructor is synchronous and just wires up the sandbox + DataStore. The first network call is gated on `isAuthorized()`:

- **Cold start** (`auth.json` empty / missing): kameleon WASM boots, full WebLogin → SSO → cookie-seed flow runs, identity is persisted to the DataStore, then `listFriends()` runs. Wall-clock around **5 seconds**.
- **Warm start** (`auth.json` already has valid cookies): `isAuthorized()` rehydrates from disk and returns `true` synchronously-ish (≈ **1 ms**). `listFriends()` is whatever the gRPC round-trip costs (≈ 200 ms).

The username/password fields are only consulted when there's nothing valid in the DataStore. They are **not** persisted — pass them on every boot if you want to be able to recover from session expiry without manual intervention.

## Cold start vs warm start

Reuse the DataStore across processes (or across PMs, or across worker boots) to skip the kameleon boot + login flow:

```ts
// Process 1, fresh disk:
new SnapcapClient({ dataStore: new FileDataStore("./auth.json"), username, password });
await client.isAuthorized();   // ≈ 5 s — full login

// Process 2, same auth.json:
new SnapcapClient({ dataStore: new FileDataStore("./auth.json") });
await client.isAuthorized();   // ≈ 1 ms — restored from disk, no network
```

If the bearer in the DataStore has expired, the next gRPC call hits 401 and the client transparently mints a fresh bearer from the long-lived `__Host-sc-a-auth-session` cookie — no caller-side handling required.

## Force a fresh login

Pass `force: true` to bypass the warm-start cache and re-run the login flow even if the DataStore looks valid:

```ts
await client.isAuthorized({ force: true });
```

Useful for password rotations or for working around a server-side session invalidation you couldn't detect any other way.

## Logout

```ts
await client.logout();
```

Clears the auth-state keys (`cookie_jar`, `session_snapcap_bearer`, `local_snapcap_self`, `indexdb_snapcap__fidelius__identity`) from the DataStore. The bundle's other sandbox storage entries are left intact so the next login doesn't have to re-bootstrap WASM state from scratch.

## Multi-account

Each account gets its own DataStore — the kameleon module and bundle code are shared across `SnapcapClient` instances:

```ts
const accounts = users.map((u) =>
  new SnapcapClient({
    dataStore: new FileDataStore(`./auth/${u.username}.json`),
    username: u.username,
    password: u.password,
  }),
);

await Promise.all(accounts.map((c) => c.isAuthorized()));
const allFriends = await Promise.all(accounts.map((c) => c.listFriends()));
```

Memory cost per extra account is the cookie jar (~2 KB) + bearer (~300 chars) + a small client object. The 5 MB JS bundle and 814 KB WASM live in the kameleon singleton — paid once.

## What's next

- [Auth model](/guide/auth) — what `isAuthorized()` actually does, and when to use `force`.
- [Persistence](/guide/persistence) — the DataStore key layout and how to plug in your own backend.
- [API reference](/api/) — every public method, indexed.
- [Internals](/internals/architecture) — how the bundle, kameleon, and SSO dance work under the hood.
