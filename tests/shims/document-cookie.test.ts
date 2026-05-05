/**
 * STATE-DRIVEN tests — `src/shims/document-cookie.ts`
 *
 * installDocumentCookieShim patches document.cookie on a Sandbox to route
 * through a tough-cookie jar. Tests use a real Sandbox + MemoryDataStore.
 *
 * The shim is installed as part of SDK_SHIMS when a Sandbox is constructed
 * with a dataStore — so constructing a Sandbox exercises it implicitly.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import { getOrCreateJar } from "../../src/shims/cookie-jar.ts";

function makeSandbox(): { sb: Sandbox; store: MemoryDataStore } {
  const store = new MemoryDataStore();
  const sb = new Sandbox({ dataStore: store });
  return { sb, store };
}

describe("shims/document-cookie — read / write via document.cookie", () => {
  test("setting a cookie via document.cookie is readable back", () => {
    const { sb } = makeSandbox();
    const doc = sb.document as { cookie: string };
    doc.cookie = "foo=bar; path=/";
    expect(doc.cookie).toContain("foo=bar");
  });

  test("HttpOnly cookies are excluded from document.cookie getter", () => {
    const { sb, store } = makeSandbox();
    const jar = getOrCreateJar(store);
    jar.setCookieSync("secret=hidden; HttpOnly; path=/", "https://www.snapchat.com/");

    const doc = sb.document as { cookie: string };
    // W3C: JS-level access never sees HttpOnly.
    expect(doc.cookie).not.toContain("secret=hidden");
  });

  test("write then read returns the value (not null)", () => {
    const { sb } = makeSandbox();
    const doc = sb.document as { cookie: string };
    doc.cookie = "sess=xyz; path=/";
    expect(doc.cookie.includes("sess=xyz")).toBe(true);
  });

  test("setting empty string does not throw", () => {
    const { sb } = makeSandbox();
    const doc = sb.document as { cookie: string };
    expect(() => { doc.cookie = ""; }).not.toThrow();
  });

  test("setting invalid cookie string does not throw", () => {
    const { sb } = makeSandbox();
    const doc = sb.document as { cookie: string };
    expect(() => { doc.cookie = ";;;==="; }).not.toThrow();
  });

  test("two Sandboxes keep cookies isolated", () => {
    const { sb: sbA } = makeSandbox();
    const { sb: sbB } = makeSandbox();
    const docA = sbA.document as { cookie: string };
    const docB = sbB.document as { cookie: string };
    docA.cookie = "owner=A; path=/";
    docB.cookie = "owner=B; path=/";
    expect(docA.cookie).toContain("owner=A");
    expect(docB.cookie).toContain("owner=B");
    // Neither side leaks.
    expect(docA.cookie).not.toContain("owner=B");
    expect(docB.cookie).not.toContain("owner=A");
  });

  test("install is idempotent — double-installing does not corrupt", () => {
    const { sb, store } = makeSandbox();
    const { installDocumentCookieShim } = require("../../src/shims/document-cookie.ts");
    // Second install should be a no-op via marker symbol.
    installDocumentCookieShim(sb, store);
    const doc = sb.document as { cookie: string };
    doc.cookie = "idempotent=yes; path=/";
    expect(doc.cookie).toContain("idempotent=yes");
  });
});
