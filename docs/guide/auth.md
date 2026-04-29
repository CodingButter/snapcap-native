# The auth model

`SnapcapClient` has two ways in.

## fromCredentials

Username + password. The full native login flow runs:

1. Boot kameleon (cached process-wide; ~2s the first time, 0ms thereafter)
2. Generate attestation token
3. POST WebLogin with username + attestation
4. POST WebLogin with password + sessionPayload
5. GET /accounts/sso → bearer ticket
6. GET www.snapchat.com/web → parent-domain cookies

Total wall-clock: about 4 seconds the first time, 1.5 seconds for subsequent calls in the same process (kameleon is cached).

```ts
const client = await SnapcapClient.fromCredentials({
  credentials: { username, password },
  userAgent: "Mozilla/5.0 …",  // optional; falls back to Linux Chrome 147
});
```

## fromAuth

Pick up a saved session. Instant.

```ts
const blob = JSON.parse(readFileSync("auth.json", "utf8"));
const client = await SnapcapClient.fromAuth({ auth: blob });
```

The blob is what `client.toAuthBlob()` returns: a serialized cookie jar plus the most recent bearer plus the user-agent. About 2 KB on disk.

The bearer in the blob may be expired. That's fine — the first API call that returns 401 triggers a transparent refresh against the long-lived `__Host-sc-a-auth-session` cookie in the jar. The retry happens once, transparently, before the result returns.

## When refresh fails

Refresh works as long as `__Host-sc-a-auth-session` is still server-side valid. If the cookie is dead (server-side expiration, account got logged out elsewhere, password rotated), refresh returns `null` and the original 401 surfaces:

```ts
try {
  await client.listFriends();
} catch (e) {
  if (e.message.includes("HTTP 401")) {
    // re-login from credentials
    client = await SnapcapClient.fromCredentials({ credentials });
  }
}
```

A nicer pattern: keep credentials around, wrap the SDK in a thin retry-on-401 shim that re-logins. The full `fromCredentials → fromAuth(blob)` pipeline can fall back to `fromCredentials` automatically.

## Multi-account

Multiple clients in the same process share the kameleon Module. Each has its own cookie jar, bearer, and user agent.

```ts
const a = await SnapcapClient.fromCredentials({ credentials: c1 });
const b = await SnapcapClient.fromCredentials({ credentials: c2 });
const c = await SnapcapClient.fromCredentials({ credentials: c3 });

// All three calls run concurrently against three separate sessions.
const [fa, fb, fc] = await Promise.all([a.listFriends(), b.listFriends(), c.listFriends()]);
```

Memory cost per extra account: cookie jar (~2 KB) + bearer string (~300 chars) + a small SnapcapClient object. The 5 MB bundle and 814 KB WASM live in the kameleon singleton — paid once.

## Why not just put the bearer in the blob and skip refresh

You can. Bearers are typically valid for an hour. But:

- A blob saved 24 hours ago will have a stale bearer. The 401-then-refresh path handles this for free.
- Bearers don't survive Snap-side session invalidation (account rotation, suspicious-activity log-out). The refresh path also handles those — gracefully transitions through a 401 to a fresh bearer or a clean error.

In short: the blob persists the *credential chain* (cookie jar > bearer); the SDK transparently re-derives the bearer when needed. You don't have to think about it.
