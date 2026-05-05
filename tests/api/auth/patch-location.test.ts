/**
 * STATE-DRIVEN test — `src/api/auth/patch-location.ts`.
 *
 * `patchSandboxLocationToWeb(ctx)` is supposed to replace
 * `sandbox.window.location` with a Proxy that returns "/web" for pathname,
 * "https://web.snapchat.com/web" for href, etc.
 *
 * # Bug exposed (DO NOT FIX HERE)
 *
 * The idempotency guard checks `if (prevLoc.pathname === "/web") return;`.
 * happy-dom's default URL for the sandbox is already `www.snapchat.com/web`,
 * so `pathname` is ALREADY "/web" before the Proxy is installed.
 * As a result, the function returns early on every call and the Proxy is
 * NEVER installed. Only `pathname` ends up correctly valued ("/web") —
 * because happy-dom already had that. `href`, `origin`, `host`, and
 * `hostname` remain pointing at `www.snapchat.com`, not `web.snapchat.com`.
 *
 * The correct idempotency guard should check `if (prevLoc.href ===
 * "https://web.snapchat.com/web") return;` (or any field that the Proxy
 * actually overrides that differs from the pre-patch default).
 *
 * These tests assert the current (buggy) behavior so any fix is visible
 * as a test failure that then needs corresponding test updates.
 *
 * We use a real `Sandbox` here because MockSandbox.runInContext throws
 * by design, and `patchSandboxLocationToWeb` calls `runInContext` to read
 * the existing location object.
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
  test("pathname reads as /web (happy-dom default; guard returns early before proxy installs)", async () => {
    const ctx = await makeRealCtx();
    // Pre-condition: happy-dom already sets pathname = "/web" for www.snapchat.com/web.
    const loc = ctx.sandbox.window.location as { pathname: string };
    expect(loc.pathname).toBe("/web");

    patchSandboxLocationToWeb(ctx);

    // Still /web — idempotency guard fires on the FIRST call because
    // pathname is already "/web". This is the documented bug.
    expect((ctx.sandbox.window.location as { pathname: string }).pathname).toBe("/web");
  });

  test("BUG: href remains www.snapchat.com/web because proxy is never installed", async () => {
    const ctx = await makeRealCtx();
    patchSandboxLocationToWeb(ctx);

    // BUG: should be "https://web.snapchat.com/web" but guard fires early.
    const loc = ctx.sandbox.window.location as { href: string };
    expect(loc.href).toBe("https://www.snapchat.com/web");
  });

  test("BUG: host remains www.snapchat.com because proxy is never installed", async () => {
    const ctx = await makeRealCtx();
    patchSandboxLocationToWeb(ctx);

    const loc = ctx.sandbox.window.location as { host: string; hostname: string };
    // BUG: should be "web.snapchat.com" once the proxy is correctly installed.
    expect(loc.host).toBe("www.snapchat.com");
    expect(loc.hostname).toBe("www.snapchat.com");
  });

  test("does not throw on repeated calls", async () => {
    const ctx = await makeRealCtx();
    expect(() => patchSandboxLocationToWeb(ctx)).not.toThrow();
    expect(() => patchSandboxLocationToWeb(ctx)).not.toThrow();
  });
});
