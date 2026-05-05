/**
 * PURE tests — `src/shims/cookie-jar.ts`
 *
 * getOrCreateJar(store) — keyed by DataStore, one jar per store instance.
 * persistJar(jar, store) — flushes jar → store for sync-capable stores.
 *
 * No Sandbox, no fetch.
 */
import { describe, expect, test } from "bun:test";
import { getOrCreateJar, persistJar, COOKIE_JAR_KEY } from "../../src/shims/cookie-jar.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

describe("shims/cookie-jar — getOrCreateJar", () => {
  test("returns a CookieJar for a fresh store", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    expect(jar).toBeDefined();
  });

  test("returns the SAME instance on repeated calls for the same store", () => {
    const store = new MemoryDataStore();
    const j1 = getOrCreateJar(store);
    const j2 = getOrCreateJar(store);
    expect(j1).toBe(j2);
  });

  test("different DataStore instances produce different jars", () => {
    const storeA = new MemoryDataStore();
    const storeB = new MemoryDataStore();
    expect(getOrCreateJar(storeA)).not.toBe(getOrCreateJar(storeB));
  });

  test("hydrates from previously persisted state (setSync)", () => {
    const store = new MemoryDataStore();
    // Pre-seed serialized jar state with a cookie.
    const seedJar = getOrCreateJar(store);
    seedJar.setCookieSync("seed=value; path=/", "https://www.snapchat.com/");
    persistJar(seedJar, store);

    // A DIFFERENT store instance points to the same store object — but
    // we want to test hydration on a NEW call. Use a fresh MemoryDataStore
    // that received the bytes via manual copy.
    const store2 = new MemoryDataStore();
    const bytes = store.getSync(COOKIE_JAR_KEY);
    if (bytes) store2.setSync(COOKIE_JAR_KEY, bytes);

    const jar2 = getOrCreateJar(store2);
    const cookies = jar2.getCookiesSync("https://www.snapchat.com/");
    expect(cookies.some((c) => c.key === "seed" && c.value === "value")).toBe(true);
  });

  test("empty store byte means start fresh (no throw)", () => {
    const store = new MemoryDataStore();
    store.setSync(COOKIE_JAR_KEY, new Uint8Array(0));
    const jar = getOrCreateJar(store);
    expect(jar.getCookiesSync("https://snap.com/")).toHaveLength(0);
  });
});

describe("shims/cookie-jar — persistJar", () => {
  test("writes serialized jar back under COOKIE_JAR_KEY", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    jar.setCookieSync("tok=abc; path=/", "https://accounts.snapchat.com/");
    persistJar(jar, store);

    const bytes = store.getSync(COOKIE_JAR_KEY);
    expect(bytes).toBeDefined();
    const json = new TextDecoder().decode(bytes!);
    expect(json).toContain("tok");
  });

  test("no-ops gracefully on store without setSync (async-only)", () => {
    // Async-only store: no setSync. persistJar should fire-and-forget, not throw.
    class AsyncOnlyStore {
      private map = new Map<string, Uint8Array>();
      async get(key: string) { return this.map.get(key); }
      async set(key: string, v: Uint8Array) { this.map.set(key, new Uint8Array(v)); }
      async delete(key: string) { this.map.delete(key); }
    }
    const store = new AsyncOnlyStore() as unknown as MemoryDataStore;
    const jar = getOrCreateJar(store);
    jar.setCookieSync("a=1; path=/", "https://snap.com/");
    expect(() => persistJar(jar, store)).not.toThrow();
  });
});
