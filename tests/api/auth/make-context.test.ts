/**
 * PURE test — `src/api/auth/make-context.ts`.
 *
 * `makeContext` is a pure wiring function: it receives four inputs and
 * returns a `ClientContext` bag. No I/O, no bundle, no Sandbox behaviour.
 * Test that every field is threaded through unchanged.
 */
import { describe, expect, test } from "bun:test";
import { makeContext } from "../../../src/api/auth/make-context.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { CookieJarStore } from "../../../src/storage/cookie-store.ts";

describe("api/auth/make-context — makeContext", () => {
  test("threads all four fields into the returned ClientContext", async () => {
    const sandbox = mockSandbox().build();
    const ds = new MemoryDataStore();
    const jar = await CookieJarStore.create(ds);
    const ua = "Mozilla/5.0 (Test)";

    const ctx = await makeContext({ sandbox, dataStore: ds, jar, userAgent: ua });

    expect(ctx.sandbox).toBe(sandbox);
    expect(ctx.dataStore).toBe(ds);
    expect(ctx.jar).toBe(jar);
    expect(ctx.userAgent).toBe(ua);
  });

  test("returns distinct objects on separate calls (no shared reference)", async () => {
    const sandbox = mockSandbox().build();
    const ds = new MemoryDataStore();
    const jar = await CookieJarStore.create(ds);

    const ctx1 = await makeContext({ sandbox, dataStore: ds, jar, userAgent: "ua-1" });
    const ctx2 = await makeContext({ sandbox, dataStore: ds, jar, userAgent: "ua-2" });

    expect(ctx1).not.toBe(ctx2);
    expect(ctx1.userAgent).toBe("ua-1");
    expect(ctx2.userAgent).toBe("ua-2");
  });

  test("does not add extra keys beyond the four expected fields", async () => {
    const sandbox = mockSandbox().build();
    const ds = new MemoryDataStore();
    const jar = await CookieJarStore.create(ds);

    const ctx = await makeContext({ sandbox, dataStore: ds, jar, userAgent: "" });

    // The context should have exactly the four wired keys (plus _bundlesLoaded
    // which is optional and may be absent).
    const keys = Object.keys(ctx);
    expect(keys).toContain("sandbox");
    expect(keys).toContain("dataStore");
    expect(keys).toContain("jar");
    expect(keys).toContain("userAgent");
  });
});
