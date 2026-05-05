/**
 * INTEGRATION reference test — `Friends.snapshot()` against a locked Snap
 * account.
 *
 * Demonstrates the Phase-5 INTEGRATION pattern:
 *   - acquire a real Snap account via `withLockedUser`
 *   - construct a real `SnapcapClient` with `FileDataStore` pointed at the
 *     account's persisted storage
 *   - run a real `client.authenticate()` (warm-restore from cached session
 *     when the account has one; cold login otherwise)
 *   - exercise the public surface (`client.friends.snapshot()`)
 *   - assert on the returned shape (NOT on specific friend identities,
 *     which would be brittle across account re-provisioning)
 *
 * # Why a snapshot test (and not, say, sendText)
 *
 * `friends.snapshot()` is read-only and idempotent. No anti-spam risk, no
 * write-back to the account, no rate-limit consumption. Auth itself is
 * the same path used by every other LIVE test, so this is the cheapest
 * real check that the wiring works end-to-end.
 *
 * The `messaging-myai.test.ts` template is the model for tests that
 * actually need to send/receive — copy that pattern (5s throttle floor,
 * hard cap on sends per run, account preference + fallthrough). This file
 * is the more common pattern: "spin up a real client, read state, assert
 * shape".
 *
 * # Hard limits
 *
 *   - Locks ONE account at a time (atomic mkdir lock).
 *   - No sends, no mutations.
 *   - Single 60s outer timeout (cold-fresh login can take ~30s, warm
 *     restore ~5s).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SnapcapClient } from "../../src/client.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import { checkoutUser, releaseUser, type LockedUser } from "../lib/user-locker.ts";

// ── Noise suppression ────────────────────────────────────────────────────
// Same shape as messaging-myai.test.ts. The standalone-WASM mint throws a
// benign `setAttribute` from a browser-only iframe init path; the mint
// catches it but the throw still surfaces as an unhandled error on Bun's
// loop. Swallow ONLY this specific bundle-internal noise.
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
  // Lock ANY available account (no preference). The locker auto-falls
  // through if the preferred account is busy.
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
  if (!client.isAuthenticated()) {
    throw new Error(
      `beforeAll: authenticate() resolved but isAuthenticated()=false for ${lockedUser.username}`,
    );
  }
}, 120_000);

afterAll(() => {
  if (lockedUser) releaseUser(lockedUser);
});

describe("INTEGRATION — Friends.snapshot", () => {
  test("returns a structurally-valid FriendsSnapshot for an authenticated client", async () => {
    const snap = await client.friends.snapshot();

    // Shape assertions only — never assert on specific friend identities,
    // since accounts are re-provisioned and friend graphs change. The
    // bridge contract is "three arrays present and well-typed".
    expect(snap).toBeDefined();
    expect(Array.isArray(snap.mutuals)).toBe(true);
    expect(Array.isArray(snap.received)).toBe(true);
    expect(Array.isArray(snap.sent)).toBe(true);

    // Every mutual must have a non-empty userId. Username may be empty
    // if `publicUsers` cache hadn't been populated when `syncFriends`
    // returned — that's a known transient and not a test failure.
    for (const f of snap.mutuals) {
      expect(typeof f.userId).toBe("string");
      expect(f.userId.length).toBeGreaterThan(0);
      expect(f.friendType).toBe("mutual");
    }

    // Same shape rules for sent/received.
    for (const r of snap.received) {
      expect(typeof r.fromUserId).toBe("string");
      expect(r.fromUserId.length).toBeGreaterThan(0);
    }
    for (const s of snap.sent) {
      expect(typeof s.toUserId).toBe("string");
      expect(s.toUserId.length).toBeGreaterThan(0);
    }

    process.stderr.write(
      `[friends.snapshot] account=${lockedUser.username} mutuals=${snap.mutuals.length} ` +
      `received=${snap.received.length} sent=${snap.sent.length}\n`,
    );
  }, 60_000);
});
