# Persistence model

Every persistent piece of state the SDK and the Snap bundle care about lands in a single `DataStore`. From the consumer side it's one object passed into the `SnapcapClient` constructor; from the bundle side, it's `localStorage` / `sessionStorage` / `indexedDB` / `document.cookie` that happen to write to the same place. The whole design is a one-way translation: standard browser-storage APIs in, prefixed `DataStore` keys out.

This chapter is the key map and the reasoning behind it.

## What a DataStore is

```ts
// src/storage/data-store.ts:18-22
export interface DataStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
```

That's it. A keyed bytes blob. Three impls live in the SDK:

- `FileDataStore` — single JSON file, in-memory cache, eager flush on every write. Default.
- `MemoryDataStore` — in-memory only; useful for tests.
- BYO — anything that satisfies the three methods. Redis, KMS, IndexedDB-on-disk, encrypted file, whatever.

`FileDataStore` and `MemoryDataStore` also implement `getSync` / `setSync` / `keys(prefix)`. The Web Storage shim and the `document.cookie` shim need synchronous reads to satisfy their spec'd APIs; if a custom DataStore omits the sync helpers, those shims fall back to a hydrate-at-construction cache.

## The key map

Everything written under that DataStore goes through one of four prefixes. The keys actually used by the SDK + bundle today:

| Key | Source | What it is |
|---|---|---|
| `cookie_jar` | tough-cookie via `CookieJarStore` | full serialized jar — domain-scoped cookies for `accounts.snapchat.com`, `web.snapchat.com`, `*.snapchat.com` |
| `session_snapcap_bearer` | `sessionStorage` shim | current SSO bearer string |
| `local_snapcap_self` | `localStorage` shim | logged-in user's `{ userId, username, displayName }` JSON |
| `indexdb_snapcap__fidelius__identity` | IndexedDB shim | serialized Fidelius identity (P-256 keypair + RWK + identityKeyId, hex-encoded JSON) |

The Snap bundle's own writes to `localStorage` / `sessionStorage` / `indexedDB` land alongside, prefixed with `local_` / `session_` / `indexdb_` respectively. We don't enumerate them — the bundle owns those entries and the SDK leaves them alone (including across `client.logout()`).

## How the prefix routing works

Each shim is a thin adapter over a DataStore with a fixed prefix:

```ts
// src/storage/storage-shim.ts:73-82
setItem(key: string, value: string): void {
  const fullKey = this.prefix + key;
  const bytes = new TextEncoder().encode(value);
  if (this.isSync()) {
    (this.store as SyncCapable).setSync(fullKey, bytes);
  } else {
    this.fallbackCache.set(key, value);
    void this.store.set(fullKey, bytes);
  }
}
```

`StorageShim` is constructed twice, once per Web Storage object — `new StorageShim(dataStore, "local_")` for `localStorage`, `new StorageShim(dataStore, "session_")` for `sessionStorage` (`src/shims/sandbox.ts:130-131`). They share the DataStore but never collide.

`IDBFactoryShim` uses a structured key. An open call like `indexedDB.open("snapcap", 1)` followed by `db.transaction("fidelius","readwrite").objectStore("fidelius").put(blob, "identity")` lands in the DataStore at:

```
indexdb_snapcap__fidelius__identity
```

— prefix + dbName + `__` + storeName + `__` + key. Two-underscore separators keep `_` inside any user-supplied key from colliding with the delimiter. See `src/shims/indexed-db.ts:32-38`.

`document.cookie` reads and writes route through tough-cookie's `getCookiesSync` / `setCookieSync` under one shared key (`cookie_jar`). See `src/shims/document-cookie.ts:33`.

## Why the cookie jar is one key, not many

tough-cookie maintains a domain-aware index internally. `jar.getCookiesSync("https://accounts.snapchat.com")` returns the cookies that match by domain, path, secure, and expiration; `jar.setCookieSync(parsed, url)` indexes by parsed `Domain`/`Path` and merges. Splitting that into multiple DataStore keys would mean re-implementing the indexing on top.

So: the entire jar serializes to JSON via `jar.serializeSync()` (`src/storage/cookie-store.ts:35-38`, `src/shims/document-cookie.ts:58`) and lands as one bytes blob under `cookie_jar`. tough-cookie does the matching at request time.

Two paths write to that key:

