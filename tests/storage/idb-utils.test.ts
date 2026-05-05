/**
 * STATE-DRIVEN tests — `src/storage/idb-utils.ts`
 *
 * idbGet / idbPut / idbDelete use the IDB shim installed on a real Sandbox.
 * We construct a real Sandbox backed by a MemoryDataStore.
 *
 * BUG FOUND (do not fix): `idbGet` returns `undefined` even after a
 * successful `idbPut`. Root cause: `IDBObjectStoreShim.get` does NOT call
 * `tx._noteOp()`, so the `IDBTransactionShim` fires `oncomplete` before
 * the async `store.get()` promise resolves and before `req.onsuccess`
 * fires. In `idb-utils.ts:runOp`, `resolve(opResult)` runs while
 * `opResult` is still `undefined`.
 *
 * The write path (put/delete) DOES call `_noteOp()` so writes land
 * correctly in the DataStore. Only reads are broken.
 *
 * Until the bug is fixed, these tests verify:
 *   - idbPut successfully writes to the DataStore (observable via store.keys)
 *   - idbDelete removes the key from the DataStore
 *   - idbGet resolves (to undefined, due to the bug) without throwing
 *   - sandbox construction + getGlobal("indexedDB") works correctly
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import { idbGet, idbPut, idbDelete } from "../../src/storage/idb-utils.ts";

function makeSandbox(): { sb: Sandbox; store: MemoryDataStore } {
  const store = new MemoryDataStore();
  const sb = new Sandbox({ dataStore: store });
  return { sb, store };
}

describe("storage/idb-utils — idbPut writes to DataStore", () => {
  test("idbPut stores bytes under the expected key prefix", async () => {
    const { sb, store } = makeSandbox();
    await idbPut(sb, "testdb", "mystore", "key1", { hello: "world" });
    const keys = store.keys("indexdb_testdb__mystore__");
    expect(keys).toContain("indexdb_testdb__mystore__key1");
  });

  test("idbPut key is JSON-encoded in the DataStore", async () => {
    const { sb, store } = makeSandbox();
    await idbPut(sb, "db", "store", "k", { n: 42 });
    const bytes = store.getSync("indexdb_db__store__k");
    expect(bytes).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(bytes!));
    expect(parsed).toEqual({ n: 42 });
  });

  test("second idbPut with same key overwrites DataStore entry", async () => {
    const { sb, store } = makeSandbox();
    await idbPut(sb, "db", "store", "k", { v: 1 });
    await idbPut(sb, "db", "store", "k", { v: 2 });
    const bytes = store.getSync("indexdb_db__store__k");
    const parsed = JSON.parse(new TextDecoder().decode(bytes!));
    expect(parsed).toEqual({ v: 2 });
  });
});

describe("storage/idb-utils — idbDelete removes from DataStore", () => {
  test("idbDelete removes the DataStore key", async () => {
    const { sb, store } = makeSandbox();
    await idbPut(sb, "db", "store", "del", { x: 1 });
    expect(store.keys("indexdb_db__store__del")).toHaveLength(1);
    await idbDelete(sb, "db", "store", "del");
    expect(store.keys("indexdb_db__store__del")).toHaveLength(0);
  });

  test("idbDelete on absent key does not throw", async () => {
    const { sb } = makeSandbox();
    await expect(idbDelete(sb, "db", "store", "ghost")).resolves.toBeUndefined();
  });
});

describe("storage/idb-utils — idbGet resolves without throwing", () => {
  test("idbGet resolves (to undefined) without throwing — BUG: tx.oncomplete fires before get result", async () => {
    // This test documents the known bug: idbGet returns undefined even
    // after a successful idbPut. See file header for root cause.
    const { sb } = makeSandbox();
    await idbPut(sb, "db", "store", "k", { tag: "A" });
    const result = await idbGet(sb, "db", "store", "k");
    // Bug: should equal { tag: "A" } but returns undefined.
    expect(result).toBeUndefined(); // KNOWN BUG — see file header
  });

  test("idbGet on absent key resolves to undefined (correct behavior)", async () => {
    const { sb } = makeSandbox();
    const got = await idbGet(sb, "db", "store", "nonexistent");
    expect(got).toBeUndefined();
  });
});

describe("storage/idb-utils — sandbox IDB wiring", () => {
  test("sandbox.getGlobal('indexedDB') returns the IDBFactoryShim", () => {
    const { sb } = makeSandbox();
    const idb = sb.getGlobal("indexedDB");
    expect(idb).toBeDefined();
    expect(typeof (idb as { open?: unknown }).open).toBe("function");
  });

  test("two Sandboxes have isolated DataStores — put does not cross realms", async () => {
    const { sb: sbA, store: storeA } = makeSandbox();
    const { store: storeB } = makeSandbox();
    await idbPut(sbA, "db", "store", "key", { tenant: "A" });
    const keysA = storeA.keys("indexdb_db__store__");
    const keysB = storeB.keys("indexdb_db__store__");
    expect(keysA).toHaveLength(1);
    expect(keysB).toHaveLength(0);
  });
});
