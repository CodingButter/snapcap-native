/**
 * STATE-DRIVEN tests — `src/shims/cache-storage.ts`
 *
 * CacheStorageShim installs a DataStore-backed `caches` global on the
 * sandbox. Tests exercise open/has/delete/keys and Cache.put/match/delete/
 * matchAll/keys via a real Sandbox + MemoryDataStore (no bundle, no auth).
 *
 * The cache.add() path is skipped — it calls nativeFetch internally and
 * would need a global.fetch stub; the rest of the API is self-contained.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

type CacheStorage = {
  open(name: string): Promise<Cache>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<boolean>;
  keys(): Promise<string[]>;
  match(req: string): Promise<Response | undefined>;
};

type Cache = {
  put(req: string | { url: string; method?: string }, res: Response): Promise<void>;
  match(req: string | { url: string; method?: string }): Promise<Response | undefined>;
  matchAll(req?: string): Promise<Response[]>;
  delete(req: string): Promise<boolean>;
  keys(req?: string): Promise<Request[]>;
};

function makeSandbox(): { sb: Sandbox; caches: CacheStorage } {
  const store = new MemoryDataStore();
  const sb = new Sandbox({ dataStore: store });
  const caches = (sb.window as unknown as { caches: CacheStorage }).caches;
  return { sb, caches };
}

describe("shims/cache-storage — CacheStorage.open / has / keys / delete", () => {
  test("open returns a Cache object", async () => {
    const { caches } = makeSandbox();
    const cache = await caches.open("v1");
    expect(cache).toBeDefined();
    expect(typeof cache.put).toBe("function");
  });

  test("has returns false for unopened cache", async () => {
    const { caches } = makeSandbox();
    expect(await caches.has("nonexistent")).toBe(false);
  });

  test("has returns true after open", async () => {
    const { caches } = makeSandbox();
    await caches.open("v1");
    expect(await caches.has("v1")).toBe(true);
  });

  test("keys returns opened cache names", async () => {
    const { caches } = makeSandbox();
    await caches.open("a");
    await caches.open("b");
    const names = await caches.keys();
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  test("delete removes the cache", async () => {
    const { caches } = makeSandbox();
    await caches.open("to-delete");
    const deleted = await caches.delete("to-delete");
    expect(deleted).toBe(true);
    expect(await caches.has("to-delete")).toBe(false);
  });

  test("delete returns false for non-existent cache", async () => {
    const { caches } = makeSandbox();
    expect(await caches.delete("ghost")).toBe(false);
  });
});

describe("shims/cache-storage — Cache.put / match / delete", () => {
  test("put then match returns the response", async () => {
    const { sb, caches } = makeSandbox();
    const VmResponse = sb.runInContext("Response") as typeof Response;
    const cache = await caches.open("v1");

    const res = new VmResponse("hello cache", { status: 200, headers: { "x-test": "yes" } });
    await cache.put("https://snap.com/test", res);

    const got = await cache.match("https://snap.com/test");
    expect(got).toBeDefined();
    expect(got!.status).toBe(200);
    const text = await got!.text();
    expect(text).toBe("hello cache");
  });

  test("match returns undefined for absent entry", async () => {
    const { caches } = makeSandbox();
    const cache = await caches.open("v1");
    expect(await cache.match("https://snap.com/missing")).toBeUndefined();
  });

  test("delete removes the cache entry", async () => {
    const { sb, caches } = makeSandbox();
    const VmResponse = sb.runInContext("Response") as typeof Response;
    const cache = await caches.open("v1");

    await cache.put("https://snap.com/to-del", new VmResponse("bye"));
    const deleted = await cache.delete("https://snap.com/to-del");
    expect(deleted).toBe(true);
    expect(await cache.match("https://snap.com/to-del")).toBeUndefined();
  });

  test("matchAll with no arg returns all cached entries", async () => {
    const { sb, caches } = makeSandbox();
    const VmResponse = sb.runInContext("Response") as typeof Response;
    const cache = await caches.open("v1");

    await cache.put("https://snap.com/a", new VmResponse("a"));
    await cache.put("https://snap.com/b", new VmResponse("b"));
    const all = await cache.matchAll();
    expect(all.length).toBe(2);
  });

  test("keys() returns Request objects for cached entries", async () => {
    const { sb, caches } = makeSandbox();
    const VmResponse = sb.runInContext("Response") as typeof Response;
    const cache = await caches.open("v1");

    await cache.put("https://snap.com/req1", new VmResponse("r1"));
    const keys = await cache.keys();
    expect(keys.length).toBe(1);
    expect(keys[0]!.url).toContain("req1");
  });

  test("two Sandboxes have isolated caches", async () => {
    const { sb: sbA, caches: cachesA } = makeSandbox();
    const { caches: cachesB } = makeSandbox();
    const VmResponseA = sbA.runInContext("Response") as typeof Response;

    const cacheA = await cachesA.open("shared");
    await cacheA.put("https://snap.com/x", new VmResponseA("from-A"));

    // cachesB is a different Sandbox with a different MemoryDataStore.
    expect(await cachesB.has("shared")).toBe(false);
  }, 10_000);
});
