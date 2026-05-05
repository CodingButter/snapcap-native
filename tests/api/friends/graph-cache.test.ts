/**
 * PURE tests — `src/api/friends/graph-cache.ts`.
 *
 * Covers:
 *  - `loadGraphCache` — missing key, populated key, legacy-key migration,
 *    malformed bytes, partial shape, non-array slots.
 *  - `saveGraphCache` — encodes + writes JSON; subsequent `loadGraphCache`
 *    round-trips cleanly.
 *  - `isEmptyGraphSnapshot` — all-empty, partially-populated, fully-populated.
 *  - `diffGraph` — added / removed per-slot, acceptedRequests cross-slot.
 *
 * No Sandbox, no fetch. All I/O is via `MemoryDataStore`.
 */
import { describe, expect, test } from "bun:test";
import {
  FRIEND_GRAPH_CACHE_KEY,
  FRIEND_GRAPH_CACHE_KEY_LEGACY,
  type FriendGraphSnapshot,
  diffGraph,
  isEmptyGraphSnapshot,
  loadGraphCache,
  saveGraphCache,
} from "../../../src/api/friends/graph-cache.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid snapshot. */
function snap(mutuals: string[], outgoing: string[], incoming: string[]): FriendGraphSnapshot {
  return { mutuals, outgoing, incoming, ts: Date.now() };
}

// ── loadGraphCache ────────────────────────────────────────────────────────────

describe("friends/graph-cache — loadGraphCache", () => {
  test("returns undefined when key is absent", async () => {
    const ds = new MemoryDataStore();
    expect(await loadGraphCache(ds)).toBeUndefined();
  });

  test("returns undefined when stored bytes are empty (zero-length)", async () => {
    const ds = new MemoryDataStore();
    await ds.set(FRIEND_GRAPH_CACHE_KEY, new Uint8Array(0));
    expect(await loadGraphCache(ds)).toBeUndefined();
  });

  test("returns undefined for malformed JSON bytes", async () => {
    const ds = new MemoryDataStore();
    await ds.set(FRIEND_GRAPH_CACHE_KEY, new TextEncoder().encode("not-json{{{{"));
    expect(await loadGraphCache(ds)).toBeUndefined();
  });

  test("returns undefined when required array slots are missing", async () => {
    const ds = new MemoryDataStore();
    await ds.set(
      FRIEND_GRAPH_CACHE_KEY,
      new TextEncoder().encode(JSON.stringify({ mutuals: ["a"] })), // missing outgoing + incoming
    );
    expect(await loadGraphCache(ds)).toBeUndefined();
  });

  test("returns undefined when slots are not arrays", async () => {
    const ds = new MemoryDataStore();
    await ds.set(
      FRIEND_GRAPH_CACHE_KEY,
      new TextEncoder().encode(JSON.stringify({ mutuals: "wrong", outgoing: 1, incoming: null })),
    );
    expect(await loadGraphCache(ds)).toBeUndefined();
  });

  test("returns a valid snapshot when the key is correctly populated", async () => {
    const ds = new MemoryDataStore();
    const stored = snap(["aaa", "bbb"], ["ccc"], ["ddd"]);
    await ds.set(FRIEND_GRAPH_CACHE_KEY, new TextEncoder().encode(JSON.stringify(stored)));
    const loaded = await loadGraphCache(ds);
    expect(loaded).not.toBeUndefined();
    expect(loaded!.mutuals).toEqual(["aaa", "bbb"]);
    expect(loaded!.outgoing).toEqual(["ccc"]);
    expect(loaded!.incoming).toEqual(["ddd"]);
  });

  test("filters non-string entries out of each array slot", async () => {
    const ds = new MemoryDataStore();
    const obj = { mutuals: ["ok", 42, null, "also-ok"], outgoing: [], incoming: [], ts: 1 };
    await ds.set(FRIEND_GRAPH_CACHE_KEY, new TextEncoder().encode(JSON.stringify(obj)));
    const loaded = await loadGraphCache(ds);
    expect(loaded!.mutuals).toEqual(["ok", "also-ok"]);
  });

  test("fills ts from Date.now() when missing in stored payload", async () => {
    const ds = new MemoryDataStore();
    const before = Date.now();
    const obj = { mutuals: [], outgoing: [], incoming: [] }; // no ts field
    await ds.set(FRIEND_GRAPH_CACHE_KEY, new TextEncoder().encode(JSON.stringify(obj)));
    const loaded = await loadGraphCache(ds);
    const after = Date.now();
    expect(loaded!.ts).toBeGreaterThanOrEqual(before);
    expect(loaded!.ts).toBeLessThanOrEqual(after);
  });

  test("lazy-migrates from legacy key when new key is absent", async () => {
    const ds = new MemoryDataStore();
    const legacy = snap(["x"], [], []);
    await ds.set(FRIEND_GRAPH_CACHE_KEY_LEGACY, new TextEncoder().encode(JSON.stringify(legacy)));

    const loaded = await loadGraphCache(ds);
    expect(loaded).not.toBeUndefined();
    expect(loaded!.mutuals).toEqual(["x"]);

    // New key should now be populated, legacy key deleted.
    const newRaw = await ds.get(FRIEND_GRAPH_CACHE_KEY);
    expect(newRaw).not.toBeUndefined();
    expect(newRaw!.byteLength).toBeGreaterThan(0);
    const legacyRaw = await ds.get(FRIEND_GRAPH_CACHE_KEY_LEGACY);
    expect(!legacyRaw || legacyRaw.byteLength === 0).toBe(true);
  });
});

