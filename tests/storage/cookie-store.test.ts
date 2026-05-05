/**
 * PURE tests — `src/storage/cookie-store.ts`
 *
 * CookieJarStore wraps tough-cookie's CookieJar over a DataStore. Tests
 * cover: create() with empty store, create() rehydrating existing state,
 * flush() persisting back, idempotency under double-flush.
 *
 * No Sandbox, no fetch, no mock-sandbox. Uses MemoryDataStore as the
 * backing store (it satisfies the DataStore interface and is synchronous).
 */
import { describe, expect, test } from "bun:test";
import { CookieJarStore } from "../../src/storage/cookie-store.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

describe("storage/cookie-store — CookieJarStore.create", () => {
  test("creates an empty jar when no prior state in store", async () => {
    const store = new MemoryDataStore();
    const jarStore = await CookieJarStore.create(store);
    expect(jarStore.jar).toBeDefined();
    const cookies = await jarStore.jar.getCookies("https://www.snapchat.com/");
    expect(cookies).toHaveLength(0);
  });

  test("rehydrates jar from previously persisted state", async () => {
    const store = new MemoryDataStore();

    // Create and persist a jar with one cookie.
    const js1 = await CookieJarStore.create(store);
    await js1.jar.setCookie("foo=bar; path=/", "https://www.snapchat.com/");
    await js1.flush();

    // A new instance over the same store should see the cookie.
    const js2 = await CookieJarStore.create(store);
    const cookies = await js2.jar.getCookies("https://www.snapchat.com/");
    const foo = cookies.find((c) => c.key === "foo");
    expect(foo?.value).toBe("bar");
  });

  test("uses custom key when provided", async () => {
    const store = new MemoryDataStore();
    const js = await CookieJarStore.create(store, "my_cookie_jar");
    await js.jar.setCookie("x=1; path=/", "https://snap.com/");
    await js.flush();

    // Data must be under the custom key.
    const bytes = await store.get("my_cookie_jar");
    expect(bytes).toBeDefined();
    const json = new TextDecoder().decode(bytes!);
    expect(json).toContain("x");

    // Default key must be absent.
    expect(await store.get("cookie_jar")).toBeUndefined();
  });

  test("flush after mutating jar persists new cookies", async () => {
    const store = new MemoryDataStore();
    const js = await CookieJarStore.create(store);

    await js.jar.setCookie("sess=abc; path=/", "https://accounts.snapchat.com/");
    await js.flush();

    const js2 = await CookieJarStore.create(store);
    const cookies = await js2.jar.getCookies("https://accounts.snapchat.com/");
    expect(cookies.some((c) => c.key === "sess" && c.value === "abc")).toBe(true);
  });

  test("two stores over distinct MemoryDataStore instances are isolated", async () => {
    const storeA = new MemoryDataStore();
    const storeB = new MemoryDataStore();

    const jsA = await CookieJarStore.create(storeA);
    await jsA.jar.setCookie("tenant=A; path=/", "https://www.snapchat.com/");
    await jsA.flush();

    const jsB = await CookieJarStore.create(storeB);
    const cookiesB = await jsB.jar.getCookies("https://www.snapchat.com/");
    expect(cookiesB.some((c) => c.key === "tenant")).toBe(false);
  });

  test("double flush does not corrupt state", async () => {
    const store = new MemoryDataStore();
    const js = await CookieJarStore.create(store);
    await js.jar.setCookie("a=1; path=/", "https://snap.com/");
    await js.flush();
    await js.flush(); // idempotent

    const js2 = await CookieJarStore.create(store);
    const cookies = await js2.jar.getCookies("https://snap.com/");
    expect(cookies.some((c) => c.key === "a")).toBe(true);
  });

  test("starts fresh when stored bytes are empty", async () => {
    const store = new MemoryDataStore();
    // Explicitly set empty bytes under the key.
    await store.set("cookie_jar", new Uint8Array(0));
    const js = await CookieJarStore.create(store);
    const cookies = await js.jar.getCookies("https://www.snapchat.com/");
    expect(cookies).toHaveLength(0);
  });
});
