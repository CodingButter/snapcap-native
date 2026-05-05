/**
 * STATE-DRIVEN test — `src/api/auth/patch-location.ts`.
 *
 * `patchSandboxLocationToWeb(ctx)` replaces `sandbox.window.location`
 * with a Proxy that returns "/web" for pathname, "https://web.snapchat.com/web"
 * for href, "web.snapchat.com" for host, etc. Idempotency is gated on
 * `host === "web.snapchat.com"` (the proxy-rewritten field that differs
 * from happy-dom's default of `www.snapchat.com`).
 *
 * Real `Sandbox` here because MockSandbox.runInContext throws by design,
 * and `patchSandboxLocationToWeb` calls runInContext to read the existing
 * location object.
 */
import { describe, expect, test } from "bun:test";
import { patchSandboxLocationToWeb } from "../../../src/api/auth/patch-location.ts";
import { Sandbox } from "../../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import type { CookieJarStore } from "../../../src/storage/cookie-store.ts";
import { CookieJar } from "tough-cookie";

function fakeJar(): CookieJarStore {
  return { jar: new CookieJar(), flush: async () => {} } as unknown as CookieJarStore;
}

async function makeRealCtx(): Promise<ClientContext> {
  const ds = new MemoryDataStore();
  const sandbox = new Sandbox({ dataStore: ds });
  return { sandbox, jar: fakeJar(), dataStore: ds, userAgent: "" };
}

describe("api/auth/patch-location — patchSandboxLocationToWeb", () => {
  test("pathname reads as /web after patch", async () => {
    const ctx = await makeRealCtx();
    expect((ctx.sandbox.window.location as { pathname: string }).pathname).toBe("/web");
    patchSandboxLocationToWeb(ctx);
    expect((ctx.sandbox.window.location as { pathname: string }).pathname).toBe("/web");
  });

  test("href becomes https://web.snapchat.com/web after patch", async () => {
    const ctx = await makeRealCtx();
    patchSandboxLocationToWeb(ctx);
    const loc = ctx.sandbox.window.location as { href: string };
    expect(loc.href).toBe("https://web.snapchat.com/web");
  });

  test("host + hostname become web.snapchat.com after patch", async () => {
    const ctx = await makeRealCtx();
    patchSandboxLocationToWeb(ctx);
    const loc = ctx.sandbox.window.location as { host: string; hostname: string };
    expect(loc.host).toBe("web.snapchat.com");
    expect(loc.hostname).toBe("web.snapchat.com");
  });

  test("does not throw on repeated calls", async () => {
    const ctx = await makeRealCtx();
    expect(() => patchSandboxLocationToWeb(ctx)).not.toThrow();
    expect(() => patchSandboxLocationToWeb(ctx)).not.toThrow();
  });
});
