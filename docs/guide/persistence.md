# Persistence

`@snapcap/native` is structured around a single `DataStore` interface. The bundle's cookies, the SSO bearer, the Fidelius identity, **and** the bundle's own sandbox-internal `localStorage` / `sessionStorage` / `indexedDB` writes all live there. The shape mirrors a browser's persistence layout — you can think of the DataStore as "the disk a Chrome profile would write to."

## The DataStore interface

```ts
interface DataStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Three async methods. That's it. The SDK never assumes anything about the backend — file, memory, Redis, KMS, IndexedDB, S3, your custom envelope-encrypted thing. Implement these three and you're done.

For Web Storage shims (`localStorage` / `sessionStorage`) the SDK additionally consults synchronous helpers if present (`getSync`, `setSync`, `keys`). Without them, the shims fall back to a small in-memory cache populated at construction. `FileDataStore` and `MemoryDataStore` both implement the sync helpers; you can omit them for async-only backends.

## Built-in implementations

### FileDataStore

Single JSON file, in-memory cache, eager flush on every write. The default. Good for development, single-process operators, low-volume batch jobs.

```ts
import { FileDataStore } from "@snapcap/native";

const store = new FileDataStore("./auth/perdyjamie.json");
```

### MemoryDataStore

In-memory only. Useful for tests, ephemeral one-shot jobs, or scratch flows where you don't want to write disk. Resets each process — full cold-start login on every boot.

```ts
import { MemoryDataStore } from "@snapcap/native";

const store = new MemoryDataStore();
```

## Key layout

A populated DataStore looks like this (after one successful login):

| Key | Owner | Format | Role |
|---|---|---|---|
| `cookie_jar` | SDK | tough-cookie JSON | Durable session cookies — `__Host-sc-a-auth-session` is the refresh credential |
| `session_snapcap_bearer` | SDK | UTF-8 JWT | Most recent SSO bearer; ~1 h lifetime, auto-refreshed on 401 |
| `local_snapcap_self` | SDK | UTF-8 JSON `{userId, username, displayName}` | Restored self-user metadata so warm starts skip the SyncFriendData round-trip |
| `indexdb_snapcap__fidelius__identity` | SDK | JSON `FideliusIdentityBlob` | Long-lived E2E keypair + RWK |
| `local_*` (other) | Bundle | UTF-8 strings | Snap-bundle's own `localStorage` writes (analytics ids, feature flags, etc.) |
| `session_*` (other) | Bundle | UTF-8 strings | Snap-bundle's own `sessionStorage` writes |
| `indexdb_*` (other) | Bundle | JSON | Snap-bundle's own `indexedDB` writes |

The `local_` / `session_` / `indexdb_` prefixes come from the `StorageShim` and IDB shim, which namespace each Web Storage area onto a shared DataStore. The exact same DataStore can back all three areas — the prefixes keep them collision-free.

You should treat `cookie_jar`, `session_snapcap_bearer`, and `indexdb_snapcap__fidelius__identity` as **credential-grade**. Anyone with read access to those keys can call APIs as the user. The Fidelius blob is in addition the long-lived root of E2E encryption — if it's lost, Snap won't let the account register a fresh one.

## Plugging in your own backend

Implement the interface and pass the instance to `SnapcapClient`:

```ts
import type { DataStore } from "@snapcap/native";
import { Redis } from "ioredis";

class RedisDataStore implements DataStore {
  constructor(private redis: Redis, private prefix: string) {}
  async get(key: string) {
    const buf = await this.redis.getBuffer(`${this.prefix}:${key}`);
    return buf ? new Uint8Array(buf) : undefined;
  }
  async set(key: string, value: Uint8Array) {
    await this.redis.set(`${this.prefix}:${key}`, Buffer.from(value));
  }
  async delete(key: string) {
    await this.redis.del(`${this.prefix}:${key}`);
  }
}

const client = new SnapcapClient({
  dataStore: new RedisDataStore(redis, `snap:${userId}`),
  username,
  password,
});
```

Common backends people reach for:

- **Redis / KeyDB** — multi-process, low-latency, cheap to spin up.
- **Postgres `BYTEA`** — durable + transactional. One row per (account, key).
- **AWS KMS + S3** — for fleets where the auth blobs are credentials and need envelope encryption.
- **IndexedDB / OPFS** — if you're embedding the SDK in a Node-flavoured runtime that exposes browser storage (Bun + a custom adapter, or an Electron preload).

Any backend works as long as `set(k, v).then(() => get(k))` round-trips the bytes faithfully.

## Encryption at rest

For `FileDataStore` on a multi-tenant host, wrap the file. Trivial AES-256-GCM with a passphrase-derived key:

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { DataStore } from "@snapcap/native";

class EncryptedFileStore implements DataStore {
  private cache = new Map<string, Uint8Array>();
  constructor(private path: string, private key: Buffer) {
    if (existsSync(path)) this.cache = decrypt(readFileSync(path), key);
  }
  async get(k: string) { return this.cache.get(k); }
  async set(k: string, v: Uint8Array) {
    this.cache.set(k, new Uint8Array(v));
    writeFileSync(this.path, encrypt(this.cache, this.key));
  }
  async delete(k: string) {
    if (this.cache.delete(k)) writeFileSync(this.path, encrypt(this.cache, this.key));
  }
}
```

(Implement `encrypt` / `decrypt` against `aes-256-gcm` with a fresh IV per write.)

## Multi-account

Each account is its own DataStore. Easiest pattern is a directory of files:

```
auth-store/
  perdyjamie.json
  testaccount2.json
  testaccount3.json
```

Or one Redis/Postgres key prefix per account. The SDK doesn't care — there is no shared per-process state across DataStores beyond the kameleon WASM module (which is account-agnostic).

```ts
const clients = new Map<string, SnapcapClient>();
for (const u of users) {
  clients.set(u.id, new SnapcapClient({
    dataStore: new FileDataStore(`./auth-store/${u.id}.json`),
    username: u.snapUsername,
    password: u.snapPassword,
  }));
}
```

## Reading the DataStore directly

You can `await dataStore.get("cookie_jar")` from outside the SDK if you need to inspect or back up state. Just don't write to the SDK-owned keys — `client.logout()` and the auth flow are the supported mutation paths. For arbitrary IDB-shaped reads, see the [`idbGet` / `idbPut` / `idbDelete`](/api/storage#idb-helpers) helpers.
