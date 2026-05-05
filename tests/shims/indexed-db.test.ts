/**
 * STATE-DRIVEN tests — `src/shims/indexed-db.ts`
 *
 * IDBFactoryShim provides indexedDB.open(name, version) → IDBDatabaseShim.
 * Tests exercise: upgradeneeded, onsuccess, put/get/delete via req.onsuccess,
 * databases(), cmp(), and Sandbox integration.
 *
 * BUG FOUND (do not fix): `IDBObjectStoreShim.get` does NOT call
 * `tx._noteOp()`, so `tx.oncomplete` fires before the get result is
 * available. Pattern used here: resolve on `req.onsuccess` for reads,
 * `req.onsuccess` for writes (bypassing `tx.oncomplete`).
 */
import { describe, expect, test } from "bun:test";
import { IDBFactoryShim } from "../../src/shims/indexed-db.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

type ShimDb = {
  transaction(names: string[], mode: "readonly" | "readwrite"): ShimTx;
  createObjectStore(name: string): unknown;
  objectStoreNames: { contains(n: string): boolean };
  close?(): void;
  name: string;
  version: number;
};

type ShimTx = {
  objectStore(name: string): ShimOs;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

type ShimOs = {
  get(key: string): ShimReq;
  put(value: unknown, key: string): ShimReq;
  delete(key: string): ShimReq;
  clear(): ShimReq;
  getAll(): ShimReq;
  getAllKeys(): ShimReq;
};

type ShimReq = {
  result: unknown;
  error: Error | null;
  readyState: string;
  onsuccess: ((ev: { target: ShimReq; type: string }) => void) | null;
  onerror: ((ev: { target: ShimReq; type: string }) => void) | null;
};

/** Open a db and resolve when onsuccess fires. */
function openDb(
  factory: IDBFactoryShim,
  name: string,
  version = 1,
  storeNameToCreate?: string,
): Promise<ShimDb> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    if (storeNameToCreate) {
      req.onupgradeneeded = (ev: { target: { result: unknown } }) => {
        const db = (ev.target as { result: ShimDb }).result;
        db.createObjectStore(storeNameToCreate);
      };
    }
    req.onsuccess = (ev: { target: { result: unknown } }) => resolve((ev.target as { result: ShimDb }).result);
    req.onerror = (ev: { target: { error?: Error | null } }) => reject(ev.target.error ?? new Error("open failed"));
  });
}

/** Put a value, resolve when req.onsuccess fires. */
function put(db: ShimDb, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], "readwrite");
    const os = tx.objectStore(store);
    const req = os.put(value, key) as ShimReq;
    req.onsuccess = () => resolve();
    req.onerror = (ev) => reject(ev.target.error ?? new Error("put failed"));
  });
}

/** Get a value, resolve when req.onsuccess fires (bypasses tx.oncomplete). */
function get(db: ShimDb, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], "readonly");
    const os = tx.objectStore(store);
    const req = os.get(key) as ShimReq;
    req.onsuccess = (ev) => resolve(ev.target.result);
    req.onerror = (ev) => reject(ev.target.error ?? new Error("get failed"));
  });
}

/** Delete a key, resolve when req.onsuccess fires. */
function del(db: ShimDb, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], "readwrite");
    const os = tx.objectStore(store);
    const req = os.delete(key) as ShimReq;
    req.onsuccess = () => resolve();
    req.onerror = (ev) => reject(ev.target.error ?? new Error("delete failed"));
  });
}

describe("shims/indexed-db — IDBFactoryShim open + upgradeneeded", () => {
  test("open fires onsuccess with a database object", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    const db = await openDb(factory, "mydb", 1, "mystore");
    expect(db).toBeDefined();
  });

  test("upgradeneeded fires on first open; onsuccess fires after", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    let upgraded = false;
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("testdb", 1);
      req.onupgradeneeded = () => { upgraded = true; };
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error("failed"));
    });
    expect(upgraded).toBe(true);
  });

  test("second open of same db at same version skips upgradeneeded", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    await openDb(factory, "db", 1, "s");
    let upgraded = false;
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("db", 1);
      req.onupgradeneeded = () => { upgraded = true; };
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error("failed"));
    });
    expect(upgraded).toBe(false);
  });
});

describe("shims/indexed-db — put / get (via req.onsuccess) / delete", () => {
  test("put then get via req.onsuccess round-trips a JSON-serializable value", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    const db = await openDb(factory, "db", 1, "store");
    await put(db, "store", "key1", { hello: "world" });
    const got = await get(db, "store", "key1");
    expect(got).toEqual({ hello: "world" });
  });

  test("get returns undefined for absent key", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    const db = await openDb(factory, "db", 1, "store");
    const got = await get(db, "store", "ghost");
    expect(got).toBeUndefined();
  });

  test("delete removes the entry", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    const db = await openDb(factory, "db", 1, "store");
    await put(db, "store", "toDel", { x: 1 });
    await del(db, "store", "toDel");
    const got = await get(db, "store", "toDel");
    expect(got).toBeUndefined();
  });

  test("multiple keys in the same store are independent", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    const db = await openDb(factory, "db", 1, "store");
    await put(db, "store", "a", { tag: "A" });
    await put(db, "store", "b", { tag: "B" });
    expect(await get(db, "store", "a")).toEqual({ tag: "A" });
    expect(await get(db, "store", "b")).toEqual({ tag: "B" });
  });

  test("tx.oncomplete waits for get's onsuccess — result is observable inside oncomplete", async () => {
    const store = new MemoryDataStore();
    const factory = new IDBFactoryShim(store);
    const db = await openDb(factory, "db", 1, "mystore");
    await put(db, "mystore", "testkey", { value: "test" });
    expect(store.getSync("indexdb_db__mystore__testkey")).toBeDefined();
    const txOnCompleteResult = await new Promise<unknown>((resolve) => {
      const tx = db.transaction(["mystore"], "readonly");
      const os = tx.objectStore("mystore");
      const req = os.get("testkey");
      let result: unknown;
      (req as { onsuccess: ((ev: { target: { result: unknown } }) => void) | null }).onsuccess = (ev) => {
        result = ev.target.result;
      };
      tx.oncomplete = () => resolve(result);
    });
    expect(txOnCompleteResult).toEqual({ value: "test" });
  });
});

describe("shims/indexed-db — databases() / cmp()", () => {
  test("cmp returns 0 for equal keys", () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    expect(factory.cmp("a", "a")).toBe(0);
  });

  test("cmp returns -1 when first key is less", () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    expect(factory.cmp("a", "b")).toBe(-1);
  });

  test("cmp returns 1 when first key is greater", () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    expect(factory.cmp("b", "a")).toBe(1);
  });

  test("databases() returns opened databases", async () => {
    const factory = new IDBFactoryShim(new MemoryDataStore());
    await openDb(factory, "alpha", 1, "s");
    const dbs = await factory.databases();
    expect(dbs.some((d) => d.name === "alpha")).toBe(true);
  });
});

describe("shims/indexed-db — Sandbox integration", () => {
  test("sandbox.window.indexedDB is an IDBFactoryShim when dataStore is set", () => {
    const { Sandbox } = require("../../src/shims/sandbox.ts");
    const sb = new Sandbox({ dataStore: new MemoryDataStore() });
    const idb = sb.window.indexedDB;
    expect(idb).toBeDefined();
    expect(typeof idb.open).toBe("function");
    expect(typeof idb.databases).toBe("function");
    expect(typeof idb.cmp).toBe("function");
  });
});
