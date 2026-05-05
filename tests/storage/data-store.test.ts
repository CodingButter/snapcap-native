/**
 * PURE tests — `src/storage/data-store.ts`
 *
 * Covers:
 *   - MemoryDataStore: get/set/delete/keys, isolation between instances
 *   - FileDataStore: round-trip through real tmp files, flush, loadSync,
 *     getSync/setSync/keys, per-instance file isolation
 *
 * No Sandbox, no fetch. Uses os.tmpdir() for real file tests.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDataStore, FileDataStore } from "../../src/storage/data-store.ts";

// ─── Shared tmp dir cleanup ───────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapcap-ds-test-"));
  tmpDirs.push(dir);
  return join(dir, "store.json");
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ─── MemoryDataStore ──────────────────────────────────────────────────────────

describe("storage/data-store — MemoryDataStore", () => {
  test("get returns undefined for missing key", async () => {
    const ds = new MemoryDataStore();
    expect(await ds.get("missing")).toBeUndefined();
  });

  test("set then get round-trips bytes", async () => {
    const ds = new MemoryDataStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await ds.set("k", bytes);
    const got = await ds.get("k");
    expect(got).toEqual(bytes);
  });

  test("set stores a copy, not the original reference", async () => {
    const ds = new MemoryDataStore();
    const orig = new Uint8Array([10, 20]);
    await ds.set("k", orig);
    orig[0] = 99;
    const got = await ds.get("k");
    expect(got![0]).toBe(10); // copy is unaffected
  });

  test("delete removes the entry", async () => {
    const ds = new MemoryDataStore();
    await ds.set("del", new Uint8Array([7]));
    await ds.delete("del");
    expect(await ds.get("del")).toBeUndefined();
  });

  test("delete on absent key is a no-op (no throw)", async () => {
    const ds = new MemoryDataStore();
    await expect(ds.delete("nope")).resolves.toBeUndefined();
  });

  test("keys() returns all stored keys without prefix filter", async () => {
    const ds = new MemoryDataStore();
    await ds.set("aaa", new Uint8Array([1]));
    await ds.set("bbb", new Uint8Array([2]));
    expect(ds.keys().sort()).toEqual(["aaa", "bbb"]);
  });

  test("keys(prefix) filters to matching keys only", async () => {
    const ds = new MemoryDataStore();
    await ds.set("local_foo", new Uint8Array([1]));
    await ds.set("session_bar", new Uint8Array([2]));
    expect(ds.keys("local_")).toEqual(["local_foo"]);
    expect(ds.keys("session_")).toEqual(["session_bar"]);
  });

  test("getSync / setSync are synchronous variants", () => {
    const ds = new MemoryDataStore();
    expect(ds.getSync("x")).toBeUndefined();
    ds.setSync("x", new Uint8Array([42]));
    expect(ds.getSync("x")).toEqual(new Uint8Array([42]));
  });

  test("two MemoryDataStore instances are isolated", async () => {
    const ds1 = new MemoryDataStore();
    const ds2 = new MemoryDataStore();
    await ds1.set("shared_key", new Uint8Array([1]));
    expect(await ds2.get("shared_key")).toBeUndefined();
  });
});

// ─── FileDataStore ────────────────────────────────────────────────────────────

describe("storage/data-store — FileDataStore", () => {
  test("get returns undefined when file does not exist yet", async () => {
    const ds = new FileDataStore(tmpStorePath());
    expect(await ds.get("any")).toBeUndefined();
  });

  test("set then get round-trips bytes", async () => {
    const ds = new FileDataStore(tmpStorePath());
    const bytes = new Uint8Array([5, 6, 7]);
    await ds.set("k", bytes);
    expect(await ds.get("k")).toEqual(bytes);
  });

  test("set flushes to disk; new instance reads it back", async () => {
    const path = tmpStorePath();
    const ds1 = new FileDataStore(path);
    await ds1.set("persist", new Uint8Array([99, 88]));

    const ds2 = new FileDataStore(path);
    expect(await ds2.get("persist")).toEqual(new Uint8Array([99, 88]));
  });

  test("delete removes entry and flushes", async () => {
    const path = tmpStorePath();
    const ds = new FileDataStore(path);
    await ds.set("toDelete", new Uint8Array([1]));
    await ds.delete("toDelete");
    expect(await ds.get("toDelete")).toBeUndefined();
    // Also persisted — new instance should not see it.
    const ds2 = new FileDataStore(path);
    expect(await ds2.get("toDelete")).toBeUndefined();
  });

  test("delete on absent key does not throw", async () => {
    const ds = new FileDataStore(tmpStorePath());
    await expect(ds.delete("ghost")).resolves.toBeUndefined();
  });

  test("getSync / setSync round-trip without awaiting", () => {
    const ds = new FileDataStore(tmpStorePath());
    expect(ds.getSync("x")).toBeUndefined();
    ds.setSync("x", new Uint8Array([77]));
    expect(ds.getSync("x")).toEqual(new Uint8Array([77]));
  });

  test("keys(prefix) enumerates matching entries", async () => {
    const ds = new FileDataStore(tmpStorePath());
    await ds.set("local_a", new Uint8Array([1]));
    await ds.set("local_b", new Uint8Array([2]));
    await ds.set("session_c", new Uint8Array([3]));
    expect(ds.keys("local_").sort()).toEqual(["local_a", "local_b"]);
    expect(ds.keys("session_")).toEqual(["session_c"]);
    expect(ds.keys().sort()).toEqual(["local_a", "local_b", "session_c"]);
  });

  test("survives corrupt JSON on disk by starting fresh", async () => {
    const path = tmpStorePath();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "not valid json");
    const ds = new FileDataStore(path);
    expect(await ds.get("anything")).toBeUndefined();
  });

  test("two FileDataStore instances on different paths are isolated", async () => {
    const ds1 = new FileDataStore(tmpStorePath());
    const ds2 = new FileDataStore(tmpStorePath());
    await ds1.set("key", new Uint8Array([1]));
    expect(await ds2.get("key")).toBeUndefined();
  });
});
