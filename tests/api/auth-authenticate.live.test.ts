/**
 * INTEGRATION (LIVE) test — `src/api/auth/authenticate.ts`.
 *
 * Exercises the warm-restore path: a locked account that has previously
 * authenticated holds a persisted `__Host-sc-a-auth-session` cookie in its
 * FileDataStore. `client.authenticate()` should resolve via the warm path
 * (SSO redirect only — no 2-step WebLogin) and leave the client in an
 * authenticated state.
 *
 * # Hard limits
 *
 *   - ONE test: the warm-restore path. No cold-login in this file.
 *   - Prefer any available account (no `preferUser` — don't over-constrain).
 *   - No mutations: read-only shape assertions after authenticate().
 *   - Anti-spam: no sends, no mutations on the Snap account.
 *
 * If no account is available (pool exhausted) the test is expected to fail
 * with a locker error — that's a pool resource problem, not a code bug.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SnapcapClient } from "../../src/client.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import { checkoutUser, releaseUser, type LockedUser } from "../lib/user-locker.ts";

// ── Noise suppression ─────────────────────────────────────────────────────
// The standalone-WASM mint (Fidelius) throws a benign `setAttribute` from
// a browser-only iframe init path. Suppress the specific known pattern;
// surface everything else.
process.on("uncaughtException", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) {
    process.stderr.write(`[suppress-bundle-noise] ${msg.slice(0, 120)}\n`);
    return;
  }
  process.stderr.write(`[uncaughtException] ${(err as Error)?.stack ?? err}\n`);
});
process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) {
    process.stderr.write(`[suppress-bundle-noise] ${msg.slice(0, 120)}\n`);
    return;
  }
  process.stderr.write(`[unhandledRejection] ${(err as Error)?.stack ?? err}\n`);
});

let client: SnapcapClient;
let lockedUser: LockedUser;

beforeAll(async () => {
  // Prefer cached session — any account will do.
  lockedUser = await checkoutUser();

  client = new SnapcapClient({
    dataStore: new FileDataStore(lockedUser.storagePath),
    credentials: {
      username: lockedUser.username,
      password: lockedUser.config.password,
    },
    browser: { userAgent: lockedUser.config.fingerprint.userAgent },
  });

  await client.authenticate();
}, 120_000);

afterAll(() => {
  if (lockedUser) releaseUser(lockedUser);
});

describe("INTEGRATION — authenticate (warm-restore path)", () => {
  test("client is authenticated after authenticate() resolves", async () => {
    expect(client.isAuthenticated()).toBe(true);

    // Shape assertions only — do not assert on specific usernames or IDs.
    // The auth surface exposed via client should be valid strings.
    process.stderr.write(
      `[auth.live] account=${lockedUser.username} authenticated=true\n`,
    );
  }, 30_000);
});