// ── saveGraphCache ────────────────────────────────────────────────────────────

describe("friends/graph-cache — saveGraphCache", () => {
  test("persists a snapshot that round-trips through loadGraphCache", async () => {
    const ds = new MemoryDataStore();
    const s = snap(["aa", "bb"], ["cc"], []);
    await saveGraphCache(ds, s);
    const loaded = await loadGraphCache(ds);
    expect(loaded!.mutuals).toEqual(["aa", "bb"]);
    expect(loaded!.outgoing).toEqual(["cc"]);
    expect(loaded!.incoming).toEqual([]);
  });

  test("overwrites a previously-saved snapshot", async () => {
    const ds = new MemoryDataStore();
    await saveGraphCache(ds, snap(["old"], [], []));
    await saveGraphCache(ds, snap(["new1", "new2"], [], []));
    const loaded = await loadGraphCache(ds);
    expect(loaded!.mutuals).toEqual(["new1", "new2"]);
  });
});

// ── isEmptyGraphSnapshot ──────────────────────────────────────────────────────

describe("friends/graph-cache — isEmptyGraphSnapshot", () => {
  test("returns true when all three slots are empty", () => {
    expect(isEmptyGraphSnapshot(snap([], [], []))).toBe(true);
  });

  test("returns false when mutuals is non-empty", () => {
    expect(isEmptyGraphSnapshot(snap(["x"], [], []))).toBe(false);
  });

  test("returns false when outgoing is non-empty", () => {
    expect(isEmptyGraphSnapshot(snap([], ["x"], []))).toBe(false);
  });

  test("returns false when incoming is non-empty", () => {
    expect(isEmptyGraphSnapshot(snap([], [], ["x"]))).toBe(false);
  });
});

// ── diffGraph ─────────────────────────────────────────────────────────────────

describe("friends/graph-cache — diffGraph", () => {
  test("returns empty diffs when prior and current are identical", () => {
    const s = snap(["a", "b"], ["c"], ["d"]);
    const { added, removed, acceptedRequests } = diffGraph(s, s);
    expect(added.mutuals).toEqual([]);
    expect(added.outgoing).toEqual([]);
    expect(added.incoming).toEqual([]);
    expect(removed.mutuals).toEqual([]);
    expect(removed.outgoing).toEqual([]);
    expect(removed.incoming).toEqual([]);
    expect(acceptedRequests).toEqual([]);
  });

  test("detects newly-added mutual", () => {
    const prior = snap(["a"], [], []);
    const current = snap(["a", "b"], [], []);
    const { added, removed } = diffGraph(prior, current);
    expect(added.mutuals).toEqual(["b"]);
    expect(removed.mutuals).toEqual([]);
  });

  test("detects removed mutual", () => {
    const prior = snap(["a", "b"], [], []);
    const current = snap(["a"], [], []);
    const { added, removed } = diffGraph(prior, current);
    expect(removed.mutuals).toEqual(["b"]);
    expect(added.mutuals).toEqual([]);
  });

  test("detects new incoming request", () => {
    const prior = snap([], [], []);
    const current = snap([], [], ["req1"]);
    const { added } = diffGraph(prior, current);
    expect(added.incoming).toEqual(["req1"]);
  });

  test("detects cancelled incoming request (removed from incoming)", () => {
    const prior = snap([], [], ["req1"]);
    const current = snap([], [], []);
    const { removed } = diffGraph(prior, current);
    expect(removed.incoming).toEqual(["req1"]);
  });

  test("detects accepted request — id moves from outgoing to mutuals", () => {
    const prior = snap([], ["outgoingUser"], []);
    const current = snap(["outgoingUser"], [], []);
    const { acceptedRequests, added, removed } = diffGraph(prior, current);
    expect(acceptedRequests).toEqual(["outgoingUser"]);
    // Also flagged as added mutual and removed outgoing.
    expect(added.mutuals).toContain("outgoingUser");
    expect(removed.outgoing).toContain("outgoingUser");
  });

  test("does NOT flag accepted request when id does not end up in mutuals", () => {
    // Outgoing request was just cancelled by us, not accepted.
    const prior = snap([], ["outgoingUser"], []);
    const current = snap([], [], []);
    const { acceptedRequests } = diffGraph(prior, current);
    expect(acceptedRequests).toEqual([]);
  });

  test("handles completely empty prior and current without errors", () => {
    const { added, removed, acceptedRequests } = diffGraph(snap([], [], []), snap([], [], []));
    expect(added.mutuals).toEqual([]);
    expect(removed.mutuals).toEqual([]);
    expect(acceptedRequests).toEqual([]);
  });
});
