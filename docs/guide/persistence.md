# Persistence

Logging in is the slow part. Once you have a `SnapcapClient`, save the session and reuse it.

## The blob

`client.toAuthBlob()` returns a serializable object:

```ts
type SnapcapAuthBlob = {
  jar: object;       // tough-cookie jar.serialize() output
  bearer: string;    // most recent bearer (may be expired; refresh handles it)
  userAgent: string; // UA used at login — keep consistent for fingerprint stability
};
```

Round-trip:

```ts
import { writeFileSync, readFileSync } from "node:fs";

const client = await SnapcapClient.fromCredentials({ credentials });
writeFileSync("auth.json", JSON.stringify(await client.toAuthBlob()));

// Later:
const blob = JSON.parse(readFileSync("auth.json", "utf8"));
const client = await SnapcapClient.fromAuth({ auth: blob });
```

About 2 KB on disk per account.

## Storing it safely

The blob is a credential. Treat it like one:

- **Don't commit it to git.** Add the path to `.gitignore`.
- **Don't log it.** It's a long-lived auth artifact; anyone with it can call APIs as the user.
- **Encrypt at rest** if persisting on a multi-tenant host. Node's built-in `crypto` module is enough — AES-256-GCM with a key derived from a passphrase (`scrypt` / `argon2id`) is plenty.

A reasonable pattern:

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const key = scryptSync(passphrase, "snapcap-auth-blob", 32);

function encrypt(blob: SnapcapAuthBlob): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(blob), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}
```

## Refresh strategy

The bearer in the blob expires. The cookie does not (until Snap invalidates it server-side). When you reload from a saved blob and immediately make a call:

- Bearer still valid → call succeeds first try
- Bearer expired → call returns 401, SDK transparently mints a fresh bearer from the cookie, retries the call once, returns success

You don't have to do anything. The refresh logic is internal.

To re-save the updated bearer after a refresh, just call `toAuthBlob()` again:

```ts
const friends = await client.listFriends();  // may have triggered a refresh
writeFileSync("auth.json", JSON.stringify(await client.toAuthBlob()));
```

If you don't re-save, the next `fromAuth` will load the old expired bearer, hit 401, refresh again, and succeed. Slightly slower (one extra round-trip) but functionally identical.

## When the cookie dies

Cookies don't live forever. When `__Host-sc-a-auth-session` is server-side invalid, the refresh attempt fails and the 401 surfaces to your code. At that point, the only remediation is re-running `fromCredentials`.

```ts
async function authenticated(blobPath: string, credentials: LoginCredentials): Promise<SnapcapClient> {
  const blob = readBlob(blobPath);
  if (blob) {
    try {
      const client = await SnapcapClient.fromAuth({ auth: blob });
      await client.listFriends();  // probe — fail-fast if cookie is dead
      return client;
    } catch {
      // fall through to fresh login
    }
  }
  const client = await SnapcapClient.fromCredentials({ credentials });
  writeBlob(blobPath, await client.toAuthBlob());
  return client;
}
```

## Multi-account persistence

Each account is its own blob. Easy to manage as a directory of files:

```
auth-store/
  perdyjamie.json
  testaccount2.json
  testaccount3.json
```

Or as rows in a DB:

```sql
CREATE TABLE snap_sessions (
  username TEXT PRIMARY KEY,
  blob     BLOB NOT NULL,    -- encrypted JSON
  updated  TIMESTAMP NOT NULL
);
```

Either way, the principle is the same: one blob per account, refresh on demand, fall back to credentials if the cookie dies.
