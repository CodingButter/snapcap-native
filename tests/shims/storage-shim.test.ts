/**
 * STATE-DRIVEN tests — `src/shims/storage-shim.ts`
 *
 * LocalStorageShim and SessionStorageShim install DataStore-backed
 * localStorage / sessionStorage onto the sandbox window. They are thin
 * Shim wrappers around StorageShim (src/storage/storage-shim.ts) —
 * these tests confirm the Sandbox-level wiring is correct.
 *
 * Uses a real Sandbox + MemoryDataStore.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

function makeSandbox(): { sb: Sandbox; store: MemoryDataStore } {
  const store = new MemoryDataStore();
  const sb = new Sandbox({ dataStore: store });
  return { sb, store };
}

describe("shims/storage-shim — localStorage via Sandbox", () => {
  test("setItem / getItem round-trips through sandbox localStorage", () => {
    const { sb } = makeSandbox();
    const ls = sb.window.localStorage as Storage;
    ls.setItem("greeting", "hello");
    expect(ls.getItem("greeting")).toBe("hello");
  });

  test("removeItem removes the entry", () => {
    const { sb } = makeSandbox();
    const ls = sb.window.localStorage as Storage;
    ls.setItem("del", "gone");
    ls.removeItem("del");
    expect(ls.getItem("del")).toBeNull();
  });

  test("clear empties all localStorage keys", () => {
    const { sb } = makeSandbox();
    const ls = sb.window.localStorage as Storage;
    ls.setItem("a", "1");
    ls.setItem("b", "2");
    ls.clear();
    expect(ls.length).toBe(0);
  });

  test("uses local_ prefix — does not collide with sessionStorage", () => {
    const { sb, store } = makeSandbox();
    const ls = sb.window.localStorage as Storage;
    const ss = sb.window.sessionStorage as Storage;
    ls.setItem("shared_key", "from-local");
    ss.setItem("shared_key", "from-session");

    // DataStore must have the prefixed keys.
    expect(store.getSync("local_shared_key")).toBeDefined();
    expect(store.getSync("session_shared_key")).toBeDefined();
    expect(ls.getItem("shared_key")).toBe("from-local");
    expect(ss.getItem("shared_key")).toBe("from-session");
  });

  test("two Sandboxes have isolated localStorage", () => {
    const { sb: sbA } = makeSandbox();
    const { sb: sbB } = makeSandbox();
    const lsA = sbA.window.localStorage as Storage;
    const lsB = sbB.window.localStorage as Storage;
    lsA.setItem("tenant", "A");
    expect(lsB.getItem("tenant")).toBeNull();
  });
});

describe("shims/storage-shim — sessionStorage via Sandbox", () => {
  test("setItem / getItem round-trips through sandbox sessionStorage", () => {
    const { sb } = makeSandbox();
    const ss = sb.window.sessionStorage as Storage;
    ss.setItem("token", "abc");
    expect(ss.getItem("token")).toBe("abc");
  });

  test("sessionStorage length tracks correctly", () => {
    const { sb } = makeSandbox();
    const ss = sb.window.sessionStorage as Storage;
    expect(ss.length).toBe(0);
    ss.setItem("x", "1");
    ss.setItem("y", "2");
    expect(ss.length).toBe(2);
  });
});
