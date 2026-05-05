/**
 * STATE-DRIVEN tests — `src/shims/cookie-container.ts`
 *
 * Tests the DataStoreCookieContainer helper (pure unit — no Sandbox) and
 * the Sandbox-level install/bind via a real Sandbox + MemoryDataStore.
 *
 * installCookieContainer + bindCookieContainer are tested indirectly via
 * the Sandbox (document.cookie shim installs both as part of SDK_SHIMS).
 */
import { describe, expect, test } from "bun:test";
import { DataStoreCookieContainer } from "../../src/shims/cookie-container.ts";
import { getOrCreateJar } from "../../src/shims/cookie-jar.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import { Sandbox } from "../../src/shims/sandbox.ts";
import CookieSameSiteEnum from "happy-dom/lib/cookie/enums/CookieSameSiteEnum.js";
import type ICookie from "happy-dom/lib/cookie/ICookie.js";

// ─── DataStoreCookieContainer (unit) ─────────────────────────────────────────

describe("shims/cookie-container — DataStoreCookieContainer.addCookies", () => {
  test("writes cookies into the jar", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    const cc = new DataStoreCookieContainer(jar, store);

    const cookie: ICookie = {
      key: "test",
      value: "hello",
      domain: "www.snapchat.com",
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: CookieSameSiteEnum.lax,
      expires: null,
      originURL: new URL("https://www.snapchat.com/"),
    };
    cc.addCookies([cookie]);
    const got = jar.getCookiesSync("https://www.snapchat.com/");
    expect(got.some((c) => c.key === "test" && c.value === "hello")).toBe(true);
  });

  test("ignores empty / null cookies without throwing", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    const cc = new DataStoreCookieContainer(jar, store);
    expect(() => cc.addCookies([])).not.toThrow();
    // @ts-expect-error — deliberate bad input for resilience test
    expect(() => cc.addCookies([null, undefined, {}])).not.toThrow();
  });

  test("addCookies falls back to synthetic originURL when none provided", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    const cc = new DataStoreCookieContainer(jar, store);
    const cookie: Partial<ICookie> = {
      key: "x",
      value: "1",
      domain: "snap.com",
      path: "/",
      secure: true,
    };
    expect(() => cc.addCookies([cookie as ICookie])).not.toThrow();
  });
});

describe("shims/cookie-container — DataStoreCookieContainer.getCookies", () => {
  test("returns all cookies when httpOnly=false (HTTP fetch context)", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    jar.setCookieSync("http_only=secret; HttpOnly; path=/", "https://www.snapchat.com/");
    jar.setCookieSync("normal=visible; path=/", "https://www.snapchat.com/");

    const cc = new DataStoreCookieContainer(jar, store);
    const all = cc.getCookies(new URL("https://www.snapchat.com/"), false);
    expect(all.some((c) => c.key === "normal")).toBe(true);
    // httpOnly=false means "all cookies for HTTP fetch" per browser semantics
    expect(all.some((c) => c.key === "http_only")).toBe(true);
  });

  test("returns only HttpOnly cookies when httpOnly=true", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    jar.setCookieSync("http_only=secret; HttpOnly; path=/", "https://www.snapchat.com/");
    jar.setCookieSync("normal=visible; path=/", "https://www.snapchat.com/");

    const cc = new DataStoreCookieContainer(jar, store);
    const httpOnlyOnly = cc.getCookies(new URL("https://www.snapchat.com/"), true);
    expect(httpOnlyOnly.every((c) => c.httpOnly)).toBe(true);
    expect(httpOnlyOnly.some((c) => c.key === "http_only")).toBe(true);
    expect(httpOnlyOnly.some((c) => c.key === "normal")).toBe(false);
  });

  test("returns [] when url is null (falls back to snapchat.com)", () => {
    const store = new MemoryDataStore();
    const jar = getOrCreateJar(store);
    const cc = new DataStoreCookieContainer(jar, store);
    const result = cc.getCookies(null, false);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Sandbox-level integration: document.cookie routes through the jar ─────────

describe("shims/cookie-container — sandbox document.cookie integration", () => {
  test("document.cookie write is visible via jar.getCookiesSync", () => {
    const store = new MemoryDataStore();
    const sb = new Sandbox({ dataStore: store, userAgent: "TestUA/1.0" });
    const jar = getOrCreateJar(store);

    const doc = sb.document as { cookie: string };
    doc.cookie = "integration=works; path=/";

    const cookies = jar.getCookiesSync("https://www.snapchat.com/");
    expect(cookies.some((c) => c.key === "integration")).toBe(true);
  });

  test("two Sandboxes do not share cookie state", () => {
    const storeA = new MemoryDataStore();
    const storeB = new MemoryDataStore();
    const sbA = new Sandbox({ dataStore: storeA, userAgent: "UA-A" });
    const sbB = new Sandbox({ dataStore: storeB, userAgent: "UA-B" });

    (sbA.document as { cookie: string }).cookie = "tenant=A; path=/";
    (sbB.document as { cookie: string }).cookie = "tenant=B; path=/";

    const jarA = getOrCreateJar(storeA);
    const jarB = getOrCreateJar(storeB);

    const cookiesA = jarA.getCookiesSync("https://www.snapchat.com/");
    const cookiesB = jarB.getCookiesSync("https://www.snapchat.com/");

    expect(cookiesA.find((c) => c.key === "tenant")?.value).toBe("A");
    expect(cookiesB.find((c) => c.key === "tenant")?.value).toBe("B");
  });
});
