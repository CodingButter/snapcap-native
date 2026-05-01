/**
 * Phase 1A spec — `client.friends` (Friends manager).
 *
 * These tests describe the contract `IFriendsManager` MUST satisfy. They
 * are intentionally FAILING in Phase 1A because every method on the
 * `Friends` class throws "not yet implemented". Phase 1B is when bodies
 * land and tests start passing.
 *
 * Auth bring-up (`beforeAll`) MUST work — this exercises the rest of the
 * SDK, which Phase 1A explicitly did not touch. If `beforeAll` fails the
 * test report is meaningless.
 *
 * Account: jamie_qtsmith (the "accepted" account in `.snapcap-smoke.json`).
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient } from "../../src/client.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import { RECOMMENDED_THROTTLE_RULES } from "../../src/index.ts";

const SDK_ROOT = join(import.meta.dir, "..", "..");
const SMOKE_PATH = join(SDK_ROOT, ".snapcap-smoke.json");

type SmokeCreds = {
  username: string;
  password: string;
  authPath?: string;
  fingerprint?: { userAgent?: string };
};

let client: SnapcapClient;

beforeAll(async () => {
  const creds = JSON.parse(readFileSync(SMOKE_PATH, "utf8")) as SmokeCreds;
  const authPath = creds.authPath ?? join(".tmp", "auth", "jamie_qtsmith.json");
  const dataStore = new FileDataStore(join(SDK_ROOT, authPath));
  client = new SnapcapClient({
    dataStore,
    username: creds.username,
    password: creds.password,
    userAgent: creds.fingerprint?.userAgent,
    throttle: { rules: RECOMMENDED_THROTTLE_RULES },
  });
  await client.authenticate();
  if (!client.isAuthenticated()) {
    throw new Error("beforeAll: authenticate() resolved but isAuthenticated()=false");
  }
}, 60_000);

// ─── Mutations ────────────────────────────────────────────────────────────

describe("client.friends.add", () => {
  test("resolves void on success with valid uuid", async () => {
    // jamie_nichols UUID — captured from previous traffic.
    await expect(client.friends.add("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });

  test("throws on invalid uuid", async () => {
    await expect(client.friends.add("not-a-uuid")).rejects.toThrow();
  });

  test("accepts optional FriendSource enum", async () => {
    // Should accept the enum without TypeScript or runtime issues.
    const { FriendSource } = await import("../../src/api/friends.ts");
    await expect(
      client.friends.add("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202", FriendSource.ADDED_BY_SEARCH),
    ).resolves.toBeUndefined();
  });
});

describe("client.friends.remove", () => {
  test("resolves void on success", async () => {
    await expect(client.friends.remove("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });

  test("throws on invalid uuid", async () => {
    await expect(client.friends.remove("not-a-uuid")).rejects.toThrow();
  });
});

describe("client.friends.block", () => {
  test("resolves void on success", async () => {
    await expect(client.friends.block("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });
});

describe("client.friends.unblock", () => {
  test("resolves void on success", async () => {
    await expect(client.friends.unblock("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });
});

describe("client.friends.ignore", () => {
  test("resolves void on success", async () => {
    await expect(client.friends.ignore("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });
});

// ─── Reads ────────────────────────────────────────────────────────────────

describe("client.friends.list", () => {
  test("returns array of Friend with required fields", async () => {
    const friends = await client.friends.list();
    expect(Array.isArray(friends)).toBe(true);
    if (friends.length > 0) {
      expect(friends[0]).toMatchObject({
        userId: expect.any(String),
        username: expect.any(String),
      });
      // friendType is required on Friend (not on User).
      expect(typeof friends[0].friendType).toBe("string");
    }
  });

  test("excludes the logged-in user from the result", async () => {
    if (!client.self?.userId) return; // can't assert without self; covered elsewhere
    const friends = await client.friends.list();
    const selfId = client.self.userId;
    expect(friends.find((f) => f.userId === selfId)).toBeUndefined();
  });
});

describe("client.friends.search", () => {
  test("returns matching User[] for known query", async () => {
    const results = await client.friends.search("jamie");
    expect(Array.isArray(results)).toBe(true);
    expect(results.some((u) => u.username.toLowerCase().includes("jamie"))).toBe(true);
  });

  test("returns empty array for nonsense query", async () => {
    const results = await client.friends.search("xyzqwertynonexistent12345");
    expect(results).toEqual([]);
  });

  test("each result has userId + username", async () => {
    const results = await client.friends.search("jamie");
    for (const u of results) {
      expect(typeof u.userId).toBe("string");
      expect(u.userId.length).toBeGreaterThan(0);
      expect(typeof u.username).toBe("string");
      expect(u.username.length).toBeGreaterThan(0);
    }
  });
});

// ─── Pending requests ─────────────────────────────────────────────────────

describe("client.friends.acceptRequest", () => {
  test("resolves void on success", async () => {
    await expect(client.friends.acceptRequest("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });
});

describe("client.friends.rejectRequest", () => {
  test("resolves void on success", async () => {
    await expect(client.friends.rejectRequest("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202")).resolves.toBeUndefined();
  });
});

describe("client.friends.incomingRequests", () => {
  test("returns array of FriendRequest", async () => {
    const requests = await client.friends.incomingRequests();
    expect(Array.isArray(requests)).toBe(true);
    for (const r of requests) {
      expect(typeof r.fromUserId).toBe("string");
      expect(typeof r.fromUsername).toBe("string");
    }
  });
});

describe("client.friends.outgoingRequests", () => {
  test("returns array of OutgoingRequest objects", async () => {
    const out = await client.friends.outgoingRequests();
    expect(Array.isArray(out)).toBe(true);
    for (const r of out) {
      expect(typeof r).toBe("object");
      expect(typeof r.toUserId).toBe("string");
      expect(r.toUserId.length).toBeGreaterThan(0);
      // Optional username/displayName: present only when publicUsers cache resolved.
      if (r.toUsername !== undefined) expect(typeof r.toUsername).toBe("string");
      if (r.toDisplayName !== undefined) expect(typeof r.toDisplayName).toBe("string");
    }
  });
});

describe("client.friends.snapshot", () => {
  test("returns FriendsSnapshot with mutuals/incoming/outgoing arrays", async () => {
    const snap = await client.friends.snapshot();
    expect(snap).toBeDefined();
    expect(Array.isArray(snap.mutuals)).toBe(true);
    expect(Array.isArray(snap.incoming)).toBe(true);
    expect(Array.isArray(snap.outgoing)).toBe(true);
  });

  test("snapshot slices match split read accessors", async () => {
    const snap = await client.friends.snapshot();
    const list = await client.friends.list();
    const incoming = await client.friends.incomingRequests();
    const outgoing = await client.friends.outgoingRequests();
    expect(list.length).toBe(snap.mutuals.length);
    expect(incoming.length).toBe(snap.incoming.length);
    expect(outgoing.length).toBe(snap.outgoing.length);
  });
});

// ─── Subscriptions ────────────────────────────────────────────────────────

describe("client.friends.onChange", () => {
  test("returns Unsubscribe function", () => {
    const unsub = client.friends.onChange(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("calling unsubscribe twice is idempotent", () => {
    const unsub = client.friends.onChange(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  test("fires callback with FriendsSnapshot when graph changes", async () => {
    let fired = false;
    let lastSnap: Awaited<ReturnType<typeof client.friends.snapshot>> | undefined;
    const unsub = client.friends.onChange((snap) => {
      fired = true;
      lastSnap = snap;
    });
    try {
      await client.friends.add("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202");
    } catch {
      // mutation may throw in some environments — onChange should still
      // fire if any of the three slots tick from server-side push.
    }
    await new Promise((r) => setTimeout(r, 1000));
    unsub();
    expect(fired).toBe(true);
    if (lastSnap) {
      expect(Array.isArray(lastSnap.mutuals)).toBe(true);
      expect(Array.isArray(lastSnap.incoming)).toBe(true);
      expect(Array.isArray(lastSnap.outgoing)).toBe(true);
    }
  });
});

// ─── Wiring sanity ────────────────────────────────────────────────────────

describe("client.friends wiring", () => {
  test("client.friends exists and is a Friends instance", async () => {
    const { Friends } = await import("../../src/api/friends.ts");
    expect(client.friends).toBeInstanceOf(Friends);
  });

  test("client.friends is a readonly field (same reference across reads)", () => {
    const a = client.friends;
    const b = client.friends;
    expect(a).toBe(b);
  });
});