- `src/transport/cookies.ts` — outgoing fetches (login POSTs, gRPC calls, media uploads). The `CookieJarStore` deserializes at construction and persists on flush.
- `src/shims/document-cookie.ts` — bundle JS that reads or writes `document.cookie` from inside the sandbox. The shim maintains a live tough-cookie `CookieJar` alongside the DataStore so synchronous reads/writes don't have to round-trip async.

Both are pointed at the same key by default, so bundle-side cookie writes are visible to the next gRPC call and vice versa.

## Why the bearer is in sessionStorage, not in cookies

SSO bearer tokens are short-lived (Snap doesn't document the TTL but empirically it's hours, not days) and re-mintable. The durable bit is `__Host-sc-a-auth-session` — that cookie is what `accounts.snapchat.com/accounts/sso` checks before issuing a new ticket. Anything that has the cookie can mint a fresh bearer; anything that has a bearer without the cookie cannot.

So:

- The cookie jar (under `cookie_jar`) is the source of truth for "am I logged in".
- The bearer (under `session_snapcap_bearer`) is a per-process cache of the most recently minted ticket. On 401 it gets re-minted via `mintBearer` against the same jar; the new value overwrites the old.

Putting it in `sessionStorage` instead of `localStorage` is a deliberate framing: per-process cache, not per-account credential. (Both prefixes live in the same DataStore so the runtime distinction doesn't matter mechanically — it's an organizational choice that's easier to reason about.)

If you cold-boot a new process and the bearer is stale, the first authenticated call gets a 401, `transport/grpc-web.ts` calls `refreshBearer`, the SSO redirect issues a fresh ticket using the still-valid `__Host-sc-a-auth-session` cookie, and the call succeeds.

## Why Fidelius is in IndexedDB-shaped storage

The serialized Fidelius identity is a plain JSON blob today (P-256 keypair + RWK + identityKeyId, hex-encoded). Putting it in `localStorage` would have worked equally well from the SDK's perspective.

The reason it lives behind an IndexedDB shim:

- The chat-bundle Fidelius WASM uses IndexedDB internally (the C++ side has Embind classes named `KeyPersistentStorageDelegate` whose JS-side delegates are expected to satisfy IDB-shaped semantics around binary blobs and async transactions).
- Eventually, the bundle's own IDB writes for WASM-internal state — RWK-wrapped per-conversation keys, session ratchets, etc. — should land in our shim too, so the same DataStore holds *all* Fidelius state, not just the SDK's serialized identity.
- The persist callback shape that Embind exposes is async-callback-shaped, which IDBRequest's `onsuccess`/`onerror` pattern matches naturally — closer than `Storage`'s synchronous interface.

So today, only the SDK's identity blob sits at `indexdb_snapcap__fidelius__identity` (`src/client.ts:70-72`, written via `idbPut` / read via `idbGet`). When the WASM's own persistence wires in, those writes will land in the same DataStore at sibling `indexdb_*` keys without any consumer-visible change.

## What `client.logout()` clears

```ts
// src/client.ts:212-224 (paraphrased)
async logout(): Promise<void> {
  await this.dataStore.delete("cookie_jar");
  ss?.removeItem("snapcap_bearer");                              // → session_snapcap_bearer
  ls?.removeItem("snapcap_self");                                // → local_snapcap_self
  await idbDelete("snapcap", "fidelius", "identity");            // → indexdb_snapcap__fidelius__identity
  // … reset in-memory fields
}
```

Four explicit deletes, one per SDK-owned key. Bundle-owned `local_*` / `session_*` / `indexdb_*` entries are deliberately left intact: wiping them would force the next `isAuthorized()` to re-bootstrap Fidelius WASM state from scratch, which costs ~250ms WASM init plus a re-register round-trip.

If a consumer wants a true wipe, they can either drop the underlying DataStore (delete the file, drop the Redis namespace) or iterate `keys()` and delete by prefix.

## Plug-in points

Three places worth noting if you want to swap persistence:

- **The DataStore itself.** Implement `get` / `set` / `delete` (and optionally `getSync` / `setSync` / `keys` for sync paths). Pass the instance into `new SnapcapClient({ dataStore, … })`. Done.
- **Encryption.** A wrapper DataStore that AES-GCMs values on the way in and decrypts on the way out is the cleanest place to add at-rest encryption. The SDK never inspects raw bytes — it round-trips through the DataStore as opaque blobs.
- **Sharing.** Two `SnapcapClient` instances pointed at the same DataStore are the same logical session. Two pointed at different DataStores are two separate accounts. Multi-tenant runners (the `SnapAutomate` workspace's pattern) use one DataStore per account.
