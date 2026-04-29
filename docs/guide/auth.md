# The auth model

`SnapcapClient` follows the same pattern a browser would: a long-lived cookie jar plus a short-lived bearer (JWT). Both auto-restore from the DataStore on every process boot. You almost never have to think about either.

## What gets persisted

| Key in DataStore | Purpose | Lifetime |
|---|---|---|
| `cookie_jar` | tough-cookie serialised — `__Host-sc-a-auth-session` (refresh-style) plus parent-domain cookies (`sc-a-nonce`, `_scid`, `sc_at`) | Days–weeks until Snap revokes |
| `session_snapcap_bearer` | Last-minted SSO bearer (JWT) | ~1 hour, then refreshed transparently |
| `local_snapcap_self` | `{userId, username, displayName}` of the logged-in user | Stable until logout |
| `indexdb_snapcap__fidelius__identity` | Long-lived E2E keypair + RWK | Per-account; **cannot be regenerated** if lost |

The truly durable bit is `__Host-sc-a-auth-session`. As long as it's still server-side valid, the client can re-mint a fresh bearer from it — no credentials needed.

## isAuthorized()

The single gate every API call passes through. Decision flow:

1. **In-memory cache hit?** — If `isAuthorized()` already returned `true` this process, return `true` immediately. Skipped if `force: true`.
2. **Try restoring from the DataStore.** Read the cookie jar; check that `__Host-sc-a-auth-session` is present; read the cached bearer. If both exist, mark warm and return `true`.
3. **No restored state, but credentials supplied?** Run the full native login (kameleon → WebLoginService 2-step → SSO bearer mint → cookie seed → SyncFriendData self-resolve → Fidelius identity mint+register). Persist everything to the DataStore. Return `true`.
4. **Server rejected the credentials, or no credentials configured?** Return `false`. Does **not** throw — consumers that want to probe authorization state shouldn't have to wrap it in try/catch.

```ts
if (await client.isAuthorized()) {
  // safe to call any API method
} else {
  // creds were missing or rejected — show login UI, prompt for new password, etc.
}
```

## When to use force: true

```ts
await client.isAuthorized({ force: true });
```

Use this when:

- **Password rotation.** The old bearer + cookie still look valid client-side but won't be honoured by the server. Force a re-login to mint fresh ones.
- **You suspect server-side invalidation.** Snap's anti-fraud may revoke a session without surfacing a clear error code; a forced re-login is the cleanest reset.
- **Periodic health check.** Some operators force-login once a week as a hygiene step. Doesn't hurt as long as you don't do it on every request.

For routine warm starts, the unforced path is what you want — it's `O(milliseconds)` and never hits the network.

## Bearer refresh (transparent)

Bearers expire roughly hourly. You don't have to handle this:

- gRPC call goes out with the cached bearer.
- Server returns `HTTP 401`.
- The transport layer re-mints a bearer from the cookie jar (the `__Host-sc-a-auth-session` cookie is the credential), persists it back to `session_snapcap_bearer`, and retries the call **once**.
- If refresh succeeds, the original call returns success — caller never sees the 401.
- If refresh fails (cookie also dead), the original 401 surfaces and the caller can call `client.isAuthorized({ force: true })` to fall back to credentials.

## When the cookie dies

Cookies don't live forever. Symptoms: every gRPC call returns 401, refresh keeps failing. Remediation:

```ts
if (!(await client.isAuthorized({ force: true }))) {
  throw new Error("snap login rejected — password rotated, account locked, or captcha required");
}
```

If you instantiate the client without credentials, the only recovery path is to construct a new client with credentials.

## logout()

```ts
await client.logout();
```

Deletes the auth-state keys from the DataStore:

- `cookie_jar` — gone.
- `session_snapcap_bearer` — gone.
- `local_snapcap_self` — gone.
- `indexdb_snapcap__fidelius__identity` — **gone**, but think twice. Snap won't let the same user re-register a Fidelius identity, so wiping this means E2E (snaps, inbound message bodies) is unrecoverable for this account from this client.

The bundle's other sandbox-storage entries (`local_*`, `session_*`, `indexdb_*` keys we don't own) are **not** deleted. Wiping them would force the next login to re-bootstrap a bunch of WASM state from scratch with no benefit.

## Multi-account

Each account gets its own DataStore — kameleon and bundle code are shared. See [Persistence](/guide/persistence) for the full layout.
