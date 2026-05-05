/**
 * PURE tests — `src/storage/storage-shim.ts`
 *
 * StorageShim wraps a DataStore with a key prefix, implementing the
 * W3C Storage interface (getItem/setItem/removeItem/clear/key/length).
 *
 * Tested with MemoryDataStore (sync) and a minimal async-only DataStore
 * (exercises the fallback-cache path that StorageShim uses when the store
 * has no getSync/setSync methods).
 */
import { describe, expect, test } from "bun:test";
import { StorageShim } from "../../src/storage/storage-shim.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import type { DataStore } from "../../src/storage/data-store.ts";

// ─── Sync store (MemoryDataStore) path ────────────────────────────────────────

describe("storage/storage-shim — sync store (MemoryDataStore)", () => {
  test("setItem / getItem round-trips UTF-8 strings", () => {
    const store = new MemoryDataStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("foo", "bar");
    expect(shim.getItem("foo")).toBe("bar");
  });

  test("getItem returns null for missing key", () => {
    const shim = new StorageShim(new MemoryDataStore(), "local_");
    expect(shim.getItem("nope")).toBeNull();
  });

  test("removeItem deletes the entry", () => {
    const store = new MemoryDataStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("x", "hello");
    shim.removeItem("x");
    expect(shim.getItem("x")).toBeNull();
  });

  test("length reflects the number of items under the prefix", () => {
    const store = new MemoryDataStore();
    const shim = new StorageShim(store, "local_");
    expect(shim.length).toBe(0);
    shim.setItem("a", "1");
    shim.setItem("b", "2");
    expect(shim.length).toBe(2);
  });

  test("clear removes all items under the prefix", () => {
    const store = new MemoryDataStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("one", "1");
    shim.setItem("two", "2");
    shim.clear();
    expect(shim.length).toBe(0);
    expect(shim.getItem("one")).toBeNull();
  });

  test("key(index) returns the Nth key (unprefixed)", () => {
    const store = new MemoryDataStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("alpha", "a");
    expect(shim.key(0)).toBe("alpha");
    expect(shim.key(1)).toBeNull();
  });

  test("two shims with different prefixes on the same store are isolated", () => {
    const store = new MemoryDataStore();
    const local = new StorageShim(store, "local_");
    const session = new StorageShim(store, "session_");
    local.setItem("k", "local-value");
    session.setItem("k", "session-value");
    expect(local.getItem("k")).toBe("local-value");
    expect(session.getItem("k")).toBe("session-value");
  });

  test("does not leak keys across prefix boundaries in length", () => {
    const store = new MemoryDataStore();
    const local = new StorageShim(store, "local_");
    const session = new StorageShim(store, "session_");
    local.setItem("a", "1");
    local.setItem("b", "2");
    session.setItem("x", "3");
    expect(local.length).toBe(2);
    expect(session.length).toBe(1);
  });

  test("stores Unicode values correctly", () => {
    const shim = new StorageShim(new MemoryDataStore(), "u_");
    shim.setItem("emoji", "🐍");
    expect(shim.getItem("emoji")).toBe("🐍");
  });
});

// ─── Async-only store path (no getSync/setSync) ───────────────────────────────

/**
 * Minimal async-only DataStore — no getSync/setSync/keys methods.
 * Exercises StorageShim's fallback-cache code path.
 */
class AsyncOnlyStore implements DataStore {
  private map = new Map<string, Uint8Array>();
  async get(key: string) { return this.map.get(key); }
  async set(key: string, v: Uint8Array) { this.map.set(key, new Uint8Array(v)); }
  async delete(key: string) { this.map.delete(key); }
}

describe("storage/storage-shim — async-only store (fallback cache path)", () => {
  test("setItem / getItem via fallback cache", () => {
    const store = new AsyncOnlyStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("hello", "world");
    expect(shim.getItem("hello")).toBe("world");
  });

  test("removeItem removes from fallback cache", () => {
    const store = new AsyncOnlyStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("x", "y");
    shim.removeItem("x");
    expect(shim.getItem("x")).toBeNull();
  });

  test("clear empties fallback cache", () => {
    const store = new AsyncOnlyStore();
    const shim = new StorageShim(store, "local_");
    shim.setItem("a", "1");
    shim.setItem("b", "2");
    shim.clear();
    expect(shim.length).toBe(0);
  });

  test("length reflects fallback cache size", () => {
    const store = new AsyncOnlyStore();
    const shim = new StorageShim(store, "local_");
    expect(shim.length).toBe(0);
    shim.setItem("p", "q");
    expect(shim.length).toBe(1);
  });
});
